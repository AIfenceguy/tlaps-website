-- 43_supabase_variation_schema.sql
-- TLAPS Variation Family schema extensions for the `products` table.
-- Adds parent/child columns + family_id + is_parent flag and a convenience view.
-- Idempotent: every ALTER uses IF NOT EXISTS so re-running is safe.

-- 1. Self-referencing parent SKU pointer.
--    Children point to their parent's tlaps_sku. NULL for parents and standalones.
ALTER TABLE products ADD COLUMN IF NOT EXISTS parent_tlaps_sku TEXT NULL REFERENCES products(tlaps_sku) ON DELETE SET NULL;

-- 2. Variation theme (Size, Color, Count, Pack). Set on both parent and children.
ALTER TABLE products ADD COLUMN IF NOT EXISTS variation_theme TEXT NULL;

-- 3. Variation value (e.g. "9 Inch", "125 Count", "Kraft").
--    Set on children only; parents and standalones leave NULL.
ALTER TABLE products ADD COLUMN IF NOT EXISTS variation_value TEXT NULL;

-- 4. Parent flag. TRUE for the parent placeholder row in each family.
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_parent BOOLEAN DEFAULT FALSE;

-- 5. Family ID (FAM-001 etc). Set on both parent and children of the same family;
--    NULL for standalone SKUs.
ALTER TABLE products ADD COLUMN IF NOT EXISTS family_id TEXT NULL;

-- Helpful partial indexes
CREATE INDEX IF NOT EXISTS idx_products_parent ON products(parent_tlaps_sku) WHERE parent_tlaps_sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_family ON products(family_id) WHERE family_id IS NOT NULL;

-- Convenience view: one row per variation family with child SKU array.
CREATE OR REPLACE VIEW v_variation_families AS
SELECT
  family_id,
  COUNT(*) FILTER (WHERE is_parent = false) AS child_count,
  MAX(CASE WHEN is_parent = true THEN tlaps_sku END) AS parent_sku,
  MAX(CASE WHEN is_parent = true THEN title END)     AS parent_title,
  MAX(variation_theme)                               AS variation_theme,
  ARRAY_AGG(tlaps_sku ORDER BY variation_value) FILTER (WHERE is_parent = false) AS child_skus,
  ARRAY_AGG(asin ORDER BY variation_value)      FILTER (WHERE is_parent = false) AS child_asins,
  ARRAY_AGG(variation_value ORDER BY variation_value) FILTER (WHERE is_parent = false) AS variation_values
FROM products
WHERE family_id IS NOT NULL
GROUP BY family_id
ORDER BY family_id;

-- Sanity-check query (run after upsert):
-- SELECT family_id, child_count, variation_theme, parent_sku FROM v_variation_families ORDER BY child_count DESC;

-- 6. Issues log (for internal corrections / audit trail). Used by script 46.
CREATE TABLE IF NOT EXISTS issues_log (
  id           BIGSERIAL PRIMARY KEY,
  asin         TEXT,
  tlaps_sku    TEXT,
  field        TEXT,
  old_value    TEXT,
  new_value    TEXT,
  note         TEXT,
  recorded_at  TIMESTAMPTZ DEFAULT NOW(),
  recorded_by  TEXT DEFAULT 'system'
);
CREATE INDEX IF NOT EXISTS idx_issues_log_asin ON issues_log(asin);
