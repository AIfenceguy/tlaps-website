// cs-mine — builds the "binder" from closed Zendesk tickets.
//
// 40k tickets don't fit in one prompt, so this is map-reduce:
//   map     -> read a batch of closed tickets + agent replies, ask Claude what
//              broke and what fixed it, write rows to cs_raw_lessons.
//   reduce  -> group cs_raw_lessons by SKU, consolidate into cs_sku_knowledge.
//   auto    -> one self-advancing map batch driven by pg_cron. State lives in
//              cs_mine_state so it resumes across invocations and stops itself.
//   status  -> row counts.
//
// Read-only against Zendesk. Writes only to Supabase.
// Batches are ~20 tickets because each needs its own comments fetch; 50 hits
// the edge-function wall clock (we measured a 504 at 50 export pages).

const ZD_SUBDOMAIN  = Deno.env.get("ZENDESK_SUBDOMAIN") ?? "";
const ZD_EMAIL      = Deno.env.get("ZENDESK_EMAIL") ?? "";
const ZD_TOKEN      = Deno.env.get("ZENDESK_TOKEN") ?? "";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ACCESS_CODE   = Deno.env.get("CS_ACCESS_CODE") || Deno.env.get("COPILOT_ACCESS_CODE") || "";
const SUPABASE_URL  = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MODEL         = Deno.env.get("CS_MODEL") ?? "claude-opus-5";

const ALLOWED_ORIGINS = [
  "https://tlapspro.com", "https://www.tlapspro.com",
  "https://aifenceguy.github.io", "http://localhost:8000",
];
function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[1];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function zdAuth() { return "Basic " + btoa(`${ZD_EMAIL}/token:${ZD_TOKEN}`); }

async function zd(path: string): Promise<any> {
  const res = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/${path}`, {
    headers: { Authorization: zdAuth(), "Content-Type": "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Zendesk ${res.status} on ${path.split("?")[0]}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function sbGet(path: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase GET ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function sbInsert(table: string, rows: any[]): Promise<void> {
  if (!rows.length) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json", Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase INSERT ${table} ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function sbPatchState(fields: Record<string, unknown>): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/cs_mine_state?id=eq.1`, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json", Prefer: "return=minimal",
    },
    body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
  });
}

let fieldMap: Record<number, string> | null = null;
async function loadFieldMap(): Promise<Record<number, string>> {
  if (fieldMap) return fieldMap;
  const data = await zd("ticket_fields.json?per_page=200");
  const m: Record<number, string> = {};
  for (const f of data.ticket_fields ?? []) m[f.id] = (f.title ?? "").trim();
  fieldMap = m;
  return m;
}
function fieldsByName(cf: any[], map: Record<number, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of cf ?? []) {
    const n = map[f.id];
    if (n && f.value !== null && f.value !== "") out[n] = String(f.value);
  }
  return out;
}

// Structured output beats parsing prose — the model must return this shape.
const MAP_SCHEMA = {
  type: "object",
  properties: {
    lessons: {
      type: "array",
      items: {
        type: "object",
        properties: {
          zendesk_id: { type: "integer" },
          sku:        { type: "string", description: "SKU if known, else empty string" },
          category:   { type: "string", description: "order_status | fitment | install | return | product_question | platform_case | other" },
          problem:    { type: "string", description: "what the customer actually had wrong, one sentence" },
          resolution: { type: "string", description: "what the agent did that fixed it; empty string if never resolved" },
          useful:     { type: "boolean", description: "false if this ticket teaches nothing reusable" },
        },
        required: ["zendesk_id", "sku", "category", "problem", "resolution", "useful"],
        additionalProperties: false,
      },
    },
  },
  required: ["lessons"],
  additionalProperties: false,
};

const REDUCE_SCHEMA = {
  type: "object",
  properties: {
    rules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          symptom:      { type: "string", description: "how the customer describes it, in their words" },
          root_cause:   { type: "string" },
          resolution:   { type: "string", description: "concrete steps the agent took" },
          ticket_count: { type: "integer", description: "how many source tickets support this rule" },
        },
        required: ["symptom", "root_cause", "resolution", "ticket_count"],
        additionalProperties: false,
      },
    },
  },
  required: ["rules"],
  additionalProperties: false,
};

async function callClaude(system: string, prompt: string, schema: any): Promise<any> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system,
      output_config: { format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  return JSON.parse(text);
}

const MAP_SYSTEM = `You are reading closed customer service tickets for JL Concepts, a seller of
truck and auto accessories on eBay and Amazon. For each ticket, extract what the customer's actual
problem was and what the agent did that resolved it.

Be strict about usefulness. Set useful=false when the ticket teaches nothing reusable:
auto-generated order notifications, one-word messages, tickets with no real agent reply, pure
"thanks" messages, or cases where the agent escalated without solving anything.

Write problem and resolution as short factual statements a future agent could act on.
Do not editorialise. Do not invent a resolution that isn't in the thread.`;

const REDUCE_SYSTEM = `You are consolidating many individual ticket lessons about ONE SKU into a
small set of reusable rules. Merge duplicates that describe the same underlying issue even when
customers word it differently. Set ticket_count to how many source lessons support each rule.

Drop anything supported by only one weak lesson unless it is clearly a real product issue.
Prefer few strong rules over many thin ones. The output is read by another AI when drafting
replies, so be concrete: "remove the spacer, only needed on 2500HD" not "check the installation".`;

/* One map batch. Shared by mode "map" (manual) and mode "auto" (cron). */
async function runMap(startTime: number, limit: number): Promise<any> {
  const page = await zd(`incremental/tickets.json?start_time=${startTime}`);
  const map = await loadFieldMap();
  const all = page.tickets ?? [];

  // Only tickets a human actually worked. Order notifications teach nothing.
  const candidates = all.filter((t: any) =>
    (t.status === "closed" || t.status === "solved") &&
    !(t.tags ?? []).includes("neworder") &&
    !(t.tags ?? []).includes("ebay_new_order_autosolved")
  ).slice(0, limit);

  const bundles: any[] = [];
  for (const t of candidates) {
    try {
      const c = await zd(`tickets/${t.id}/comments.json`);
      const comments = c.comments ?? [];
      if (comments.length < 2) continue;   // no agent reply -> no resolution to learn
      const f = fieldsByName(t.custom_fields, map);
      bundles.push({
        zendesk_id: t.id,
        sku: f["SKU"] ?? f["Variation SKU"] ?? "",
        subject: t.subject ?? "",
        thread: comments.slice(0, 6).map((x: any) =>
          `[${x.public ? "public" : "internal"}] ${(x.body ?? "").slice(0, 900)}`
        ).join("\n---\n"),
      });
    } catch { /* skip unreadable tickets rather than fail the batch */ }
  }

  if (!bundles.length) {
    return {
      scanned: all.length, bundled: 0, mined: 0,
      next_start_time: page.end_time, end_of_stream: !!page.end_of_stream,
      note: "no tickets with agent replies in this page",
    };
  }

  const prompt = bundles.map((b) =>
    `### TICKET ${b.zendesk_id}\nSKU: ${b.sku || "(unknown)"}\nSUBJECT: ${b.subject}\n${b.thread}`
  ).join("\n\n");

  const result = await callClaude(MAP_SYSTEM, prompt, MAP_SCHEMA);
  const useful = (result.lessons ?? []).filter((l: any) => l.useful);

  await sbInsert("cs_raw_lessons", useful.map((l: any) => ({
    zendesk_id: l.zendesk_id,
    sku: l.sku || null,
    category: l.category,
    problem: l.problem,
    resolution: l.resolution,
  })));

  return {
    scanned: all.length, bundled: bundles.length,
    mined: useful.length, discarded: (result.lessons ?? []).length - useful.length,
    next_start_time: page.end_time, end_of_stream: !!page.end_of_stream,
  };
}

async function countRows(table: string): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
               Prefer: "count=exact", Range: "0-0" },
  });
  return r.headers.get("content-range")?.split("/")[1] ?? "?";
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = { ...cors(origin), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });

  try {
    const body = await req.json().catch(() => ({}));

    // Two ways in:
    //  - access_code: Ricky, from PowerShell.
    //  - internal_token: pg_cron, which reads it from cs_mine_state. This exists
    //    so the scheduler can authenticate without the access code ever being
    //    written into a cron job definition.
    let authed = !!ACCESS_CODE && body.access_code === ACCESS_CODE;
    if (!authed && body.internal_token) {
      const st = await sbGet("cs_mine_state?select=internal_token&id=eq.1").catch(() => []);
      authed = !!st[0]?.internal_token && st[0].internal_token === body.internal_token;
    }
    if (!authed)
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });

    const mode = body.mode ?? "status";

    /* ---------------- status ---------------- */
    if (mode === "status") {
      const st = await sbGet("cs_mine_state?select=last_start_time,batches_run,max_batches,stopped,stop_reason,last_error,updated_at&id=eq.1").catch(() => []);
      const pb = await sbGet("cs_playbooks?select=name").catch(() => []);
      return new Response(JSON.stringify({
        raw_lessons:   await countRows("cs_raw_lessons"),
        sku_knowledge: await countRows("cs_sku_knowledge"),
        playbooks:     pb.length,
        tickets_seen:  await countRows("cs_tickets"),
        auto:          st[0] ?? null,
      }, null, 2), { headers });
    }

    /* ---------------- auto (cron-driven) ---------------- */
    if (mode === "auto") {
      const st = (await sbGet("cs_mine_state?select=*&id=eq.1"))[0];
      if (!st) return new Response(JSON.stringify({ error: "no cs_mine_state row" }), { status: 500, headers });

      if (st.stopped)
        return new Response(JSON.stringify({ mode: "auto", skipped: true, reason: st.stop_reason }), { headers });
      if (st.batches_run >= st.max_batches) {
        await sbPatchState({ stopped: true, stop_reason: "max_batches reached" });
        return new Response(JSON.stringify({ mode: "auto", stopped: true, reason: "max_batches reached" }), { headers });
      }

      try {
        const r = await runMap(st.last_start_time, 20);
        await sbPatchState({
          last_start_time: r.next_start_time ?? st.last_start_time,
          batches_run: st.batches_run + 1,
          last_error: null,
          ...(r.end_of_stream ? { stopped: true, stop_reason: "end of stream" } : {}),
        });
        return new Response(JSON.stringify({ mode: "auto", batch: st.batches_run + 1, ...r }, null, 2), { headers });
      } catch (err) {
        // Record and continue next tick — one bad page shouldn't end the run.
        await sbPatchState({
          batches_run: st.batches_run + 1,
          last_error: String((err as any)?.message ?? err).slice(0, 500),
        });
        return new Response(JSON.stringify({ mode: "auto", error: String((err as any)?.message ?? err) }), { status: 500, headers });
      }
    }

    /* ---------------- map (manual) ---------------- */
    if (mode === "map") {
      const limit = Math.min(Math.max(parseInt(body.limit ?? "20", 10) || 20, 1), 40);
      const startTime = parseInt(body.start_time ?? "0", 10) || 0;
      return new Response(JSON.stringify({ mode: "map", ...(await runMap(startTime, limit)) }, null, 2), { headers });
    }

    /* ---------------- reduce ---------------- */
    if (mode === "reduce") {
      const minLessons = parseInt(body.min_lessons ?? "3", 10) || 3;
      const maxSkus = Math.min(parseInt(body.max_skus ?? "3", 10) || 3, 10);

      const lessons = await sbGet("cs_raw_lessons?select=sku,category,problem,resolution&sku=not.is.null&limit=4000");
      const bySku: Record<string, any[]> = {};
      for (const l of lessons) (bySku[l.sku] ??= []).push(l);

      const already = await sbGet("cs_sku_knowledge?select=sku");
      const done = new Set(already.map((r: any) => r.sku));

      const targets = Object.entries(bySku)
        .filter(([sku, ls]) => (ls as any[]).length >= minLessons && !done.has(sku))
        .sort((a, b) => (b[1] as any[]).length - (a[1] as any[]).length)
        .slice(0, maxSkus);

      if (!targets.length) {
        return new Response(JSON.stringify({
          mode: "reduce", consolidated: 0,
          note: `no SKU has >= ${minLessons} un-consolidated lessons yet — run more map passes`,
          skus_with_lessons: Object.keys(bySku).length,
        }, null, 2), { headers });
      }

      const summary: any[] = [];
      for (const [sku, ls] of targets) {
        const list = ls as any[];
        const prompt = `SKU: ${sku}\n\nLESSONS:\n` +
          list.map((l: any, i: number) => `${i + 1}. [${l.category}] problem: ${l.problem} | resolution: ${l.resolution}`).join("\n");
        const out = await callClaude(REDUCE_SYSTEM, prompt, REDUCE_SCHEMA);
        const rules = (out.rules ?? []).map((r: any) => ({
          sku, symptom: r.symptom, root_cause: r.root_cause,
          resolution: r.resolution, ticket_count: r.ticket_count,
          confidence: "unreviewed",
        }));
        await sbInsert("cs_sku_knowledge", rules);
        summary.push({ sku, source_lessons: list.length, rules_written: rules.length });
      }

      return new Response(JSON.stringify({ mode: "reduce", consolidated: summary.length, summary }, null, 2), { headers });
    }

    return new Response(JSON.stringify({ error: `unknown mode: ${mode}` }), { status: 400, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as any)?.message ?? e) }), { status: 500, headers });
  }
});
