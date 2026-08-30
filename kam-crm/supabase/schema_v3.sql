-- ============================================================================
-- CarryBee KAM CRM - Supabase schema v3
-- Data Intelligence & Research
--
-- Run once in the Supabase SQL editor BEFORE deploying the v3 backend.
-- Everything here is idempotent and additive: no v2 table is dropped and no
-- v2 column is removed, so the current app keeps working until the new
-- backend is deployed.
--
-- WHAT v3 ADDS
--   1. kam_team_directory        KAM -> Lead -> Team. Sole source of truth for
--                                access scoping (replaces the hardcoded
--                                TEAM_LEADS dict inside the Python job).
--   2. kam_daily_report columns  acquisition_type (Organic / Hunt).
--   3. feedback_call_followup    the new Flag-tab Call FollowUp button.
--      kam_alerts.alert_type     extended with 'call_followup'; 'issue' is
--                                NO LONGER alert-generating (approved change).
--   4. kam_targets               admin-set revenue / incremental / retention
--                                targets and the New Sales unlock threshold.
--   5. kam_merchant_month        per-merchant monthly state that powers every
--                                Home KPI (classification, orders, revenue,
--                                discount, week/month/prev-month rollups).
--   6. ba_* tables               Business Insights: the five Top-Merchant
--                                dashboard datasets, for ALL KAM merchants,
--                                on a rolling 30-day window.
--
-- CONVENTIONS
--   - Every operational date is a Bangladesh calendar date derived from the
--     06:00-06:00 BD operational day, exactly as the source jobs compute it.
--   - Revenue = Final Fee per the standard rule: status 17 -> delivery_fee -
--     discount; otherwise delivery_fee + cod_fee - discount. Stored in taka.
--   - Money columns are numeric(20,2); never float.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. KAM -> Lead -> Team directory (access control source of truth)
--    A lead sees every KAM whose lead_name equals the lead's own kam_name.
--    Names are matched on kam_name_norm so 'MD Solayman Shadik Shady' and
--    'Md Solayman Shadik Shady' resolve to one person.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kam_team_directory (
    kam_name      text PRIMARY KEY,
    kam_name_norm text GENERATED ALWAYS AS (lower(btrim(regexp_replace(kam_name, '\s+', ' ', 'g')))) STORED,
    lead_name     text NOT NULL,
    team_name     text NOT NULL,
    is_active     boolean NOT NULL DEFAULT true,
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ktd_norm ON public.kam_team_directory (kam_name_norm);
CREATE INDEX IF NOT EXISTS idx_ktd_lead ON public.kam_team_directory (lower(btrim(lead_name)));

-- Approved mapping. Duplicated source rows are collapsed; casing variants of
-- the same person are folded into one canonical spelling.
INSERT INTO public.kam_team_directory (kam_name, lead_name, team_name) VALUES
    ('Ahmed Asif Rashid',        'Ahmed Asif Rashid',     'Team Rashid'),
    ('Md Solayman Shadik Shady', 'Ahmed Asif Rashid',     'Team Rashid'),
    ('Nuruzzaman Nahid',         'Ahmed Asif Rashid',     'Team Rashid'),
    ('Akash Saha',               'Akash Saha',            'Team Akash'),
    ('Md. Anik Ahamed',          'Akash Saha',            'Team Akash'),
    ('Abdul Goni Howlader',      'Akash Saha',            'Team Akash'),
    ('Md. Istiaque Ahamed',      'Akash Saha',            'Team Akash'),
    ('Jaber Al Aunto',           'Akash Saha',            'Team Akash'),
    ('Internal',                 'Akash Saha',            'Team Akash'),
    ('Md Komayel Hossain',       'Akash Saha',            'Team Akash'),
    ('Md Ibrahim Mojumder',      'Md Ibrahim Mojumder',   'Team Ibrahim'),
    ('Shabib Md Shahnawaj',      'Md Ibrahim Mojumder',   'Team Ibrahim'),
    ('Md. Asif Rayhan',          'Md. Asif Rayhan',       'Team Rayhan'),
    ('Tanvir Ahmmed',            'Md. Asif Rayhan',       'Team Rayhan'),
    ('Mubassir Ahmed Munim',     'Md. Asif Rayhan',       'Team Rayhan'),
    ('Md. Sahabul Alam',         'Sufian Ahmed',          'Organic'),
    ('SK Fardin Osi',            'Sufian Ahmed',          'Organic'),
    ('Md. Mahmudul Hasan',       'Sufian Ahmed',          'Organic'),
    ('Fayezul Islam Khan',       'Sufian Ahmed',          'Organic'),
    ('Mahmudul (Inbound)',       'Sufian Ahmed',          'Organic'),
    ('Sazzad Haider',            'Sufian Ahmed',          'Organic'),
    ('Nusrat Zahan',             'Sufian Ahmed',          'Organic'),
    ('MD Rakib Chowdhury',       'Sufian Ahmed',          'Organic'),
    ('Not Specified',            'Sufian Ahmed',          'Organic'),
    ('Raian Islam Rudra',        'Raian Islam Rudra',     'Team Rudra'),
    ('Rahul Roy',                'Raian Islam Rudra',     'Team Rudra'),
    ('Hasib Islam',              'Raian Islam Rudra',     'Team Rudra'),
    ('MD Sohel Rana',            'Raian Islam Rudra',     'Team Rudra'),
    ('Jubayer Rahman',           'Raian Islam Rudra',     'Team Rudra'),
    ('Rizvi Ahmed',              'Raian Islam Rudra',     'Team Rudra'),
    ('Shohanur Rahman Shuvo',    'Shohanur Rahman Shuvo', 'Team Shuvo'),
    ('S. M Shihab',              'Shohanur Rahman Shuvo', 'Team Shuvo'),
    ('MD.kayef Ahmed Shajib',    'Shohanur Rahman Shuvo', 'Team Shuvo')
ON CONFLICT (kam_name) DO UPDATE
    SET lead_name = EXCLUDED.lead_name,
        team_name = EXCLUDED.team_name,
        is_active = true,
        updated_at = now();


-- ----------------------------------------------------------------------------
-- 2. kam_daily_report additions
--    acquisition_type carries the Merchant Information "Type" column so the
--    Flag table can show Organic / Hunt without a second lookup.
-- ----------------------------------------------------------------------------
ALTER TABLE public.kam_daily_report
    ADD COLUMN IF NOT EXISTS acquisition_type text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_kdr_kam  ON public.kam_daily_report (lower(btrim(kam_name)));
CREATE INDEX IF NOT EXISTS idx_kdr_lead ON public.kam_daily_report (lower(btrim(lead_name)));


-- ----------------------------------------------------------------------------
-- 3. Flag tab: Call FollowUp feedback + alert type change
--    Approved rule split (no overlap):
--      order gap = 2 days at zero  -> Call FollowUp button only
--      order gap >= 3 days at zero -> Visit button only
--    Issue is always available and NEVER raises an alert; it only stores an
--    explanation, so 'issue' rows are no longer generated by the nightly job.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.feedback_call_followup (
    id               bigserial PRIMARY KEY,
    business_id      bigint NOT NULL,
    business_name    text NOT NULL DEFAULT '',
    kam_name         text NOT NULL DEFAULT '',
    reporting_date   date NOT NULL,
    call_record_link text NOT NULL DEFAULT '',
    comment          varchar(1000) NOT NULL DEFAULT '',
    created_by       text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, reporting_date)
);
CREATE INDEX IF NOT EXISTS idx_fcf_business ON public.feedback_call_followup (business_id);
CREATE INDEX IF NOT EXISTS idx_fcf_kam      ON public.feedback_call_followup (kam_name);

-- Extend the alert_type vocabulary. Dropping and re-adding the CHECK is the
-- only safe way to widen it; existing rows are all still valid values.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
               WHERE conname = 'kam_alerts_alert_type_check') THEN
        ALTER TABLE public.kam_alerts DROP CONSTRAINT kam_alerts_alert_type_check;
    END IF;
    ALTER TABLE public.kam_alerts
        ADD CONSTRAINT kam_alerts_alert_type_check
        CHECK (alert_type IN ('order_drop', 'call_followup', 'visit', 'issue'));
END $$;


-- ----------------------------------------------------------------------------
-- 4. Targets (Home tab). Admin-only writes, enforced in the backend.
--    scope_type 'global' applies to everyone; 'lead' and 'kam' override it.
--    Resolution order at read time: kam -> lead -> global.
--
--    target_revenue          NEW SALES revenue target for the month (taka)
--    unlock_threshold_pct    Achievement % that unlocks the incentive card
--    incentive_pct           the "2% of Current Revenue" rate (default 2)
--    incremental_target_pct  SAME STORE INCREMENTAL growth target (%)
--    retention_target_pct    SAME STORE RETENTION target (%)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kam_targets (
    scope_type             text NOT NULL CHECK (scope_type IN ('global', 'lead', 'kam')),
    scope_value            text NOT NULL DEFAULT '',
    report_month           date NOT NULL,
    target_revenue         numeric(20, 2),
    unlock_threshold_pct   numeric(9, 4) NOT NULL DEFAULT 100,
    incentive_pct          numeric(9, 4) NOT NULL DEFAULT 2,
    incremental_target_pct numeric(9, 4),
    retention_target_pct   numeric(9, 4),
    updated_by             text NOT NULL DEFAULT '',
    updated_at             timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scope_type, scope_value, report_month)
);


-- ----------------------------------------------------------------------------
-- 5. Per-merchant monthly state. Written by the nightly job; every Home KPI
--    and every New Sales / Incremental / Retention figure reads from here.
--
--    classification is mutually exclusive, priority New Onboard > Churn Win >
--    Existing > Inactive:
--      New Onboard  first qualifying processed order ever falls in this month
--      Churn Win    ordered this month, had prior history, and the gap between
--                   the last pre-month order and the first order this month
--                   is at least 30 days
--      Existing     at least one qualifying processed order this month
--      Inactive     no qualifying processed order this month
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kam_merchant_month (
    business_id             bigint NOT NULL,
    report_month            date NOT NULL,
    business_name           text NOT NULL DEFAULT '',
    kam_name                text NOT NULL DEFAULT '',
    lead_name               text NOT NULL DEFAULT '',
    acquisition_type        text NOT NULL DEFAULT '',
    orders_month            bigint NOT NULL DEFAULT 0,
    orders_prev_month       bigint NOT NULL DEFAULT 0,
    orders_last_week        bigint NOT NULL DEFAULT 0,
    orders_prev_day         bigint NOT NULL DEFAULT 0,
    active_days_month       integer NOT NULL DEFAULT 0,
    revenue_month           numeric(20, 2) NOT NULL DEFAULT 0,
    revenue_prev_month      numeric(20, 2) NOT NULL DEFAULT 0,
    discount_month          numeric(20, 2) NOT NULL DEFAULT 0,
    gross_fee_month         numeric(20, 2) NOT NULL DEFAULT 0,
    first_order_date        date,
    last_order_date         date,
    last_order_before_month date,
    first_order_in_month    date,
    churn_gap_days          integer,
    classification          text NOT NULL DEFAULT 'Inactive'
                                 CHECK (classification IN
                                     ('New Onboard', 'Churn Win', 'Existing', 'Inactive')),
    is_active_30d           boolean NOT NULL DEFAULT false,
    refreshed_at            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, report_month)
);
CREATE INDEX IF NOT EXISTS idx_kmm_month_kam
    ON public.kam_merchant_month (report_month, lower(btrim(kam_name)));
CREATE INDEX IF NOT EXISTS idx_kmm_month_lead
    ON public.kam_merchant_month (report_month, lower(btrim(lead_name)));


-- ----------------------------------------------------------------------------
-- 6. BUSINESS INSIGHTS (ba_*)
--    Same five datasets as the Top Merchant dashboard, but for every KAM
--    merchant and a rolling 30-day window. Written by
--    scripts/carrybee_business_insights.py.
--
--    kam_name / lead_name are denormalised onto every row so the backend can
--    scope a query without joining kam_daily_report (which the nightly job
--    rewrites), and so historical rows keep the assignment they were built
--    under.
-- ----------------------------------------------------------------------------

-- 6a. Sorted Cohort Summary: date x business daily KPIs.
CREATE TABLE IF NOT EXISTS public.ba_cohort_daily (
    report_date        date NOT NULL,
    business_id        bigint NOT NULL,
    business_name      text NOT NULL DEFAULT '',
    kam_name           text NOT NULL DEFAULT '',
    lead_name          text NOT NULL DEFAULT '',
    processed          bigint NOT NULL DEFAULT 0,
    delivered          bigint NOT NULL DEFAULT 0,
    returned           bigint NOT NULL DEFAULT 0,
    lost_damage        bigint NOT NULL DEFAULT 0,
    in_process         bigint NOT NULL DEFAULT 0,
    within_sla         bigint NOT NULL DEFAULT 0,
    sla_breached       bigint NOT NULL DEFAULT 0,
    collectable_amount numeric(20, 2) NOT NULL DEFAULT 0,
    collected_amount   numeric(20, 2) NOT NULL DEFAULT 0,
    delivery_fee       numeric(20, 2) NOT NULL DEFAULT 0,
    discount           numeric(20, 2) NOT NULL DEFAULT 0,
    cod_fee            numeric(20, 2) NOT NULL DEFAULT 0,
    final_fee          numeric(20, 2) NOT NULL DEFAULT 0,
    adjustment         numeric(20, 2) NOT NULL DEFAULT 0,
    revenue            numeric(20, 2) NOT NULL DEFAULT 0,
    overall_aging      numeric(20, 4) NOT NULL DEFAULT 0,
    refreshed_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (report_date, business_id)
);
CREATE INDEX IF NOT EXISTS idx_bacd_kam  ON public.ba_cohort_daily (lower(btrim(kam_name)), report_date);
CREATE INDEX IF NOT EXISTS idx_bacd_lead ON public.ba_cohort_daily (lower(btrim(lead_name)), report_date);

-- 6b. Forward Aging Analysis - Terminal (region x division x business).
CREATE TABLE IF NOT EXISTS public.ba_forward_terminal (
    report_date       date NOT NULL,
    business_id       bigint NOT NULL,
    delivery_region   text NOT NULL DEFAULT 'Unknown',
    delivery_division text NOT NULL DEFAULT 'Unknown',
    business_name     text NOT NULL DEFAULT '',
    kam_name          text NOT NULL DEFAULT '',
    lead_name         text NOT NULL DEFAULT '',
    b1 bigint NOT NULL DEFAULT 0,
    b2 bigint NOT NULL DEFAULT 0,
    b3 bigint NOT NULL DEFAULT 0,
    b4 bigint NOT NULL DEFAULT 0,
    b5 bigint NOT NULL DEFAULT 0,
    b6 bigint NOT NULL DEFAULT 0,
    b7 bigint NOT NULL DEFAULT 0,
    b7_plus bigint NOT NULL DEFAULT 0,
    total   bigint NOT NULL DEFAULT 0,
    refreshed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (report_date, business_id, delivery_region, delivery_division)
);
CREATE INDEX IF NOT EXISTS idx_baft_kam  ON public.ba_forward_terminal (lower(btrim(kam_name)), report_date);
CREATE INDEX IF NOT EXISTS idx_baft_lead ON public.ba_forward_terminal (lower(btrim(lead_name)), report_date);

-- 6c. Reverse Aging Analysis - Terminal (adds RID Type: Reverse | CR).
CREATE TABLE IF NOT EXISTS public.ba_reverse_terminal (
    report_date       date NOT NULL,
    business_id       bigint NOT NULL,
    rid_type          text NOT NULL DEFAULT 'Reverse',
    delivery_region   text NOT NULL DEFAULT 'Unknown',
    delivery_division text NOT NULL DEFAULT 'Unknown',
    business_name     text NOT NULL DEFAULT '',
    kam_name          text NOT NULL DEFAULT '',
    lead_name         text NOT NULL DEFAULT '',
    b1 bigint NOT NULL DEFAULT 0,
    b2 bigint NOT NULL DEFAULT 0,
    b3 bigint NOT NULL DEFAULT 0,
    b4 bigint NOT NULL DEFAULT 0,
    b5 bigint NOT NULL DEFAULT 0,
    b6 bigint NOT NULL DEFAULT 0,
    b7 bigint NOT NULL DEFAULT 0,
    b7_plus bigint NOT NULL DEFAULT 0,
    total   bigint NOT NULL DEFAULT 0,
    refreshed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (report_date, business_id, rid_type, delivery_region, delivery_division)
);
CREATE INDEX IF NOT EXISTS idx_bart_kam  ON public.ba_reverse_terminal (lower(btrim(kam_name)), report_date);
CREATE INDEX IF NOT EXISTS idx_bart_lead ON public.ba_reverse_terminal (lower(btrim(lead_name)), report_date);

-- 6d. FID In Process aggregate: snapshot date x business x status x bracket.
--     snapshot_date basis = COALESCE(sorted_at, created_at), BD local.
CREATE TABLE IF NOT EXISTS public.ba_fid_inprocess (
    snapshot_date date NOT NULL,
    business_id   bigint NOT NULL,
    system_status text NOT NULL DEFAULT 'Unknown',
    aging_bracket text NOT NULL DEFAULT 'Unknown',
    business_name text NOT NULL DEFAULT '',
    kam_name      text NOT NULL DEFAULT '',
    lead_name     text NOT NULL DEFAULT '',
    parcels       bigint NOT NULL DEFAULT 0,
    refreshed_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (snapshot_date, business_id, system_status, aging_bracket)
);
CREATE INDEX IF NOT EXISTS idx_bafid_kam  ON public.ba_fid_inprocess (lower(btrim(kam_name)), snapshot_date);
CREATE INDEX IF NOT EXISTS idx_bafid_lead ON public.ba_fid_inprocess (lower(btrim(lead_name)), snapshot_date);

-- 6e. RID In Process aggregate: adds RID Type (Reverse | CR).
CREATE TABLE IF NOT EXISTS public.ba_rid_inprocess (
    snapshot_date     date NOT NULL,
    business_id       bigint NOT NULL,
    rid_type          text NOT NULL DEFAULT 'Unknown',
    system_status     text NOT NULL DEFAULT 'Unknown',
    rid_aging_bracket text NOT NULL DEFAULT 'Unknown',
    business_name     text NOT NULL DEFAULT '',
    kam_name          text NOT NULL DEFAULT '',
    lead_name         text NOT NULL DEFAULT '',
    cids              bigint NOT NULL DEFAULT 0,
    refreshed_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (snapshot_date, business_id, rid_type, system_status, rid_aging_bracket)
);
CREATE INDEX IF NOT EXISTS idx_barid_kam  ON public.ba_rid_inprocess (lower(btrim(kam_name)), snapshot_date);
CREATE INDEX IF NOT EXISTS idx_barid_lead ON public.ba_rid_inprocess (lower(btrim(lead_name)), snapshot_date);

-- 6f. Parcel-level detail, kept so the Business Insights tab can export CSV.
--     Replaced wholesale on every run (current snapshot, not history).
CREATE TABLE IF NOT EXISTS public.ba_fid_detail (
    cid                        text PRIMARY KEY,
    business_id                bigint NOT NULL,
    business_name              text NOT NULL DEFAULT '',
    kam_name                   text NOT NULL DEFAULT '',
    lead_name                  text NOT NULL DEFAULT '',
    system_status              text NOT NULL DEFAULT '',
    attempt_count              integer NOT NULL DEFAULT 0,
    first_attempt_at           timestamp,
    attempt_status             text NOT NULL DEFAULT '',
    city_name                  text NOT NULL DEFAULT '',
    zone_name                  text NOT NULL DEFAULT '',
    weight                     numeric(20, 3),
    pickup_hub                 text NOT NULL DEFAULT '',
    pickup_division            text NOT NULL DEFAULT '',
    pickup_region              text NOT NULL DEFAULT '',
    delivery_hub               text NOT NULL DEFAULT '',
    delivery_division          text NOT NULL DEFAULT '',
    delivery_region            text NOT NULL DEFAULT '',
    created_at_bd              timestamp,
    sorted_at_bd               timestamp,
    lmh_at_bd                  timestamp,
    transfer_status_updated_bd timestamp,
    snapshot_date              date,
    aging_bracket              text NOT NULL DEFAULT '',
    first_attempt_aging        numeric(20, 4),
    refreshed_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bafd_kam ON public.ba_fid_detail (lower(btrim(kam_name)));
CREATE INDEX IF NOT EXISTS idx_bafd_biz ON public.ba_fid_detail (business_id);

CREATE TABLE IF NOT EXISTS public.ba_rid_detail (
    cid                        text PRIMARY KEY,
    rid_type                   text NOT NULL DEFAULT '',
    business_id                bigint NOT NULL,
    business_name              text NOT NULL DEFAULT '',
    kam_name                   text NOT NULL DEFAULT '',
    lead_name                  text NOT NULL DEFAULT '',
    system_status              text NOT NULL DEFAULT '',
    created_at_bd              timestamp,
    sorted_at_bd               timestamp,
    transfer_status_updated_bd timestamp,
    corresponding_fid          text NOT NULL DEFAULT '',
    fid_sorted_at_bd           timestamp,
    city_name                  text NOT NULL DEFAULT '',
    zone_name                  text NOT NULL DEFAULT '',
    weight                     numeric(20, 3),
    pickup_hub                 text NOT NULL DEFAULT '',
    pickup_division            text NOT NULL DEFAULT '',
    pickup_region              text NOT NULL DEFAULT '',
    delivery_hub               text NOT NULL DEFAULT '',
    delivery_division          text NOT NULL DEFAULT '',
    delivery_region            text NOT NULL DEFAULT '',
    snapshot_date              date,
    rid_aging_bracket          text NOT NULL DEFAULT '',
    entire_aging               numeric(20, 4),
    entire_aging_bracket       text NOT NULL DEFAULT '',
    refreshed_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bard_kam ON public.ba_rid_detail (lower(btrim(kam_name)));
CREATE INDEX IF NOT EXISTS idx_bard_biz ON public.ba_rid_detail (business_id);

-- 6g. Run log. The app reads window_start/window_end so the UI can state the
--     exact window a user is looking at instead of assuming "last 30 days".
CREATE TABLE IF NOT EXISTS public.ba_refresh_log (
    id            bigserial PRIMARY KEY,
    window_start  date NOT NULL,
    window_end    date NOT NULL,
    merchants     integer NOT NULL DEFAULT 0,
    cohort_rows   integer NOT NULL DEFAULT 0,
    fwd_rows      integer NOT NULL DEFAULT 0,
    rev_rows      integer NOT NULL DEFAULT 0,
    fid_rows      integer NOT NULL DEFAULT 0,
    rid_rows      integer NOT NULL DEFAULT 0,
    status        text NOT NULL DEFAULT 'ok',
    message       text NOT NULL DEFAULT '',
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz
);


-- ----------------------------------------------------------------------------
-- 7. RLS stays on for every new table. All app access goes through the Node
--    backend on the direct Postgres connection, which owns these tables and
--    therefore bypasses RLS; the anon/authenticated PostgREST roles cannot
--    read anything directly.
-- ----------------------------------------------------------------------------
ALTER TABLE public.kam_team_directory      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_call_followup  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kam_targets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kam_merchant_month      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ba_cohort_daily         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ba_forward_terminal     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ba_reverse_terminal     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ba_fid_inprocess        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ba_rid_inprocess        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ba_fid_detail           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ba_rid_detail           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ba_refresh_log          ENABLE ROW LEVEL SECURITY;
