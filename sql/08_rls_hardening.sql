-- ============================================================================
-- TLAPS / I3 Enterprise — RLS hardening for public tables
-- File: sql/08_rls_hardening.sql
-- Created: 2026-05-12
-- Spec: Supabase Advisor flagged 4 public tables with RLS disabled. Enable RLS
--       and add permissive policies that match the existing pattern used by
--       i3_warehouse_box_inventory and products (anon + authenticated full
--       access). This closes the 4 Advisor warnings without changing portal
--       behavior. Tighten policies later when real auth is wired up.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. asset_status (365 rows — listing completion booleans)
-- ---------------------------------------------------------------------------
ALTER TABLE asset_status ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='asset_status' AND policyname='asset_status_all_anon') THEN
        DROP POLICY asset_status_all_anon ON asset_status;
    END IF;
END $$;
CREATE POLICY asset_status_all_anon ON asset_status FOR ALL TO anon USING (true) WITH CHECK (true);

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='asset_status' AND policyname='asset_status_all_auth') THEN
        DROP POLICY asset_status_all_auth ON asset_status;
    END IF;
END $$;
CREATE POLICY asset_status_all_auth ON asset_status FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 2. sku_upc_map (5 rows)
-- ---------------------------------------------------------------------------
ALTER TABLE sku_upc_map ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='sku_upc_map' AND policyname='sku_upc_map_all_anon') THEN
        DROP POLICY sku_upc_map_all_anon ON sku_upc_map;
    END IF;
END $$;
CREATE POLICY sku_upc_map_all_anon ON sku_upc_map FOR ALL TO anon USING (true) WITH CHECK (true);

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='sku_upc_map' AND policyname='sku_upc_map_all_auth') THEN
        DROP POLICY sku_upc_map_all_auth ON sku_upc_map;
    END IF;
END $$;
CREATE POLICY sku_upc_map_all_auth ON sku_upc_map FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 3. dhg_inventory (0 rows currently)
-- ---------------------------------------------------------------------------
ALTER TABLE dhg_inventory ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='dhg_inventory' AND policyname='dhg_inventory_all_anon') THEN
        DROP POLICY dhg_inventory_all_anon ON dhg_inventory;
    END IF;
END $$;
CREATE POLICY dhg_inventory_all_anon ON dhg_inventory FOR ALL TO anon USING (true) WITH CHECK (true);

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='dhg_inventory' AND policyname='dhg_inventory_all_auth') THEN
        DROP POLICY dhg_inventory_all_auth ON dhg_inventory;
    END IF;
END $$;
CREATE POLICY dhg_inventory_all_auth ON dhg_inventory FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 4. competitor_research (100 rows)
-- ---------------------------------------------------------------------------
ALTER TABLE competitor_research ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='competitor_research' AND policyname='comp_research_all_anon') THEN
        DROP POLICY comp_research_all_anon ON competitor_research;
    END IF;
END $$;
CREATE POLICY comp_research_all_anon ON competitor_research FOR ALL TO anon USING (true) WITH CHECK (true);

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='competitor_research' AND policyname='comp_research_all_auth') THEN
        DROP POLICY comp_research_all_auth ON competitor_research;
    END IF;
END $$;
CREATE POLICY comp_research_all_auth ON competitor_research FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
SELECT
    tablename,
    rowsecurity AS rls_enabled,
    (SELECT COUNT(*) FROM pg_policies pp WHERE pp.tablename = pt.tablename AND pp.schemaname='public') AS policy_count
FROM pg_tables pt
WHERE schemaname='public'
  AND tablename IN ('asset_status','sku_upc_map','dhg_inventory','competitor_research')
ORDER BY tablename;
