-- ============================================================================
-- TLAPS / I3 Enterprise — Listing Completion View + (re-)apply box inventory
-- File: sql/07_completion_view.sql
-- Created: 2026-05-11
-- Spec: Define "listing complete" as the 6-criteria checklist from Ricky:
--   1. basic listing data done          -> asset_status.listing_done
--   2. AI comparison pictures added     -> asset_status.comparison_image
--   3. AI lifestyle picture added       -> asset_status.ai_lifestyle_1
--   4. AI 15-second video               -> asset_status.video_done
--   5. A+ page done                     -> asset_status.aplus_done
--   6. product reviews >= 10            -> listings.live_review_count >= 10
--
-- Idempotent. Run via Supabase SQL editor.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. (Re-)apply i3_warehouse_box_inventory in case it was missed earlier
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS i3_warehouse_box_inventory (
    id                      SERIAL PRIMARY KEY,
    dhg_sku                 TEXT        NOT NULL UNIQUE,
    tlaps_sku               TEXT        NOT NULL,
    retail_boxes_on_hand    INTEGER     NOT NULL DEFAULT 0
                              CHECK (retail_boxes_on_hand >= 0),
    last_counted_at         TIMESTAMPTZ,
    notes                   TEXT        DEFAULT '',
    updated_by              TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_box_inv_tlaps_sku ON i3_warehouse_box_inventory(tlaps_sku);

CREATE OR REPLACE FUNCTION i3_box_inv_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_box_inv_touch_updated_at ON i3_warehouse_box_inventory;
CREATE TRIGGER trg_box_inv_touch_updated_at
    BEFORE UPDATE ON i3_warehouse_box_inventory
    FOR EACH ROW EXECUTE FUNCTION i3_box_inv_touch_updated_at();

-- Seed for the 12 launched TLAPS SKUs at 0 boxes (will no-op if already seeded)
INSERT INTO i3_warehouse_box_inventory (dhg_sku, tlaps_sku, retail_boxes_on_hand, notes)
SELECT
    p.dhg_sku,
    p.tlaps_sku,
    0,
    'Auto-seeded from products table'
FROM products p
WHERE p.tlaps_sku LIKE 'TLAPS-%'
  AND p.status = 'live'
ON CONFLICT (dhg_sku) DO NOTHING;

-- Permissive RLS for now (matches existing pattern; tighten later)
ALTER TABLE i3_warehouse_box_inventory ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='i3_warehouse_box_inventory' AND policyname='box_inv_all_anon') THEN
        DROP POLICY box_inv_all_anon ON i3_warehouse_box_inventory;
    END IF;
END $$;
CREATE POLICY box_inv_all_anon ON i3_warehouse_box_inventory FOR ALL TO anon USING (true) WITH CHECK (true);

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='i3_warehouse_box_inventory' AND policyname='box_inv_all_auth') THEN
        DROP POLICY box_inv_all_auth ON i3_warehouse_box_inventory;
    END IF;
END $$;
CREATE POLICY box_inv_all_auth ON i3_warehouse_box_inventory FOR ALL TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON i3_warehouse_box_inventory TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE i3_warehouse_box_inventory_id_seq TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. v_sku_completion — the 6-criteria completion view
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_sku_completion AS
SELECT
    p.tlaps_sku,
    p.dhg_sku,
    p.asin,
    p.status,
    p.category,
    p.map_price,
    p.vc_cost,
    p.i3_cost,
    p.margin_pct_vc,
    p.cost_confirmed,
    -- six individual criteria, each NULL-safe
    COALESCE(a.listing_done,     FALSE) AS c1_basic_listing,
    COALESCE(a.comparison_image, FALSE) AS c2_comparison_image,
    COALESCE(a.ai_lifestyle_1,   FALSE) AS c3_lifestyle_image,
    COALESCE(a.video_done,       FALSE) AS c4_video,
    COALESCE(a.aplus_done,       FALSE) AS c5_aplus,
    (COALESCE(l.live_review_count, 0) >= 10) AS c6_reviews_min10,
    -- count how many criteria met (0..6)
    (
        (CASE WHEN COALESCE(a.listing_done, FALSE)            THEN 1 ELSE 0 END) +
        (CASE WHEN COALESCE(a.comparison_image, FALSE)        THEN 1 ELSE 0 END) +
        (CASE WHEN COALESCE(a.ai_lifestyle_1, FALSE)          THEN 1 ELSE 0 END) +
        (CASE WHEN COALESCE(a.video_done, FALSE)              THEN 1 ELSE 0 END) +
        (CASE WHEN COALESCE(a.aplus_done, FALSE)              THEN 1 ELSE 0 END) +
        (CASE WHEN COALESCE(l.live_review_count, 0) >= 10     THEN 1 ELSE 0 END)
    ) AS criteria_met,
    -- pct (0..100)
    ROUND(
      (
        (CASE WHEN COALESCE(a.listing_done, FALSE)            THEN 1 ELSE 0 END) +
        (CASE WHEN COALESCE(a.comparison_image, FALSE)        THEN 1 ELSE 0 END) +
        (CASE WHEN COALESCE(a.ai_lifestyle_1, FALSE)          THEN 1 ELSE 0 END) +
        (CASE WHEN COALESCE(a.video_done, FALSE)              THEN 1 ELSE 0 END) +
        (CASE WHEN COALESCE(a.aplus_done, FALSE)              THEN 1 ELSE 0 END) +
        (CASE WHEN COALESCE(l.live_review_count, 0) >= 10     THEN 1 ELSE 0 END)
      ) * 100.0 / 6
    , 1) AS completion_pct,
    -- fully complete?
    (
        COALESCE(a.listing_done, FALSE) AND
        COALESCE(a.comparison_image, FALSE) AND
        COALESCE(a.ai_lifestyle_1, FALSE) AND
        COALESCE(a.video_done, FALSE) AND
        COALESCE(a.aplus_done, FALSE) AND
        COALESCE(l.live_review_count, 0) >= 10
    ) AS is_complete,
    -- raw signals for the UI
    COALESCE(l.live_review_count, 0) AS live_review_count,
    a.product_image_count,
    l.gen_title,
    a.updated_at AS assets_updated_at,
    l.updated_at AS listing_updated_at
FROM products p
LEFT JOIN asset_status a ON a.tlaps_sku = p.tlaps_sku
LEFT JOIN listings l     ON l.tlaps_sku = p.tlaps_sku;

GRANT SELECT ON v_sku_completion TO anon, authenticated;

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- Per-SKU view (top 5 thinnest + bottom 5 most complete)
SELECT tlaps_sku, status, completion_pct, criteria_met,
       c1_basic_listing, c2_comparison_image, c3_lifestyle_image,
       c4_video, c5_aplus, c6_reviews_min10, live_review_count
  FROM v_sku_completion
 WHERE tlaps_sku LIKE 'TLAPS-%'
 ORDER BY completion_pct DESC NULLS LAST, tlaps_sku
 LIMIT 25;

-- Aggregated counts by completion bucket
SELECT
    CASE
        WHEN completion_pct = 100 THEN '100% (complete)'
        WHEN completion_pct >= 67 THEN '67-99% (near complete)'
        WHEN completion_pct >= 33 THEN '33-66% (in progress)'
        WHEN completion_pct >  0  THEN '1-32% (started)'
        ELSE '0% (untouched)'
    END AS bucket,
    COUNT(*) AS skus
FROM v_sku_completion
GROUP BY 1
ORDER BY MIN(completion_pct) DESC NULLS LAST;
