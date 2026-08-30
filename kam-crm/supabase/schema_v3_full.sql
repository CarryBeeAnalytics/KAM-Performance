-- ============================================================================
-- CarryBee KAM CRM - Supabase schema v3 (FULL / self-sufficient)
-- Data Intelligence & Research
--
-- Run this ONCE in the Supabase SQL editor. It works on an empty project and
-- on a project that already carries the v2 tables: every statement is
-- CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, or a guarded DO block.
--
-- WHY THIS FILE REPLACES schema_v3.sql
--   schema_v3.sql assumed the v2 tables already existed and went straight to
--   ALTER TABLE public.kam_daily_report, which fails with 42P01 on a project
--   that has never run the v2 job. Section 0 below creates the v2 base first,
--   so the v3 sections have something to alter.
--
-- STRUCTURE
--   0. v2 base tables      kam_daily_report, kam_dod(+monthly), promised order,
--                          retention target, app_users, feedback_*, alerts,
--                          weekly call log, daily summary, issue reasons
--   1. kam_team_directory  KAM -> Lead -> Team, the access-control source
--   2. kam_daily_report    acquisition_type (Organic / Hunt)
--   3. feedback_call_followup + widened kam_alerts.alert_type
--   4. kam_targets         admin-set New Sales / Incremental / Retention
--   5. kam_merchant_month  per-merchant monthly state behind every Home KPI
--   6. ba_*                Business Insights datasets for the whole book
--   7. Row Level Security
--
-- CONVENTIONS
--   - Every operational date is a Bangladesh calendar date derived from the
--     06:00-06:00 BD operational day, exactly as the source jobs compute it.
--   - Revenue = Final Fee: status 17 -> delivery_fee - discount; otherwise
--     delivery_fee + cod_fee - discount. Stored in taka.
--   - Money columns are numeric(20,2); never float.
--
-- ORDER OF OPERATIONS AFTER RUNNING THIS
--   1. this file
--   2. KAMP_merchant_information.py (with scripts/kamp_v3_patch.py applied)
--      -> fills kam_daily_report, kam_dod_monthly, kam_alerts
--   3. backend `npm run seed`  -> app_users
--   4. carrybee_business_insights.py -> kam_merchant_month + ba_*
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ============================================================================
-- 0. v2 BASE TABLES
--
-- These are owned by the KAMP job in normal operation. They are created here
-- so a fresh project can be brought up in one step and so the v3 sections
-- below have a table to alter. The definitions match KAMP's own
-- ensure_supabase_schema() exactly - if they ever diverge, KAMP wins, because
-- it is what actually writes the rows.
--
-- No foreign key points at kam_daily_report on purpose: the nightly job
-- deletes stale current-state rows, and feedback / alert history must survive
-- a merchant being reassigned or dropped.
-- ============================================================================

-- 0a. Current-state merchant book. One row per merchant, rewritten nightly.
CREATE TABLE IF NOT EXISTS public.kam_daily_report (
    business_id                 bigint PRIMARY KEY,
    business_name               text NOT NULL DEFAULT '',
    kam_name                    text NOT NULL DEFAULT '',
    lead_name                   text NOT NULL DEFAULT '',
    registration_date           timestamp,
    lifetime_order              bigint NOT NULL DEFAULT 0,
    lifetime_delivered          bigint NOT NULL DEFAULT 0,
    lifetime_returned           bigint NOT NULL DEFAULT 0,
    lifetime_active_days        integer NOT NULL DEFAULT 0,
    avg_order                   numeric(20, 2) NOT NULL DEFAULT 0,
    max_order_in_a_day          integer NOT NULL DEFAULT 0,
    potentiality                text NOT NULL DEFAULT '',
    last_order_date             timestamp,
    visit                       text NOT NULL DEFAULT '',
    last_day_order              bigint NOT NULL DEFAULT 0,
    last_7_day_order            bigint NOT NULL DEFAULT 0,
    risk                        text NOT NULL DEFAULT '',
    order_gap_with_previous_day bigint NOT NULL DEFAULT 0,
    reporting_date              date NOT NULL,
    refreshed_at                timestamptz NOT NULL DEFAULT now()
);

-- 0a-i. v2 column renames, for a project that ran an older KAMP build. Each
--       branch is a no-op once the column already carries its new name.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'kam_daily_report'
                 AND column_name = 'onboarded_date') THEN
        ALTER TABLE public.kam_daily_report
            RENAME COLUMN onboarded_date TO registration_date;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'kam_daily_report'
                 AND column_name = 'day_over_day_change') THEN
        ALTER TABLE public.kam_daily_report
            RENAME COLUMN day_over_day_change TO order_gap_with_previous_day;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'kam_daily_report'
                 AND column_name = 'report_date') THEN
        ALTER TABLE public.kam_daily_report
            RENAME COLUMN report_date TO reporting_date;
    END IF;

    -- The legacy wide kam_dod (day_01..day_30) cannot represent 28/29/31-day
    -- months or real date labels. kam_dod is fully rebuilt by every nightly
    -- run, so dropping the legacy shape loses nothing.
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'kam_dod'
                 AND column_name = 'day_01') THEN
        DROP TABLE public.kam_dod;
    END IF;
END $$;

-- 0b. Current-month DOD, day values keyed by real dates.
CREATE TABLE IF NOT EXISTS public.kam_dod (
    business_id    bigint PRIMARY KEY,
    business_name  text NOT NULL DEFAULT '',
    kam_name       text NOT NULL DEFAULT '',
    onboarded_date timestamp,
    report_month   date NOT NULL,
    -- {"2026-08-01": 5, "2026-08-02": 0, ...} - true month length preserved.
    day_values     jsonb NOT NULL DEFAULT '{}'::jsonb,
    active_days    integer NOT NULL DEFAULT 0,
    refreshed_at   timestamptz NOT NULL DEFAULT now()
);

-- 0c. Permanent month-by-month DOD archive. Upserted on every run keyed by
--     (business_id, report_month) and never deleted, so a finished month's
--     final state is already stored the moment the next month begins.
CREATE TABLE IF NOT EXISTS public.kam_dod_monthly (
    business_id    bigint NOT NULL,
    business_name  text NOT NULL DEFAULT '',
    kam_name       text NOT NULL DEFAULT '',
    onboarded_date timestamp,
    report_month   date NOT NULL,
    day_values     jsonb NOT NULL DEFAULT '{}'::jsonb,
    active_days    integer NOT NULL DEFAULT 0,
    refreshed_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, report_month)
);

-- 0d. Promised order, entered in the web app. Separate table so the nightly
--     current-state DELETE never wipes it.
CREATE TABLE IF NOT EXISTS public.merchant_promised_order (
    business_id    bigint PRIMARY KEY,
    business_name  text NOT NULL DEFAULT '',
    kam_name       text NOT NULL DEFAULT '',
    promised_order numeric(20, 2),
    updated_by     text NOT NULL DEFAULT '',
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- 0e. Legacy per-KAM retention target table. v3 reads targets from
--     kam_targets instead, but KAMP still writes this one, so it is kept.
CREATE TABLE IF NOT EXISTS public.kam_retention_target (
    kam_name                   text PRIMARY KEY,
    report_month               date NOT NULL,
    per_active_merchant_count  integer NOT NULL DEFAULT 0,
    curr_active_merchant_count integer NOT NULL DEFAULT 0,
    merchant_retention_pct     numeric(20, 6) NOT NULL DEFAULT 0,
    per_month_orders           bigint NOT NULL DEFAULT 0,
    per_month_rvn              numeric(20, 2) NOT NULL DEFAULT 0,
    curr_month_orders          bigint NOT NULL DEFAULT 0,
    curr_month_rvn             numeric(20, 2) NOT NULL DEFAULT 0,
    order_retention_pct        numeric(20, 6) NOT NULL DEFAULT 0,
    target                     numeric(20, 6),
    target_orders numeric(20, 2) GENERATED ALWAYS AS (
        CASE WHEN target IS NULL THEN NULL
             ELSE per_month_orders::numeric * (1 + target) END
    ) STORED,
    target_rvn numeric(20, 2) GENERATED ALWAYS AS (
        CASE WHEN target IS NULL THEN NULL
             ELSE per_month_rvn * (1 + target) END
    ) STORED,
    target_achievement_order bigint GENERATED ALWAYS AS (curr_month_orders) STORED,
    target_achievement_rvn numeric(20, 2) GENERATED ALWAYS AS (curr_month_rvn) STORED,
    achievement numeric(20, 6) GENERATED ALWAYS AS (
        CASE WHEN target IS NULL OR per_month_orders = 0 OR (1 + target) = 0
             THEN NULL
             ELSE curr_month_orders::numeric / (per_month_orders::numeric * (1 + target))
        END
    ) STORED,
    refreshed_at timestamptz NOT NULL DEFAULT now()
);

-- 0f. App users. Passwords are bcrypt hashes; seed with backend/seed_users.js.
CREATE TABLE IF NOT EXISTS public.app_users (
    id            bigserial PRIMARY KEY,
    username      text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    full_name     text NOT NULL,
    role          text NOT NULL CHECK (role IN ('kam', 'lead', 'admin')),
    -- For role 'kam' and 'lead' this must match kam_team_directory.kam_name.
    kam_name      text NOT NULL DEFAULT '',
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- 0g. Feedback tables. One editable entry per business per reporting date;
--     history is preserved because reporting_date is part of the key.
CREATE TABLE IF NOT EXISTS public.feedback_order_drop (
    id             bigserial PRIMARY KEY,
    business_id    bigint NOT NULL,
    business_name  text NOT NULL DEFAULT '',
    kam_name       text NOT NULL DEFAULT '',
    reporting_date date NOT NULL,
    comment        varchar(1000) NOT NULL,
    created_by     text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, reporting_date)
);
CREATE INDEX IF NOT EXISTS idx_fod_business ON public.feedback_order_drop (business_id);
CREATE INDEX IF NOT EXISTS idx_fod_kam      ON public.feedback_order_drop (kam_name);

CREATE TABLE IF NOT EXISTS public.feedback_visit (
    id               bigserial PRIMARY KEY,
    business_id      bigint NOT NULL,
    business_name    text NOT NULL DEFAULT '',
    kam_name         text NOT NULL DEFAULT '',
    reporting_date   date NOT NULL,
    call_record_link text NOT NULL DEFAULT '',
    visit_pic_link   text NOT NULL DEFAULT '',
    created_by       text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, reporting_date)
);
CREATE INDEX IF NOT EXISTS idx_fv_business ON public.feedback_visit (business_id);
CREATE INDEX IF NOT EXISTS idx_fv_kam      ON public.feedback_visit (kam_name);

CREATE TABLE IF NOT EXISTS public.feedback_issue (
    id             bigserial PRIMARY KEY,
    business_id    bigint NOT NULL,
    business_name  text NOT NULL DEFAULT '',
    kam_name       text NOT NULL DEFAULT '',
    reporting_date date NOT NULL,
    reason         text NOT NULL,
    comment        varchar(1000) NOT NULL DEFAULT '',
    created_by     text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, reporting_date)
);
CREATE INDEX IF NOT EXISTS idx_fi_business ON public.feedback_issue (business_id);
CREATE INDEX IF NOT EXISTS idx_fi_kam      ON public.feedback_issue (kam_name);

-- 0h. Issue reason dropdown; grows when a KAM types a new one.
CREATE TABLE IF NOT EXISTS public.issue_reasons (
    id         bigserial PRIMARY KEY,
    reason     text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.issue_reasons (reason) VALUES
    ('Pricing issue'),
    ('Delivery complaint'),
    ('Return rate concern'),
    ('COD payment delay'),
    ('Pickup delay'),
    ('Merchant switched courier'),
    ('Seasonal slowdown'),
    ('Stock unavailable')
ON CONFLICT (reason) DO NOTHING;

-- 0i. Alerts. Section 3 widens alert_type to include 'call_followup'.
CREATE TABLE IF NOT EXISTS public.kam_alerts (
    id             bigserial PRIMARY KEY,
    business_id    bigint NOT NULL,
    business_name  text NOT NULL DEFAULT '',
    kam_name       text NOT NULL DEFAULT '',
    reporting_date date NOT NULL,
    alert_type     text NOT NULL,
    alert_reason   text NOT NULL DEFAULT '',
    status         text NOT NULL DEFAULT 'Not Worked'
                       CHECK (status IN ('Worked', 'Not Worked')),
    worked_at      timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, reporting_date, alert_type)
);
CREATE INDEX IF NOT EXISTS idx_alerts_kam_status
    ON public.kam_alerts (kam_name, status);

-- 0j. Weekly call tracker. Weeks start Monday, Bangladesh time.
CREATE TABLE IF NOT EXISTS public.weekly_call_log (
    id            bigserial PRIMARY KEY,
    business_id   bigint NOT NULL,
    business_name text NOT NULL DEFAULT '',
    kam_name      text NOT NULL DEFAULT '',
    week_start    date NOT NULL,
    note          varchar(1000) NOT NULL DEFAULT '',
    drive_link    text NOT NULL DEFAULT '',
    status        text NOT NULL DEFAULT 'Not Worked'
                      CHECK (status IN ('Worked', 'Not Worked')),
    created_by    text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_wcl_kam_week
    ON public.weekly_call_log (kam_name, week_start);

-- 0k. Daily KAM summary snapshots, one row per KAM per reporting date.
CREATE TABLE IF NOT EXISTS public.kam_summary_daily (
    id                         bigserial PRIMARY KEY,
    kam_name                   text NOT NULL,
    reporting_date             date NOT NULL,
    active_merchant            integer NOT NULL DEFAULT 0,
    total_merchant             integer NOT NULL DEFAULT 0,
    active_merchant_pct        numeric(20, 6) NOT NULL DEFAULT 0,
    inactive_merchant          integer NOT NULL DEFAULT 0,
    total_order_present_month  bigint NOT NULL DEFAULT 0,
    total_order_previous_month bigint NOT NULL DEFAULT 0,
    todays_order               bigint NOT NULL DEFAULT 0,
    order_gap                  bigint NOT NULL DEFAULT 0,
    refreshed_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kam_name, reporting_date)
);

-- 0l. RLS on the v2 base. All app access goes through the Node backend on the
--     direct Postgres connection, which owns these tables and bypasses RLS;
--     the anon / authenticated PostgREST roles cannot read anything directly.
ALTER TABLE public.kam_daily_report        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kam_dod                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kam_dod_monthly         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merchant_promised_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kam_retention_target    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_order_drop     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_visit          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_issue          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.issue_reasons           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kam_alerts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_call_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kam_summary_daily       ENABLE ROW LEVEL SECURITY;


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
DECLARE
    con_name text;
BEGIN
    -- Drop ANY existing CHECK on kam_alerts.alert_type, whatever Postgres
    -- named it, then add the widened one. Looking the name up by table and
    -- column is what makes this safe on both a fresh project and one that
    -- already carries the v2 three-value constraint.
    FOR con_name IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'public.kam_alerts'::regclass
          AND c.contype = 'c'
          AND a.attname = 'alert_type'
    LOOP
        EXECUTE format('ALTER TABLE public.kam_alerts DROP CONSTRAINT %I', con_name);
    END LOOP;

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
-- (the v2 base tables were already covered in section 0l)
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
