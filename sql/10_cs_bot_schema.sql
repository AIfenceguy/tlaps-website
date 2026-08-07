-- ============================================================================
-- JL Zendesk CS Bot — phase 1 schema
-- File: sql/10_cs_bot_schema.sql
-- Created: 2026-08-05
-- Spec: Tables for the Zendesk CS bot. Draft-only: the bot posts suggested
--       replies as Zendesk internal notes; a human always sends.
--
--       Flow: edge function pulls tickets -> classifies -> looks up binder +
--       ERP -> one Claude call -> posts an internal note. Claude holds no
--       state; the binder tables below ARE the memory.
--
-- SECURITY NOTE — this differs from every other table in this project.
--   Customer tickets contain PII (names, addresses, order history). The
--   existing phase-1 pattern (anon can read everything) is NOT acceptable
--   here, because the anon key is published in portal.js.
--   RLS is enabled with NO anon or authenticated policy, so these tables are
--   reachable only by the service role, which lives in the edge function.
--   If a portal page is ever added, add a scoped policy then -- deliberately,
--   not by copying the old pattern.
--
-- Run once in the Supabase SQL editor (project poescwjdppbweqfdqcue).
-- NOTE: PostgreSQL has no CREATE POLICY IF NOT EXISTS -- see 08 for the
--       drop-then-create pattern if policies are added later.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. cs_tickets — the working queue. One row per Zendesk ticket we've seen.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cs_tickets (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    zendesk_id      bigint NOT NULL UNIQUE,
    marketplace     text,            -- 'ebay' | 'amazon' | null
    store_account   text,            -- which of the 6-7 stores (from support address)
    subject         text,
    body            text,            -- customer's message
    requester       text,            -- anonymized relay address; NOT a real email
    order_ref       text,            -- marketplace order no. parsed from body
    sales_order_code text,           -- resolved ERP SalesOrderCode, once matched
    sku             text,            -- resolved via order_ref -> ERP

    category        text,            -- order_status | fitment | install | return | ...
    routing         text NOT NULL DEFAULT 'unclassified'
                    CHECK (routing IN ('unclassified','auto_draft','human_only','no_draft')),
    money_flag      boolean NOT NULL DEFAULT false,

    draft_body      text,            -- what Claude suggested
    draft_posted_at timestamptz,     -- when it was pushed to Zendesk as a note
    outcome         text CHECK (outcome IN ('used_verbatim','edited','discarded')),

    zendesk_created_at timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cs_tickets_routing_idx     ON cs_tickets (routing);
CREATE INDEX IF NOT EXISTS cs_tickets_store_idx       ON cs_tickets (store_account);
CREATE INDEX IF NOT EXISTS cs_tickets_sku_idx         ON cs_tickets (sku);
CREATE INDEX IF NOT EXISTS cs_tickets_outcome_idx     ON cs_tickets (outcome);

-- ---------------------------------------------------------------------------
-- 2. cs_raw_lessons — MAP output. One row per closed ticket Claude read.
--    Intentionally messy and duplicative; step 3 consolidates it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cs_raw_lessons (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    zendesk_id      bigint,
    sku             text,
    category        text,
    problem         text,            -- what the customer actually had wrong
    resolution      text,            -- what the agent did that fixed it
    agent_reply     text,            -- verbatim, for voice/tone examples
    mined_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cs_raw_lessons_sku_idx      ON cs_raw_lessons (sku);
CREATE INDEX IF NOT EXISTS cs_raw_lessons_category_idx ON cs_raw_lessons (category);

-- ---------------------------------------------------------------------------
-- 3. cs_sku_knowledge — REDUCE output. The per-SKU binder.
--    This is what gets pasted into the prompt at runtime.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cs_sku_knowledge (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sku             text NOT NULL,
    symptom         text NOT NULL,   -- "bracket won't line up"
    ticket_count    int  NOT NULL DEFAULT 0,   -- how many tickets support this
    root_cause      text,
    resolution      text,
    confidence      text NOT NULL DEFAULT 'unreviewed'
                    CHECK (confidence IN ('unreviewed','confirmed','rejected')),
    active          boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One entry per (sku, symptom).
CREATE UNIQUE INDEX IF NOT EXISTS cs_sku_knowledge_uidx
    ON cs_sku_knowledge (sku, lower(symptom));
CREATE INDEX IF NOT EXISTS cs_sku_knowledge_active_idx
    ON cs_sku_knowledge (active, sku);

-- ---------------------------------------------------------------------------
-- 4. cs_playbooks — per-category handling rules. Same shape as
--    email_playbooks, which is already proven in the Email Center.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cs_playbooks (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text NOT NULL UNIQUE,
    category        text,
    trigger_hint    text,
    instructions    text NOT NULL,
    marketplace     text,            -- null = applies to all
    active          boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 5. cs_actions — audit trail. Every draft and every send.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cs_actions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id       uuid REFERENCES cs_tickets(id) ON DELETE SET NULL,
    zendesk_id      bigint,
    action          text NOT NULL,   -- drafted | note_posted | outcome_recorded
    detail          text,
    actor           text,            -- 'bot' or the agent's email
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cs_actions_ticket_idx ON cs_actions (ticket_id);

-- ---------------------------------------------------------------------------
-- 6. RLS — enabled with NO policies. Service role only (edge functions).
--    See the security note at the top before adding an anon policy.
-- ---------------------------------------------------------------------------
ALTER TABLE cs_tickets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_raw_lessons   ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_sku_knowledge ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_playbooks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_actions       ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ============================================================================
-- Verify (run after COMMIT):
--   SELECT table_name FROM information_schema.tables
--    WHERE table_name LIKE 'cs\_%' ORDER BY 1;      -- expect 5 rows
--
--   -- should return 0 rows: no anon/authenticated policies exist
--   SELECT tablename, policyname FROM pg_policies
--    WHERE tablename LIKE 'cs\_%';
-- ============================================================================
