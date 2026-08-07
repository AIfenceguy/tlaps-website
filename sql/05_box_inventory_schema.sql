-- ============================================================================
-- TLAPS / I3 Enterprise — Pablo's Retail-Box Inventory
-- File: sql/05_box_inventory_schema.sql
-- Created: 2026-05-11
-- Spec: dashboard feature — track retail boxes on hand in I3 warehouse so the
--       DHG PO flow can skip "request retail boxes from DHG" when Pablo
--       already has stock to repack.
--
-- Run inside the Supabase SQL Editor (project tlaps-prod / poescwjdppbweqfdqcue).
-- Idempotent — safe to re-run.
--
-- IMPORTANT: PostgreSQL does NOT support `CREATE POLICY IF NOT EXISTS`.
--            Policies are wrapped in DO $$ blocks that drop-then-create.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. i3_warehouse_box_inventory  — one row per TLAPS SKU
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS i3_warehouse_box_inventory (
    id                      SERIAL PRIMARY KEY,
    dhg_sku                 TEXT        NOT NULL UNIQUE,
    tlaps_sku               TEXT        NOT NULL,
    retail_boxes_on_hand    INTEGER     NOT NULL DEFAULT 0
                              CHECK (retail_boxes_on_hand >= 0),
    last_counted_at         TIMESTAMPTZ,
    notes                   TEXT        DEFAULT '',
    updated_by              TEXT,                     -- email of editor
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- FK to products.dhg_sku — soft FK; products is the master catalog.
-- The constraint is added only if both tables and column exist so this
-- migration stays runnable even before products is in place.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_name = 'products' AND column_name = 'dhg_sku'
    )
    AND NOT EXISTS (
        SELECT 1
          FROM information_schema.table_constraints
         WHERE constraint_name = 'i3_box_inv_dhg_sku_fk'
    ) THEN
        ALTER TABLE i3_warehouse_box_inventory
          ADD CONSTRAINT i3_box_inv_dhg_sku_fk
          FOREIGN KEY (dhg_sku) REFERENCES products(dhg_sku)
          ON UPDATE CASCADE
          ON DELETE RESTRICT;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_box_inv_tlaps_sku ON i3_warehouse_box_inventory(tlaps_sku);
CREATE INDEX IF NOT EXISTS idx_box_inv_last_counted ON i3_warehouse_box_inventory(last_counted_at);

-- ---------------------------------------------------------------------------
-- 2. updated_at auto-bump trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION i3_box_inv_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_box_inv_touch_updated_at ON i3_warehouse_box_inventory;
CREATE TRIGGER trg_box_inv_touch_updated_at
    BEFORE UPDATE ON i3_warehouse_box_inventory
    FOR EACH ROW EXECUTE FUNCTION i3_box_inv_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Seed: one row per launched TLAPS SKU at 0 boxes
-- ---------------------------------------------------------------------------
INSERT INTO i3_warehouse_box_inventory (dhg_sku, tlaps_sku, retail_boxes_on_hand, notes)
VALUES
    ('PP9PR',                  'TLAPS-8796009',             0, 'Seeded 2026-05-11'),
    ('B108W-P',                'TLAPS-PLTS-B108W-P',        0, 'Seeded 2026-05-11'),
    ('500-9pops',              'TLAPS-FOIL-500-9POPS',      0, 'Seeded 2026-05-11'),
    ('500-PM-S7WT245',         'TLAPS-STRW-500-PM-S7WT245', 0, 'Seeded 2026-05-11'),
    ('ft-25',                  'TLAPS-TRAY-FT-25',          0, 'Seeded 2026-05-11'),
    ('1PM-1212POPS',           'TLAPS-FOIL-1PM-1212POPS',   0, 'Seeded 2026-05-11'),
    ('PM-12POPS',              'TLAPS-FOIL-PM-12POPS',      0, 'Seeded 2026-05-11'),
    ('FOIL23',                 'TLAPS-FOIL-FOIL23',         0, 'Seeded 2026-05-11'),
    ('10-F4LBOP+FDLOPS4LB',    'TLAPS-CONT-10-F4LBOP',      0, 'Seeded 2026-05-11'),
    ('10PIZBR4C',              'TLAPS-PIZZA-10PIZBR4C',     0, 'Seeded 2026-05-11')
ON CONFLICT (dhg_sku) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Convenience view: join box inventory to products
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_box_inventory_with_product AS
SELECT
    bi.id,
    bi.dhg_sku,
    bi.tlaps_sku,
    bi.retail_boxes_on_hand,
    bi.last_counted_at,
    bi.notes,
    bi.updated_by,
    bi.updated_at,
    p.asin           AS asin,
    p.category       AS category,
    p.map_price      AS map_price
FROM i3_warehouse_box_inventory bi
LEFT JOIN products p ON p.dhg_sku = bi.dhg_sku;

-- ---------------------------------------------------------------------------
-- 5. RLS — gate via portal Supabase Auth
--    Policy: any authenticated user can read; any authenticated user can
--    upsert / update. (Pablo + Ricky only; portal_users table not yet wired,
--    so we keep policies broad now and tighten in a later migration.)
-- ---------------------------------------------------------------------------
ALTER TABLE i3_warehouse_box_inventory ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public'
                  AND tablename  = 'i3_warehouse_box_inventory'
                  AND policyname = 'box_inv_read_auth') THEN
        DROP POLICY box_inv_read_auth ON i3_warehouse_box_inventory;
    END IF;
END $$;

CREATE POLICY box_inv_read_auth
    ON i3_warehouse_box_inventory
    FOR SELECT
    TO authenticated
    USING (true);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public'
                  AND tablename  = 'i3_warehouse_box_inventory'
                  AND policyname = 'box_inv_write_auth') THEN
        DROP POLICY box_inv_write_auth ON i3_warehouse_box_inventory;
    END IF;
END $$;

CREATE POLICY box_inv_write_auth
    ON i3_warehouse_box_inventory
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- Also allow anon read for unauthenticated portal pages (the portal currently
-- uses a sessionStorage password gate, not Supabase Auth yet — so requests are
-- made with the anon key). Tighten this once Supabase Auth is live.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public'
                  AND tablename  = 'i3_warehouse_box_inventory'
                  AND policyname = 'box_inv_read_anon') THEN
        DROP POLICY box_inv_read_anon ON i3_warehouse_box_inventory;
    END IF;
END $$;

CREATE POLICY box_inv_read_anon
    ON i3_warehouse_box_inventory
    FOR SELECT
    TO anon
    USING (true);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public'
                  AND tablename  = 'i3_warehouse_box_inventory'
                  AND policyname = 'box_inv_write_anon') THEN
        DROP POLICY box_inv_write_anon ON i3_warehouse_box_inventory;
    END IF;
END $$;

CREATE POLICY box_inv_write_anon
    ON i3_warehouse_box_inventory
    FOR ALL
    TO anon
    USING (true)
    WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON i3_warehouse_box_inventory TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE i3_warehouse_box_inventory_id_seq TO anon, authenticated;
GRANT SELECT ON v_box_inventory_with_product TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Verification
-- ---------------------------------------------------------------------------
-- SELECT dhg_sku, tlaps_sku, retail_boxes_on_hand, last_counted_at, notes
--   FROM i3_warehouse_box_inventory
--  ORDER BY tlaps_sku;
