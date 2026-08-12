-- ============================================================================
-- CarryBee KAM CRM - Supabase schema
-- Run once in the Supabase SQL editor (or psql) BEFORE the first web-app run.
-- The edited kamlk.py job also applies this DDL idempotently on every run,
-- so this file is the authoritative reference copy.
--
-- Existing tables owned by the kamlk.py job (current-state, refreshed daily):
--   kam_daily_report, kam_dod, kam_retention_target
-- This file:
--   1. Renames three kam_daily_report columns to the approved web-app names.
--   2. Creates the web-app tables (users, feedback, alerts, weekly calls,
--      daily summary snapshots).
--
-- Feedback tables intentionally have NO foreign key to kam_daily_report:
-- the nightly job deletes stale current-state rows, and feedback history
-- must survive merchant reassignment or removal (approved fix A7).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Column renames on kam_daily_report (safe to re-run)
-- ----------------------------------------------------------------------------
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
END $$;

-- ----------------------------------------------------------------------------
-- 2. App users (premade username/password login, MVM-dashboard pattern)
--    Passwords are bcrypt hashes; seed with backend/seed_users.js.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_users (
    id            bigserial PRIMARY KEY,
    username      text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    full_name     text NOT NULL,
    role          text NOT NULL CHECK (role IN ('kam', 'lead', 'admin')),
    -- For role = 'kam' this must EXACTLY match kam_daily_report.kam_name.
    kam_name      text NOT NULL DEFAULT '',
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 3. Feedback tables (one editable entry per business per reporting date;
--    full history preserved because reporting_date is part of the key)
-- ----------------------------------------------------------------------------
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

-- Dropdown of issue reasons; grows automatically when a KAM types a new one.
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

-- ----------------------------------------------------------------------------
-- 4. Alerts. Generated by the nightly kamlk.py job for every active-button
--    merchant whose KAM submitted no matching feedback for that reporting day.
--    Status flips to 'Worked' automatically when the feedback is submitted.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kam_alerts (
    id             bigserial PRIMARY KEY,
    business_id    bigint NOT NULL,
    business_name  text NOT NULL DEFAULT '',
    kam_name       text NOT NULL DEFAULT '',
    reporting_date date NOT NULL,
    alert_type     text NOT NULL CHECK (alert_type IN ('order_drop', 'visit', 'issue')),
    alert_reason   text NOT NULL DEFAULT '',
    status         text NOT NULL DEFAULT 'Not Worked'
                       CHECK (status IN ('Worked', 'Not Worked')),
    worked_at      timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, reporting_date, alert_type)
);
CREATE INDEX IF NOT EXISTS idx_alerts_kam_status
    ON public.kam_alerts (kam_name, status);

-- ----------------------------------------------------------------------------
-- 5. Weekly call tracker. Every KAM must call every assigned merchant at
--    least once per week (weeks start Monday, Bangladesh time). The app
--    upserts 'Worked' rows when a drive link is saved; the nightly job
--    backfills 'Not Worked' rows for every merchant missed in a completed
--    week, so non-compliance history is stored permanently.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.weekly_call_log (
    id            bigserial PRIMARY KEY,
    business_id   bigint NOT NULL,
    business_name text NOT NULL DEFAULT '',
    kam_name      text NOT NULL DEFAULT '',
    week_start    date NOT NULL,           -- Monday of the BD week
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

-- ----------------------------------------------------------------------------
-- 6. Daily KAM summary snapshots ("Summery Report" tab history).
--    One row per KAM per reporting date, upserted by the nightly job.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kam_summary_daily (
    id                        bigserial PRIMARY KEY,
    kam_name                  text NOT NULL,
    reporting_date            date NOT NULL,
    active_merchant           integer NOT NULL DEFAULT 0,
    total_merchant            integer NOT NULL DEFAULT 0,
    active_merchant_pct       numeric(20, 6) NOT NULL DEFAULT 0,
    inactive_merchant         integer NOT NULL DEFAULT 0,
    total_order_present_month bigint NOT NULL DEFAULT 0,
    total_order_previous_month bigint NOT NULL DEFAULT 0,
    todays_order              bigint NOT NULL DEFAULT 0,
    order_gap                 bigint NOT NULL DEFAULT 0,
    refreshed_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kam_name, reporting_date)
);

-- ----------------------------------------------------------------------------
-- 7. Row Level Security. All web-app access goes through the Node backend
--    using the direct Postgres connection (which bypasses RLS as table
--    owner). RLS stays enabled so the anon/authenticated PostgREST roles
--    cannot read anything directly.
-- ----------------------------------------------------------------------------
ALTER TABLE public.app_users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_order_drop ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_visit     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_issue     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.issue_reasons      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kam_alerts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_call_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kam_summary_daily  ENABLE ROW LEVEL SECURITY;
