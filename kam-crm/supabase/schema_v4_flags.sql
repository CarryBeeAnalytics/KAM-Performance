-- ============================================================================
-- KAM CRM - Supabase schema v4 (additive, safe to re-run)
-- Data Intelligence & Research
--
-- 1. kam_flag_log     one row per merchant per flag per reporting day, so a
--                     flag that was not worked on its day is remembered and
--                     carried over instead of being lost or double counted.
--                       Worked       feedback saved on the flag's own day
--                       Worked Late  cleared on a later day (history kept)
--                       Not Worked   still pending; "carried over" once the
--                                    next reporting day arrives
-- 2. sync trigger     kam_daily_report is rewritten by the nightly KAMP job;
--                     a statement-level trigger records that day's flags as
--                     soon as the rows land, whether or not anyone opens the
--                     app that day. Failures only warn, so the job never
--                     breaks because of this.
-- 3. feedback_visit   free-text visit note (500-word limit, enforced in API).
-- 4. kam_targets      unlock / incentive may be NULL on a KAM or lead row so a
--                     blank cell in the bulk target sheet inherits the level
--                     above instead of forcing 100 / 2.
-- ============================================================================

-- 1. Flag log ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kam_flag_log (
    id             bigserial PRIMARY KEY,
    business_id    bigint NOT NULL,
    business_name  text NOT NULL DEFAULT '',
    kam_name       text NOT NULL DEFAULT '',
    lead_name      text NOT NULL DEFAULT '',
    reporting_date date NOT NULL,
    flag_type      text NOT NULL
                       CHECK (flag_type IN ('order_drop', 'call_followup', 'visit')),
    status         text NOT NULL DEFAULT 'Not Worked'
                       CHECK (status IN ('Worked', 'Worked Late', 'Not Worked')),
    worked_at      timestamptz,
    worked_by      text NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, reporting_date, flag_type)
);
CREATE INDEX IF NOT EXISTS idx_flag_log_kam
    ON public.kam_flag_log ((lower(btrim(kam_name))), reporting_date, status);
CREATE INDEX IF NOT EXISTS idx_flag_log_pending
    ON public.kam_flag_log (business_id) WHERE status = 'Not Worked';
ALTER TABLE public.kam_flag_log ENABLE ROW LEVEL SECURITY;

-- Same button rules as the Flag tab (server.js FLAG_SELECT).
CREATE OR REPLACE FUNCTION public.sync_kam_flag_log()
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    inserted integer;
BEGIN
    INSERT INTO kam_flag_log
        (business_id, business_name, kam_name, lead_name, reporting_date, flag_type)
    SELECT d.business_id, d.business_name, d.kam_name, d.lead_name,
           d.reporting_date, f.flag_type
    FROM kam_daily_report d
    CROSS JOIN LATERAL (VALUES
        ('order_drop',    d.order_gap_with_previous_day < 0),
        ('call_followup', d.last_order_date IS NOT NULL
                          AND d.reporting_date - d.last_order_date::date = 2),
        ('visit',         d.last_order_date IS NULL
                          OR d.reporting_date - d.last_order_date::date >= 3)
    ) AS f(flag_type, active)
    WHERE f.active
    ON CONFLICT (business_id, reporting_date, flag_type) DO NOTHING;
    GET DIAGNOSTICS inserted = ROW_COUNT;
    RETURN inserted;
END $$;

-- 2. Trigger ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_sync_kam_flag_log()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    BEGIN
        PERFORM sync_kam_flag_log();
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'kam_flag_log sync skipped: %', SQLERRM;
    END;
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS kam_flag_log_sync ON public.kam_daily_report;
CREATE TRIGGER kam_flag_log_sync
    AFTER INSERT OR UPDATE ON public.kam_daily_report
    FOR EACH STATEMENT EXECUTE FUNCTION public.trg_sync_kam_flag_log();

-- Seed with the current reporting day, then mark flags that already have
-- feedback for that day as Worked.
SELECT public.sync_kam_flag_log();

UPDATE public.kam_flag_log f
SET status = 'Worked', worked_at = x.updated_at, worked_by = x.created_by
FROM (
    SELECT business_id, reporting_date, 'order_drop' AS flag_type, updated_at, created_by
    FROM public.feedback_order_drop
    UNION ALL
    SELECT business_id, reporting_date, 'call_followup', updated_at, created_by
    FROM public.feedback_call_followup
    UNION ALL
    SELECT business_id, reporting_date, 'visit', updated_at, created_by
    FROM public.feedback_visit
) x
WHERE f.business_id = x.business_id
  AND f.reporting_date = x.reporting_date
  AND f.flag_type = x.flag_type
  AND f.status = 'Not Worked';

-- 3. Visit note -------------------------------------------------------------
ALTER TABLE public.feedback_visit
    ADD COLUMN IF NOT EXISTS comment text NOT NULL DEFAULT '';

-- 4. Target inheritance -----------------------------------------------------
ALTER TABLE public.kam_targets ALTER COLUMN unlock_threshold_pct DROP NOT NULL;
ALTER TABLE public.kam_targets ALTER COLUMN incentive_pct DROP NOT NULL;
