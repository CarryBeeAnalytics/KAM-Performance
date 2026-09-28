-- ============================================================================
-- KAM CRM - Supabase schema v5 (additive, safe to re-run)
-- Data Intelligence & Research
--
-- Per-merchant fields the Home tab's New Sales / Same Store sections read.
-- Written by KAMP_merchant_information.py (which also adds these columns
-- itself on every run), listed here so the schema is documented in the repo.
--
--   merchant_type     New Onboard / Churn Win / Existing / Inactive
--                     (first parcel or comeback on the 16th or later keeps
--                     the Type for the following month)
--   mtd_orders        orders from the 1st of the report month to the report day
--   prev_mtd_orders   orders on the same days of the previous month
--   mtd_revenue       revenue this month so far
--   prev_mtd_revenue  revenue on the same days of the previous month
-- ============================================================================

ALTER TABLE public.kam_daily_report
    ADD COLUMN IF NOT EXISTS merchant_type text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS mtd_orders bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS prev_mtd_orders bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS mtd_revenue numeric(20, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS prev_mtd_revenue numeric(20, 2) NOT NULL DEFAULT 0;
