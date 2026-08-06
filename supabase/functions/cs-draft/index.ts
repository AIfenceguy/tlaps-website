// cs-draft — the CS bot runtime path.
//
// Takes a Zendesk ticket, classifies it, and (when allowed) asks Claude for a
// suggested reply which is posted back as a PRIVATE INTERNAL NOTE.
//
// HARD GUARDRAILS — do not relax without Ricky's explicit say-so:
//   1. Every Zendesk write is public:false. A note can never reach a customer.
//   2. Returns / refunds / money / angry escalations are HUMAN ONLY — never drafted.
//   3. Platform cases (eBay/Amazon) are never drafted: they resolve in Seller Hub,
//      and an email reply burns the response clock without filing a case response.
//   4. Fitment is never ASSERTED. The bot may only ask qualifying questions.
//   5. dry_run:true (the default) returns the draft without touching Zendesk.
//
// Modes (POST { access_code, ticket_id, dry_run }):
//   dry_run true  (default) -> classify + draft, return JSON, write nothing
//   dry_run false           -> also post the draft as an internal note

const ZD_SUBDOMAIN = Deno.env.get("ZENDESK_SUBDOMAIN") ?? "";
const ZD_EMAIL     = Deno.env.get("ZENDESK_EMAIL") ?? "";
const ZD_TOKEN     = Deno.env.get("ZENDESK_TOKEN") ?? "";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ACCESS_CODE  = Deno.env.get("CS_ACCESS_CODE") || Deno.env.get("COPILOT_ACCESS_CODE") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MODEL        = Deno.env.get("CS_MODEL") ?? "claude-opus-5";

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

async function zd(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/${path}`, {
    ...init,
    headers: { Authorization: zdAuth(), "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Zendesk ${res.status} on ${path.split("?")[0]}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function sb(path: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/* ---------------- ChannelReply field mapping ----------------
 * Field IDs are per-account, so resolve them by NAME at runtime rather than
 * hardcoding. /ticket_fields.json is small and cached for the invocation.
 */
let fieldMap: Record<number, string> | null = null;
async function loadFieldMap(): Promise<Record<number, string>> {
  if (fieldMap) return fieldMap;
  const data = await zd("ticket_fields.json?per_page=200");
  const m: Record<number, string> = {};
  for (const f of data.ticket_fields ?? []) m[f.id] = (f.title ?? "").trim();
  fieldMap = m;
  return m;
}

function fieldsByName(customFields: any[], map: Record<number, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of customFields ?? []) {
    const name = map[f.id];
    if (name && f.value !== null && f.value !== "") out[name] = String(f.value);
  }
  return out;
}

/* ---------------- classification ----------------
 * Regex first: free, deterministic, auditable. The model is for writing,
 * not for deciding whether something is a refund request.
 */
const RX_MONEY    = /\b(refund|money back|reimburs|chargeback|charge back|credit me|pay(ing)? me back)\b/i;
const RX_RETURN   = /\b(return|rma|send it back|ship it back|restock)\b/i;
const RX_PLATFORM = /\b(a-to-z|a to z claim|case (id|#|opened|number)|opened a case|item not received case|ebay case|amazon claim|dispute)\b/i;
const RX_ANGRY    = /\b(worst|terrible|scam|ridiculous|furious|so mad|lawyer|sue you|negative feedback|bad feedback|report you)\b/i;
const RX_FITMENT  = /\b(fit|fits|fitment|compatible|will this work (on|with)|does this work (on|with))\b/i;
const RX_NOFIT    = /\b(does ?n[o']?t fit|doesn.t fit|won.t fit|wrong size|not the right|advertis(ed|ing) wrong|misleading)\b/i;
const RX_INSTALL  = /\b(install|instruction|bracket|hardware|bolt|screw|mount|assembl|line up|lines up)\b/i;
const RX_ORDER    = /\b(where is my order|tracking|ship(ped|ping)?|when will (it|my)|delivery|arrive|hasn.t (arrived|shipped))\b/i;

type Routing = "auto_draft" | "human_only" | "no_draft";

function classify(text: string): { category: string; routing: Routing; reason: string } {
  // Order matters. Most-restrictive wins.
  if (RX_PLATFORM.test(text))
    return { category: "platform_case", routing: "no_draft", reason: "resolve in Seller Hub / Seller Central, not by email" };
  if (RX_MONEY.test(text) || RX_RETURN.test(text))
    return { category: "return", routing: "human_only", reason: "money / return decision belongs to a human" };
  if (RX_NOFIT.test(text))
    return { category: "fitment_dispute", routing: "human_only", reason: "fitment complaint is one step from a return" };
  if (RX_ANGRY.test(text))
    return { category: "escalated", routing: "human_only", reason: "customer is escalated" };
  if (RX_FITMENT.test(text))
    return { category: "fitment", routing: "auto_draft", reason: "clarifying questions only — never asserts fit" };
  if (RX_ORDER.test(text))
    return { category: "order_status", routing: "auto_draft", reason: "answerable from ticket fields" };
  if (RX_INSTALL.test(text))
    return { category: "install", routing: "auto_draft", reason: "diagnostic questions" };
  return { category: "other", routing: "human_only", reason: "unrecognised — defaulting to human" };
}

const SYSTEM = `You draft customer service replies for JL Concepts, which sells truck and auto
accessories on eBay and Amazon under several store names.

You are drafting a SUGGESTION for a human agent. It is posted as an internal note; the agent
reads it, edits it, and decides whether to send. You are never talking to the customer directly.

Absolute rules:
- NEVER state or imply whether a part fits a vehicle. You do not have authoritative fitment data.
  You may only ask qualifying questions (exact year/make/model, cab and bed config, engine).
- NEVER promise, approve, or refuse a refund, return, discount, or replacement.
- NEVER invent an order number, tracking number, date, price, or specification. Use only the
  facts given to you below. If a fact is missing, say what you need rather than guessing.
- For Amazon: no URLs, no email addresses, no phone numbers. Amazon policy forbids them.

Style: short, plain, warm but not effusive. No "I hope this message finds you well". Get to the
point in the first sentence. Sign off as the store's support team. Return ONLY the reply body —
no subject line, no preamble, no markdown fences, no commentary.`;

async function callClaude(prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  if (data.stop_reason === "refusal") throw new Error("model declined to draft this");
  return (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = { ...cors(origin), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });

  try {
    const body = await req.json().catch(() => ({}));
    if (!ACCESS_CODE || body.access_code !== ACCESS_CODE)
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });
    if (!body.ticket_id)
      return new Response(JSON.stringify({ error: "ticket_id required" }), { status: 400, headers });

    const dryRun = body.dry_run !== false;   // default true — never writes unless told

    // 1. Pull the ticket + its conversation
    const [tRes, cRes, map] = await Promise.all([
      zd(`tickets/${body.ticket_id}.json`),
      zd(`tickets/${body.ticket_id}/comments.json`),
      loadFieldMap(),
    ]);
    const ticket = tRes.ticket;
    const comments = cRes.comments ?? [];
    const fields = fieldsByName(ticket.custom_fields, map);

    // 2. Classify on the customer's words only (public comments, not agent replies)
    const customerText = comments
      .filter((c: any) => c.public)
      .map((c: any) => c.body ?? "")
      .join("\n\n");
    const hay = `${ticket.subject ?? ""}\n${customerText}`;
    const { category, routing, reason } = classify(hay);

    // Store tag, e.g. ebay_gt-racers -> gt-racers
    const storeTag = (ticket.tags ?? []).find((t: string) => t.startsWith("ebay_") || t.startsWith("amazon_"));
    const marketplace = fields["Marketplace Channel"] ?? (storeTag?.startsWith("amazon") ? "Amazon" : "eBay");

    const base = {
      ticket_id: ticket.id, subject: ticket.subject, status: ticket.status,
      category, routing, reason, marketplace, store: storeTag ?? null,
      fields_present: Object.keys(fields),
    };

    if (routing !== "auto_draft") {
      return new Response(JSON.stringify({ ...base, drafted: false }, null, 2), { headers });
    }

    // 3. Pull matching guidance — playbook for the category, plus any mined
    //    SKU knowledge. Both are optional; the bot still works without them.
    const sku = fields["SKU"] ?? fields["Variation SKU"] ?? null;
    const [playbooks, skuKnowledge] = await Promise.all([
      sb(`cs_playbooks?select=name,instructions&active=is.true&or=(category.eq.${category},category.eq.marketplace_rules)`).catch(() => []),
      sku ? sb(`cs_sku_knowledge?select=symptom,root_cause,resolution,ticket_count&active=is.true&sku=eq.${encodeURIComponent(sku)}`).catch(() => []) : Promise.resolve([]),
    ]);

    // 4. Build the prompt. Everything the model knows comes from here.
    const factLines = Object.entries(fields)
      .filter(([k]) => !/email|phone|address|tax|paypal/i.test(k))   // keep PII out of the prompt
      .map(([k, v]) => `  ${k}: ${v}`).join("\n");

    const prompt = [
      `MARKETPLACE: ${marketplace}`,
      `CATEGORY: ${category}`,
      "",
      "ORDER FACTS (the only facts you may use — do not invent others):",
      factLines || "  (none — this ticket has no order data attached)",
      "",
      playbooks.length ? "HANDLING RULES:\n" + playbooks.map((p: any) => `- ${p.name}: ${p.instructions}`).join("\n\n") : "",
      "",
      skuKnowledge.length
        ? "KNOWN ISSUES FOR THIS SKU (from past tickets):\n" +
          skuKnowledge.map((k: any) => `- "${k.symptom}" (${k.ticket_count} tickets) -> cause: ${k.root_cause}; fix: ${k.resolution}`).join("\n")
        : "",
      "",
      "CUSTOMER MESSAGE:",
      customerText.slice(0, 4000),
      "",
      "Draft the reply.",
    ].filter(Boolean).join("\n");

    const draft = await callClaude(prompt);

    // 5. Post as an internal note — public:false is the safety property.
    let posted = false;
    if (!dryRun) {
      await zd(`tickets/${ticket.id}.json`, {
        method: "PUT",
        body: JSON.stringify({
          ticket: {
            comment: {
              body: `🤖 AI DRAFT — review before sending\n(category: ${category})\n\n${draft}`,
              public: false,          // NEVER true. See guardrail 1.
            },
          },
        }),
      });
      posted = true;
    }

    return new Response(
      JSON.stringify({ ...base, drafted: true, posted, dry_run: dryRun,
                       sku, knowledge_used: skuKnowledge.length, draft }, null, 2),
      { headers },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as any)?.message ?? e) }), { status: 500, headers });
  }
});
