-- Migration 06: VC Cost auto-sync columns
-- Adds vc_cost (scraped daily from Vendor Central) and i3_cost (what I3 pays
-- DHG, from first-10-items-JL-V2-May2026.xlsx column R), plus three computed
-- columns that drive the margin watchdog: net_to_i3, margin_pct, vc_cost_floor.
--
-- Idempotent: re-running this migration is safe. Plain columns use
-- ADD COLUMN IF NOT EXISTS. Generated columns use DROP-then-ADD so the
-- generation expression can be updated without manual schema surgery.
--
-- Key column for the seed UPDATEs is assumed to be products.tlaps_sku. If the
-- products table uses a different identifier (e.g. sku, product_sku), edit the
-- WHERE clauses below before applying.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Raw cost columns
-- ---------------------------------------------------------------------------
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS vc_cost NUMERIC(10,4);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS vc_cost_updated_at TIMESTAMPTZ;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS i3_cost NUMERIC(10,4);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS i3_cost_updated_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 2. Computed columns (drop-then-add so re-runs can change the formula)
-- ---------------------------------------------------------------------------

-- What I3 actually receives from Amazon after the standard 22% VC fee.
ALTER TABLE products DROP COLUMN IF EXISTS net_to_i3;
ALTER TABLE products
  ADD COLUMN net_to_i3 NUMERIC GENERATED ALWAYS AS (vc_cost * 0.78) STORED;

-- Margin against what I3 pays DHG (i3_cost). NULL if either input is missing
-- or vc_cost is zero, to avoid division-by-zero and false 0% margins on
-- unseeded rows.
ALTER TABLE products DROP COLUMN IF EXISTS margin_pct;
ALTER TABLE products
  ADD COLUMN margin_pct NUMERIC GENERATED ALWAYS AS (
    CASE
      WHEN vc_cost IS NULL OR vc_cost = 0 OR i3_cost IS NULL THEN NULL
      ELSE ((vc_cost * 0.78 - i3_cost) / (vc_cost * 0.78) * 100)
    END
  ) STORED;

-- Breakeven VC Cost: the minimum Amazon Cost before net_to_i3 dips below
-- i3_cost. Surfaces in the Margin tab as "you cannot accept a Cost below X".
ALTER TABLE products DROP COLUMN IF EXISTS vc_cost_floor;
ALTER TABLE products
  ADD COLUMN vc_cost_floor NUMERIC GENERATED ALWAYS AS (
    CASE WHEN i3_cost IS NULL THEN NULL ELSE (i3_cost / 0.78) END
  ) STORED;

-- ---------------------------------------------------------------------------
-- 3. Seed values for the 10 live SKUs
--    i3_cost: first-10-items-JL-V2-May2026.xlsx column R
--    vc_cost: Vendor Central "Manage your inventory" Cost column as of seed date
-- ---------------------------------------------------------------------------
UPDATE products SET i3_cost = 3.42,  i3_cost_updated_at = NOW(), vc_cost = 13.60, vc_cost_updated_at = NOW() WHERE tlaps_sku = 'TLAPS-8796009';
UPDATE products SET i3_cost = 4.00,  i3_cost_updated_at = NOW(), vc_cost = 13.50, vc_cost_updated_at = NOW() WHERE tlaps_sku = 'TLAPS-CONT-10-F4LBOP';
UPDATE products SET i3_cost = 3.00,  i3_cost_updated_at = NOW(), vc_cost = 14.58, vc_cost_updated_at = NOW() WHERE tlaps_sku = 'TLAPS-FOIL-FOIL23';
UPDATE products SET i3_cost = 9.41,  i3_cost_updated_at = NOW(), vc_cost = 20.50, vc_cost_updated_at = NOW() WHERE tlaps_sku = 'TLAPS-PLTS-B108W-P';
UPDATE products SET i3_cost = 7.97,  i3_cost_updated_at = NOW(), vc_cost = 19.70, vc_cost_updated_at = NOW() WHERE tlaps_sku = 'TLAPS-FOIL-500-9POPS';
UPDATE products SET i3_cost = 13.84, i3_cost_updated_at = NOW(), vc_cost = 33.84, vc_cost_updated_at = NOW() WHERE tlaps_sku = 'TLAPS-FOIL-1PM-1212POPS';
UPDATE products SET i3_cost = 10.98, i3_cost_updated_at = NOW(), vc_cost = 22.69, vc_cost_updated_at = NOW() WHERE tlaps_sku = 'TLAPS-FOIL-PM-12POPS';
UPDATE products SET i3_cost = 1.48,  i3_cost_updated_at = NOW(), vc_cost = 9.57,  vc_cost_updated_at = NOW() WHERE tlaps_sku = 'TLAPS-STRW-500-PM-S7WT245';
UPDATE products SET i3_cost = 8.80,  i3_cost_updated_at = NOW(), vc_cost = 27.30, vc_cost_updated_at = NOW() WHERE tlaps_sku = 'TLAPS-PIZZA-10PIZBR4C';
UPDATE products SET i3_cost = 10.00, i3_cost_updated_at = NOW(), vc_cost = 36.65, vc_cost_updated_at = NOW() WHERE tlaps_sku = 'TLAPS-TRAY-FT-25';

COMMIT;

-- ---------------------------------------------------------------------------
-- 4. Verification: list all 10 SKUs sorted by margin ascending (thinnest first)
-- ---------------------------------------------------------------------------
SELECT
  tlaps_sku,
  vc_cost,
  i3_cost,
  ROUND(net_to_i3,     2) AS net_to_i3,
  ROUND(margin_pct,    2) AS margin_pct,
  ROUND(vc_cost_floor, 2) AS vc_cost_floor
FROM products
WHERE tlaps_sku LIKE 'TLAPS-%'
ORDER BY margin_pct ASC NULLS LAST;
