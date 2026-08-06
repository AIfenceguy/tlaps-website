# CS Bot — Runbook

Zendesk → Claude → internal-note drafts for JL Concepts. Built 2026-08-06.

`YOUR_CODE` below = the `CS_ACCESS_CODE` you set in Supabase secrets.

---

## Do this first (about 5 minutes)

Everything else is already deployed and waiting on these two SQL files.

1. Open the [SQL editor](https://supabase.com/dashboard/project/poescwjdppbweqfdqcue/sql/new)
2. Paste and run `sql/10_cs_bot_schema.sql` — creates the five `cs_*` tables
3. Paste and run `sql/11_cs_playbooks_seed.sql` — seeds 8 handling rules
4. Confirm:

```powershell
Invoke-RestMethod -Uri "https://poescwjdppbweqfdqcue.supabase.co/functions/v1/cs-mine" -Method Post -ContentType "application/json" -Body '{"access_code":"YOUR_CODE","mode":"status"}' | ConvertTo-Json
```

Expect `playbooks: 8`, everything else 0.

---

## The three functions

| Function | Does | Writes to Zendesk? |
|---|---|---|
| `cs-zendesk` | read-only probe — count, export, sample, comments | No |
| `cs-mine` | builds the binder from closed tickets | No |
| `cs-draft` | classifies one ticket, drafts a reply | Only as an internal note, only when `dry_run:false` |

---

## Step 1 — See a draft (this is the beta test)

Start with dry run. Nothing is written anywhere.

```powershell
Invoke-RestMethod -Uri "https://poescwjdppbweqfdqcue.supabase.co/functions/v1/cs-draft" -Method Post -ContentType "application/json" -Body '{"access_code":"YOUR_CODE","ticket_id":555208,"dry_run":true}' | ConvertTo-Json -Depth 6
```

Ticket 555208 (the angry 50"/52" light bar one) **should come back `routing: "human_only"`, `drafted: false`** — it's a refund demand. If it drafts a reply, the guardrail is broken; stop and tell me.

Then try an open fitment or order-status ticket. Those should return `drafted: true` with a `draft` field.

When a draft looks right, post it for real:

```powershell
... -Body '{"access_code":"YOUR_CODE","ticket_id":NNNNNN,"dry_run":false}'
```

It lands as a **private internal note** prefixed `🤖 AI DRAFT — review before sending`. Customers never see it.

---

## Step 2 — Build the binder

Each `map` call reads ~20 closed tickets, extracts what broke and what fixed it, and stores the lessons. Run it in a loop — takes a while, costs a few dollars total.

```powershell
$code = "YOUR_CODE"
$start = 0
for ($i = 0; $i -lt 40; $i++) {
  $r = Invoke-RestMethod -Uri "https://poescwjdppbweqfdqcue.supabase.co/functions/v1/cs-mine" `
    -Method Post -ContentType "application/json" `
    -Body (@{access_code=$code; mode="map"; start_time=$start; limit=20} | ConvertTo-Json)
  "batch $i : mined $($r.mined), next $($r.next_start_time)"
  if ($r.end_of_stream) { "done"; break }
  $start = $r.next_start_time
}
```

Then consolidate per-SKU lessons into rules:

```powershell
Invoke-RestMethod -Uri "https://poescwjdppbweqfdqcue.supabase.co/functions/v1/cs-mine" -Method Post -ContentType "application/json" -Body '{"access_code":"YOUR_CODE","mode":"reduce","max_skus":5}' | ConvertTo-Json -Depth 6
```

Re-run `reduce` until it says nothing left. Then re-run a `cs-draft` on an install ticket — it should now cite known issues (`knowledge_used` > 0).

**Review what it mined.** Everything lands as `confidence: 'unreviewed'`. Spot-check in the table editor and set anything wrong to `'rejected'`:

```sql
select sku, symptom, root_cause, resolution, ticket_count
from cs_sku_knowledge order by ticket_count desc limit 40;
```

---

## Guardrails (in `cs-draft`, don't relax without deciding to)

1. Every Zendesk write is `public:false`. A draft cannot reach a customer.
2. Refunds / returns / money / angry customers → `human_only`, never drafted.
3. eBay & Amazon platform cases → `no_draft` (they resolve in Seller Hub; an email reply burns the response clock).
4. Fitment is never asserted — the bot may only ask qualifying questions.
5. Unrecognised category → defaults to `human_only`.
6. `dry_run` defaults to **true**.

---

## Known gaps

- **ERP join unsolved for eBay.** eBay orders sit in the ERP under an 8-digit ChannelAdvisor ID in `POCode`; ChannelReply doesn't expose that ID. Amazon joins fine (Amazon order ID → `POCode`). Bridge candidates: ChannelReply's `Tracking ID` ↔ `Shipment.TrackingNumber`, or the Rithum API.
- **ERP is unreachable from edge functions anyway** — they're cloud-hosted, `jl-sql` is LAN-only. Needs a tunnel or a synced slice if we ever want live ERP data at draft time.
- **No webhook yet.** Drafts are triggered manually per ticket. Add a Zendesk trigger → `cs-draft` once the drafts are trusted.
- **Token expires 2026-09-05**, and Zendesk kills API tokens entirely 2027-04-30 → OAuth migration owed.
- **No outcome logging yet.** `cs_tickets.outcome` exists but nothing writes it. That's the used/edited/discarded measurement that tells us whether this works — worth wiring before expanding scope.
