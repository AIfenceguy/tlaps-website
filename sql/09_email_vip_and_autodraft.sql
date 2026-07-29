-- ============================================================================
-- TLAPS Email Command Center — VIP inclusion list + proactive Claude drafts
-- File: sql/09_email_vip_and_autodraft.sql
-- Created: 2026-07-29
-- Spec: Two add-ons requested by Ricky (Jul 29 2026).
--
--   1. email_vip — user-editable "always include" list. Senders / domains /
--      keywords that must ALWAYS surface into the queue, checked BEFORE the
--      noise filter so a VIP can never be silently dropped. Replaces the
--      idea of a hardcoded RX_VIP regex (which was never actually in
--      email.js) with a table the owner can edit from the Settings modal.
--
--   2. email_queue.no_autodraft / draft_source — support for Claude
--      pre-generating a suggested reply on open. Platform cases (eBay /
--      Amazon, which are resolved in Seller Hub / Seller Central, not by
--      email) get opted out so we don't draft a reply that should never
--      be sent. draft_source records who wrote the draft.
--
-- Guardrails unchanged: drafts only, never auto-send; money decisions stay
-- with the human; the Anthropic key stays server-side in the edge function.
--
-- Run once in the Supabase SQL editor (project poescwjdppbweqfdqcue).
-- NOTE: PostgreSQL does not support CREATE POLICY IF NOT EXISTS — the DO
--       blocks below follow the same drop-then-create pattern as 08.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. email_vip — the "always include" list
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_vip (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        text NOT NULL CHECK (kind IN ('sender', 'domain', 'keyword')),
    value       text NOT NULL,
    label       text,
    category    text NOT NULL DEFAULT 'URGENT' CHECK (category IN ('URGENT', 'ACTION')),
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per (kind, value); case-insensitive so "Appsid@Amazon.com" and
-- "appsid@amazon.com" cannot both be added.
CREATE UNIQUE INDEX IF NOT EXISTS email_vip_kind_value_uidx
    ON email_vip (kind, lower(value));

CREATE INDEX IF NOT EXISTS email_vip_active_idx ON email_vip (active);

ALTER TABLE email_vip ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='email_vip' AND policyname='email_vip_all_anon') THEN
        DROP POLICY email_vip_all_anon ON email_vip;
    END IF;
END $$;
CREATE POLICY email_vip_all_anon ON email_vip FOR ALL TO anon USING (true) WITH CHECK (true);

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='email_vip' AND policyname='email_vip_all_auth') THEN
        DROP POLICY email_vip_all_auth ON email_vip;
    END IF;
END $$;
CREATE POLICY email_vip_all_auth ON email_vip FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 2. Seed the roster already in use as of Jul 29 2026
--    ON CONFLICT DO NOTHING so re-running this file is safe and does not
--    clobber edits made from the Settings modal.
-- ---------------------------------------------------------------------------
INSERT INTO email_vip (kind, value, label, category) VALUES
    -- People
    ('sender',  'contact.jlconcepts@gmail.com', 'Laura Chung — finance/AP, IZMO & Lee legal threads', 'URGENT'),
    ('sender',  'appsid@amazon.com',            'Appaiah — Amazon manager (Amazon Connect calls)',    'URGENT'),
    ('keyword', 'david nelson',                 'David Nelson — ERP developer/support',               'URGENT'),

    -- Amazon account-health topics
    ('keyword', 'account health',      'Amazon account health',            'URGENT'),
    ('keyword', 'health rating',       'Amazon account health rating',     'URGENT'),
    ('keyword', 'OTDR',                'On-time delivery rate',            'URGENT'),
    ('keyword', 'ODR',                 'Order defect rate',                'URGENT'),
    ('keyword', 'late shipment',       'Late shipment rate',               'URGENT'),
    ('keyword', 'late-shipment',       'Late shipment rate (hyphenated)',  'URGENT'),
    ('keyword', 'violation',           'Policy violation notice',          'URGENT'),
    ('keyword', 'listing removed',     'Listing removed',                  'URGENT'),
    ('keyword', 'listing suppressed',  'Listing suppressed',               'URGENT'),
    ('keyword', 'at risk',             'Account at risk',                  'URGENT'),
    ('keyword', 'at-risk',             'Account at risk (hyphenated)',     'URGENT'),
    ('keyword', 'deactivation',        'Account deactivation',             'URGENT'),
    ('keyword', 'suspension',          'Account suspension',               'URGENT'),

    -- Money / continuity notices, any account
    ('keyword', 'past due',            'Past due notice',                  'URGENT'),
    ('keyword', 'past-due',            'Past due notice (hyphenated)',     'URGENT'),
    ('keyword', 'collections',         'Collections notice',               'URGENT'),
    ('keyword', 'final notice',        'Final notice',                     'URGENT'),
    ('keyword', 'service disruption',  'Service disruption notice',        'URGENT'),
    ('keyword', 'service interruption','Service interruption notice',      'URGENT')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. email_queue — columns supporting proactive Claude drafts
-- ---------------------------------------------------------------------------

-- Per-item opt-out. Platform cases (eBay/Amazon) are resolved in Seller Hub /
-- Seller Central, not by replying to the notification email, so drafting an
-- email reply for them is worse than useless. email.js sets this automatically
-- when it detects a platform case, and the composer exposes a checkbox.
ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS no_autodraft boolean NOT NULL DEFAULT false;

-- 'claude' when the draft was pre-generated, 'human' once Ricky saves over it.
-- Lets the queue badge distinguish "Claude suggested this" from "I wrote this".
ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS draft_source text;

-- Which VIP rule pulled this in, if any (label text, for display + debugging).
ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS vip_reason text;

-- Queue rows are filtered by "has a draft" for the ✎ badge and the
-- "Draft all urgent" batch, so index the common lookup.
CREATE INDEX IF NOT EXISTS email_queue_autodraft_idx
    ON email_queue (status, no_autodraft);

COMMIT;

-- ============================================================================
-- Verify (run separately after COMMIT):
--   SELECT kind, count(*) FROM email_vip WHERE active GROUP BY kind;
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'email_queue'
--      AND column_name IN ('no_autodraft','draft_source','vip_reason');
-- ============================================================================
