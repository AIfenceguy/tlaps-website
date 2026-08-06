// cs-zendesk — Zendesk read-only probe + ingest for the JL CS bot.
//
// Phase 1 is deliberately read-only: this function never writes to Zendesk.
// The Zendesk credentials live in Supabase secrets and are read from env here;
// they are never returned to the caller and never reach the browser or Claude.
//
// Modes (POST body { access_code, mode, ... }):
//   sample   - a few solved tickets + the comment thread for one, trimmed.
//              Used to learn the real field shape before writing the parser.
//   count    - how many solved tickets exist (sizing the mining job).
//   comments - full comment thread for one ticket_id.
//
// Deploy: supabase functions deploy cs-zendesk --no-verify-jwt

const ZD_SUBDOMAIN = Deno.env.get("ZENDESK_SUBDOMAIN") ?? "";
const ZD_EMAIL     = Deno.env.get("ZENDESK_EMAIL") ?? "";
const ZD_TOKEN     = Deno.env.get("ZENDESK_TOKEN") ?? "";
// Own access code so this function is independent of the Email Center's
// COPILOT_ACCESS_CODE — changing one must never break the other.
// Falls back to COPILOT_ACCESS_CODE only if CS_ACCESS_CODE isn't set yet.
const ACCESS_CODE  = Deno.env.get("CS_ACCESS_CODE") || Deno.env.get("COPILOT_ACCESS_CODE") || "";

const ALLOWED_ORIGINS = [
  "https://tlapspro.com",
  "https://www.tlapspro.com",
  "https://aifenceguy.github.io",
  "http://localhost:8000",
];

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[1];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// Zendesk basic auth is literally "{email}/token:{api_token}" base64'd.
function zdAuth(): string {
  return "Basic " + btoa(`${ZD_EMAIL}/token:${ZD_TOKEN}`);
}

async function zd(path: string): Promise<any> {
  const res = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/${path}`, {
    headers: { Authorization: zdAuth(), "Content-Type": "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    // Surface Zendesk's own error body — a 401 here usually means the
    // ZENDESK_EMAIL doesn't match the account that created the token.
    throw new Error(`Zendesk ${res.status} on ${path.split("?")[0]}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

// Keep responses small and readable — full tickets are very noisy.
function trimTicket(t: any) {
  return {
    id: t.id,
    subject: t.subject,
    description: (t.description ?? "").slice(0, 800),
    status: t.status,
    created_at: t.created_at,
    via_channel: t.via?.channel,
    via_source: t.via?.source,          // where eBay/Amazon identity should live
    recipient: t.recipient,             // which support address -> which store
    tags: t.tags,
    custom_fields: (t.custom_fields ?? []).filter((f: any) => f.value !== null),
  };
}

function trimComment(c: any) {
  return {
    id: c.id,
    author_id: c.author_id,
    public: c.public,
    created_at: c.created_at,
    body: (c.body ?? "").slice(0, 1200),
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = { ...cors(origin), "Content-Type": "application/json" };

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });

  try {
    const body = await req.json().catch(() => ({}));

    if (!ACCESS_CODE || body.access_code !== ACCESS_CODE) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });
    }
    if (!ZD_SUBDOMAIN || !ZD_EMAIL || !ZD_TOKEN) {
      return new Response(
        JSON.stringify({ error: "Zendesk secrets missing (ZENDESK_SUBDOMAIN/EMAIL/TOKEN)" }),
        { status: 500, headers },
      );
    }

    const mode = body.mode ?? "sample";
    // Caller can override the search query. Default is solved-only, which
    // UNDERCOUNTS badly: Zendesk auto-closes solved tickets after ~28 days,
    // and archives closed ones after 120 days -- archived tickets are invisible
    // to Search entirely. Use mode "export" for the true historical total.
    const query = body.query ?? "type:ticket status:solved";

    if (mode === "count") {
      const data = await zd("search.json?query=" + encodeURIComponent(query) + "&per_page=1");
      return new Response(JSON.stringify({ query, count: data.count }), { headers });
    }

    // Incremental Export — the only endpoint that returns archived tickets.
    // Walks pages of 1000 from start_time (unix seconds; 0 = all history).
    // Returns just the tally + a status breakdown so we can size the mining job.
    if (mode === "export") {
      const maxPages = Math.min(parseInt(body.max_pages ?? "20", 10) || 20, 100);
      let url = `incremental/tickets.json?start_time=${parseInt(body.start_time ?? "0", 10) || 0}`;
      let total = 0, pages = 0, endOfStream = false;
      const byStatus: Record<string, number> = {};
      const byChannel: Record<string, number> = {};

      // Optional: return N full tickets so we can inspect real field shape.
      // Search can't see archived tickets, so this is the only way to sample history.
      const wantSamples = Math.min(parseInt(body.samples ?? "0", 10) || 0, 10);
      const sampleChannel = body.sample_channel ?? null;   // e.g. "api" to see connector tickets
      const samples: any[] = [];

      while (pages < maxPages) {
        const data = await zd(url);
        const batch = data.tickets ?? [];
        total += batch.length;
        pages++;
        for (const t of batch) {
          byStatus[t.status ?? "?"] = (byStatus[t.status ?? "?"] ?? 0) + 1;
          const ch = t.via?.channel ?? "?";
          byChannel[ch] = (byChannel[ch] ?? 0) + 1;
          if (samples.length < wantSamples && (!sampleChannel || ch === sampleChannel)) {
            samples.push(trimTicket(t));
          }
        }
        if (data.end_of_stream) { endOfStream = true; break; }
        if (!data.next_page) break;
        url = data.next_page.split("/api/v2/")[1];
      }

      return new Response(
        JSON.stringify(
          { counted: total, pages, end_of_stream: endOfStream, by_status: byStatus, by_channel: byChannel,
            samples: samples.length ? samples : undefined },
          null, 2),
        { headers },
      );
    }

    if (mode === "comments") {
      if (!body.ticket_id) {
        return new Response(JSON.stringify({ error: "ticket_id required" }), { status: 400, headers });
      }
      const data = await zd(`tickets/${body.ticket_id}/comments.json`);
      return new Response(
        JSON.stringify({ ticket_id: body.ticket_id, comments: (data.comments ?? []).map(trimComment) }),
        { headers },
      );
    }

    // mode === "sample": a few solved tickets, plus the thread for the first one,
    // so we can see both the ticket shape and whether agent replies come back clean.
    const n = Math.min(Math.max(parseInt(body.limit ?? "3", 10) || 3, 1), 10);
    const search = await zd(
      "search.json?query=" + encodeURIComponent("type:ticket status:solved") + `&per_page=${n}`,
    );
    const tickets = (search.results ?? []).map(trimTicket);

    let firstThread = null;
    if (tickets.length) {
      const c = await zd(`tickets/${tickets[0].id}/comments.json`);
      firstThread = { ticket_id: tickets[0].id, comments: (c.comments ?? []).map(trimComment) };
    }

    return new Response(
      JSON.stringify({ total_solved: search.count, tickets, first_thread: firstThread }, null, 2),
      { headers },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), { status: 500, headers });
  }
});
