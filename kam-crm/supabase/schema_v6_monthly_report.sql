-- ============================================================================
-- KAM CRM - Supabase schema v6 (additive, safe to re-run)
-- Data Intelligence & Research
--
-- kam_monthly_performance: one row per KAM per month with the Home tab's
-- New Sales / Same Store Incremental / Same Store Retention inputs, so every
-- month's result is kept after the month ends.
--
-- Filled by snapshot_kam_monthly_performance(), which KAMP calls after every
-- sync. Each run overwrites the rows of the month it reports on, so the last
-- run of a month leaves that month's final numbers; through_date records the
-- last day a row covers (e.g. a month whose last run reported the 29th reads
-- "through 29 Sep").
--
-- Only raw sums are stored. Percentages are derived when displayed, so Team /
-- Lead / All totals are exact sums of their KAMs' rows. lead_name and
-- team_name are copied from kam_team_directory at the time of the run, so a
-- KAM moving teams later does not rewrite history.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.kam_monthly_performance (
    report_month           date NOT NULL,
    kam_name               text NOT NULL,
    lead_name              text NOT NULL DEFAULT '',
    team_name              text NOT NULL DEFAULT '',
    through_date           date NOT NULL,
    merchants              integer NOT NULL DEFAULT 0,
    new_onboard            integer NOT NULL DEFAULT 0,
    churn_win              integer NOT NULL DEFAULT 0,
    total_orders           bigint NOT NULL DEFAULT 0,
    total_revenue          numeric(20, 2) NOT NULL DEFAULT 0,
    new_sales_revenue      numeric(20, 2) NOT NULL DEFAULT 0,
    -- targets as resolved for this KAM (kam -> lead -> global) at run time
    target_revenue         numeric(20, 2),
    unlock_threshold_pct   numeric(20, 4),
    incentive_pct          numeric(20, 4),
    incremental_target_pct numeric(20, 4),
    retention_target_pct   numeric(20, 4),
    -- same store incremental (Existing merchants that ordered on the same
    -- days of the previous month)
    ss_curr_orders         bigint NOT NULL DEFAULT 0,
    ss_prev_orders         bigint NOT NULL DEFAULT 0,
    ss_curr_revenue        numeric(20, 2) NOT NULL DEFAULT 0,
    ss_prev_revenue        numeric(20, 2) NOT NULL DEFAULT 0,
    -- same store retention
    base_merchants         integer NOT NULL DEFAULT 0,
    retained_merchants     integer NOT NULL DEFAULT 0,
    retention_orders       bigint NOT NULL DEFAULT 0,
    retention_revenue      numeric(20, 2) NOT NULL DEFAULT 0,
    refreshed_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (report_month, kam_name)
);
CREATE INDEX IF NOT EXISTS idx_kmp_kam
    ON public.kam_monthly_performance ((lower(btrim(kam_name))), report_month);
ALTER TABLE public.kam_monthly_performance ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.snapshot_kam_monthly_performance()
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    saved integer;
BEGIN
    WITH per_kam AS (
        SELECT
            date_trunc('month', d.reporting_date)::date AS report_month,
            btrim(d.kam_name) AS kam_name,
            MAX(d.reporting_date) AS through_date,
            MAX(d.lead_name) AS report_lead,
            COUNT(*) AS merchants,
            COUNT(*) FILTER (WHERE d.merchant_type = 'New Onboard') AS new_onboard,
            COUNT(*) FILTER (WHERE d.merchant_type = 'Churn Win') AS churn_win,
            COALESCE(SUM(d.mtd_orders), 0) AS total_orders,
            COALESCE(SUM(d.mtd_revenue), 0) AS total_revenue,
            COALESCE(SUM(d.mtd_revenue) FILTER (
                WHERE d.merchant_type IN ('New Onboard', 'Churn Win')), 0) AS new_sales_revenue,
            COALESCE(SUM(d.mtd_orders) FILTER (
                WHERE d.merchant_type = 'Existing' AND d.prev_mtd_orders > 0), 0) AS ss_curr_orders,
            COALESCE(SUM(d.prev_mtd_orders) FILTER (
                WHERE d.merchant_type = 'Existing' AND d.prev_mtd_orders > 0), 0) AS ss_prev_orders,
            COALESCE(SUM(d.mtd_revenue) FILTER (
                WHERE d.merchant_type = 'Existing' AND d.prev_mtd_orders > 0), 0) AS ss_curr_revenue,
            COALESCE(SUM(d.prev_mtd_revenue) FILTER (
                WHERE d.merchant_type = 'Existing' AND d.prev_mtd_orders > 0), 0) AS ss_prev_revenue,
            COUNT(*) FILTER (WHERE d.prev_mtd_orders > 0) AS base_merchants,
            COUNT(*) FILTER (WHERE d.prev_mtd_orders > 0 AND d.mtd_orders > 0) AS retained_merchants,
            COALESCE(SUM(d.mtd_orders) FILTER (
                WHERE d.prev_mtd_orders > 0 AND d.mtd_orders > 0), 0) AS retention_orders,
            COALESCE(SUM(d.mtd_revenue) FILTER (
                WHERE d.prev_mtd_orders > 0 AND d.mtd_orders > 0), 0) AS retention_revenue
        FROM kam_daily_report d
        WHERE btrim(d.kam_name) <> ''
        GROUP BY 1, 2
    ),
    with_directory AS (
        SELECT p.*,
               COALESCE(NULLIF(btrim(t.lead_name), ''), p.report_lead, '') AS lead_name,
               COALESCE(t.team_name, '') AS team_name
        FROM per_kam p
        LEFT JOIN kam_team_directory t
               ON lower(btrim(t.kam_name)) = lower(p.kam_name)
    )
    INSERT INTO kam_monthly_performance AS m (
        report_month, kam_name, lead_name, team_name, through_date,
        merchants, new_onboard, churn_win, total_orders, total_revenue,
        new_sales_revenue, target_revenue, unlock_threshold_pct, incentive_pct,
        incremental_target_pct, retention_target_pct,
        ss_curr_orders, ss_prev_orders, ss_curr_revenue, ss_prev_revenue,
        base_merchants, retained_merchants, retention_orders, retention_revenue,
        refreshed_at
    )
    SELECT
        w.report_month, w.kam_name, w.lead_name, w.team_name, w.through_date,
        w.merchants, w.new_onboard, w.churn_win, w.total_orders, w.total_revenue,
        w.new_sales_revenue,
        -- kam -> lead -> global, the same resolution as the Home tab.
        -- "No KAM" merchants have no owner, so no New Sales target.
        CASE WHEN lower(w.kam_name) = 'no kam' THEN NULL
             ELSE COALESCE(tk.target_revenue, tl.target_revenue, tg.target_revenue)
        END,
        COALESCE(tk.unlock_threshold_pct, tl.unlock_threshold_pct, tg.unlock_threshold_pct, 100),
        COALESCE(tk.incentive_pct, tl.incentive_pct, tg.incentive_pct, 2),
        COALESCE(tk.incremental_target_pct, tl.incremental_target_pct, tg.incremental_target_pct),
        COALESCE(tk.retention_target_pct, tl.retention_target_pct, tg.retention_target_pct),
        w.ss_curr_orders, w.ss_prev_orders, w.ss_curr_revenue, w.ss_prev_revenue,
        w.base_merchants, w.retained_merchants, w.retention_orders, w.retention_revenue,
        now()
    FROM with_directory w
    LEFT JOIN kam_targets tk
           ON tk.report_month = w.report_month AND tk.scope_type = 'kam'
          AND lower(btrim(tk.scope_value)) = lower(w.kam_name)
    LEFT JOIN kam_targets tl
           ON tl.report_month = w.report_month AND tl.scope_type = 'lead'
          AND lower(btrim(tl.scope_value)) = lower(btrim(w.lead_name))
    LEFT JOIN kam_targets tg
           ON tg.report_month = w.report_month AND tg.scope_type = 'global'
    ON CONFLICT (report_month, kam_name) DO UPDATE SET
        lead_name = EXCLUDED.lead_name,
        team_name = EXCLUDED.team_name,
        through_date = EXCLUDED.through_date,
        merchants = EXCLUDED.merchants,
        new_onboard = EXCLUDED.new_onboard,
        churn_win = EXCLUDED.churn_win,
        total_orders = EXCLUDED.total_orders,
        total_revenue = EXCLUDED.total_revenue,
        new_sales_revenue = EXCLUDED.new_sales_revenue,
        target_revenue = EXCLUDED.target_revenue,
        unlock_threshold_pct = EXCLUDED.unlock_threshold_pct,
        incentive_pct = EXCLUDED.incentive_pct,
        incremental_target_pct = EXCLUDED.incremental_target_pct,
        retention_target_pct = EXCLUDED.retention_target_pct,
        ss_curr_orders = EXCLUDED.ss_curr_orders,
        ss_prev_orders = EXCLUDED.ss_prev_orders,
        ss_curr_revenue = EXCLUDED.ss_curr_revenue,
        ss_prev_revenue = EXCLUDED.ss_prev_revenue,
        base_merchants = EXCLUDED.base_merchants,
        retained_merchants = EXCLUDED.retained_merchants,
        retention_orders = EXCLUDED.retention_orders,
        retention_revenue = EXCLUDED.retention_revenue,
        refreshed_at = now();
    GET DIAGNOSTICS saved = ROW_COUNT;
    RETURN saved;
END $$;

-- First snapshot from the data already loaded.
SELECT public.snapshot_kam_monthly_performance();
