-- Diagnostic queries for migration 06 collision investigation.
-- Run both in the tlaps-prod Supabase SQL editor and paste the full output back.
-- This file is read-only — it contains no DDL/DML, only SELECTs.

-- Query 1 — view definitions referencing products.net_to_i3
SELECT viewname, definition
FROM pg_views
WHERE viewname IN ('v_sku_dashboard', 'product_dashboard');

-- Query 2 — current cost data for the 10 live TLAPS SKUs
SELECT tlaps_sku, col_e, map_price, net_to_i3
FROM products
WHERE tlaps_sku LIKE 'TLAPS-%'
ORDER BY tlaps_sku;
