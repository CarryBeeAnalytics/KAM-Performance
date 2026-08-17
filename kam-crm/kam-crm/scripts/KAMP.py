"""
KAM merchant reports -> Google Sheets + Supabase (single job file).

This job keeps the existing KAM Daily Report, KAM DOD, and Retention & Target
calculations in one script. A normal run updates Google Sheets and mirrors the
same current state to Supabase. Supabase uses stable primary keys, so a
rerun updates existing merchants/KAMs; it does not append a new daily snapshot.

WEB-APP INTEGRATION (KAM CRM) -- changes in this version
--------------------------------------------------------
1. Approved column names (web-app spec):
     onboarded_date       -> registration_date
     day_over_day_change  -> order_gap_with_previous_day
     report_date          -> reporting_date
   The Google Sheet headers follow the same naming. A one-time rename
   migration runs automatically against an existing Supabase table.
2. New Visit logic (approved A3):
     days since last order >= 3            -> "Must visit"
     0 < days < 3                          -> "Call Mandatory"
     days <= 0 (ordered on the report day) -> "No need"
     never ordered                         -> "Must visit"
3. Alert generation: BEFORE the current-state sync overwrites yesterday's
   flags, every active-button merchant (order drop / visit / issue) whose KAM
   submitted no matching feedback for that reporting date gets a 'Not Worked'
   row in kam_alerts.
4. Weekly call tracker backfill: after the sync, every merchant with no
   weekly_call_log entry for the last COMPLETED Monday-start BD week gets a
   permanent 'Not Worked' row.
5. Daily summary snapshot: one row per KAM per reporting date is upserted
   into kam_summary_daily for the "Summery Report" tab history.
6. The web-app tables (app_users, feedback_*, kam_alerts, weekly_call_log,
   kam_summary_daily, issue_reasons) are created idempotently on every run.

Required project configuration
------------------------------
The existing CarryBee project must already provide its OMS, Pegasus, and
Google Sheets connections through ``src.utils``. Supabase credentials are read
from the project's existing .env/environment using either:

    SUPABASE_DB_URL

or the safer component variables (recommended when a password contains #/@):

    SUPABASE_DB_HOST
    SUPABASE_DB_PORT
    SUPABASE_DB_NAME
    SUPABASE_DB_USER
    SUPABASE_DB_PASSWORD

Run from the carrybee-automation project root:

    python -m src.jobs.kamlk --cutoff-date 2026-08-06
"""
from __future__ import annotations

import argparse
import calendar
import json
import os
import re
import secrets
import unicodedata
from decimal import Decimal, InvalidOperation
from datetime import date, datetime, time, timedelta, timezone
from typing import Dict, Iterable, List, Mapping, Sequence, Tuple

import pandas as pd
from dotenv import load_dotenv
from sqlalchemy import URL, bindparam, create_engine, text

from src.utils.db import get_engine
from src.utils.sheets_utils import get_gspread_client

# -----------------------------------------------------------------------------
# Report configuration
# -----------------------------------------------------------------------------
# Source and destination are intentionally separate workbooks.
DEFAULT_SOURCE_SHEET_ID = "1dWHU7B_odyTKYdZ__hQbuR7opVbtazuDaVJuoY92kjI"
DEFAULT_OUTPUT_SHEET_ID = "14EVQuLxFci-fKiaRnuMX_NRoiaWsi5M0o6dDz9gsbhk"
DEFAULT_SOURCE_TAB = "Updated KAM Merchant List"
DEFAULT_OUTPUT_TAB = "KAM Daily Report"
DEFAULT_DOD_TAB = "KAM DOD"
DEFAULT_RETENTION_TAB = "Retention & Target"

DEFAULT_HISTORY_START = date(2025, 2, 1)
DEFAULT_DOD_START = None
DEFAULT_DOD_END = None

SUPABASE_SCHEMA = "public"
SUPABASE_DAILY_TABLE = "kam_daily_report"
SUPABASE_DOD_TABLE = "kam_dod"
SUPABASE_DOD_MONTHLY_TABLE = "kam_dod_monthly"
SUPABASE_PROMISED_TABLE = "merchant_promised_order"
SUPABASE_RETENTION_TABLE = "kam_retention_target"
# Web-app tables written by this job.
SUPABASE_ALERTS_TABLE = "kam_alerts"
SUPABASE_WEEKLY_CALL_TABLE = "weekly_call_log"
SUPABASE_SUMMARY_TABLE = "kam_summary_daily"

SUPABASE_EXPECTED_PROJECT_REF = "wrlntwvgsjonvcxytocx"
SUPABASE_EXPECTED_HOST = "aws-0-ap-southeast-1.pooler.supabase.com"
SUPABASE_EXPECTED_PORT = 5432
SUPABASE_EXPECTED_DATABASE = "postgres"
SUPABASE_EXPECTED_USER = f"postgres.{SUPABASE_EXPECTED_PROJECT_REF}"

BD_TZ = timezone(timedelta(hours=6))

load_dotenv()

PROCESSED_STATUS_IDS: Tuple[int, ...] = (
    4, 7, 8, 9, 10, 11, 12, 13, 14,
    15, 16, 17, 18, 19, 20, 21, 22,
    35, 37, 38, 39,
)
# User-specified lifetime terminal definitions for this report.
DELIVERED_STATUS_IDS: Tuple[int, ...] = (15, 18, 21, 22)
RETURNED_STATUS_IDS: Tuple[int, ...] = (17,)
# User-specified terminal statuses for the Retention & Target RVN metrics.
RVN_STATUS_IDS: Tuple[int, ...] = (15, 17, 18, 21, 22, 32)

TEAM_LEADS: Dict[str, str] = {
    # Team 1
    "Md. Asif Rayhan": "Md. Asif Rayhan",
    "Tanvir Ahmmed": "Md. Asif Rayhan",
    "Mubassir Ahmed Munim": "Md. Asif Rayhan",
    # Team 2
    "Akash Saha": "Akash Saha",
    "Md. Istiaque Ahamed": "Akash Saha",
    "Md. Anik Ahamed": "Akash Saha",
    "Jaber Al Aunto": "Akash Saha",
    "Abdul Goni Howlader": "Akash Saha",
    # Team 3
    "Ahmed Asif Rashid": "Ahmed Asif Rashid",
    "Nuruzzaman Nahid": "Ahmed Asif Rashid",
    "Md. Solayman Shadik Shady": "Ahmed Asif Rashid",
    # Team 4
    "Shohanur Rahman Shuvo": "Shohanur Rahman Shuvo",
    "S. M Shihab": "Shohanur Rahman Shuvo",
    "Md. Kayef Ahmed": "Shohanur Rahman Shuvo",
    # Team 5
    "Raian Islam Rudra": "Raian Islam Rudra",
    "Rizvi Ahmed": "Raian Islam Rudra",
    "Md. Sohel Rana": "Raian Islam Rudra",
    "Hasib Islam": "Raian Islam Rudra",
    "Jubayer Rahman": "Raian Islam Rudra",
    "Rahul Roy": "Raian Islam Rudra",
    # Team 6
    "Md Ibrahim Mojumder": "Md Ibrahim Mojumder",
    "Shabib Md Shahnawaj": "Md Ibrahim Mojumder",
}

# Approved web-app column names (spec names). "Reporting Date" is now also a
# visible sheet column so the sheet mirrors kam_daily_report exactly.
OUTPUT_COLUMNS = [
    "Business_id",
    "Business_name",
    "KAM_name",
    "Lead_name",
    "Registration_date",
    "Lifetime_order",
    "Lifetime_delivered",
    "Lifetime_returned",
    "Lifetime_active_days",
    "Avg._order",
    "Max_order_in_a_day",
    "Potentiality",
    "Last_order_date",
    "Visit",
    "Last_day_order",
    "Last 7 day order",
    "Reporting Date",
    "Risk",
    "Order Gap with Previous Day",
]

RETENTION_COLUMNS = [
    "KAM name",
    "Per. Active merchant count",
    "Curr. Active merchant count",
    "Retention %",
    "Per. Month orders",
    "Per. Month RVN",
    "Curr. Month Orders",
    "Curr. Month RVN",
    "Retention %",
    "Target",
    "Target Orders",
    "Target RVN",
    "Target Achievement (order)",
    "Target Achievement (RVN)",
    "Achievement",
]


def normalize_name(value: object) -> str:
    """Normalize spacing/case for safe KAM-name matching."""
    if value is None:
        return ""
    return " ".join(str(value).strip().split()).casefold()


def normalize_header(value: object) -> str:
    """Normalize a Google Sheet header for tolerant matching."""
    if value is None:
        return ""
    text_value = str(value).replace("\u00a0", " ").replace("_", " ")
    return " ".join(text_value.strip().split()).casefold()


KAM_SOURCE_ALIASES = {
    "id": {"id", "business id"},
    "Business Name": {"business name"},
    "KAM": {"kam", "kam name"},
}


NORMALIZED_TEAM_LEADS = {
    normalize_name(member): lead
    for member, lead in TEAM_LEADS.items()
}


def bd_now() -> datetime:
    return datetime.now(timezone.utc).astimezone(BD_TZ)


def default_cutoff_date() -> date:
    """Return the date of the latest completed 06:00 BD boundary."""
    local_now = bd_now()
    if local_now.time() >= time(6, 0):
        return local_now.date()
    return local_now.date() - timedelta(days=1)


def parse_date(value: str) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            f"Invalid date '{value}'. Use YYYY-MM-DD."
        ) from exc


def fetch_df(engine, sql: str, params: dict, expanding: Iterable[str] = ()) -> pd.DataFrame:
    stmt = text(sql)
    for param_name in expanding:
        stmt = stmt.bindparams(bindparam(param_name, expanding=True))
    return pd.read_sql_query(stmt, con=engine, params=params)


def get_supabase_engine():
    """
    Create an engine for this exact Supabase project.

    Never fall back to the project's generic DATABASE_URL: that variable is
    normally the OMS/application database and previously allowed a successful
    sync message even though the Supabase project remained empty.
    """
    sslmode = os.getenv("SUPABASE_DB_SSLMODE", "require").strip() or "require"
    required = {
        "SUPABASE_DB_HOST": os.getenv("SUPABASE_DB_HOST", "").strip(),
        "SUPABASE_DB_PORT": os.getenv("SUPABASE_DB_PORT", "5432").strip(),
        "SUPABASE_DB_NAME": os.getenv("SUPABASE_DB_NAME", "postgres").strip(),
        "SUPABASE_DB_USER": os.getenv("SUPABASE_DB_USER", "").strip(),
        "SUPABASE_DB_PASSWORD": os.getenv("SUPABASE_DB_PASSWORD", ""),
    }
    component_names = (
        "SUPABASE_DB_HOST",
        "SUPABASE_DB_USER",
        "SUPABASE_DB_PASSWORD",
    )
    if all(required[name] for name in component_names):
        try:
            port = int(required["SUPABASE_DB_PORT"])
        except ValueError as exc:
            raise RuntimeError("SUPABASE_DB_PORT must be a number.") from exc
        url = URL.create(
            drivername="postgresql+psycopg2",
            username=required["SUPABASE_DB_USER"],
            password=required["SUPABASE_DB_PASSWORD"],
            host=required["SUPABASE_DB_HOST"],
            port=port,
            database=required["SUPABASE_DB_NAME"],
        )
    else:
        db_url = next(
            (
                os.getenv(name, "").strip()
                for name in (
                    "SUPABASE_DB_URL",
                    "SUPABASE_DATABASE_URL",
                )
                if os.getenv(name, "").strip()
            ),
            "",
        )
        if not db_url:
            missing = [
                name for name in component_names if not required[name]
            ]
            raise RuntimeError(
                "Missing Supabase configuration. Set SUPABASE_DB_URL or: "
                + ", ".join(missing)
            )
        if "#" in db_url:
            raise RuntimeError(
                "SUPABASE_DB_URL contains an unescaped '#'. Use the separate "
                "SUPABASE_DB_HOST/PORT/NAME/USER/PASSWORD variables so special "
                "password characters are handled safely."
            )
        if db_url.startswith("postgres://"):
            db_url = "postgresql+psycopg2://" + db_url[len("postgres://"):]
        elif db_url.startswith("postgresql://"):
            db_url = (
                "postgresql+psycopg2://"
                + db_url[len("postgresql://"):]
            )
        url = db_url

    engine = create_engine(
        url,
        pool_pre_ping=True,
        pool_recycle=300,
        connect_args={"sslmode": sslmode},
    )
    actual_host = (engine.url.host or "").casefold()
    actual_user = engine.url.username or ""
    actual_port = engine.url.port or 5432
    actual_database = engine.url.database or ""
    expected = (
        actual_host == SUPABASE_EXPECTED_HOST.casefold()
        and actual_user == SUPABASE_EXPECTED_USER
        and actual_port == SUPABASE_EXPECTED_PORT
        and actual_database == SUPABASE_EXPECTED_DATABASE
    )
    if not expected:
        engine.dispose()
        raise RuntimeError(
            "Supabase destination check failed. Refusing to create tables in "
            "the wrong database. Expected "
            f"{SUPABASE_EXPECTED_USER}@{SUPABASE_EXPECTED_HOST}:"
            f"{SUPABASE_EXPECTED_PORT}/{SUPABASE_EXPECTED_DATABASE}, but got "
            f"{actual_user or '<missing user>'}@{actual_host or '<missing host>'}:"
            f"{actual_port}/{actual_database or '<missing database>'}."
        )
    return engine


def verify_supabase_connection(engine) -> None:
    """Open a real connection and print the password-free destination."""
    with engine.connect() as connection:
        identity = connection.execute(
            text(
                """
                SELECT
                    current_database() AS database_name,
                    current_user AS database_user,
                    current_schema() AS schema_name
                """
            )
        ).mappings().one()
    if identity["database_name"] != SUPABASE_EXPECTED_DATABASE:
        raise RuntimeError(
            "Connected to an unexpected database: "
            f"{identity['database_name']!r}."
        )
    print(
        "Verified Supabase destination: "
        f"project={SUPABASE_EXPECTED_PROJECT_REF}, "
        f"host={engine.url.host}, port={engine.url.port or 5432}, "
        f"database={identity['database_name']}, "
        f"login={engine.url.username}, db_user={identity['database_user']}, "
        f"schema={identity['schema_name']}"
    )


def verify_supabase_tables(engine) -> None:
    """Confirm that all required tables are visible in public after DDL commit."""
    expected_tables = {
        SUPABASE_DAILY_TABLE,
        SUPABASE_DOD_TABLE,
        SUPABASE_DOD_MONTHLY_TABLE,
        SUPABASE_PROMISED_TABLE,
        SUPABASE_RETENTION_TABLE,
        SUPABASE_ALERTS_TABLE,
        SUPABASE_WEEKLY_CALL_TABLE,
        SUPABASE_SUMMARY_TABLE,
        "feedback_order_drop",
        "feedback_visit",
        "feedback_issue",
        "issue_reasons",
        "app_users",
    }
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                """
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = :schema_name
                  AND table_name = ANY(CAST(:table_names AS text[]))
                """
            ),
            {
                "schema_name": SUPABASE_SCHEMA,
                "table_names": sorted(expected_tables),
            },
        ).scalars().all()
    missing = expected_tables.difference(rows)
    if missing:
        raise RuntimeError(
            "Supabase table creation did not persist. Missing: "
            + ", ".join(sorted(missing))
        )
    print(
        "Supabase tables verified: "
        + ", ".join(
            f"{SUPABASE_SCHEMA}.{table_name}"
            for table_name in sorted(expected_tables)
        )
    )


def ensure_supabase_schema(engine) -> None:
    """
    Create the current-state tables, run the approved column-rename migration,
    and create every web-app table (all idempotent).
    """
    rename_migration = f"""
    DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = '{SUPABASE_SCHEMA}'
                     AND table_name = '{SUPABASE_DAILY_TABLE}'
                     AND column_name = 'onboarded_date') THEN
            ALTER TABLE {SUPABASE_SCHEMA}.{SUPABASE_DAILY_TABLE}
                RENAME COLUMN onboarded_date TO registration_date;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = '{SUPABASE_SCHEMA}'
                     AND table_name = '{SUPABASE_DAILY_TABLE}'
                     AND column_name = 'day_over_day_change') THEN
            ALTER TABLE {SUPABASE_SCHEMA}.{SUPABASE_DAILY_TABLE}
                RENAME COLUMN day_over_day_change TO order_gap_with_previous_day;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = '{SUPABASE_SCHEMA}'
                     AND table_name = '{SUPABASE_DAILY_TABLE}'
                     AND column_name = 'report_date') THEN
            ALTER TABLE {SUPABASE_SCHEMA}.{SUPABASE_DAILY_TABLE}
                RENAME COLUMN report_date TO reporting_date;
        END IF;
        -- Legacy KAM DOD redesign: the old wide table (day_01..day_30) cannot
        -- represent 28/29/31-day months or real date labels. kam_dod is a
        -- current-state table fully rebuilt by every run, so dropping the
        -- legacy shape is safe; the jsonb version is created right after.
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = '{SUPABASE_SCHEMA}'
                     AND table_name = '{SUPABASE_DOD_TABLE}'
                     AND column_name = 'day_01') THEN
            DROP TABLE {SUPABASE_SCHEMA}.{SUPABASE_DOD_TABLE};
        END IF;
    END $$;
    """
    ddl = f"""
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.{SUPABASE_DAILY_TABLE} (
        business_id bigint PRIMARY KEY,
        business_name text NOT NULL DEFAULT '',
        kam_name text NOT NULL DEFAULT '',
        lead_name text NOT NULL DEFAULT '',
        registration_date timestamp,
        lifetime_order bigint NOT NULL DEFAULT 0,
        lifetime_delivered bigint NOT NULL DEFAULT 0,
        lifetime_returned bigint NOT NULL DEFAULT 0,
        lifetime_active_days integer NOT NULL DEFAULT 0,
        avg_order numeric(20, 2) NOT NULL DEFAULT 0,
        max_order_in_a_day integer NOT NULL DEFAULT 0,
        potentiality text NOT NULL DEFAULT '',
        last_order_date timestamp,
        visit text NOT NULL DEFAULT '',
        last_day_order bigint NOT NULL DEFAULT 0,
        last_7_day_order bigint NOT NULL DEFAULT 0,
        risk text NOT NULL DEFAULT '',
        order_gap_with_previous_day bigint NOT NULL DEFAULT 0,
        reporting_date date NOT NULL,
        refreshed_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.{SUPABASE_DOD_TABLE} (
        business_id bigint PRIMARY KEY,
        business_name text NOT NULL DEFAULT '',
        kam_name text NOT NULL DEFAULT '',
        onboarded_date timestamp,
        report_month date NOT NULL,
        -- One key per real business date: {{"2026-08-01": 5, "2026-08-02": 0}}.
        -- The web app renders keys as "Aug 1", "Aug 2", ... so every month
        -- carries its true 28/29/30/31-day length.
        day_values jsonb NOT NULL DEFAULT '{{}}'::jsonb,
        active_days integer NOT NULL DEFAULT 0,
        refreshed_at timestamptz NOT NULL DEFAULT now()
    );

    -- Permanent month-by-month archive. Upserted on every run keyed by
    -- (business_id, report_month): when a new month starts, the finished
    -- month's final state is already stored here and is never deleted.
    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.{SUPABASE_DOD_MONTHLY_TABLE} (
        business_id bigint NOT NULL,
        business_name text NOT NULL DEFAULT '',
        kam_name text NOT NULL DEFAULT '',
        onboarded_date timestamp,
        report_month date NOT NULL,
        day_values jsonb NOT NULL DEFAULT '{{}}'::jsonb,
        active_days integer NOT NULL DEFAULT 0,
        refreshed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, report_month)
    );

    -- Promised order per merchant, entered by KAM/Lead in the web app.
    -- Separate table so the nightly current-state DELETE never wipes it.
    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.{SUPABASE_PROMISED_TABLE} (
        business_id bigint PRIMARY KEY,
        business_name text NOT NULL DEFAULT '',
        kam_name text NOT NULL DEFAULT '',
        promised_order numeric(20, 2),
        updated_by text NOT NULL DEFAULT '',
        updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.{SUPABASE_RETENTION_TABLE} (
        kam_name text PRIMARY KEY,
        report_month date NOT NULL,
        per_active_merchant_count integer NOT NULL DEFAULT 0,
        curr_active_merchant_count integer NOT NULL DEFAULT 0,
        merchant_retention_pct numeric(20, 6) NOT NULL DEFAULT 0,
        per_month_orders bigint NOT NULL DEFAULT 0,
        per_month_rvn numeric(20, 2) NOT NULL DEFAULT 0,
        curr_month_orders bigint NOT NULL DEFAULT 0,
        curr_month_rvn numeric(20, 2) NOT NULL DEFAULT 0,
        order_retention_pct numeric(20, 6) NOT NULL DEFAULT 0,
        target numeric(20, 6),
        target_orders numeric(20, 2) GENERATED ALWAYS AS (
            CASE
                WHEN target IS NULL THEN NULL
                ELSE per_month_orders::numeric * (1 + target)
            END
        ) STORED,
        target_rvn numeric(20, 2) GENERATED ALWAYS AS (
            CASE
                WHEN target IS NULL THEN NULL
                ELSE per_month_rvn * (1 + target)
            END
        ) STORED,
        target_achievement_order bigint GENERATED ALWAYS AS (
            curr_month_orders
        ) STORED,
        target_achievement_rvn numeric(20, 2) GENERATED ALWAYS AS (
            curr_month_rvn
        ) STORED,
        achievement numeric(20, 6) GENERATED ALWAYS AS (
            CASE
                WHEN target IS NULL
                  OR per_month_orders = 0
                  OR (1 + target) = 0
                THEN NULL
                ELSE curr_month_orders::numeric
                     / (per_month_orders::numeric * (1 + target))
            END
        ) STORED,
        refreshed_at timestamptz NOT NULL DEFAULT now()
    );

    -- ------------------------------------------------------------------
    -- Web-app tables (KAM CRM). No FK to kam_daily_report on purpose:
    -- feedback/alert history must survive the stale-row DELETE below.
    -- ------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.app_users (
        id bigserial PRIMARY KEY,
        username text NOT NULL UNIQUE,
        password_hash text NOT NULL,
        full_name text NOT NULL,
        role text NOT NULL CHECK (role IN ('kam', 'lead', 'admin')),
        kam_name text NOT NULL DEFAULT '',
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.feedback_order_drop (
        id bigserial PRIMARY KEY,
        business_id bigint NOT NULL,
        business_name text NOT NULL DEFAULT '',
        kam_name text NOT NULL DEFAULT '',
        reporting_date date NOT NULL,
        comment varchar(1000) NOT NULL,
        created_by text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (business_id, reporting_date)
    );

    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.feedback_visit (
        id bigserial PRIMARY KEY,
        business_id bigint NOT NULL,
        business_name text NOT NULL DEFAULT '',
        kam_name text NOT NULL DEFAULT '',
        reporting_date date NOT NULL,
        call_record_link text NOT NULL DEFAULT '',
        visit_pic_link text NOT NULL DEFAULT '',
        created_by text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (business_id, reporting_date)
    );

    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.feedback_issue (
        id bigserial PRIMARY KEY,
        business_id bigint NOT NULL,
        business_name text NOT NULL DEFAULT '',
        kam_name text NOT NULL DEFAULT '',
        reporting_date date NOT NULL,
        reason text NOT NULL,
        comment varchar(1000) NOT NULL DEFAULT '',
        created_by text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (business_id, reporting_date)
    );

    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.issue_reasons (
        id bigserial PRIMARY KEY,
        reason text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.{SUPABASE_ALERTS_TABLE} (
        id bigserial PRIMARY KEY,
        business_id bigint NOT NULL,
        business_name text NOT NULL DEFAULT '',
        kam_name text NOT NULL DEFAULT '',
        reporting_date date NOT NULL,
        alert_type text NOT NULL CHECK (alert_type IN ('order_drop', 'visit', 'issue')),
        alert_reason text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'Not Worked'
            CHECK (status IN ('Worked', 'Not Worked')),
        worked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (business_id, reporting_date, alert_type)
    );

    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.{SUPABASE_WEEKLY_CALL_TABLE} (
        id bigserial PRIMARY KEY,
        business_id bigint NOT NULL,
        business_name text NOT NULL DEFAULT '',
        kam_name text NOT NULL DEFAULT '',
        week_start date NOT NULL,
        note varchar(1000) NOT NULL DEFAULT '',
        drive_link text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'Not Worked'
            CHECK (status IN ('Worked', 'Not Worked')),
        created_by text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (business_id, week_start)
    );

    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.{SUPABASE_SUMMARY_TABLE} (
        id bigserial PRIMARY KEY,
        kam_name text NOT NULL,
        reporting_date date NOT NULL,
        active_merchant integer NOT NULL DEFAULT 0,
        total_merchant integer NOT NULL DEFAULT 0,
        active_merchant_pct numeric(20, 6) NOT NULL DEFAULT 0,
        inactive_merchant integer NOT NULL DEFAULT 0,
        total_order_present_month bigint NOT NULL DEFAULT 0,
        total_order_previous_month bigint NOT NULL DEFAULT 0,
        todays_order bigint NOT NULL DEFAULT 0,
        order_gap bigint NOT NULL DEFAULT 0,
        refreshed_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (kam_name, reporting_date)
    );

    ALTER TABLE {SUPABASE_SCHEMA}.{SUPABASE_DAILY_TABLE}
        ENABLE ROW LEVEL SECURITY;
    ALTER TABLE {SUPABASE_SCHEMA}.{SUPABASE_DOD_TABLE}
        ENABLE ROW LEVEL SECURITY;
    ALTER TABLE {SUPABASE_SCHEMA}.{SUPABASE_RETENTION_TABLE}
        ENABLE ROW LEVEL SECURITY;
    ALTER TABLE {SUPABASE_SCHEMA}.app_users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE {SUPABASE_SCHEMA}.feedback_order_drop ENABLE ROW LEVEL SECURITY;
    ALTER TABLE {SUPABASE_SCHEMA}.feedback_visit ENABLE ROW LEVEL SECURITY;
    ALTER TABLE {SUPABASE_SCHEMA}.feedback_issue ENABLE ROW LEVEL SECURITY;
    ALTER TABLE {SUPABASE_SCHEMA}.issue_reasons ENABLE ROW LEVEL SECURITY;
    ALTER TABLE {SUPABASE_SCHEMA}.{SUPABASE_ALERTS_TABLE} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE {SUPABASE_SCHEMA}.{SUPABASE_WEEKLY_CALL_TABLE} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE {SUPABASE_SCHEMA}.{SUPABASE_SUMMARY_TABLE} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE {SUPABASE_SCHEMA}.{SUPABASE_DOD_MONTHLY_TABLE} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE {SUPABASE_SCHEMA}.{SUPABASE_PROMISED_TABLE} ENABLE ROW LEVEL SECURITY;
    """
    with engine.begin() as connection:
        # The migration runs first so the legacy wide kam_dod is dropped
        # before CREATE TABLE IF NOT EXISTS builds the jsonb version.
        connection.execute(text(rename_migration))
        connection.execute(text(ddl))
    verify_supabase_tables(engine)


def username_base(full_name: str) -> str:
    """Build a deterministic, URL/login-safe username from a person's name."""
    ascii_name = unicodedata.normalize("NFKD", full_name).encode(
        "ascii", "ignore"
    ).decode("ascii")
    username = re.sub(r"[^a-z0-9]+", ".", ascii_name.casefold()).strip(".")
    return username or "kam.user"


def sync_app_user_directory(engine, kam_df: pd.DataFrame) -> dict:
    """
    Ensure every KAM represented in the current merchant assignment has an
    active app_users row, which is what the CRM uses to build its KAM selector.

    Existing password hashes and admin accounts are never overwritten. A new
    account receives KAM_APP_DEFAULT_PASSWORD when configured. Otherwise it
    receives a strong random password that is intentionally not printed; an
    administrator can reset that account before giving it to the KAM.
    """
    kam_names = sorted(
        {
            " ".join(str(value).strip().split())
            for value in kam_df["KAM_name"].tolist()
            if str(value).strip() and str(value).strip().casefold() != "nan"
        },
        key=str.casefold,
    )
    if not kam_names:
        print("App-user directory sync: no nonblank KAM names found.")
        return {"created": 0, "updated": 0}

    normalized_leads = {
        normalize_name(lead_name) for lead_name in TEAM_LEADS.values()
    }
    configured_password = os.getenv("KAM_APP_DEFAULT_PASSWORD", "").strip()
    initial_password = configured_password or secrets.token_urlsafe(48)

    select_existing = text(
        f"""
        SELECT id, username, full_name, role, kam_name
        FROM {SUPABASE_SCHEMA}.app_users
        ORDER BY id
        """
    )
    update_existing = text(
        f"""
        UPDATE {SUPABASE_SCHEMA}.app_users
        SET
            full_name = CASE WHEN role = 'admin' THEN full_name ELSE :full_name END,
            role = CASE WHEN role = 'admin' THEN role ELSE :role END,
            kam_name = CASE WHEN role = 'admin' THEN kam_name ELSE :kam_name END,
            is_active = TRUE
        WHERE id = :id
        """
    )
    insert_new = text(
        f"""
        INSERT INTO {SUPABASE_SCHEMA}.app_users (
            username, password_hash, full_name, role, kam_name, is_active
        )
        VALUES (
            :username,
            crypt(:initial_password, gen_salt('bf', 10)),
            :full_name,
            :role,
            :kam_name,
            TRUE
        )
        """
    )

    created = 0
    updated = 0
    created_usernames: List[str] = []
    with engine.begin() as connection:
        existing_rows = connection.execute(select_existing).mappings().all()
        usernames_in_use = {
            str(row["username"]).strip().casefold() for row in existing_rows
        }
        rows_by_identity: Dict[str, Mapping[str, object]] = {}
        for row in existing_rows:
            for identity_value in (row["kam_name"], row["full_name"]):
                identity_key = normalize_name(identity_value)
                if identity_key:
                    rows_by_identity.setdefault(identity_key, row)

        for kam_name in kam_names:
            identity_key = normalize_name(kam_name)
            role = "lead" if identity_key in normalized_leads else "kam"
            existing = rows_by_identity.get(identity_key)
            if existing is not None:
                connection.execute(
                    update_existing,
                    {
                        "id": int(existing["id"]),
                        "full_name": kam_name,
                        "role": role,
                        "kam_name": kam_name,
                    },
                )
                updated += 1
                continue

            base = username_base(kam_name)
            username = base
            suffix = 2
            while username.casefold() in usernames_in_use:
                username = f"{base}.{suffix}"
                suffix += 1
            connection.execute(
                insert_new,
                {
                    "username": username,
                    "initial_password": initial_password,
                    "full_name": kam_name,
                    "role": role,
                    "kam_name": kam_name,
                },
            )
            usernames_in_use.add(username.casefold())
            created_usernames.append(username)
            created += 1

    print(
        "App-user directory synced: "
        f"{created} created, {updated} existing account(s) refreshed; "
        "existing passwords preserved."
    )
    if created_usernames:
        print("New CRM usernames: " + ", ".join(created_usernames))
        if configured_password:
            print(
                "New accounts use KAM_APP_DEFAULT_PASSWORD. Reset individual "
                "passwords before distributing access."
            )
        else:
            print(
                "New accounts were directory-only with random passwords. "
                "Reset an account before giving that KAM login access."
            )
    return {"created": created, "updated": updated}


def generate_pending_alerts(engine) -> int:
    """
    Store 'Not Worked' alerts for every active-button merchant whose KAM
    submitted no matching feedback for the CURRENT rows in kam_daily_report.

    Must run BEFORE sync_supabase_current_state: the rows still carry the
    previous reporting_date, i.e. the business day the KAM has just had a
    full day to work on. ON CONFLICT keeps existing alert rows untouched.
    """
    sql = text(
        f"""
        INSERT INTO {SUPABASE_SCHEMA}.{SUPABASE_ALERTS_TABLE} (
            business_id, business_name, kam_name, reporting_date,
            alert_type, alert_reason, status
        )
        SELECT
            d.business_id,
            d.business_name,
            d.kam_name,
            d.reporting_date,
            flags.alert_type,
            flags.alert_reason,
            'Not Worked'
        FROM {SUPABASE_SCHEMA}.{SUPABASE_DAILY_TABLE} d
        CROSS JOIN LATERAL (
            VALUES
                (
                    'order_drop',
                    'Order gap ' || d.order_gap_with_previous_day::text
                        || ' vs previous day',
                    d.order_gap_with_previous_day < 0
                ),
                (
                    'visit',
                    'Visit flag: ' || d.visit,
                    lower(d.visit) IN ('call mandatory', 'must visit')
                ),
                (
                    'issue',
                    'Risk: ' || d.risk,
                    lower(d.risk) <> 'no risk'
                )
        ) AS flags(alert_type, alert_reason, is_active)
        WHERE flags.is_active
          AND NOT (
                flags.alert_type = 'order_drop'
                AND EXISTS (
                    SELECT 1 FROM {SUPABASE_SCHEMA}.feedback_order_drop f
                    WHERE f.business_id = d.business_id
                      AND f.reporting_date = d.reporting_date
                )
          )
          AND NOT (
                flags.alert_type = 'visit'
                AND EXISTS (
                    SELECT 1 FROM {SUPABASE_SCHEMA}.feedback_visit f
                    WHERE f.business_id = d.business_id
                      AND f.reporting_date = d.reporting_date
                )
          )
          AND NOT (
                flags.alert_type = 'issue'
                AND EXISTS (
                    SELECT 1 FROM {SUPABASE_SCHEMA}.feedback_issue f
                    WHERE f.business_id = d.business_id
                      AND f.reporting_date = d.reporting_date
                )
          )
        ON CONFLICT (business_id, reporting_date, alert_type) DO NOTHING
        """
    )
    with engine.begin() as connection:
        result = connection.execute(sql)
        inserted = result.rowcount if result.rowcount is not None else 0
    print(f"Alert generation: {inserted:,} new 'Not Worked' alert(s) stored.")
    return inserted


def week_start_bd(any_date: date) -> date:
    """Monday of the Bangladesh week containing any_date."""
    return any_date - timedelta(days=any_date.weekday())


def backfill_weekly_call_misses(engine, report_date: date) -> int:
    """
    Every KAM must call every assigned merchant at least once per week.
    For the last COMPLETED Monday-start week, insert a permanent
    'Not Worked' row for every current merchant that has no entry.
    Runs after the sync so the fresh merchant list is used. Idempotent.
    """
    current_week_start = week_start_bd(report_date)
    completed_week_start = current_week_start - timedelta(days=7)
    sql = text(
        f"""
        INSERT INTO {SUPABASE_SCHEMA}.{SUPABASE_WEEKLY_CALL_TABLE} (
            business_id, business_name, kam_name, week_start, status
        )
        SELECT d.business_id, d.business_name, d.kam_name,
               CAST(:week_start AS date), 'Not Worked'
        FROM {SUPABASE_SCHEMA}.{SUPABASE_DAILY_TABLE} d
        ON CONFLICT (business_id, week_start) DO NOTHING
        """
    )
    with engine.begin() as connection:
        result = connection.execute(sql, {"week_start": completed_week_start})
        inserted = result.rowcount if result.rowcount is not None else 0
    print(
        f"Weekly call backfill for week starting {completed_week_start}: "
        f"{inserted:,} 'Not Worked' row(s) stored."
    )
    return inserted


def build_kam_summary_rows(
    kam_df: pd.DataFrame,
    report: pd.DataFrame,
    dod_report: pd.DataFrame,
    monthly_metrics_df: pd.DataFrame,
    report_date: date,
) -> List[dict]:
    """
    One "Summery Report" row per KAM for the reporting date:
      Active Merchant  = merchants with >= 1 active day in the current month
      Total Merchant   = assigned merchants
      Today's Order    = report business-day orders (last_day_order)
      Present month    = sum of KAM DOD daily columns
      Previous month   = previous-month processed orders
      Order Gap        = present-month total - previous-month total
    """
    merchants = kam_df[["Business_id", "KAM_name"]].copy()
    merchants["KAM_key"] = merchants["KAM_name"].map(normalize_name)
    merchants = merchants.loc[merchants["KAM_key"].ne("")].copy()
    if merchants.empty:
        return []

    day_columns = list(dod_report.columns[4:-1])
    dod_working = dod_report[["Business ID", "Active Days", *day_columns]].copy()
    dod_working["month_orders"] = (
        dod_working[day_columns]
        .apply(pd.to_numeric, errors="coerce")
        .fillna(0)
        .sum(axis=1)
    )
    dod_working["is_active"] = (
        pd.to_numeric(dod_working["Active Days"], errors="coerce")
        .fillna(0)
        .gt(0)
        .astype(int)
    )

    todays = report[["Business_id", "Last_day_order"]].copy()

    monthly = merchants.merge(monthly_metrics_df, on="Business_id", how="left")
    if "Previous_month_orders" not in monthly.columns:
        monthly["Previous_month_orders"] = 0
    monthly["Previous_month_orders"] = pd.to_numeric(
        monthly["Previous_month_orders"], errors="coerce"
    ).fillna(0)

    base = merchants.merge(
        dod_working[["Business ID", "month_orders", "is_active"]],
        left_on="Business_id",
        right_on="Business ID",
        how="left",
    )
    base = base.merge(todays, on="Business_id", how="left")
    for column in ("month_orders", "is_active", "Last_day_order"):
        base[column] = pd.to_numeric(base[column], errors="coerce").fillna(0)

    grouped = base.groupby("KAM_key", as_index=False).agg(
        KAM_name=("KAM_name", "first"),
        total_merchant=("Business_id", "nunique"),
        active_merchant=("is_active", "sum"),
        present_month=("month_orders", "sum"),
        todays_order=("Last_day_order", "sum"),
    )
    prev = monthly.groupby("KAM_key", as_index=False).agg(
        previous_month=("Previous_month_orders", "sum"),
    )
    grouped = grouped.merge(prev, on="KAM_key", how="left")
    grouped["previous_month"] = pd.to_numeric(
        grouped["previous_month"], errors="coerce"
    ).fillna(0)

    rows: List[dict] = []
    for _, row in grouped.iterrows():
        total = int(row["total_merchant"])
        active = int(row["active_merchant"])
        present = int(row["present_month"])
        previous = int(row["previous_month"])
        rows.append(
            {
                "kam_name": str(row["KAM_name"]),
                "reporting_date": report_date,
                "active_merchant": active,
                "total_merchant": total,
                "active_merchant_pct": (
                    Decimal(active) / Decimal(total) if total else Decimal("0")
                ),
                "inactive_merchant": total - active,
                "total_order_present_month": present,
                "total_order_previous_month": previous,
                "todays_order": int(row["todays_order"]),
                "order_gap": present - previous,
            }
        )
    return rows


def upsert_kam_summary(engine, summary_rows: Sequence[Mapping[str, object]]) -> None:
    if not summary_rows:
        print("WARNING: no KAM summary rows to store.")
        return
    sql = text(
        f"""
        INSERT INTO {SUPABASE_SCHEMA}.{SUPABASE_SUMMARY_TABLE} (
            kam_name, reporting_date, active_merchant, total_merchant,
            active_merchant_pct, inactive_merchant,
            total_order_present_month, total_order_previous_month,
            todays_order, order_gap, refreshed_at
        ) VALUES (
            :kam_name, :reporting_date, :active_merchant, :total_merchant,
            :active_merchant_pct, :inactive_merchant,
            :total_order_present_month, :total_order_previous_month,
            :todays_order, :order_gap, now()
        )
        ON CONFLICT (kam_name, reporting_date) DO UPDATE SET
            active_merchant = EXCLUDED.active_merchant,
            total_merchant = EXCLUDED.total_merchant,
            active_merchant_pct = EXCLUDED.active_merchant_pct,
            inactive_merchant = EXCLUDED.inactive_merchant,
            total_order_present_month = EXCLUDED.total_order_present_month,
            total_order_previous_month = EXCLUDED.total_order_previous_month,
            todays_order = EXCLUDED.todays_order,
            order_gap = EXCLUDED.order_gap,
            refreshed_at = now()
        """
    )
    with engine.begin() as connection:
        connection.execute(sql, list(summary_rows))
    print(f"KAM summary snapshot stored: {len(summary_rows):,} row(s).")


def verify_supabase_row_counts(
    engine,
    expected_daily_rows: int,
    expected_dod_rows: int,
    expected_retention_rows: int,
) -> Dict[str, int]:
    """Read committed row counts back from Supabase and fail on any mismatch."""
    with engine.connect() as connection:
        counts = connection.execute(
            text(
                f"""
                SELECT
                    (SELECT COUNT(*) FROM {SUPABASE_SCHEMA}.{SUPABASE_DAILY_TABLE})
                        AS daily_rows,
                    (SELECT COUNT(*) FROM {SUPABASE_SCHEMA}.{SUPABASE_DOD_TABLE})
                        AS dod_rows,
                    (SELECT COUNT(*) FROM {SUPABASE_SCHEMA}.{SUPABASE_RETENTION_TABLE})
                        AS retention_rows
                """
            )
        ).mappings().one()
    actual = {
        "daily_rows": int(counts["daily_rows"]),
        "dod_rows": int(counts["dod_rows"]),
        "retention_rows": int(counts["retention_rows"]),
    }
    expected = {
        "daily_rows": expected_daily_rows,
        "dod_rows": expected_dod_rows,
        "retention_rows": expected_retention_rows,
    }
    if actual != expected:
        raise RuntimeError(
            "Supabase post-commit row-count check failed. "
            f"Expected {expected}, got {actual}."
        )
    return actual


def read_supabase_targets(engine) -> Dict[str, object]:
    """Read Supabase target inputs so web-app changes survive every refresh."""
    sql = text(
        f"SELECT kam_name, target "
        f"FROM {SUPABASE_SCHEMA}.{SUPABASE_RETENTION_TABLE}"
    )
    with engine.connect() as connection:
        rows = connection.execute(sql).mappings().all()
    return {
        normalize_name(row["kam_name"]): (
            row["target"] if row["target"] is not None else ""
        )
        for row in rows
        if normalize_name(row["kam_name"])
    }


def parse_target_value(value: object) -> Decimal | None:
    """Convert a blank, decimal, or percentage-formatted target to a ratio."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, Decimal):
        return value
    text_value = str(value).strip().replace(",", "")
    is_percentage = text_value.endswith("%")
    if is_percentage:
        text_value = text_value[:-1].strip()
    try:
        parsed = Decimal(text_value)
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"Invalid Target value: {value!r}") from exc
    return parsed / Decimal("100") if is_percentage else parsed


def parse_optional_datetime(value: object) -> datetime | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    parsed = pd.to_datetime(value, errors="coerce")
    if pd.isna(parsed):
        return None
    if isinstance(parsed, pd.Timestamp):
        return parsed.to_pydatetime()
    return parsed


def build_supabase_daily_rows(
    report: pd.DataFrame,
    report_date: date,
) -> List[dict]:
    rows: List[dict] = []
    for _, row in report.iterrows():
        rows.append(
            {
                "business_id": int(row["Business_id"]),
                "business_name": str(row["Business_name"] or ""),
                "kam_name": str(row["KAM_name"] or ""),
                "lead_name": str(row["Lead_name"] or ""),
                "registration_date": parse_optional_datetime(
                    row["Registration_date"]
                ),
                "lifetime_order": int(row["Lifetime_order"]),
                "lifetime_delivered": int(row["Lifetime_delivered"]),
                "lifetime_returned": int(row["Lifetime_returned"]),
                "lifetime_active_days": int(row["Lifetime_active_days"]),
                "avg_order": Decimal(str(row["Avg._order"])),
                "max_order_in_a_day": int(row["Max_order_in_a_day"]),
                "potentiality": str(row["Potentiality"] or ""),
                "last_order_date": parse_optional_datetime(row["Last_order_date"]),
                "visit": str(row["Visit"] or ""),
                "last_day_order": int(row["Last_day_order"]),
                "last_7_day_order": int(row["Last 7 day order"]),
                "risk": str(row["Risk"] or ""),
                "order_gap_with_previous_day": int(
                    row["Order Gap with Previous Day"]
                ),
                "reporting_date": report_date,
            }
        )
    return rows


def build_supabase_dod_rows(
    dod_report: pd.DataFrame,
    report_month: date,
    day_dates: Sequence[date],
) -> List[dict]:
    """
    One row per merchant. day_values is a JSON object keyed by the real
    business date, e.g. {"2026-08-01": 5, ..., "2026-08-31": 2}, so the web
    app can label columns "Aug 1" ... "Aug 31" and months keep their true
    28/29/30/31-day length.
    """
    day_columns = list(dod_report.columns[4:-1])
    if len(day_columns) != len(day_dates):
        raise ValueError(
            "Supabase KAM DOD sync: sheet day columns "
            f"({len(day_columns)}) do not match the business dates "
            f"({len(day_dates)})."
        )
    rows: List[dict] = []
    for _, row in dod_report.iterrows():
        day_values = {
            business_date.isoformat(): int(row[source_column])
            for business_date, source_column in zip(day_dates, day_columns)
        }
        rows.append(
            {
                "business_id": int(row["Business ID"]),
                "business_name": str(row["Business Name"] or ""),
                "kam_name": str(row["KAM name"] or ""),
                "onboarded_date": parse_optional_datetime(row["Onboarded date"]),
                "report_month": report_month,
                "day_values": json.dumps(day_values),
                "active_days": int(row["Active Days"]),
            }
        )
    return rows


def build_supabase_retention_rows(
    retention_report: pd.DataFrame,
    report_month: date,
) -> List[dict]:
    rows: List[dict] = []
    for _, row in retention_report.iterrows():
        assigned = int(row["Per. Active merchant count"])
        current_active = int(row["Curr. Active merchant count"])
        previous_orders = int(row["Per. Month orders"])
        current_orders = int(row["Curr. Month Orders"])
        rows.append(
            {
                "kam_name": str(row["KAM name"]),
                "report_month": report_month,
                "per_active_merchant_count": assigned,
                "curr_active_merchant_count": current_active,
                "merchant_retention_pct": (
                    Decimal(current_active) / Decimal(assigned)
                    if assigned
                    else Decimal("0")
                ),
                "per_month_orders": previous_orders,
                "per_month_rvn": Decimal(str(row["Per. Month RVN"])),
                "curr_month_orders": current_orders,
                "curr_month_rvn": Decimal(str(row["Curr. Month RVN"])),
                "order_retention_pct": (
                    Decimal(current_orders) / Decimal(previous_orders)
                    if previous_orders
                    else Decimal("0")
                ),
                # Used only when inserting a brand-new KAM. ON CONFLICT never
                # overwrites the existing Supabase-controlled Target value.
                "target": parse_target_value(row["Target"]),
            }
        )
    return rows


def sync_supabase_current_state(
    engine,
    daily_rows: Sequence[Mapping[str, object]],
    dod_rows: Sequence[Mapping[str, object]],
    retention_rows: Sequence[Mapping[str, object]],
) -> None:
    """
    Upsert the current report state.

    Stable primary keys mean a rerun updates existing rows. A row is inserted
    only for a newly assigned Business ID/KAM, and stale rows are deleted.
    Feedback/alert/weekly-call tables are never touched here: they carry no
    FK to the current-state tables, so history always survives this DELETE.
    """
    daily_upsert = text(
        f"""
        INSERT INTO {SUPABASE_SCHEMA}.{SUPABASE_DAILY_TABLE} (
            business_id, business_name, kam_name, lead_name, registration_date,
            lifetime_order, lifetime_delivered, lifetime_returned,
            lifetime_active_days, avg_order, max_order_in_a_day, potentiality,
            last_order_date, visit, last_day_order, last_7_day_order, risk,
            order_gap_with_previous_day, reporting_date, refreshed_at
        ) VALUES (
            :business_id, :business_name, :kam_name, :lead_name, :registration_date,
            :lifetime_order, :lifetime_delivered, :lifetime_returned,
            :lifetime_active_days, :avg_order, :max_order_in_a_day, :potentiality,
            :last_order_date, :visit, :last_day_order, :last_7_day_order, :risk,
            :order_gap_with_previous_day, :reporting_date, now()
        )
        ON CONFLICT (business_id) DO UPDATE SET
            business_name = EXCLUDED.business_name,
            kam_name = EXCLUDED.kam_name,
            lead_name = EXCLUDED.lead_name,
            registration_date = EXCLUDED.registration_date,
            lifetime_order = EXCLUDED.lifetime_order,
            lifetime_delivered = EXCLUDED.lifetime_delivered,
            lifetime_returned = EXCLUDED.lifetime_returned,
            lifetime_active_days = EXCLUDED.lifetime_active_days,
            avg_order = EXCLUDED.avg_order,
            max_order_in_a_day = EXCLUDED.max_order_in_a_day,
            potentiality = EXCLUDED.potentiality,
            last_order_date = EXCLUDED.last_order_date,
            visit = EXCLUDED.visit,
            last_day_order = EXCLUDED.last_day_order,
            last_7_day_order = EXCLUDED.last_7_day_order,
            risk = EXCLUDED.risk,
            order_gap_with_previous_day = EXCLUDED.order_gap_with_previous_day,
            reporting_date = EXCLUDED.reporting_date,
            refreshed_at = now()
        """
    )
    dod_upsert = text(
        f"""
        INSERT INTO {SUPABASE_SCHEMA}.{SUPABASE_DOD_TABLE} (
            business_id, business_name, kam_name, onboarded_date, report_month,
            day_values, active_days, refreshed_at
        ) VALUES (
            :business_id, :business_name, :kam_name, :onboarded_date,
            :report_month, CAST(:day_values AS jsonb), :active_days, now()
        )
        ON CONFLICT (business_id) DO UPDATE SET
            business_name = EXCLUDED.business_name,
            kam_name = EXCLUDED.kam_name,
            onboarded_date = EXCLUDED.onboarded_date,
            report_month = EXCLUDED.report_month,
            day_values = EXCLUDED.day_values,
            active_days = EXCLUDED.active_days,
            refreshed_at = now()
        """
    )
    # Month archive: keyed by (business_id, report_month) and never deleted.
    # Because it is refreshed on every run, the previous month's final state
    # is already stored the moment a new month begins.
    dod_monthly_upsert = text(
        f"""
        INSERT INTO {SUPABASE_SCHEMA}.{SUPABASE_DOD_MONTHLY_TABLE} (
            business_id, business_name, kam_name, onboarded_date, report_month,
            day_values, active_days, refreshed_at
        ) VALUES (
            :business_id, :business_name, :kam_name, :onboarded_date,
            :report_month, CAST(:day_values AS jsonb), :active_days, now()
        )
        ON CONFLICT (business_id, report_month) DO UPDATE SET
            business_name = EXCLUDED.business_name,
            kam_name = EXCLUDED.kam_name,
            onboarded_date = EXCLUDED.onboarded_date,
            day_values = EXCLUDED.day_values,
            active_days = EXCLUDED.active_days,
            refreshed_at = now()
        """
    )
    retention_upsert = text(
        f"""
        INSERT INTO {SUPABASE_SCHEMA}.{SUPABASE_RETENTION_TABLE} (
            kam_name, report_month, per_active_merchant_count,
            curr_active_merchant_count, merchant_retention_pct,
            per_month_orders, per_month_rvn, curr_month_orders,
            curr_month_rvn, order_retention_pct, target, refreshed_at
        ) VALUES (
            :kam_name, :report_month, :per_active_merchant_count,
            :curr_active_merchant_count, :merchant_retention_pct,
            :per_month_orders, :per_month_rvn, :curr_month_orders,
            :curr_month_rvn, :order_retention_pct, :target, now()
        )
        ON CONFLICT (kam_name) DO UPDATE SET
            report_month = EXCLUDED.report_month,
            per_active_merchant_count = EXCLUDED.per_active_merchant_count,
            curr_active_merchant_count = EXCLUDED.curr_active_merchant_count,
            merchant_retention_pct = EXCLUDED.merchant_retention_pct,
            per_month_orders = EXCLUDED.per_month_orders,
            per_month_rvn = EXCLUDED.per_month_rvn,
            curr_month_orders = EXCLUDED.curr_month_orders,
            curr_month_rvn = EXCLUDED.curr_month_rvn,
            order_retention_pct = EXCLUDED.order_retention_pct,
            refreshed_at = now()
        """
    )
    business_ids = [int(row["business_id"]) for row in daily_rows]
    kam_names = [str(row["kam_name"]) for row in retention_rows]
    if not business_ids:
        raise ValueError("Supabase sync refused: there are no Business IDs.")
    if not kam_names:
        raise ValueError("Supabase sync refused: there are no KAM names.")
    with engine.begin() as connection:
        connection.execute(daily_upsert, list(daily_rows))
        connection.execute(dod_upsert, list(dod_rows))
        connection.execute(dod_monthly_upsert, list(dod_rows))
        connection.execute(retention_upsert, list(retention_rows))
        connection.execute(
            text(
                f"DELETE FROM {SUPABASE_SCHEMA}.{SUPABASE_DAILY_TABLE} "
                f"WHERE NOT (business_id = ANY(CAST(:ids AS bigint[])))"
            ),
            {"ids": business_ids},
        )
        connection.execute(
            text(
                f"DELETE FROM {SUPABASE_SCHEMA}.{SUPABASE_DOD_TABLE} "
                f"WHERE NOT (business_id = ANY(CAST(:ids AS bigint[])))"
            ),
            {"ids": business_ids},
        )
        connection.execute(
            text(
                f"DELETE FROM {SUPABASE_SCHEMA}.{SUPABASE_RETENTION_TABLE} "
                f"WHERE NOT (kam_name = ANY(CAST(:names AS text[])))"
            ),
            {"names": kam_names},
        )


def locate_kam_headers(ws) -> Tuple[int | None, Dict[str, int]]:
    """Return the first compatible header row and required column indexes."""
    header_row = None
    column_indexes: Dict[str, int] = {}
    for candidate_row in range(1, 11):
        row_values = ws.row_values(candidate_row)
        if not row_values:
            continue
        normalized = [normalize_header(value) for value in row_values]
        candidate_indexes: Dict[str, int] = {}
        for field_name, accepted_headers in KAM_SOURCE_ALIASES.items():
            for idx, header in enumerate(normalized, start=1):
                if header in accepted_headers:
                    candidate_indexes[field_name] = idx
                    break
        if len(candidate_indexes) == len(KAM_SOURCE_ALIASES):
            header_row = candidate_row
            column_indexes = candidate_indexes
            break
    return header_row, column_indexes


def resolve_kam_worksheet(workbook, requested_tab: str):
    """
    Resolve the KAM source safely: exact title first, then a unique
    whitespace/case-equivalent title, then a unique tab with compatible
    ID / Business Name / KAM headers.
    """
    worksheets = workbook.worksheets()
    available_titles = [ws.title for ws in worksheets]
    exact = [ws for ws in worksheets if ws.title == requested_tab]
    if exact:
        return exact[0]

    requested_key = normalize_header(requested_tab)
    equivalent = [
        ws for ws in worksheets if normalize_header(ws.title) == requested_key
    ]
    if len(equivalent) == 1:
        print(
            f"KAM source tab resolved to '{equivalent[0].title}' "
            f"(requested '{requested_tab}')."
        )
        return equivalent[0]

    compatible = []
    for ws in worksheets:
        header_row, _ = locate_kam_headers(ws)
        if header_row is not None:
            compatible.append(ws)
    if len(compatible) == 1:
        print(
            f"KAM source tab auto-detected: '{compatible[0].title}' "
            f"(requested '{requested_tab}')."
        )
        return compatible[0]

    workbook_title = getattr(workbook, "title", "<unknown workbook>")
    available = ", ".join(repr(title) for title in available_titles) or "<none>"
    if len(compatible) > 1:
        compatible_titles = ", ".join(repr(ws.title) for ws in compatible)
        raise ValueError(
            f"Workbook '{workbook_title}' has multiple KAM-compatible tabs: "
            f"{compatible_titles}. Rerun with --source-tab and the exact title."
        )
    raise ValueError(
        f"Could not find KAM source tab '{requested_tab}' in workbook "
        f"'{workbook_title}'. Available tabs: {available}. Expected a tab with "
        "ID/Business ID, Business Name, and KAM/KAM Name headers."
    )


def read_kam_list(workbook, tab_name: str) -> pd.DataFrame:
    """
    Read only the required columns from the KAM list:
      id -> Business_id
      Business Name -> Business_name
      KAM -> KAM_name
    """
    ws = resolve_kam_worksheet(workbook, tab_name)
    header_row, column_indexes = locate_kam_headers(ws)
    if header_row is None:
        raise ValueError(
            f"Could not locate the required columns in the first 10 rows of "
            f"'{ws.title}'. Expected ID/id (or Business ID), Business Name, "
            f"and KAM (or KAM Name)."
        )
    print(f"KAM source: '{ws.title}' (header row {header_row})")
    source_columns = {
        col: ws.col_values(column_indexes[col])[header_row:]
        for col in KAM_SOURCE_ALIASES
    }
    row_count = max((len(values) for values in source_columns.values()), default=0)
    rows: List[dict] = []
    for row_idx in range(row_count):
        def cell(column: str) -> str:
            values = source_columns[column]
            return values[row_idx].strip() if row_idx < len(values) else ""
        business_id_raw = cell("id")
        if not business_id_raw:
            continue
        try:
            business_id = int(float(business_id_raw.replace(",", "")))
        except ValueError:
            print(f"WARNING: skipped invalid business id: {business_id_raw!r}")
            continue
        kam_name = cell("KAM")
        rows.append(
            {
                "Business_id": business_id,
                "Business_name": cell("Business Name"),
                "KAM_name": kam_name,
                "Lead_name": NORMALIZED_TEAM_LEADS.get(normalize_name(kam_name), ""),
            }
        )
    if not rows:
        return pd.DataFrame(
            columns=["Business_id", "Business_name", "KAM_name", "Lead_name"]
        )
    df = pd.DataFrame(rows)
    duplicate_ids = df.loc[df["Business_id"].duplicated(keep=False), "Business_id"].unique()
    if len(duplicate_ids):
        print(
            f"WARNING: duplicate business IDs found in '{ws.title}'; "
            "keeping the first row for each ID: "
            + ", ".join(map(str, duplicate_ids[:20]))
            + (" ..." if len(duplicate_ids) > 20 else "")
        )
    df = df.drop_duplicates(subset=["Business_id"], keep="first").reset_index(drop=True)
    unmapped = sorted(
        name
        for name in df.loc[df["Lead_name"].eq(""), "KAM_name"].dropna().unique()
        if str(name).strip()
    )
    if unmapped:
        print("WARNING: no Lead_name mapping for KAM(s): " + ", ".join(unmapped))
    return df


def fetch_registration_dates(business_ids: List[int]) -> pd.DataFrame:
    """Merchant registration (business creation) timestamps from Pegasus."""
    if not business_ids:
        return pd.DataFrame(columns=["Business_id", "Registration_date"])
    peg = get_engine("PEGASUS")
    return fetch_df(
        peg,
        """
        SELECT
            b.id AS "Business_id",
            b.created_at + INTERVAL '6 hours' AS "Registration_date"
        FROM businesses b
        WHERE b.id IN :business_ids
        """,
        {"business_ids": business_ids},
        expanding=("business_ids",),
    )


def fetch_oms_metrics(
    business_ids: List[int],
    history_start: date,
    cutoff_date: date,
) -> pd.DataFrame:
    """
    cutoff_date is the exclusive 06:00 BD boundary.

    Example for --cutoff-date 2026-08-06:
      report day       = 2026-08-05 06:00 BD to 2026-08-06 06:00 BD
      previous day     = 2026-08-04 06:00 BD to 2026-08-05 06:00 BD
      last 7 days      = 2026-07-30 06:00 BD to 2026-08-06 06:00 BD
      history starts   = 2025-02-01 06:00 BD

    OMS timestamps are stored in UTC. Bangladesh 06:00 is UTC 00:00, so the
    raw UTC date is the correct 06:00-to-06:00 Bangladesh business date.
    """
    if not business_ids:
        return pd.DataFrame()
    oms = get_engine("OMS")
    processed_ids = ",".join(map(str, PROCESSED_STATUS_IDS))
    delivered_ids = ",".join(map(str, DELIVERED_STATUS_IDS))
    returned_ids = ",".join(map(str, RETURNED_STATUS_IDS))
    sql = f"""
    WITH filtered AS (
        SELECT
            o.business_id,
            o.consignment_id,
            o.transfer_status_id,
            COALESCE(o.sorted_at, o.created_at) AS processed_at_utc
        FROM orders o
        WHERE o.business_id IN :business_ids
          AND o.transfer_status_id IN ({processed_ids})
          AND COALESCE(o.sorted_at, o.created_at)
                >= CAST(:history_start_utc AS timestamp)
          AND COALESCE(o.sorted_at, o.created_at)
                <  CAST(:cutoff_utc AS timestamp)
    ),
    daily AS (
        SELECT
            business_id,
            processed_at_utc::date AS business_date,
            COUNT(DISTINCT consignment_id) AS daily_order
        FROM filtered
        GROUP BY 1, 2
    ),
    totals AS (
        SELECT
            business_id,
            COUNT(DISTINCT consignment_id) AS lifetime_order,
            COUNT(DISTINCT consignment_id) FILTER (
                WHERE transfer_status_id IN ({delivered_ids})
            ) AS lifetime_delivered,
            COUNT(DISTINCT consignment_id) FILTER (
                WHERE transfer_status_id IN ({returned_ids})
            ) AS lifetime_returned,
            MAX(processed_at_utc) + INTERVAL '6 hours' AS last_order_date,
            MAX(processed_at_utc::date) AS last_order_business_date
        FROM filtered
        GROUP BY 1
    ),
    daily_summary AS (
        SELECT
            business_id,
            COUNT(*) AS lifetime_active_days,
            MAX(daily_order) AS max_order_in_a_day,
            COALESCE(
                SUM(daily_order) FILTER (
                    WHERE business_date >= CAST(:last_7_start AS date)
                      AND business_date <  CAST(:cutoff_date AS date)
                ), 0
            ) AS last_7_day_order,
            COALESCE(
                SUM(daily_order) FILTER (
                    WHERE business_date = CAST(:report_date AS date)
                ), 0
            ) AS last_day_order,
            COALESCE(
                SUM(daily_order) FILTER (
                    WHERE business_date = CAST(:previous_date AS date)
                ), 0
            ) AS previous_day_order
        FROM daily
        GROUP BY 1
    )
    SELECT
        t.business_id AS "Business_id",
        t.lifetime_order AS "Lifetime_order",
        t.lifetime_delivered AS "Lifetime_delivered",
        t.lifetime_returned AS "Lifetime_returned",
        ds.lifetime_active_days AS "Lifetime_active_days",
        ds.max_order_in_a_day AS "Max_order_in_a_day",
        t.last_order_date AS "Last_order_date",
        t.last_order_business_date AS "Last_order_business_date",
        ds.last_day_order AS "Last_day_order",
        ds.last_7_day_order AS "Last 7 day order",
        ds.previous_day_order AS "Previous_day_order"
    FROM totals t
    INNER JOIN daily_summary ds
            ON ds.business_id = t.business_id
    ORDER BY t.business_id
    """
    report_date = cutoff_date - timedelta(days=1)
    previous_date = cutoff_date - timedelta(days=2)
    last_7_start = cutoff_date - timedelta(days=7)
    return fetch_df(
        oms,
        sql,
        {
            "business_ids": business_ids,
            "history_start_utc": datetime.combine(history_start, time.min),
            "cutoff_utc": datetime.combine(cutoff_date, time.min),
            "cutoff_date": cutoff_date,
            "report_date": report_date,
            "previous_date": previous_date,
            "last_7_start": last_7_start,
        },
        expanding=("business_ids",),
    )


def fetch_dod_counts(
    business_ids: List[int],
    start_date: date,
    end_date: date,
    cutoff_date: date,
) -> pd.DataFrame:
    """
    Fetch the supplied day-wise OMS logic for KAM DOD.

    Logic intentionally retained from the supplied script:
      - processed status set is unchanged;
      - order volume uses COUNT(*);
      - created_at must be non-null;
      - sorted_at is the DOD timestamp;
      - each business date is 06:00 BD to next-day 06:00 BD.
    """
    if not business_ids:
        return pd.DataFrame(columns=["Business_id", "Business_date", "Total_count"])
    query_end_exclusive = min(end_date + timedelta(days=1), cutoff_date)
    if query_end_exclusive <= start_date:
        return pd.DataFrame(columns=["Business_id", "Business_date", "Total_count"])
    oms = get_engine("OMS")
    processed_ids = ",".join(map(str, PROCESSED_STATUS_IDS))
    sql = f"""
    SELECT
        o.business_id AS "Business_id",
        o.sorted_at::date AS "Business_date",
        COUNT(*) AS "Total_count"
    FROM orders o
    WHERE o.business_id IN :business_ids
      AND o.created_at IS NOT NULL
      AND o.transfer_status_id IN ({processed_ids})
      AND o.sorted_at >= CAST(:start_utc AS timestamp)
      AND o.sorted_at <  CAST(:end_utc AS timestamp)
    GROUP BY 1, 2
    ORDER BY 1, 2
    """
    return fetch_df(
        oms,
        sql,
        {
            "business_ids": business_ids,
            "start_utc": datetime.combine(start_date, time.min),
            "end_utc": datetime.combine(query_end_exclusive, time.min),
        },
        expanding=("business_ids",),
    )


def fetch_retention_monthly_metrics(
    business_ids: List[int],
    previous_month_start: date,
    current_month_start: date,
    current_period_end: date,
) -> pd.DataFrame:
    """
    Fetch merchant-level inputs for Retention & Target.

    Every boundary is a Bangladesh 06:00 business-day boundary passed as
    00:00 UTC. Current-month orders are deliberately not queried here; they
    are summed from the exact KAM DOD daily columns, as requested.
    """
    if not business_ids:
        return pd.DataFrame(
            columns=[
                "Business_id",
                "Previous_month_orders",
                "Previous_month_rvn",
                "Current_month_rvn",
            ]
        )
    oms = get_engine("OMS")
    processed_ids = ",".join(map(str, PROCESSED_STATUS_IDS))
    rvn_ids = ",".join(map(str, RVN_STATUS_IDS))
    relevant_ids = ",".join(
        map(str, sorted(set(PROCESSED_STATUS_IDS) | set(RVN_STATUS_IDS)))
    )
    sql = f"""
    WITH filtered AS (
        SELECT
            o.business_id,
            o.consignment_id,
            o.transfer_status_id,
            COALESCE(o.total_fee, 0) AS total_fee,
            COALESCE(o.sorted_at, o.created_at) AS processed_at_utc
        FROM orders o
        WHERE o.business_id IN :business_ids
          AND o.transfer_status_id IN ({relevant_ids})
          AND COALESCE(o.sorted_at, o.created_at)
                >= CAST(:previous_start_utc AS timestamp)
          AND COALESCE(o.sorted_at, o.created_at)
                <  CAST(:current_end_utc AS timestamp)
    )
    SELECT
        business_id AS "Business_id",
        COUNT(DISTINCT consignment_id) FILTER (
            WHERE transfer_status_id IN ({processed_ids})
              AND processed_at_utc >= CAST(:previous_start_utc AS timestamp)
              AND processed_at_utc <  CAST(:current_start_utc AS timestamp)
        ) AS "Previous_month_orders",
        COALESCE(
            SUM(total_fee) FILTER (
                WHERE transfer_status_id IN ({rvn_ids})
                  AND processed_at_utc >= CAST(:previous_start_utc AS timestamp)
                  AND processed_at_utc <  CAST(:current_start_utc AS timestamp)
            ), 0
        ) AS "Previous_month_rvn",
        COALESCE(
            SUM(total_fee) FILTER (
                WHERE transfer_status_id IN ({rvn_ids})
                  AND processed_at_utc >= CAST(:current_start_utc AS timestamp)
                  AND processed_at_utc <  CAST(:current_end_utc AS timestamp)
            ), 0
        ) AS "Current_month_rvn"
    FROM filtered
    GROUP BY 1
    ORDER BY 1
    """
    return fetch_df(
        oms,
        sql,
        {
            "business_ids": business_ids,
            "previous_start_utc": datetime.combine(previous_month_start, time.min),
            "current_start_utc": datetime.combine(current_month_start, time.min),
            "current_end_utc": datetime.combine(current_period_end, time.min),
        },
        expanding=("business_ids",),
    )


def potentiality(max_order: int) -> str:
    if max_order < 50:
        return "Low tier"
    if max_order < 100:
        return "mid tier"
    if max_order < 300:
        return "semi top tier"
    if max_order < 500:
        return "Top tier"
    return "leaders"


def risk_label(days_since_last_order: int) -> str:
    if days_since_last_order <= 0:
        return "No risk"
    if days_since_last_order <= 3:
        return "Low Risk"
    if days_since_last_order <= 5:
        return "Mid Risk"
    if days_since_last_order <= 7:
        return "High Risk"
    if days_since_last_order <= 15:
        return "Early churn Risk"
    if days_since_last_order <= 29:
        return "High churn Risk"
    return "Churned"


def visit_label(days_since_last_order: int | None) -> str:
    """
    Approved Visit rule (A3):
      never ordered            -> Must visit
      days >= 3                -> Must visit
      0 < days < 3             -> Call Mandatory
      days <= 0 (ordered on report day) -> No need
    """
    if days_since_last_order is None:
        return "Must visit"
    if days_since_last_order >= 3:
        return "Must visit"
    if days_since_last_order > 0:
        return "Call Mandatory"
    return "No need"


def build_report(
    kam_df: pd.DataFrame,
    registration_df: pd.DataFrame,
    metrics_df: pd.DataFrame,
    cutoff_date: date,
) -> pd.DataFrame:
    report_date = cutoff_date - timedelta(days=1)
    out = kam_df.merge(registration_df, on="Business_id", how="left")
    out = out.merge(metrics_df, on="Business_id", how="left")
    count_columns = [
        "Lifetime_order",
        "Lifetime_delivered",
        "Lifetime_returned",
        "Lifetime_active_days",
        "Max_order_in_a_day",
        "Last_day_order",
        "Last 7 day order",
        "Previous_day_order",
    ]
    for col in count_columns:
        if col not in out.columns:
            out[col] = 0
        out[col] = pd.to_numeric(out[col], errors="coerce").fillna(0).astype(int)
    out["Avg._order"] = (
        out["Lifetime_order"]
        .div(out["Lifetime_active_days"].where(out["Lifetime_active_days"].ne(0)))
        .fillna(0)
        .round(2)
    )
    out["Potentiality"] = out["Max_order_in_a_day"].map(potentiality)
    last_order_dt = pd.to_datetime(out.get("Last_order_date"), errors="coerce")
    last_business_dates = pd.to_datetime(
        out.get("Last_order_business_date"), errors="coerce"
    ).dt.date

    def days_since(value) -> int | None:
        if pd.isna(value):
            return None
        # Never produce a negative risk age if a source timestamp is
        # unexpectedly later than the report date.
        return max((report_date - value).days, 0)

    days_since_last = last_business_dates.map(days_since)
    out["Risk"] = days_since_last.map(
        lambda d: "No Order" if d is None or pd.isna(d) else risk_label(int(d))
    )
    out["Visit"] = days_since_last.map(
        lambda d: visit_label(None if d is None or pd.isna(d) else int(d))
    )
    out["Order Gap with Previous Day"] = (
        out["Last_day_order"] - out["Previous_day_order"]
    )
    out["Reporting Date"] = report_date.strftime("%Y-%m-%d")
    # Human-readable BD timestamps for Google Sheets.
    registration_dt = pd.to_datetime(out.get("Registration_date"), errors="coerce")
    out["Registration_date"] = (
        registration_dt.dt.strftime("%Y-%m-%d %H:%M:%S").fillna("")
    )
    out["Last_order_date"] = last_order_dt.dt.strftime("%Y-%m-%d %H:%M:%S").fillna("")
    return out[OUTPUT_COLUMNS].sort_values("Business_id").reset_index(drop=True)


def build_dod_report(
    kam_df: pd.DataFrame,
    registration_df: pd.DataFrame,
    counts_df: pd.DataFrame,
    start_date: date,
    end_date: date,
) -> pd.DataFrame:
    """
    Build KAM DOD with the requested layout:
      A Business ID
      B Business Name
      C KAM name
      D Onboarded date
      E onward: one column per real business date of the month
                (28, 29, 30 or 31 columns depending on the month)
      Last column: Active Days
    """
    day_list = [
        start_date + timedelta(days=offset)
        for offset in range((end_date - start_date).days + 1)
    ]
    if not (28 <= len(day_list) <= 31):
        raise ValueError(
            "KAM DOD must cover one full calendar month "
            f"(28-31 dates); got {len(day_list)}."
        )
    if counts_df.empty:
        pivot = pd.DataFrame({"Business_id": pd.Series(dtype="int64")})
    else:
        working = counts_df.copy()
        working["Business_date"] = pd.to_datetime(
            working["Business_date"], errors="coerce"
        ).dt.date
        working["Total_count"] = pd.to_numeric(
            working["Total_count"], errors="coerce"
        ).fillna(0)
        pivot = working.pivot_table(
            index="Business_id",
            columns="Business_date",
            values="Total_count",
            aggfunc="sum",
            fill_value=0,
        )
        pivot.reset_index(inplace=True)
    for business_date in day_list:
        if business_date not in pivot.columns:
            pivot[business_date] = 0
    pivot = pivot[["Business_id"] + day_list]
    base = kam_df[["Business_id", "Business_name", "KAM_name"]].copy()
    base = base.merge(registration_df, on="Business_id", how="left")
    out = base.merge(pivot, on="Business_id", how="left")
    for business_date in day_list:
        out[business_date] = pd.to_numeric(
            out[business_date], errors="coerce"
        ).fillna(0).astype(int)
    out["Active Days"] = out[day_list].gt(0).sum(axis=1).astype(int)
    out["Registration_date"] = (
        pd.to_datetime(out.get("Registration_date"), errors="coerce")
        .dt.strftime("%Y-%m-%d %H:%M:%S")
        .fillna("")
    )
    date_headers = {
        business_date: f"{business_date.strftime('%b')} {business_date.day}"
        for business_date in day_list
    }
    out.rename(
        columns={
            "Business_id": "Business ID",
            "Business_name": "Business Name",
            "KAM_name": "KAM name",
            "Registration_date": "Onboarded date",
            **date_headers,
        },
        inplace=True,
    )
    final_columns = [
        "Business ID",
        "Business Name",
        "KAM name",
        "Onboarded date",
        *[date_headers[business_date] for business_date in day_list],
        "Active Days",
    ]
    return out[final_columns].sort_values("Business ID").reset_index(drop=True)


def read_existing_targets(ws) -> Dict[str, str]:
    """
    Preserve Target inputs already entered in Retention & Target.

    A newly created tab has no values, so every Target starts blank. On later
    runs, values entered by the web app are retained by KAM name while all
    calculated columns are refreshed.
    """
    headers = ws.row_values(1)
    if not headers:
        return {}
    normalized_headers = [normalize_header(value) for value in headers]
    try:
        kam_col = normalized_headers.index("kam name") + 1
        target_col = normalized_headers.index("target") + 1
    except ValueError:
        return {}
    kam_values = ws.col_values(kam_col)[1:]
    target_values = ws.col_values(target_col)[1:]
    existing: Dict[str, str] = {}
    for idx, kam_name in enumerate(kam_values):
        key = normalize_name(kam_name)
        if not key:
            continue
        target_value = target_values[idx].strip() if idx < len(target_values) else ""
        if target_value:
            existing[key] = target_value
    return existing


def build_retention_target_report(
    kam_df: pd.DataFrame,
    dod_report: pd.DataFrame,
    monthly_metrics_df: pd.DataFrame,
    existing_targets: Dict[str, str] | None = None,
) -> pd.DataFrame:
    """Build the KAM-level Retention & Target summary."""
    existing_targets = existing_targets or {}
    merchants = kam_df[["Business_id", "KAM_name"]].copy()
    merchants["KAM_key"] = merchants["KAM_name"].map(normalize_name)
    merchants = merchants.loc[merchants["KAM_key"].ne("")].copy()
    if merchants.empty:
        return pd.DataFrame(columns=RETENTION_COLUMNS)
    assigned = (
        merchants.groupby("KAM_key", as_index=False)
        .agg(
            KAM_name=("KAM_name", "first"),
            assigned_merchants=("Business_id", "nunique"),
        )
    )
    day_columns = list(dod_report.columns[4:-1])
    dod_working = dod_report[["Business ID", "Active Days", *day_columns]].copy()
    dod_working["Current_month_orders"] = (
        dod_working[day_columns]
        .apply(pd.to_numeric, errors="coerce")
        .fillna(0)
        .sum(axis=1)
    )
    dod_working["Is_currently_active"] = (
        pd.to_numeric(dod_working["Active Days"], errors="coerce")
        .fillna(0)
        .gt(0)
        .astype(int)
    )
    activity = merchants.merge(
        dod_working[
            ["Business ID", "Current_month_orders", "Is_currently_active"]
        ],
        left_on="Business_id",
        right_on="Business ID",
        how="left",
    )
    activity_summary = (
        activity.groupby("KAM_key", as_index=False)
        .agg(
            current_active_merchants=("Is_currently_active", "sum"),
            current_month_orders=("Current_month_orders", "sum"),
        )
    )
    monthly = merchants.merge(monthly_metrics_df, on="Business_id", how="left")
    for column in (
        "Previous_month_orders",
        "Previous_month_rvn",
        "Current_month_rvn",
    ):
        if column not in monthly.columns:
            monthly[column] = 0
        monthly[column] = pd.to_numeric(monthly[column], errors="coerce").fillna(0)
    monthly_summary = (
        monthly.groupby("KAM_key", as_index=False)
        .agg(
            previous_month_orders=("Previous_month_orders", "sum"),
            previous_month_rvn=("Previous_month_rvn", "sum"),
            current_month_rvn=("Current_month_rvn", "sum"),
        )
    )
    summary = assigned.merge(activity_summary, on="KAM_key", how="left")
    summary = summary.merge(monthly_summary, on="KAM_key", how="left")
    numeric_columns = [
        "assigned_merchants",
        "current_active_merchants",
        "previous_month_orders",
        "previous_month_rvn",
        "current_month_orders",
        "current_month_rvn",
    ]
    for column in numeric_columns:
        summary[column] = pd.to_numeric(
            summary[column], errors="coerce"
        ).fillna(0)
    summary = summary.sort_values(
        "KAM_name", key=lambda values: values.str.casefold()
    ).reset_index(drop=True)
    rows: List[List[object]] = []
    for index, row in summary.iterrows():
        sheet_row = index + 2
        target_value = existing_targets.get(row["KAM_key"], "")
        rows.append(
            [
                row["KAM_name"],
                int(row["assigned_merchants"]),
                int(row["current_active_merchants"]),
                f"=IFERROR(C{sheet_row}/B{sheet_row},0)",
                int(row["previous_month_orders"]),
                round(float(row["previous_month_rvn"]), 2),
                int(row["current_month_orders"]),
                round(float(row["current_month_rvn"]), 2),
                f"=IFERROR(G{sheet_row}/E{sheet_row},0)",
                target_value,
                f'=IF(J{sheet_row}="","",E{sheet_row}*(1+J{sheet_row}))',
                f'=IF(J{sheet_row}="","",F{sheet_row}*(1+J{sheet_row}))',
                f"=G{sheet_row}",
                f"=H{sheet_row}",
                (
                    f'=IF(K{sheet_row}="","",'
                    f"IFERROR(M{sheet_row}/K{sheet_row},0))"
                ),
            ]
        )
    return pd.DataFrame(rows, columns=RETENTION_COLUMNS)


def google_sheet_value(value: object) -> object:
    """Convert pandas/SQL numeric and date scalars into JSON-safe values."""
    if value is None:
        return ""
    try:
        if pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, pd.Timestamp):
        return value.to_pydatetime().isoformat(sep=" ")
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    # Convert numpy scalar types (int64, float64, bool_) to Python scalars.
    item_method = getattr(value, "item", None)
    if callable(item_method):
        try:
            return item_method()
        except (TypeError, ValueError):
            pass
    return value


def clear_and_write(ws, df: pd.DataFrame) -> None:
    from gspread.utils import rowcol_to_a1
    raw_rows = df.astype(object).where(pd.notna(df), "").values.tolist()
    values = [df.columns.tolist()] + [
        [google_sheet_value(value) for value in row]
        for row in raw_rows
    ]
    rows_needed = max(len(values), 2)
    cols_needed = len(df.columns)
    ws.resize(
        rows=max(ws.row_count, rows_needed),
        cols=max(ws.col_count, cols_needed),
    )
    ws.batch_clear(["A:ZZ"])
    chunk_size = 1000
    for offset in range(0, len(values), chunk_size):
        chunk = values[offset:offset + chunk_size]
        start_row = offset + 1
        end_row = start_row + len(chunk) - 1
        end_col = rowcol_to_a1(1, cols_needed).rstrip("1")
        ws.update(
            range_name=f"A{start_row}:{end_col}{end_row}",
            values=chunk,
            value_input_option="USER_ENTERED",
        )
    try:
        ws.freeze(rows=1)
        ws.format(
            f"A1:{rowcol_to_a1(1, cols_needed)}",
            {
                "backgroundColor": {"red": 0.12, "green": 0.31, "blue": 0.47},
                "textFormat": {"bold": True, "foregroundColor": {"red": 1, "green": 1, "blue": 1}},
            },
        )
    except Exception as exc:
        print(f"WARNING: data was written but header formatting failed: {exc}")


def format_retention_target_sheet(ws, row_count: int) -> None:
    """Apply readable numeric formats to the Retention & Target tab."""
    if row_count <= 0:
        return
    last_row = row_count + 1
    try:
        for column in ("D", "I", "J", "O"):
            ws.format(
                f"{column}2:{column}{last_row}",
                {"numberFormat": {"type": "PERCENT", "pattern": "0.00%"}},
            )
        for column in ("B", "C", "E", "G", "K", "M"):
            ws.format(
                f"{column}2:{column}{last_row}",
                {"numberFormat": {"type": "NUMBER", "pattern": "#,##0"}},
            )
        for column in ("F", "H", "L", "N"):
            ws.format(
                f"{column}2:{column}{last_row}",
                {"numberFormat": {"type": "NUMBER", "pattern": "#,##0.00"}},
            )
    except Exception as exc:
        print(f"WARNING: Retention & Target number formatting failed: {exc}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build the KAM reports from Google Sheets + OMS + Pegasus and "
            "update the same current-state rows in Supabase."
        )
    )
    parser.add_argument("--source-sheet-id", default=DEFAULT_SOURCE_SHEET_ID)
    parser.add_argument("--output-sheet-id", default=DEFAULT_OUTPUT_SHEET_ID)
    parser.add_argument("--source-tab", default=DEFAULT_SOURCE_TAB)
    parser.add_argument("--output-tab", default=DEFAULT_OUTPUT_TAB)
    parser.add_argument("--dod-tab", default=DEFAULT_DOD_TAB)
    parser.add_argument("--retention-tab", default=DEFAULT_RETENTION_TAB)
    parser.add_argument(
        "--history-start",
        type=parse_date,
        default=DEFAULT_HISTORY_START,
        help="Inclusive BD date, default: 2025-02-01",
    )
    parser.add_argument(
        "--cutoff-date",
        type=parse_date,
        default=None,
        help=(
            "Exclusive 06:00 BD cutoff date. Example: 2026-08-06 means data "
            "before 6 Aug 06:00 BD, so report business day is 5 Aug. "
            "Default: current effective BD business date."
        ),
    )
    parser.add_argument(
        "--dod-start-date",
        type=parse_date,
        default=DEFAULT_DOD_START,
        help=(
            "First KAM DOD business date. Default: first day of the REPORT "
            "business day's month (cutoff date minus one day)."
        ),
    )
    parser.add_argument(
        "--dod-end-date",
        type=parse_date,
        default=DEFAULT_DOD_END,
        help=(
            "Last KAM DOD business date. Default: the true last day of the "
            "DOD month (28, 29, 30 or 31)."
        ),
    )
    parser.add_argument(
        "--skip-supabase",
        action="store_true",
        help="Refresh Google Sheets only (Supabase sync is enabled by default).",
    )
    parser.add_argument(
        "--skip-alerts",
        action="store_true",
        help="Skip web-app alert generation and weekly-call backfill.",
    )
    parser.add_argument(
        "--skip-app-user-sync",
        action="store_true",
        help=(
            "Do not synchronize active KAM directory rows into app_users. "
            "Existing users are never deleted by this job."
        ),
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    cutoff_date = args.cutoff_date or default_cutoff_date()
    # The DOD month follows the REPORT business day, not the cutoff date.
    # Example: --cutoff-date 2026-09-01 reports the 31 Aug business day, so
    # DOD still covers August (1-31). The first September DOD run is
    # --cutoff-date 2026-09-02 (report day 1 Sep). At that moment August's
    # final state is already stored permanently in kam_dod_monthly, so the
    # month rollover loses nothing.
    report_date = cutoff_date - timedelta(days=1)
    dod_start_date = args.dod_start_date or report_date.replace(day=1)
    default_dod_end = dod_start_date.replace(
        day=calendar.monthrange(dod_start_date.year, dod_start_date.month)[1]
    )
    dod_end_date = args.dod_end_date or default_dod_end
    if args.history_start >= cutoff_date:
        raise ValueError("--history-start must be earlier than --cutoff-date")
    if dod_end_date < dod_start_date:
        raise ValueError("--dod-end-date must be on or after --dod-start-date")
    if dod_start_date.day != 1:
        raise ValueError(
            "--dod-start-date must be the first day of the reporting month "
            "so Retention & Target can calculate the full previous month."
        )
    if dod_end_date != default_dod_end:
        raise ValueError(
            "--dod-end-date must be the last day of the same month as "
            f"--dod-start-date ({default_dod_end}), so every month keeps its "
            "true 28/29/30/31-day length."
        )
    previous_date = cutoff_date - timedelta(days=2)
    last_7_start = cutoff_date - timedelta(days=7)
    current_month_start = dod_start_date
    current_period_end = min(dod_end_date + timedelta(days=1), cutoff_date)
    previous_month_end = current_month_start
    previous_month_start = (
        current_month_start - timedelta(days=1)
    ).replace(day=1)
    print(
        f"History window (BD 6AM): {args.history_start} 06:00:00 -> "
        f"{cutoff_date} 06:00:00 exclusive"
    )
    print(
        f"Report business day: {report_date} 06:00:00 -> "
        f"{cutoff_date} 06:00:00 exclusive"
    )
    print(
        f"Previous business day: {previous_date} 06:00:00 -> "
        f"{report_date} 06:00:00 exclusive"
    )
    print(
        f"Last 7 business days: {last_7_start} 06:00:00 -> "
        f"{cutoff_date} 06:00:00 exclusive"
    )
    print(
        f"KAM DOD business dates: {dod_start_date} through "
        f"{dod_end_date} (each 06:00 BD to next-day 06:00 BD)"
    )
    print(
        f"Previous-month retention window: {previous_month_start} 06:00:00 -> "
        f"{previous_month_end} 06:00:00 exclusive"
    )
    print(
        f"Current-month retention window: {current_month_start} 06:00:00 -> "
        f"{current_period_end} 06:00:00 exclusive"
    )
    supabase_engine = None
    if not args.skip_supabase:
        # Fail fast on missing/invalid Supabase configuration before running
        # the heavier OMS, Pegasus, and Google Sheets refresh.
        supabase_engine = get_supabase_engine()
        verify_supabase_connection(supabase_engine)
        ensure_supabase_schema(supabase_engine)
    gc = get_gspread_client()
    source_workbook = gc.open_by_key(args.source_sheet_id)
    kam_df = read_kam_list(source_workbook, args.source_tab)
    if kam_df.empty:
        raise ValueError(f"No valid business IDs found in '{args.source_tab}'.")
    business_ids = kam_df["Business_id"].astype(int).tolist()
    print(f"KAM merchants loaded: {len(business_ids):,}")
    if supabase_engine is not None:
        # app_users is the CRM's KAM-selector directory. Synchronize only
        # after the Google source is validated, and preserve every existing
        # password hash/admin account.
        if not args.skip_app_user_sync:
            sync_app_user_directory(supabase_engine, kam_df)
        # Alert generation MUST run before the report sync overwrites the
        # previous reporting date's button flags. It is deliberately delayed
        # until after source validation so a bad Sheet setting cannot cause a
        # partial alert-only run.
        if not args.skip_alerts:
            generate_pending_alerts(supabase_engine)
    registration_df = fetch_registration_dates(business_ids)
    metrics_df = fetch_oms_metrics(
        business_ids=business_ids,
        history_start=args.history_start,
        cutoff_date=cutoff_date,
    )
    dod_counts_df = fetch_dod_counts(
        business_ids=business_ids,
        start_date=dod_start_date,
        end_date=dod_end_date,
        cutoff_date=cutoff_date,
    )
    retention_monthly_df = fetch_retention_monthly_metrics(
        business_ids=business_ids,
        previous_month_start=previous_month_start,
        current_month_start=current_month_start,
        current_period_end=current_period_end,
    )
    report = build_report(
        kam_df=kam_df,
        registration_df=registration_df,
        metrics_df=metrics_df,
        cutoff_date=cutoff_date,
    )
    dod_report = build_dod_report(
        kam_df=kam_df,
        registration_df=registration_df,
        counts_df=dod_counts_df,
        start_date=dod_start_date,
        end_date=dod_end_date,
    )
    output_workbook = gc.open_by_key(args.output_sheet_id)
    try:
        output_ws = output_workbook.worksheet(args.output_tab)
    except Exception as exc:
        worksheet_not_found = exc.__class__.__name__ == "WorksheetNotFound"
        if not worksheet_not_found:
            raise
        output_ws = output_workbook.add_worksheet(
            title=args.output_tab,
            rows=max(len(report) + 10, 100),
            cols=max(len(OUTPUT_COLUMNS), 20),
        )
    try:
        dod_ws = output_workbook.worksheet(args.dod_tab)
    except Exception as exc:
        worksheet_not_found = exc.__class__.__name__ == "WorksheetNotFound"
        if not worksheet_not_found:
            raise
        dod_ws = output_workbook.add_worksheet(
            title=args.dod_tab,
            rows=max(len(dod_report) + 10, 100),
            cols=max(len(dod_report.columns), 35),
        )
    try:
        retention_ws = output_workbook.worksheet(args.retention_tab)
    except Exception as exc:
        worksheet_not_found = exc.__class__.__name__ == "WorksheetNotFound"
        if not worksheet_not_found:
            raise
        retention_ws = output_workbook.add_worksheet(
            title=args.retention_tab,
            rows=max(kam_df["KAM_name"].nunique() + 10, 100),
            cols=max(len(RETENTION_COLUMNS), 15),
        )
    # New tabs start blank. On later runs, preserve Target percentages. When
    # Supabase already has a KAM row, its Target is the source of truth so a
    # web-app update is also reflected back into Google Sheets.
    existing_targets = read_existing_targets(retention_ws)
    if supabase_engine is not None:
        existing_targets.update(read_supabase_targets(supabase_engine))
    retention_report = build_retention_target_report(
        kam_df=kam_df,
        dod_report=dod_report,
        monthly_metrics_df=retention_monthly_df,
        existing_targets=existing_targets,
    )
    if supabase_engine is not None:
        daily_rows = build_supabase_daily_rows(report, report_date)
        dod_day_dates = [
            dod_start_date + timedelta(days=offset)
            for offset in range((dod_end_date - dod_start_date).days + 1)
        ]
        dod_rows = build_supabase_dod_rows(
            dod_report,
            current_month_start,
            dod_day_dates,
        )
        retention_rows = build_supabase_retention_rows(
            retention_report,
            current_month_start,
        )
        sync_supabase_current_state(
            supabase_engine,
            daily_rows=daily_rows,
            dod_rows=dod_rows,
            retention_rows=retention_rows,
        )
        committed_counts = verify_supabase_row_counts(
            supabase_engine,
            expected_daily_rows=len(daily_rows),
            expected_dod_rows=len(dod_rows),
            expected_retention_rows=len(retention_rows),
        )
        # Post-sync web-app maintenance: weekly-call misses for the last
        # completed BD week and the daily "Summery Report" snapshot.
        if not args.skip_alerts:
            backfill_weekly_call_misses(supabase_engine, report_date)
        summary_rows = build_kam_summary_rows(
            kam_df=kam_df,
            report=report,
            dod_report=dod_report,
            monthly_metrics_df=retention_monthly_df,
            report_date=report_date,
        )
        upsert_kam_summary(supabase_engine, summary_rows)
        supabase_engine.dispose()
        print(
            "Supabase current-state sync committed and verified: "
            f"{committed_counts['daily_rows']:,} daily-report rows, "
            f"{committed_counts['dod_rows']:,} DOD rows, "
            f"{committed_counts['retention_rows']:,} retention rows"
        )
    clear_and_write(output_ws, report)
    clear_and_write(dod_ws, dod_report)
    clear_and_write(retention_ws, retention_report)
    format_retention_target_sheet(retention_ws, len(retention_report))
    print(f"Updated tab: {args.output_tab}")
    print(f"Rows written: {len(report):,}")
    print(f"Updated tab: {args.dod_tab}")
    print(f"Rows written: {len(dod_report):,}")
    print(f"Updated tab: {args.retention_tab}")
    print(f"Rows written: {len(retention_report):,}")
    print(f"Sheet: https://docs.google.com/spreadsheets/d/{args.output_sheet_id}")


if __name__ == "__main__":
    main()
