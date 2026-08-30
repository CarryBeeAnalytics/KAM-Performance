"""
CarryBee Business Insights refresh
==================================

Purpose
-------
Merged job. It takes the five Top-Merchant dashboard datasets that
``selected_merchant_5_tab_backfill`` built for twenty hand-picked merchants and
runs them for EVERY merchant currently assigned to a KAM, on a rolling 30-day
window, writing the result to Supabase instead of Google Sheets. It also builds
the per-merchant monthly state that the KAM CRM Home tab reads.

What it produces
----------------
Supabase (public schema):
  kam_merchant_month    one row per merchant per report month - orders,
                        revenue, discount, week/month/prev-month rollups and
                        the New Onboard / Churn Win / Existing / Inactive
                        classification that drives every Home KPI
  ba_cohort_daily       Sorted Cohort Summary, date x business
  ba_forward_terminal   Forward Aging Analysis - Terminal
  ba_reverse_terminal   Reverse Aging Analysis - Terminal (with RID Type)
  ba_fid_inprocess      FID In Process, aggregated to date x business x
                        status x aging bracket
  ba_rid_inprocess      RID In Process, aggregated with RID Type
  ba_fid_detail /
  ba_rid_detail         parcel-level rows kept for the CSV export button
  ba_refresh_log        one row per run, so the app can state the exact window

Merchant scope
--------------
Read from ``kam_daily_report`` (refreshed by the KAMP merchant-information job)
joined to ``kam_team_directory`` for the Lead. Nothing is hardcoded: adding a
merchant to the Merchant Information sheet is enough for it to appear here on
the next run.

Analytical logic
----------------
Unchanged from the source job, deliberately. The OMS/Pegasus/Mohajon SQL, the
06:00-06:00 BD operational day, the aging brackets, the SLA rule, the Final Fee
formula and the FID/Sorted-Cohort reconciliation check are all carried over
verbatim. Only the merchant scope, the window and the output target are new.

Batching
--------
Merchants are processed in batches (default 400) so an ``IN`` list never grows
unbounded. Each batch runs the full five-dataset pipeline; the results are
concatenated before a single windowed write per table.

Write semantics
---------------
- Windowed tables (cohort, forward/reverse terminal) delete exactly the
  rebuilt date window, then insert. Rows outside the window are untouched.
- Snapshot tables (FID/RID in process and their detail) are truncated and
  rebuilt, because they represent "right now" and not a history.

Required project utilities
--------------------------
    from src.utils.db import get_engine          # OMS, PEGASUS, MOHAJON
    from src.utils.sheets_utils import get_gspread_client   # Hub Info tab only

Supabase credentials come from the environment: SUPABASE_DB_URL, or
SUPABASE_DB_HOST / _PORT / _NAME / _USER / _PASSWORD.

Run examples
------------
    python -m src.jobs.carrybee_business_insights
    python -m src.jobs.carrybee_business_insights --days 30
    python -m src.jobs.carrybee_business_insights --start "2026-08-01 00:00:00" \
                                                  --end   "2026-08-31 00:00:00"
    python -m src.jobs.carrybee_business_insights --limit-merchants 50 --output-mode csv
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone, date
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from sqlalchemy import URL, bindparam, create_engine, text
from sqlalchemy.exc import DBAPIError, OperationalError, ProgrammingError

from src.utils.db import get_engine
from src.utils.sheets_utils import get_gspread_client


# ============================================================
# Configuration
# ============================================================
load_dotenv()

BD_TZ = timezone(timedelta(hours=6))
BD_OFFSET_SQL = "INTERVAL '6 hours'"

# Window defaults are computed at run time; see resolve_window().

DEFAULT_SHEET_ID = "1tZ9XFI96c0dqMRr9eZIp4C0nAGLKKj7WXJZylHaovCk"
HUB_INFO_TAB = "Hub Info"
DEFAULT_OUTPUT_MODE = "none"  # none | csv | excel (Supabase is always written)
DEFAULT_OUT_DIR = r"D:\Carry Bee Projects\carrybee-automation\out\top_merchant_dashboard"
DEFAULT_EXCEL_PATH = r"D:\Carry Bee Projects\carrybee-automation\out\top_merchant_dashboard.xlsx"
DEFAULT_CHUNK_DAYS = 10
DEFAULT_DB_RETRIES = 5
DEFAULT_RETRY_SLEEP_SEC = 10

# The merchant list is no longer hardcoded. It is read at run time from
# kam_daily_report + kam_team_directory in Supabase (load_merchant_scope).
# Use --limit-merchants only for debugging a short run.

PENDING_STATUS = {1, 2, 3}
EXCLUDED_STATUS = {5, 6}
FORWARD_DELIVERED_STATUS = {15, 18, 21, 22}
FORWARD_RETURN_STATUS = {17, 32}
FORWARD_TERMINAL_STATUS = FORWARD_DELIVERED_STATUS | FORWARD_RETURN_STATUS
FORWARD_LOST_DAMAGE_STATUS = {19, 20}
FORWARD_IN_PROCESS_STATUS = {
    4, 7, 8, 9, 10, 11, 12, 13, 14,
    16, 35, 37, 38, 39,
}

REVERSE_TERMINAL_STATUS = {32, 33}  # For aging/status classification only. 33 is also reported as inventory.

TAB_FORWARD_AGING_TERMINAL = "Forward Aging Analysis - Terminal"
TAB_REVERSE_AGING_TERMINAL = "Reverse Aging Analysis - Terminal"
TAB_SORTED_COHORT = "Sorted Cohort Summary"
TAB_FID = "FID In Process"
TAB_RID = "RID In Process"

AGING_TERMINAL_COLS = [
    "Date", "Week", "Month", "Delivery Region", "Delivery Division", "Business ID", "Business Name",
    "1", "2", "3", "4", "5", "6", "7", "7+", "Total",
]

REVERSE_AGING_TERMINAL_COLS = [
    "Date", "Week", "Month", "Delivery Region", "Delivery Division", "Business ID", "Business Name",
    "RID Type", "1", "2", "3", "4", "5", "6", "7", "7+", "Total",
]

# Larger sheet write chunks keep the request count below the Google Sheets per-minute quota.
# Retry/backoff below handles quota spikes and transient API failures.
DEFAULT_SHEET_WRITE_CHUNK_ROWS = 10000
DEFAULT_SHEET_WRITE_RETRIES = 8
DEFAULT_SHEET_QUOTA_SLEEP_SEC = 65
DEFAULT_SHEET_TRANSIENT_SLEEP_SEC = 10

SORTED_COHORT_COLS = [
    "Date", "Week", "Month", "Business ID", "Business Name",
    "Processed", "Delivered", "Return", "Lost & Damage", "In Process",
    "Within SLA", "SLA Breached", "SLA Breach Ratio",
    "Collectable Amount", "Collected Amount", "Delivery Fee", "Discount", "COD Fee", "Final Fee",
    "Adjustment", "Revenue", "Overall Aging",
]

FID_OUTPUT_COLUMNS = [
    "CID", "Business ID", "Business Name", "System Status", "Attempt Count",
    "1st Attempt At", "Attempt Status", "City Name", "Zone Name", "Weight",
    "Pickup Hub", "Pickup Division", "Pickup Region", "Delivery Hub",
    "Delivery Division", "Delivery Region", "Created at", "Sorted at", "LMH at",
    "Transfer Status Updated at", "Aging Bracket", "1st Attempt Aging",
]

RID_OUTPUT_COLUMNS = [
    "CID", "RID Type", "Business ID", "Business Name", "System Status",
    "Created at", "Sorted at", "Transfer Status Updated at", "Corresponding FID",
    "FID Sorted At", "City Name", "Zone Name", "Weight", "Pickup Hub",
    "Pickup Division", "Pickup Region", "Delivery Hub", "Delivery Division",
    "Delivery Region", "RID Aging Bracket", "Entire Aging", "Entire Aging Bracket",
]

# ============================================================
# Logging
# ============================================================
def setup_logger() -> logging.Logger:
    logger = logging.getLogger("top_merchant_dashboard")
    logger.setLevel(logging.INFO)

    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter("[%(asctime)s] %(levelname)s - %(message)s"))
        logger.addHandler(handler)

    return logger


logger = setup_logger()


# ============================================================
# General helpers
# ============================================================
def bd_now() -> datetime:
    return datetime.now(timezone.utc).astimezone(BD_TZ)


def parse_bd_dt(s: str) -> datetime:
    s = (s or "").strip()
    if not s:
        raise ValueError("Empty datetime string")
    if len(s) == 10:
        dt = datetime.strptime(s, "%Y-%m-%d")
    else:
        dt = datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
    return dt.replace(tzinfo=None)


def clean_text(v: Any) -> str:
    if v is None:
        return ""
    try:
        if pd.isna(v):
            return ""
    except Exception:
        pass
    return str(v).strip()


def to_int_or_none(v: Any) -> Optional[int]:
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except Exception:
        pass
    try:
        s = str(v).strip().replace(",", "")
        if not s:
            return None
        return int(float(s))
    except Exception:
        return None


def to_float_or_zero(v: Any) -> float:
    if v is None:
        return 0.0
    try:
        if pd.isna(v):
            return 0.0
    except Exception:
        pass
    try:
        return float(v)
    except Exception:
        return 0.0


def add_week_month_columns(df: pd.DataFrame, date_col: str = "Date") -> pd.DataFrame:
    """Add ISO Week (YYYY-Www) and Month (YYYY-MM) based on a date column."""
    if df.empty or date_col not in df.columns:
        if "Week" not in df.columns:
            df["Week"] = ""
        if "Month" not in df.columns:
            df["Month"] = ""
        return df
    dt = pd.to_datetime(df[date_col], errors="coerce")
    iso = dt.dt.isocalendar()
    df["Week"] = iso["year"].astype("Int64").astype(str) + "-W" + iso["week"].astype("Int64").astype(str).str.zfill(2)
    df.loc[dt.isna(), "Week"] = ""
    df["Month"] = dt.dt.strftime("%Y-%m")
    df["Month"] = df["Month"].fillna("")
    return df


def daterange_chunks(start_dt: datetime, end_dt: datetime, chunk_days: int) -> List[Tuple[datetime, datetime]]:
    if chunk_days <= 0:
        raise ValueError("--chunk-days must be greater than 0")
    chunks: List[Tuple[datetime, datetime]] = []
    cur = start_dt
    while cur < end_dt:
        nxt = min(cur + timedelta(days=chunk_days), end_dt)
        chunks.append((cur, nxt))
        cur = nxt
    return chunks


def concat_nonempty(parts: Sequence[pd.DataFrame], columns: Optional[Sequence[str]] = None) -> pd.DataFrame:
    """Concatenate only non-empty frames to avoid pandas all-NA concat warnings."""
    usable = [p for p in parts if p is not None and not p.empty]
    if not usable:
        return pd.DataFrame(columns=list(columns) if columns is not None else None)
    return pd.concat(usable, ignore_index=True)


def dt_text(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def safe_div(num: Any, den: Any) -> float:
    n = to_float_or_zero(num)
    d = to_float_or_zero(den)
    if d == 0:
        return 0.0
    return round(n / d, 6)


def ensure_datetime(df: pd.DataFrame, cols: Iterable[str]) -> pd.DataFrame:
    for c in cols:
        if c in df.columns:
            df[c] = pd.to_datetime(df[c], errors="coerce")
    return df


def valid_timestamp_series(s: pd.Series) -> pd.Series:
    out = pd.to_datetime(s, errors="coerce")
    return out.mask(out <= pd.Timestamp("1971-01-01 00:00:00"))


def calendar_date_series(s: pd.Series) -> pd.Series:
    return pd.to_datetime(s, errors="coerce").dt.date


def six_am_reporting_date_series(s: pd.Series) -> pd.Series:
    # 1 Jun 06:00 to 2 Jun 05:59:59 is reporting date 1 Jun.
    return (pd.to_datetime(s, errors="coerce") - pd.Timedelta(hours=6)).dt.date


def report_date_bounds(start_bd: datetime, end_bd: datetime) -> Tuple[date, date]:
    # End date is exclusive for date filtering.
    return start_bd.date(), end_bd.date() if end_bd.time() == datetime.min.time() else (end_bd.date() + timedelta(days=1))


def filter_date_range(df: pd.DataFrame, date_col: str, start_date: date, end_date_exclusive: date) -> pd.DataFrame:
    if df.empty or date_col not in df.columns:
        return df.iloc[0:0].copy()
    return df[(df[date_col].notna()) & (df[date_col] >= start_date) & (df[date_col] < end_date_exclusive)].copy()


def make_sheet_safe_value(value: Any) -> Any:
    if value is None:
        return ""
    try:
        if pd.isna(value):
            return ""
    except Exception:
        pass
    if isinstance(value, pd.Timestamp):
        if pd.isna(value):
            return ""
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, date):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value)
    return value


def dataframe_to_sheet_values(df: pd.DataFrame) -> List[List[Any]]:
    return [[make_sheet_safe_value(v) for v in row] for row in df.itertuples(index=False, name=None)]


# ============================================================
# DB helpers
# ============================================================
def fetch_df(
    engine,
    sql: Any,
    params: Optional[Dict[str, Any]] = None,
    expanding_keys: Optional[List[str]] = None,
) -> pd.DataFrame:
    # Accept either raw SQL or an already prepared SQLAlchemy TextClause.
    # FID_SQL/RID_SQL already contain their expanding business_ids bind.
    stmt = text(sql) if isinstance(sql, str) else sql
    if expanding_keys:
        for k in expanding_keys:
            stmt = stmt.bindparams(bindparam(k, expanding=True))
    with engine.connect() as conn:
        return pd.read_sql_query(stmt, con=conn, params=params or {})


def fetch_df_with_retry(
    engine,
    sql: Any,
    params: Optional[Dict[str, Any]] = None,
    expanding_keys: Optional[List[str]] = None,
    retries: int = DEFAULT_DB_RETRIES,
    retry_sleep_sec: int = DEFAULT_RETRY_SLEEP_SEC,
    query_label: str = "DB query",
) -> pd.DataFrame:
    attempt = 1
    while True:
        try:
            return fetch_df(engine, sql, params=params, expanding_keys=expanding_keys)
        except ProgrammingError as e:
            first_line = str(e).splitlines()[0] if str(e).splitlines() else repr(e)
            logger.error("%s failed due to SQL/schema error: %s", query_label, first_line)
            raise
        except (OperationalError, DBAPIError) as e:
            try:
                engine.dispose()
            except Exception:
                pass
            first_line = str(e).splitlines()[0] if str(e).splitlines() else repr(e)
            if attempt >= retries:
                logger.error("%s failed after %s attempts. Last error=%s", query_label, retries, first_line)
                raise
            sleep_for = min(120, retry_sleep_sec * attempt)
            logger.warning(
                "%s failed on attempt %s/%s. Disposed pool; retrying after %ss. Error=%s",
                query_label, attempt, retries, sleep_for, first_line,
            )
            time.sleep(sleep_for)
            attempt += 1


# ============================================================
# SQL
# ============================================================
def build_oms_orders_sql(filter_expr_bd: str, date_filter_sql: str) -> str:
    prefix_expr = "SUBSTRING(UPPER(COALESCE(o.consignment_id, '')) FROM 1 FOR 1)"
    reporting_business_expr = f"""
      CASE
        WHEN {prefix_expr} IN ('R', 'C') THEN COALESCE(o.old_business_id, o.business_id)
        ELSE o.business_id
      END
    """

    return f"""
SELECT
  o.id AS order_id,
  o.consignment_id,

  CASE
    WHEN {prefix_expr} IN ('F', 'E') THEN 'Forward'
    WHEN {prefix_expr} IN ('R', 'C') THEN 'Reverse'
    ELSE ''
  END AS id_type,

  {reporting_business_expr} AS reporting_business_id,
  o.business_id AS oms_business_id,
  o.old_business_id,

  o.transfer_status_id,
  ts.name AS transfer_status_name,

  o.created_at AS created_at_raw,
  o.sorted_at AS sorted_at_raw,
  o.last_mile_at AS last_mile_at_raw,
  o.transfer_status_updated_at AS transfer_status_updated_at_raw,

  (o.created_at + {BD_OFFSET_SQL}) AS created_at_bd,
  (o.sorted_at + {BD_OFFSET_SQL}) AS sorted_at_bd,
  (o.last_mile_at + {BD_OFFSET_SQL}) AS lmh_at_bd,
  (o.transfer_status_updated_at + {BD_OFFSET_SQL}) AS transfer_status_updated_at_bd,
  (o.updated_at + {BD_OFFSET_SQL}) AS updated_at_bd,
  ({filter_expr_bd}) AS driver_ts_bd,

  o.distance_type,

  /* OMS orders.weight is the confirmed parcel weight field. */
  o.weight AS weight_value,

  o.pickup_hub_id,
  ph.name AS pickup_hub_name,

  o.delivery_hub_id,
  dh.name AS delivery_hub_name,

  ROUND(COALESCE(o.collectable_amount, 0) / 100.0, 2) AS collectable_amount_tk,
  ROUND(COALESCE(o.collected_amount, 0) / 100.0, 2) AS collected_amount_tk,
  ROUND(COALESCE(o.delivery_fee, 0) / 100.0, 2) AS delivery_fee_tk,
  ROUND(COALESCE(o.cod_fee, 0) / 100.0, 2) AS cod_fee_tk,
  ROUND(COALESCE(o.discount, 0) / 100.0, 2) AS discount_tk,
  ROUND(COALESCE(o.compensation_amount, 0) / 100.0, 2) AS compensation_amount_tk,

  ROUND(
    CASE
      WHEN o.transfer_status_id = 17 THEN
        (COALESCE(o.delivery_fee, 0) - COALESCE(o.discount, 0))
      ELSE
        (COALESCE(o.delivery_fee, 0) + COALESCE(o.cod_fee, 0) - COALESCE(o.discount, 0))
    END / 100.0,
    2
  ) AS final_fee_tk,

  COALESCE(o.billing_status_id, 0) AS billing_status_id,
  o.payment_invoice_id

FROM orders o
LEFT JOIN transfer_statuses ts ON ts.id = o.transfer_status_id
LEFT JOIN hubs ph ON ph.id = o.pickup_hub_id
LEFT JOIN hubs dh ON dh.id = o.delivery_hub_id
WHERE
  o.consignment_id IS NOT NULL
  AND TRIM(o.consignment_id) <> ''
  AND {prefix_expr} IN ('F', 'E', 'R', 'C')
  AND {reporting_business_expr} IN :business_ids
  {date_filter_sql}
"""


SQL_PEGASUS_BUSINESSES = """
SELECT id AS business_id, name AS business_name
FROM businesses
WHERE id IN :business_ids;
"""

SQL_MOHAJON_FINANCIALS = """
SELECT
  oi.consignment_id,
  ROUND(
    COALESCE(SUM(oi.amount), 0) / 100.0,
    2
  ) AS adjustment_tk
FROM order_invoices oi
WHERE
  oi.business_id IN :business_ids
  AND LOWER(TRIM(COALESCE(oi.invoice_type::text, ''))) = 'adjustment'
  AND oi.consignment_id IS NOT NULL
GROUP BY oi.consignment_id;
"""

# ============================================================
# FID SQL
# ============================================================

FID_SQL = text(
    """
WITH

params AS (
    SELECT
        NOW() AT TIME ZONE 'UTC' AS now_utc
),

candidate_orders AS (
    SELECT
        o.id AS order_id,
        o.consignment_id,
        o.business_id,
        o.transfer_status_id,
        ts.name AS system_status,
        o.created_at AS created_at_raw,
        o.sorted_at AS sorted_at_raw,
        o.last_mile_at AS last_mile_at_raw,
        o.transfer_status_updated_at AS status_updated_at_raw,

        COALESCE(
            o.sorted_at,
            o.created_at
        ) AS aging_base_raw,

        o.pickup_hub_id,
        o.delivery_hub_id,
        o.city_id,
        o.zone_id,
        c.name AS city_name,
        z.name AS zone_name,
        o.weight

    FROM public.orders o

    LEFT JOIN public.transfer_statuses ts
        ON ts.id = o.transfer_status_id

    LEFT JOIN public.cities c
        ON c.id = o.city_id

    LEFT JOIN public.zones z
        ON z.id = o.zone_id

    WHERE
        o.business_id IN :business_ids

        AND (
            o.consignment_id LIKE 'F%'
            OR o.consignment_id LIKE 'E%'
        )

        AND o.transfer_status_id IN (
            4, 7, 8, 9, 10, 11, 12, 13, 14,
            16, 35, 37, 38, 39
        )
),

attempt_ranked AS (
    SELECT
        co.order_id,
        orr.id AS order_run_id,
        orr.run_id,
        orr.created_at AS attempt_at_utc,

        orr.created_at
            + INTERVAL '6 hours'
            AS attempt_at_bd,

        orr.order_run_status,

        CASE orr.order_run_status
            WHEN 1  THEN 'Pending'
            WHEN 2  THEN 'Delivered'
            WHEN 3  THEN 'Returned'
            WHEN 4  THEN 'Hold'
            WHEN 5  THEN 'Lost'
            WHEN 6  THEN 'Damage'
            WHEN 7  THEN 'Partial Delivery'
            WHEN 8  THEN 'Price Change'
            WHEN 9  THEN 'Paid Return'
            WHEN 10 THEN 'Exchange'
            WHEN 11 THEN 'Not Accepted'
            ELSE orr.order_run_status::text
        END AS attempt_status_name,

        ROW_NUMBER() OVER (
            PARTITION BY co.order_id
            ORDER BY
                orr.created_at ASC,
                orr.id ASC
        ) AS first_attempt_rank,

        ROW_NUMBER() OVER (
            PARTITION BY co.order_id
            ORDER BY
                orr.created_at DESC,
                orr.id DESC
        ) AS latest_attempt_rank

    FROM candidate_orders co

    INNER JOIN public.order_runs orr
        ON orr.order_id = co.order_id
       AND orr.deleted_at IS NULL

    INNER JOIN public.runs r
        ON r.id = orr.run_id
       AND r.run_type = 2
),

attempt_summary AS (
    SELECT
        ar.order_id,
        COUNT(*) AS attempt_count,

        MAX(
            ar.attempt_at_utc
        ) FILTER (
            WHERE ar.first_attempt_rank = 1
        ) AS first_attempt_at_utc,

        MAX(
            ar.attempt_at_bd
        ) FILTER (
            WHERE ar.first_attempt_rank = 1
        ) AS first_attempt_at_bd,

        MAX(
            ar.attempt_status_name
        ) FILTER (
            WHERE ar.latest_attempt_rank = 1
        ) AS latest_attempt_status

    FROM attempt_ranked ar

    GROUP BY
        ar.order_id
),

combined AS (
    SELECT
        co.*,

        ph.name AS pickup_hub_name,
        dh.name AS delivery_hub_name,

        COALESCE(
        ats.attempt_count,
        0
        ) AS attempt_count,

        ats.first_attempt_at_utc,
        ats.first_attempt_at_bd,
        ats.latest_attempt_status

    FROM candidate_orders co

    LEFT JOIN public.hubs ph
        ON ph.id = co.pickup_hub_id

    LEFT JOIN public.hubs dh
        ON dh.id = co.delivery_hub_id

    LEFT JOIN attempt_summary ats
        ON ats.order_id = co.order_id
),

calculated AS (
    SELECT
        c.*,

        EXTRACT(
            EPOCH FROM (
                p.now_utc
                - c.aging_base_raw
            )
        ) / 86400.0 AS aging_days,

        CASE
            WHEN c.first_attempt_at_utc IS NOT NULL
            THEN
                EXTRACT(
                    EPOCH FROM (
                        c.first_attempt_at_utc
                        - c.aging_base_raw
                    )
                ) / 86400.0
            ELSE NULL
        END AS first_attempt_aging_days

    FROM combined c

    CROSS JOIN params p
),

final_data AS (
    SELECT
        c.*,

        CASE
            WHEN GREATEST(
                CEIL(c.aging_days::numeric),
                1
            ) > 7
                THEN '7+'

            ELSE
                GREATEST(
                    CEIL(c.aging_days::numeric),
                    1
                )::integer::text
        END AS aging_bracket_final

    FROM calculated c
)

SELECT
    c.consignment_id AS "CID",
    c.business_id AS "Business ID",
    c.system_status AS "System Status",
    c.attempt_count AS "Attempt Count",
    c.first_attempt_at_bd AS "1st Attempt At",
    c.latest_attempt_status AS "Attempt Status",
    c.city_name AS "City Name",
    c.zone_name AS "Zone Name",
    c.weight AS "Weight",
    c.pickup_hub_id AS "_Pickup Hub ID",
    c.pickup_hub_name AS "Pickup Hub",
    c.delivery_hub_id AS "_Delivery Hub ID",
    c.delivery_hub_name AS "Delivery Hub",

    c.created_at_raw
        + INTERVAL '6 hours'
        AS "Created at",

    c.sorted_at_raw
        + INTERVAL '6 hours'
        AS "Sorted at",

    c.last_mile_at_raw
        + INTERVAL '6 hours'
        AS "LMH at",

    c.status_updated_at_raw
        + INTERVAL '6 hours'
        AS "Transfer Status Updated at",

    c.aging_bracket_final AS "Aging Bracket",

    ROUND(
        c.first_attempt_aging_days::numeric,
        1
    ) AS "1st Attempt Aging"

FROM final_data c

ORDER BY
    c.business_id,
    c.aging_base_raw DESC,
    c.consignment_id ASC
"""
).bindparams(
    bindparam(
        "business_ids",
        expanding=True,
    )
)


# ============================================================
# RID SQL
# ============================================================

RID_SQL = text(
    """
WITH

params AS (
    SELECT
        NOW() AT TIME ZONE 'UTC' AS now_utc
),

rid_orders AS (
    SELECT
        o.id AS order_id,
        o.consignment_id,

        CASE
            WHEN o.consignment_id LIKE 'R%' THEN 'Reverse'
            WHEN o.consignment_id LIKE 'C%' THEN 'CR'
            ELSE NULL
        END AS rid_type,

        o.old_business_id
            AS business_id,

        o.transfer_status_id,
        ts.name AS system_status,

        o.created_at
            AS created_at_raw,

        o.sorted_at
            AS sorted_at_raw,

        o.transfer_status_updated_at
            AS status_updated_at_raw,

        o.old_consignment_id
            AS corresponding_fid,

        o.city_id,
        o.zone_id,
        c.name AS city_name,
        z.name AS zone_name,
        o.weight,
        o.pickup_hub_id,
        o.delivery_hub_id

    FROM public.orders o

    LEFT JOIN public.transfer_statuses ts
        ON ts.id = o.transfer_status_id

    LEFT JOIN public.cities c
        ON c.id = o.city_id

    LEFT JOIN public.zones z
        ON z.id = o.zone_id

    WHERE
        o.old_business_id IN :business_ids

        AND o.transfer_status_id IN (
            23,
            24,
            25,
            26,
            27,
            28,
            29,
            30,
            31,
            34,
            35,
            40,
            41,
            42,
            43,
            44,
            45
        )
),

corresponding_fids AS (
    SELECT DISTINCT
        NULLIF(TRIM(corresponding_fid), '') AS corresponding_fid
    FROM rid_orders
    WHERE NULLIF(TRIM(corresponding_fid), '') IS NOT NULL
),

fid_lookup AS (
    SELECT DISTINCT ON (
        o.consignment_id
    )
        o.consignment_id,
        o.sorted_at AS fid_sorted_at_raw

    FROM public.orders o

    INNER JOIN corresponding_fids cf
        ON cf.corresponding_fid = o.consignment_id

    ORDER BY
        o.consignment_id,
        o.id DESC
),

rid_with_fid AS (
    SELECT
        ro.*,
        fl.fid_sorted_at_raw

    FROM rid_orders ro

    LEFT JOIN fid_lookup fl
        ON fl.consignment_id
            = ro.corresponding_fid
),

combined AS (
    SELECT
        rwf.*,

        ph.name AS pickup_hub_name,
        dh.name AS delivery_hub_name

    FROM rid_with_fid rwf

    LEFT JOIN public.hubs ph
        ON ph.id = rwf.pickup_hub_id

    LEFT JOIN public.hubs dh
        ON dh.id = rwf.delivery_hub_id
),

calculated AS (
    SELECT
        c.*,

        /* RID Aging: every CR uses NOW - CR Created At, regardless of FID. */
        CASE
            /* Every C-prefixed return-side CID */
            WHEN c.consignment_id LIKE 'C%'
            THEN
                EXTRACT(
                    EPOCH FROM (
                        p.now_utc
                        - c.created_at_raw
                    )
                ) / 86400.0

            /* R-prefixed RID */
            ELSE
                EXTRACT(
                    EPOCH FROM (
                        p.now_utc
                        - COALESCE(
                            c.sorted_at_raw,
                            c.created_at_raw
                        )
                    )
                ) / 86400.0
        END AS aging_days,

        /* Entire Aging */
        CASE
            WHEN c.consignment_id LIKE 'R%'
             AND c.fid_sorted_at_raw IS NOT NULL
            THEN
                EXTRACT(
                    EPOCH FROM (
                        p.now_utc
                        - c.fid_sorted_at_raw
                    )
                ) / 86400.0

            WHEN c.consignment_id LIKE 'C%'
            THEN
                EXTRACT(
                    EPOCH FROM (
                        p.now_utc
                        - c.created_at_raw
                    )
                ) / 86400.0

            ELSE NULL
        END AS entire_aging_days

    FROM combined c

    CROSS JOIN params p
),

final_data AS (
    SELECT
        c.*,

        CASE
            WHEN c.aging_days IS NULL
                THEN NULL

            WHEN GREATEST(
                CEIL(c.aging_days::numeric),
                1
            ) > 7
                THEN '7+'

            ELSE
                GREATEST(
                    CEIL(c.aging_days::numeric),
                    1
                )::integer::text
        END AS aging_bracket_final,

        CASE
            WHEN c.entire_aging_days IS NULL
                THEN NULL

            WHEN GREATEST(
                CEIL(c.entire_aging_days::numeric),
                1
            ) > 7
                THEN '7+'

            ELSE
                GREATEST(
                    CEIL(c.entire_aging_days::numeric),
                    1
                )::integer::text
        END AS entire_aging_bracket_final

    FROM calculated c
)

SELECT
    c.consignment_id AS "CID",
    c.rid_type AS "RID Type",
    c.business_id AS "Business ID",
    c.system_status AS "System Status",

    c.created_at_raw
        + INTERVAL '6 hours'
        AS "Created at",

    c.sorted_at_raw
        + INTERVAL '6 hours'
        AS "Sorted at",

    c.status_updated_at_raw
        + INTERVAL '6 hours'
        AS "Transfer Status Updated at",

    c.corresponding_fid
        AS "Corresponding FID",

    c.fid_sorted_at_raw
        + INTERVAL '6 hours'
        AS "FID Sorted At",

    c.city_name AS "City Name",
    c.zone_name AS "Zone Name",
    c.weight AS "Weight",
    c.pickup_hub_id AS "_Pickup Hub ID",
    c.pickup_hub_name AS "Pickup Hub",
    c.delivery_hub_id AS "_Delivery Hub ID",
    c.delivery_hub_name AS "Delivery Hub",

    c.aging_bracket_final
        AS "RID Aging Bracket",

    ROUND(
        c.entire_aging_days::numeric,
        2
    ) AS "Entire Aging",

    c.entire_aging_bracket_final
        AS "Entire Aging Bracket"

FROM final_data c

ORDER BY
    c.business_id,

    COALESCE(
        c.sorted_at_raw,
        c.created_at_raw
    ) DESC,

    c.consignment_id ASC
"""
).bindparams(
    bindparam(
        "business_ids",
        expanding=True,
    )
)


# ============================================================
# Database Helpers

# ============================================================
# Fetchers
# ============================================================
def fetch_oms_orders_all_candidates(
    oms_engine,
    start_bd: datetime,
    end_bd: datetime,
    business_ids: Sequence[int],
    chunk_days: int,
    retries: int,
    retry_sleep_sec: int,
) -> pd.DataFrame:
    """Fetch terminal and sorted-cohort candidates once per date chunk.

    Terminal reports are driven by transfer_status_updated_at. Sorted Cohort is
    driven by the 06:00 operational day of sorted_at. Both predicates are kept,
    but they are evaluated in one OMS query instead of five separate scans.
    """
    combined_date_filter = f"""
  AND (
        (
          o.transfer_status_updated_at + {BD_OFFSET_SQL} >= CAST(:start_bd AS timestamp)
          AND o.transfer_status_updated_at + {BD_OFFSET_SQL} < CAST(:end_bd AS timestamp)
        )
        OR
        (
          o.sorted_at + {BD_OFFSET_SQL} >= CAST(:sorted_start_bd AS timestamp)
          AND o.sorted_at + {BD_OFFSET_SQL} < CAST(:sorted_end_bd AS timestamp)
        )
      )
"""
    sql = build_oms_orders_sql(
        f"COALESCE(o.sorted_at, o.created_at) + {BD_OFFSET_SQL}",
        combined_date_filter,
    )
    chunks = daterange_chunks(start_bd, end_bd, chunk_days)
    parts: List[pd.DataFrame] = []
    logger.info("OMS combined historical fetch: %s chunks (one query per chunk)", len(chunks))
    for idx, (chunk_start, chunk_end) in enumerate(chunks, start=1):
        logger.info(
            "Fetching OMS combined chunk %s/%s | BD: %s -> %s",
            idx, len(chunks), dt_text(chunk_start), dt_text(chunk_end),
        )
        df_part = fetch_df_with_retry(
            oms_engine,
            sql,
            params={
                "start_bd": dt_text(chunk_start),
                "end_bd": dt_text(chunk_end),
                # A business date runs 06:00 to 06:00, so sorted boundaries
                # are shifted consistently instead of overlapping chunks.
                "sorted_start_bd": dt_text(chunk_start + timedelta(hours=6)),
                "sorted_end_bd": dt_text(chunk_end + timedelta(hours=6)),
                "business_ids": list(business_ids),
            },
            expanding_keys=["business_ids"],
            retries=retries,
            retry_sleep_sec=retry_sleep_sec,
            query_label=f"OMS combined historical chunk {idx}",
        )
        logger.info("OMS combined chunk %s rows: %s", idx, len(df_part))
        if not df_part.empty:
            df_part["source_filter"] = "combined_terminal_sorted"
            parts.append(df_part)

    if not parts:
        return pd.DataFrame()

    df = concat_nonempty(parts)
    df = ensure_datetime(df, [
        "created_at_bd", "sorted_at_bd", "lmh_at_bd", "transfer_status_updated_at_bd", "updated_at_bd", "driver_ts_bd",
        "created_at_raw", "sorted_at_raw", "last_mile_at_raw", "transfer_status_updated_at_raw",
    ])
    df["consignment_id"] = df["consignment_id"].astype(str).str.strip()
    df = df.sort_values(
        ["updated_at_bd", "transfer_status_updated_at_bd", "order_id"],
        ascending=[True, True, True],
        kind="mergesort",
    ).drop_duplicates(subset=["order_id"], keep="last").reset_index(drop=True)

    logger.info("OMS candidate orders after merge/dedupe: %s", len(df))
    return df



def fetch_pegasus_businesses(
    peg_engine,
    business_ids: Sequence[int],
    retries: int,
    retry_sleep_sec: int,
) -> pd.DataFrame:
    """Fetch merchant names only; hub geography never comes from Pegasus."""
    logger.info("Fetching Pegasus business names...")
    return fetch_df_with_retry(
        peg_engine,
        SQL_PEGASUS_BUSINESSES,
        params={"business_ids": list(business_ids)},
        expanding_keys=["business_ids"],
        retries=retries,
        retry_sleep_sec=retry_sleep_sec,
        query_label="Pegasus businesses",
    )


def _normalized_header(value: Any) -> str:
    """Normalize a Google Sheet header for strict-but-readable matching."""
    return " ".join(clean_text(value).lstrip("\ufeff").lower().replace("_", " ").split())


def fetch_hub_info(sheet_id: str) -> pd.DataFrame:
    """Read the authoritative Hub ID -> name/region/division mapping.

    Required ``Hub Info`` headers:
    - Hub ID
    - Name
    - Region Name
    - Ops Division

    Missing hub mappings remain blank in report outputs; database region and
    cluster values are intentionally never used as fallbacks.
    """
    logger.info("Reading authoritative hub mapping from worksheet '%s'...", HUB_INFO_TAB)
    gc = get_gspread_client()
    sh = safe_sheet_call("open target spreadsheet for Hub Info", gc.open_by_key, sheet_id)
    ws = safe_sheet_call(f"open worksheet {HUB_INFO_TAB}", sh.worksheet, HUB_INFO_TAB)
    values = safe_sheet_call(f"read worksheet {HUB_INFO_TAB}", ws.get_all_values)

    if not values:
        raise ValueError(f"Worksheet '{HUB_INFO_TAB}' is empty")

    raw_headers = [clean_text(x) for x in values[0]]
    normalized = [_normalized_header(x) for x in raw_headers]
    required = {
        "hub id": "hub_id",
        "name": "hub_info_name",
        "region name": "hub_region_name",
        "ops division": "hub_division_name",
    }
    missing = [label for label in required if label not in normalized]
    if missing:
        raise ValueError(
            f"Worksheet '{HUB_INFO_TAB}' is missing required header(s): {', '.join(missing)}. "
            f"Found headers: {raw_headers}"
        )

    positions = {target: normalized.index(source) for source, target in required.items()}
    rows: List[Dict[str, Any]] = []
    for sheet_row, row in enumerate(values[1:], start=2):
        padded = list(row) + [""] * max(0, len(raw_headers) - len(row))
        hub_id = to_int_or_none(padded[positions["hub_id"]])
        if hub_id is None:
            # Fully blank lines are ignored; a populated row with a bad Hub ID
            # is rejected so the geography cannot silently shift to a wrong hub.
            if any(clean_text(cell) for cell in padded):
                raise ValueError(
                    f"Worksheet '{HUB_INFO_TAB}' row {sheet_row} has an invalid Hub ID: "
                    f"{padded[positions['hub_id']]!r}"
                )
            continue
        rows.append({
            "hub_id": hub_id,
            "hub_info_name": clean_text(padded[positions["hub_info_name"]]),
            "hub_region_name": clean_text(padded[positions["hub_region_name"]]),
            "hub_division_name": clean_text(padded[positions["hub_division_name"]]),
        })

    df_hubs = pd.DataFrame(
        rows,
        columns=["hub_id", "hub_info_name", "hub_region_name", "hub_division_name"],
    )
    if df_hubs.empty:
        raise ValueError(f"Worksheet '{HUB_INFO_TAB}' has no valid Hub ID rows")

    duplicate_ids = df_hubs.loc[df_hubs["hub_id"].duplicated(keep=False), "hub_id"].unique().tolist()
    if duplicate_ids:
        raise ValueError(
            f"Worksheet '{HUB_INFO_TAB}' contains duplicate Hub ID(s): {sorted(duplicate_ids)}"
        )

    logger.info("Hub Info mappings loaded: %s", len(df_hubs))
    return df_hubs.sort_values("hub_id", kind="mergesort").reset_index(drop=True)


def fetch_mohajon_financials(
    moh_engine,
    business_ids: Sequence[int],
    retries: int,
    retry_sleep_sec: int,
) -> pd.DataFrame:
    if not business_ids:
        return pd.DataFrame(columns=["consignment_id", "adjustment_tk"])
    logger.info(
        "Fetching Mohajon adjustments once for %s selected business IDs...",
        len(business_ids),
    )
    return fetch_df_with_retry(
        moh_engine,
        SQL_MOHAJON_FINANCIALS,
        params={"business_ids": list(business_ids)},
        expanding_keys=["business_ids"],
        retries=retries,
        retry_sleep_sec=retry_sleep_sec,
        query_label="Mohajon adjustments by business ID",
    )


# Transform helpers
# ============================================================
def add_dimensions(
    df: pd.DataFrame,
    df_biz: pd.DataFrame,
    df_hubs: pd.DataFrame,
) -> pd.DataFrame:
    """Attach business names and Hub Info geography to OMS order rows."""
    if df.empty:
        return df

    df = df.merge(
        df_biz.rename(columns={"business_id": "reporting_business_id"}),
        on="reporting_business_id",
        how="left",
    )

    for side in ("pickup", "delivery"):
        side_map = df_hubs.rename(columns={
            "hub_id": f"{side}_hub_id",
            "hub_info_name": f"{side}_hub_info_name",
            "hub_region_name": f"{side}_region_name",
            "hub_division_name": f"{side}_division_name",
        })
        df = df.merge(side_map, on=f"{side}_hub_id", how="left")

        # Hub names stay on the OMS value; Hub Info Name only fills a missing
        # name. Region/division never fall back to a database table.
        db_name_col = f"{side}_hub_name"
        info_name_col = f"{side}_hub_info_name"
        if db_name_col not in df.columns:
            df[db_name_col] = ""
        info_names = df[info_name_col].replace("", np.nan)
        db_names = df[db_name_col].replace("", np.nan)
        df[db_name_col] = db_names.combine_first(info_names).fillna("")

        region_missing = df[f"{side}_region_name"].fillna("").astype(str).str.strip().eq("")
        division_missing = df[f"{side}_division_name"].fillna("").astype(str).str.strip().eq("")
        unmapped = sorted({
            int(x)
            for x in df.loc[
                df[f"{side}_hub_id"].notna()
                & region_missing
                & division_missing,
                f"{side}_hub_id",
            ].tolist()
        })
        if unmapped:
            logger.warning(
                "Hub Info has no %s mapping for Hub ID(s): %s. "
                "Their region/division outputs will be blank.",
                side,
                unmapped,
            )

    if "business_name" not in df.columns:
        df["business_name"] = ""
    df["business_name"] = df["business_name"].fillna("")

    for c in [
        "pickup_region_name", "pickup_division_name",
        "delivery_region_name", "delivery_division_name",
    ]:
        if c not in df.columns:
            df[c] = ""
        df[c] = df[c].fillna("")

    return df


def enrich_inprocess_detail(
    df: pd.DataFrame,
    df_biz: pd.DataFrame,
    df_hubs: pd.DataFrame,
    output_columns: Sequence[str],
) -> pd.DataFrame:
    """Attach names/geography to the raw FID/RID result and enforce its schema."""
    if df.empty:
        return pd.DataFrame(columns=list(output_columns))

    out = df.copy()
    biz_map = df_biz.rename(columns={
        "business_id": "Business ID",
        "business_name": "Business Name",
    })[["Business ID", "Business Name"]]
    out = out.merge(biz_map, on="Business ID", how="left")
    out["Business Name"] = out["Business Name"].fillna("")

    for side, label in (("Pickup", "Pickup"), ("Delivery", "Delivery")):
        id_col = f"_{side} Hub ID"
        side_map = df_hubs.rename(columns={
            "hub_id": id_col,
            "hub_info_name": f"_{side} Hub Info Name",
            "hub_region_name": f"{label} Region",
            "hub_division_name": f"{label} Division",
        })
        out = out.merge(side_map, on=id_col, how="left")

        # Keep the OMS hub name; use Hub Info Name only as a missing-name fallback.
        info_name = out[f"_{side} Hub Info Name"].replace("", np.nan)
        db_name = out[label + " Hub"].replace("", np.nan)
        out[label + " Hub"] = db_name.combine_first(info_name).fillna("")
        out[label + " Region"] = out[label + " Region"].fillna("")
        out[label + " Division"] = out[label + " Division"].fillna("")

        unmapped = sorted({
            int(x)
            for x in out.loc[
                out[id_col].notna()
                & out[label + " Region"].eq("")
                & out[label + " Division"].eq(""),
                id_col,
            ].tolist()
        })
        if unmapped:
            logger.warning(
                "Hub Info has no %s detail mapping for Hub ID(s): %s. "
                "Their region/division outputs will be blank.",
                label.lower(),
                unmapped,
            )

    out["Business ID"] = out["Business ID"].apply(
        lambda x: int(x) if pd.notna(x) else ""
    )
    for col in output_columns:
        if col not in out.columns:
            out[col] = ""
    return out.reindex(columns=list(output_columns))


def filter_fid_to_cohort_scope(
    df_fid: pd.DataFrame,
    start_bd: datetime,
    end_bd: datetime,
) -> pd.DataFrame:
    """Keep the exact FID/E snapshot that can be assigned to Sorted Cohort.

    Both outputs use the same operational-date rule:
    Bangladesh sorted timestamp minus six hours, so a business day runs from
    06:00 BD to the next 06:00 BD. Rows without a valid sorted_at cannot be
    assigned to a sorted cohort and are therefore excluded from both outputs.
    """
    if df_fid.empty:
        return pd.DataFrame(columns=FID_OUTPUT_COLUMNS)

    out = df_fid.copy()
    sorted_bd = valid_timestamp_series(out["Sorted at"])
    out["_shared_sorted_op_date"] = six_am_reporting_date_series(sorted_bd)
    start_date, end_date_excl = report_date_bounds(start_bd, end_bd)
    out = filter_date_range(
        out,
        "_shared_sorted_op_date",
        start_date,
        end_date_excl,
    )
    # The summary counts distinct CIDs, so the detail tab must have the same
    # one-row-per-business/CID grain for an exact row-count reconciliation.
    out = out.drop_duplicates(subset=["Business ID", "CID"], keep="last")
    out = out.drop(columns=["_shared_sorted_op_date"], errors="ignore")
    return out.reindex(columns=FID_OUTPUT_COLUMNS).reset_index(drop=True)


def aging_bracket_from_days(days: Any) -> str:
    try:
        if pd.isna(days):
            return ""
    except Exception:
        return ""
    d = max(0.0, float(days))
    if d <= 1:
        return "1"
    if d <= 2:
        return "2"
    if d <= 3:
        return "3"
    if d <= 4:
        return "4"
    if d <= 5:
        return "5"
    if d <= 6:
        return "6"
    if d <= 7:
        return "7"
    return "7+"


def sla_threshold_days(distance_type: Any) -> float:
    x = to_int_or_none(distance_type)
    if x in (1, 2):
        return 3.0
    if x in (3, 4, 5):
        return 4.0
    # User confirmed null/outside 1-5 is not expected. Default protects the script.
    return 4.0


def prepare_base_dataframe(
    df_orders: pd.DataFrame,
    df_fin: pd.DataFrame,
) -> pd.DataFrame:
    if df_orders.empty:
        return df_orders

    df = df_orders.copy()
    df = ensure_datetime(df, [
        "created_at_bd", "sorted_at_bd", "lmh_at_bd", "transfer_status_updated_at_bd", "updated_at_bd",
        "created_at_raw", "sorted_at_raw", "last_mile_at_raw", "transfer_status_updated_at_raw",
    ])

    # Forward and standard Reverse aging start from COALESCE(orders.sorted_at,
    # orders.created_at). CR is overridden below to start strictly at Created At.
    # No order_logs lookup is performed.
    df["effective_created_at_bd"] = df["created_at_bd"]

    if df_fin.empty:
        df_fin = pd.DataFrame(columns=["consignment_id", "adjustment_tk"])
    df = df.merge(df_fin, on="consignment_id", how="left")

    money_cols = [
        "collectable_amount_tk", "collected_amount_tk", "delivery_fee_tk", "cod_fee_tk", "discount_tk",
        "final_fee_tk", "adjustment_tk",
    ]
    for c in money_cols:
        if c not in df.columns:
            df[c] = 0.0
        df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0.0)

    # Sorted Cohort Revenue uses OMS final fee minus Mohajon adjustment.
    df["revenue_tk"] = df["final_fee_tk"] - df["adjustment_tk"]

    now_bd_naive = bd_now().replace(tzinfo=None)
    now_series = pd.Series(pd.Timestamp(now_bd_naive), index=df.index)

    sorted_valid = valid_timestamp_series(df["sorted_at_bd"])
    created_valid = valid_timestamp_series(df["effective_created_at_bd"])
    tsu_valid = valid_timestamp_series(df["transfer_status_updated_at_bd"])

    forward_base = sorted_valid.combine_first(created_valid)
    reverse_base = sorted_valid.combine_first(created_valid)

    # CR aging always starts from the CR Created At timestamp.
    # This applies to CR terminal rows here; CR Pending/In Process uses the
    # matching NOW - Created At rule in RID_SQL above.
    cr_reverse_side = (
        df["id_type"].eq("Reverse")
        & df["consignment_id"].astype(str).str.startswith("C", na=False)
    )
    reverse_base.loc[cr_reverse_side] = created_valid.loc[cr_reverse_side]

    forward_terminal_like = df["transfer_status_id"].isin(list(FORWARD_TERMINAL_STATUS | FORWARD_LOST_DAMAGE_STATUS))
    forward_in_process = (
        df["id_type"].eq("Forward")
        & ~df["transfer_status_id"].isin(list(FORWARD_TERMINAL_STATUS | FORWARD_LOST_DAMAGE_STATUS | PENDING_STATUS | EXCLUDED_STATUS))
    )

    reverse_terminal = df["id_type"].eq("Reverse") & df["transfer_status_id"].isin(list(REVERSE_TERMINAL_STATUS))
    reverse_in_process = df["id_type"].eq("Reverse") & ~df["transfer_status_id"].isin(list(REVERSE_TERMINAL_STATUS))

    end_for_aging = pd.Series(pd.NaT, index=df.index, dtype="datetime64[ns]")
    end_for_aging.loc[df["id_type"].eq("Forward") & forward_terminal_like] = tsu_valid.loc[df["id_type"].eq("Forward") & forward_terminal_like]
    end_for_aging.loc[forward_in_process] = now_series.loc[forward_in_process]
    end_for_aging.loc[reverse_terminal] = tsu_valid.loc[reverse_terminal]
    end_for_aging.loc[reverse_in_process] = now_series.loc[reverse_in_process]

    aging_base = pd.Series(pd.NaT, index=df.index, dtype="datetime64[ns]")
    aging_base.loc[df["id_type"].eq("Forward")] = forward_base.loc[df["id_type"].eq("Forward")]
    aging_base.loc[df["id_type"].eq("Reverse")] = reverse_base.loc[df["id_type"].eq("Reverse")]

    # Reverse-only fallback: if sorted and created are both blank, use
    # NOW - transfer_status_updated_at. CR is intentionally excluded because
    # its required aging start is strictly CR Created At.
    reverse_missing_base = (
        df["id_type"].eq("Reverse")
        & ~cr_reverse_side
        & aging_base.isna()
        & tsu_valid.notna()
    )
    aging_base.loc[reverse_missing_base] = tsu_valid.loc[reverse_missing_base]
    end_for_aging.loc[reverse_missing_base] = now_series.loc[reverse_missing_base]

    df["overall_aging_days"] = (end_for_aging - aging_base).dt.total_seconds() / 86400.0
    df.loc[df["overall_aging_days"] < 0, "overall_aging_days"] = 0.0
    df["aging_bracket"] = df["overall_aging_days"].apply(aging_bracket_from_days)

    df["sla_threshold_days"] = df["distance_type"].apply(sla_threshold_days)
    df["sla_eligible"] = df["id_type"].eq("Forward") & ~df["transfer_status_id"].isin(list(PENDING_STATUS | EXCLUDED_STATUS))
    df["sla_breached"] = df["sla_eligible"] & (df["overall_aging_days"] > df["sla_threshold_days"])
    df["within_sla"] = df["sla_eligible"] & ~df["sla_breached"]

    # Active report date drivers.
    df["sorted_op_date"] = six_am_reporting_date_series(df["sorted_at_bd"])
    df["forward_aging_date"] = calendar_date_series(sorted_valid.combine_first(valid_timestamp_series(df["created_at_bd"])))
    df["reverse_aging_date"] = calendar_date_series(sorted_valid.combine_first(created_valid).combine_first(tsu_valid))

    return df


# ============================================================
# Report builders
# ============================================================
def _ensure_aging_bucket_columns(pivot: pd.DataFrame) -> pd.DataFrame:
    for b in ["1", "2", "3", "4", "5", "6", "7", "7+"]:
        if b not in pivot.columns:
            pivot[b] = 0
    pivot["Total"] = pivot[["1", "2", "3", "4", "5", "6", "7", "7+"]].sum(axis=1)
    for c in ["1", "2", "3", "4", "5", "6", "7", "7+", "Total"]:
        pivot[c] = pd.to_numeric(pivot[c], errors="coerce").fillna(0).astype(int)
    return pivot


def build_aging_analysis_terminal(
    df: pd.DataFrame,
    id_type: str,
    start_bd: datetime,
    end_bd: datetime,
) -> pd.DataFrame:
    """Terminal aging report.

    Current structure:
    - Date + Week + Month
    - Delivery Region + Delivery Division from the Hub Info worksheet
    - Business ID + Business Name
    - Aging bucket distribution

    Forward terminal includes only transfer_status_id 15,17,18,21,22,32.
    Lost & Damage is intentionally excluded from this terminal tab.
    Reverse terminal keeps reverse terminal status 32,33.
    """
    output_cols = AGING_TERMINAL_COLS if id_type == "Forward" else REVERSE_AGING_TERMINAL_COLS
    if df.empty:
        return pd.DataFrame(columns=output_cols)

    start_date, end_date_excl = report_date_bounds(start_bd, end_bd)
    if id_type == "Forward":
        dfx = df[
            df["id_type"].eq("Forward")
            & df["transfer_status_id"].isin(list(FORWARD_TERMINAL_STATUS))
        ].copy()
        date_col = "forward_aging_date"
    else:
        dfx = df[
            df["id_type"].eq("Reverse")
            & df["transfer_status_id"].isin(list(REVERSE_TERMINAL_STATUS))
        ].copy()
        date_col = "reverse_aging_date"
        dfx["RID Type"] = np.where(
            dfx["consignment_id"].astype(str).str.startswith("C"),
            "CR",
            "Reverse",
        )

    dfx = filter_date_range(dfx, date_col, start_date, end_date_excl)
    if dfx.empty:
        return pd.DataFrame(columns=output_cols)

    for c in ["delivery_region_name", "delivery_division_name", "business_name"]:
        if c not in dfx.columns:
            dfx[c] = ""
        dfx[c] = dfx[c].fillna("")

    group_cols = [
        date_col, "delivery_region_name", "delivery_division_name",
        "reporting_business_id", "business_name",
    ]
    if id_type != "Forward":
        group_cols.append("RID Type")

    grouped = (
        dfx.groupby(group_cols + ["aging_bracket"], dropna=False)["consignment_id"]
        .nunique()
        .reset_index(name="cnt")
    )

    pivot = grouped.pivot_table(
        index=group_cols,
        columns="aging_bracket",
        values="cnt",
        aggfunc="sum",
        fill_value=0,
    ).reset_index()

    pivot = _ensure_aging_bucket_columns(pivot)
    out = pivot.rename(columns={
        date_col: "Date",
        "delivery_region_name": "Delivery Region",
        "delivery_division_name": "Delivery Division",
        "reporting_business_id": "Business ID",
        "business_name": "Business Name",
    })

    out["Date"] = pd.to_datetime(out["Date"], errors="coerce").dt.strftime("%Y-%m-%d")
    out = add_week_month_columns(out, "Date")
    out["Business ID"] = out["Business ID"].apply(lambda x: int(x) if pd.notna(x) else "")
    sort_cols = ["Date", "Delivery Region", "Delivery Division", "Business ID"]
    if id_type != "Forward":
        sort_cols.append("RID Type")
    out = out.sort_values(sort_cols, ascending=True).reset_index(drop=True)
    return out[output_cols]


def build_sorted_cohort_summary(
    df: pd.DataFrame,
    df_fid_inprocess: pd.DataFrame,
    start_bd: datetime,
    end_bd: datetime,
) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame(columns=SORTED_COHORT_COLS)

    start_date, end_date_excl = report_date_bounds(start_bd, end_bd)
    dfx = df[
        df["id_type"].eq("Forward")
        & ~df["transfer_status_id"].isin(list(PENDING_STATUS | EXCLUDED_STATUS))
    ].copy()
    dfx = filter_date_range(dfx, "sorted_op_date", start_date, end_date_excl)
    if dfx.empty:
        return pd.DataFrame(columns=SORTED_COHORT_COLS)

    group_cols = ["sorted_op_date", "reporting_business_id", "business_name"]
    base = (
        dfx.groupby(group_cols, dropna=False)["consignment_id"]
        .nunique().reset_index(name="Processed")
    )

    def _count_status(status_set: Set[int], name: str) -> pd.DataFrame:
        return (
            dfx[dfx["transfer_status_id"].isin(list(status_set))]
            .groupby(group_cols, dropna=False)["consignment_id"]
            .nunique().reset_index(name=name)
        )

    parts = [
        base,
        _count_status(FORWARD_DELIVERED_STATUS, "Delivered"),
        _count_status(FORWARD_RETURN_STATUS, "Return"),
        _count_status(FORWARD_LOST_DAMAGE_STATUS, "Lost & Damage"),
        dfx[dfx["within_sla"]].groupby(group_cols, dropna=False)["consignment_id"].nunique().reset_index(name="Within SLA"),
        dfx[dfx["sla_breached"]].groupby(group_cols, dropna=False)["consignment_id"].nunique().reset_index(name="SLA Breached"),
    ]

    out = parts[0]
    for p in parts[1:]:
        out = out.merge(p, on=group_cols, how="left")

    # In Process is sourced only from the exact same current FID/E snapshot
    # written to the detail tab. This removes differences caused by separate
    # status snapshots or different CID/status filters.
    if df_fid_inprocess.empty:
        inprocess = pd.DataFrame(columns=group_cols + ["In Process"])
    else:
        fid = df_fid_inprocess.copy()
        fid["sorted_op_date"] = six_am_reporting_date_series(
            valid_timestamp_series(fid["Sorted at"])
        )
        inprocess = (
            fid.groupby(
                ["sorted_op_date", "Business ID", "Business Name"],
                dropna=False,
            )["CID"]
            .nunique()
            .reset_index(name="In Process")
            .rename(columns={
                "Business ID": "reporting_business_id",
                "Business Name": "business_name",
            })
        )

    out = out.merge(inprocess, on=group_cols, how="outer")

    overall_age = (
        dfx[dfx["overall_aging_days"].notna()]
        .groupby(group_cols, dropna=False)["overall_aging_days"]
        .mean().round(2)
        .reset_index(name="Overall Aging")
    )
    for attempt_part in [overall_age]:
        out = out.merge(attempt_part, on=group_cols, how="left")

    # Monetary fields exclude Lost & Damage statuses 19,20 as requested.
    dfx_money = dfx[~dfx["transfer_status_id"].isin(list(FORWARD_LOST_DAMAGE_STATUS))].copy()
    sum_cols_map = {
        "collectable_amount_tk": "Collectable Amount",
        "collected_amount_tk": "Collected Amount",
        "delivery_fee_tk": "Delivery Fee",
        "discount_tk": "Discount",
        "cod_fee_tk": "COD Fee",
        "final_fee_tk": "Final Fee",
        "adjustment_tk": "Adjustment",
        "revenue_tk": "Revenue",
    }
    fin = (
        dfx_money.groupby(group_cols, dropna=False)[list(sum_cols_map.keys())]
        .sum()
        .round(2)
        .reset_index()
        .rename(columns=sum_cols_map)
    )
    out = out.merge(fin, on=group_cols, how="left")

    out = out.rename(columns={"sorted_op_date": "Date", "reporting_business_id": "Business ID", "business_name": "Business Name"})
    for c in SORTED_COHORT_COLS:
        if c not in out.columns and c not in ("Date", "Week", "Month", "Business ID", "Business Name"):
            out[c] = 0
    for c in ["Delivered", "Return", "Lost & Damage", "In Process", "Within SLA", "SLA Breached"]:
        out[c] = pd.to_numeric(out[c], errors="coerce").fillna(0).astype(int)
    out["Processed"] = pd.to_numeric(out["Processed"], errors="coerce").fillna(0).astype(int)
    out["SLA Breach Ratio"] = [safe_div(b, w + b) for w, b in zip(out["Within SLA"], out["SLA Breached"])]

    out["Date"] = pd.to_datetime(out["Date"], errors="coerce").dt.strftime("%Y-%m-%d")
    out = add_week_month_columns(out, "Date")
    out["Business ID"] = out["Business ID"].apply(lambda x: int(x) if pd.notna(x) else "")
    money_cols = [
        "Collectable Amount", "Collected Amount", "Delivery Fee", "Discount", "COD Fee", "Final Fee",
        "Adjustment", "Revenue",
    ]
    for c in money_cols:
        out[c] = pd.to_numeric(out[c], errors="coerce").fillna(0).round(2)
    for c in ["Overall Aging"]:
        out[c] = pd.to_numeric(out[c], errors="coerce").fillna(0).round(2)
    out = out.sort_values(["Date", "Business ID"]).reset_index(drop=True)
    return out[SORTED_COHORT_COLS]


def validate_fid_cohort_reconciliation(
    df_fid: pd.DataFrame,
    df_cohort: pd.DataFrame,
) -> None:
    """Fail before writing if shared FID and cohort totals do not reconcile."""
    fid_by_business = (
        df_fid.groupby("Business ID", dropna=False)["CID"].nunique()
        if not df_fid.empty else pd.Series(dtype="int64")
    )
    cohort_by_business = (
        df_cohort.groupby("Business ID", dropna=False)["In Process"].sum()
        if not df_cohort.empty else pd.Series(dtype="int64")
    )
    all_business_ids = fid_by_business.index.union(cohort_by_business.index)
    mismatches: List[str] = []
    for business_id in all_business_ids:
        fid_count = int(fid_by_business.get(business_id, 0))
        cohort_count = int(cohort_by_business.get(business_id, 0))
        if fid_count != cohort_count:
            mismatches.append(
                f"Business ID {business_id}: FID={fid_count}, Cohort={cohort_count}"
            )

    if mismatches:
        raise ValueError(
            "FID/Sorted Cohort In Process reconciliation failed: "
            + "; ".join(mismatches)
        )

    logger.info(
        "FID/Sorted Cohort reconciliation passed: %s distinct CIDs in both outputs",
        int(df_fid["CID"].nunique()) if not df_fid.empty else 0,
    )


# Output writers
# ============================================================
def get_or_create_ws(sh, title: str, rows: int = 200, cols: int = 20):
    try:
        return sh.worksheet(title)
    except Exception:
        logger.warning("Worksheet '%s' not found. Creating it.", title)
        return safe_sheet_call(
            f"create worksheet {title}",
            sh.add_worksheet,
            title=title,
            rows=rows,
            cols=cols,
        )


def _is_quota_or_transient_sheet_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(token in msg for token in [
        "429", "quota exceeded", "rate limit", "internal error", "backend error", "503", "500", "temporarily unavailable",
    ])


def safe_sheet_call(action_name: str, func, *args, **kwargs):
    """Run a Google Sheets API call with retry/backoff for 429 write quota errors."""
    max_retries = int(kwargs.pop("max_retries", DEFAULT_SHEET_WRITE_RETRIES))
    for attempt in range(1, max_retries + 1):
        try:
            return func(*args, **kwargs)
        except Exception as exc:
            if not _is_quota_or_transient_sheet_error(exc) or attempt >= max_retries:
                logger.error("Google Sheets action failed: %s | Error=%s", action_name, str(exc).splitlines()[0])
                raise

            msg = str(exc).lower()
            if "429" in msg or "quota" in msg or "rate limit" in msg:
                sleep_for = DEFAULT_SHEET_QUOTA_SLEEP_SEC + (attempt - 1) * 10
            else:
                sleep_for = min(60, DEFAULT_SHEET_TRANSIENT_SLEEP_SEC * attempt)

            logger.warning(
                "Google Sheets action '%s' failed on attempt %s/%s. Retrying after %ss. Error=%s",
                action_name,
                attempt,
                max_retries,
                sleep_for,
                str(exc).splitlines()[0],
            )
            time.sleep(sleep_for)


def update_range_chunked(ws, start_row: int, start_col: int, values: List[List[Any]], chunk_rows: int = DEFAULT_SHEET_WRITE_CHUNK_ROWS) -> None:
    if not values:
        return
    from gspread.utils import rowcol_to_a1

    n_rows = len(values)
    n_cols = len(values[0]) if n_rows else 0
    req_rows = start_row + n_rows - 1
    req_cols = start_col + n_cols - 1
    if ws.row_count < req_rows or ws.col_count < req_cols:
        safe_sheet_call(
            f"resize {ws.title}",
            ws.resize,
            rows=max(ws.row_count, req_rows),
            cols=max(ws.col_count, req_cols),
        )

    for i in range(0, n_rows, chunk_rows):
        chunk = values[i:i + chunk_rows]
        r1 = start_row + i
        r2 = r1 + len(chunk) - 1
        c1 = start_col
        c2 = start_col + n_cols - 1
        rng = f"{rowcol_to_a1(r1, c1)}:{rowcol_to_a1(r2, c2)}"
        logger.info("Updating '%s' range %s rows=%s", ws.title, rng, len(chunk))
        safe_sheet_call(
            f"update {ws.title} {rng}",
            ws.update,
            range_name=rng,
            values=chunk,
            value_input_option="RAW",
        )


def write_df_to_sheet(ws, df: pd.DataFrame, header_cols: List[str], chunk_rows: int = DEFAULT_SHEET_WRITE_CHUNK_ROWS) -> None:
    safe_sheet_call(f"clear {ws.title}", ws.clear)
    safe_sheet_call(
        f"resize {ws.title}",
        ws.resize,
        rows=max(len(df) + 1, 2),
        cols=max(len(header_cols), 1),
    )
    safe_sheet_call(
        f"write header {ws.title}",
        ws.update,
        range_name="A1",
        values=[header_cols],
        value_input_option="RAW",
    )
    if df.empty:
        return
    dfw = df.reindex(columns=header_cols)
    update_range_chunked(ws, 2, 1, dataframe_to_sheet_values(dfw), chunk_rows=chunk_rows)


def write_outputs_to_sheets(sheet_id: str, outputs: Dict[str, pd.DataFrame]) -> None:
    gc = get_gspread_client()
    sh = gc.open_by_key(sheet_id)

    tab_cols = {
        TAB_FORWARD_AGING_TERMINAL: AGING_TERMINAL_COLS,
        TAB_REVERSE_AGING_TERMINAL: REVERSE_AGING_TERMINAL_COLS,
        TAB_SORTED_COHORT: SORTED_COHORT_COLS,
        TAB_FID: FID_OUTPUT_COLUMNS,
        TAB_RID: RID_OUTPUT_COLUMNS,
    }
    for tab, cols in tab_cols.items():
        df = outputs.get(tab, pd.DataFrame(columns=cols))
        logger.info("Writing Google Sheet tab '%s' rows=%s cols=%s", tab, len(df), len(cols))
        ws = get_or_create_ws(sh, tab, rows=max(200, len(df) + 1), cols=len(cols))
        write_df_to_sheet(ws, df, cols, chunk_rows=DEFAULT_SHEET_WRITE_CHUNK_ROWS)

def write_outputs_to_csv(out_dir: str, outputs: Dict[str, pd.DataFrame]) -> None:
    os.makedirs(out_dir, exist_ok=True)
    for tab, df in outputs.items():
        filename = tab.lower().replace(" - ", "_").replace(" ", "_") + ".csv"
        path = os.path.join(out_dir, filename)
        df.to_csv(path, index=False, encoding="utf-8-sig")
        logger.info("CSV written: %s rows=%s", path, len(df))


def write_outputs_to_excel(excel_path: str, outputs: Dict[str, pd.DataFrame]) -> None:
    out_dir = os.path.dirname(excel_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with pd.ExcelWriter(excel_path, engine="openpyxl") as writer:
        for tab, df in outputs.items():
            # Excel sheet names max 31 chars; all current names fit.
            df.to_excel(writer, sheet_name=tab[:31], index=False)
    logger.info("Excel workbook written: %s", excel_path)


# ============================================================
# v3 ADDITIONS - merchant scope, Supabase target, orchestration
# ============================================================

SUPABASE_SCHEMA = "public"
SUPABASE_EXPECTED_PROJECT_REF = "wrlntwvgsjonvcxytocx"
SUPABASE_EXPECTED_HOST = "aws-0-ap-southeast-1.pooler.supabase.com"

# Statuses used for the monthly revenue roll-up. Revenue is only recognised on
# a terminal parcel, so the in-process statuses in PROCESSED_STATUS_IDS are
# deliberately excluded here even though they count as processed orders.
MONTHLY_PROCESSED_STATUS_IDS: Tuple[int, ...] = (
    4, 7, 8, 9, 10, 11, 12, 13, 14,
    15, 16, 17, 18, 19, 20, 21, 22,
    35, 37, 38, 39,
)
MONTHLY_REVENUE_STATUS_IDS: Tuple[int, ...] = (15, 17, 18, 21, 22)

# A merchant counts as Active when it processed at least one order in the
# trailing 30 days ending at the cutoff. Matches the churn-risk ladder in the
# DIR data dictionary (Early churn risk starts at 3 days inactive; Churned at
# more than 30).
ACTIVE_WINDOW_DAYS = 30
# Churn Win: at least this many days between the last pre-month order and the
# first order inside the month.
CHURN_WIN_GAP_DAYS = 30

DEFAULT_WINDOW_DAYS = 30
DEFAULT_MERCHANT_BATCH = 400


# ------------------------------------------------------------
# Supabase connection
# ------------------------------------------------------------
def get_supabase_engine():
    """
    Engine for the KAM CRM Supabase project only.

    DATABASE_URL is never used as a fallback: that variable points at the OMS
    application database, and falling back to it would report a successful
    sync while the Supabase project stayed empty.
    """
    url = os.getenv("SUPABASE_DB_URL", "").strip()
    if url:
        engine = create_engine(url, pool_pre_ping=True, future=True)
    else:
        required = ["SUPABASE_DB_HOST", "SUPABASE_DB_USER", "SUPABASE_DB_PASSWORD"]
        missing = [name for name in required if not os.getenv(name, "").strip()]
        if missing:
            raise RuntimeError(
                "Supabase configuration is incomplete. Set SUPABASE_DB_URL, or "
                f"all of: {', '.join(missing)}"
            )
        engine = create_engine(
            URL.create(
                "postgresql+psycopg2",
                username=os.getenv("SUPABASE_DB_USER").strip(),
                password=os.getenv("SUPABASE_DB_PASSWORD"),
                host=os.getenv("SUPABASE_DB_HOST").strip(),
                port=int(os.getenv("SUPABASE_DB_PORT", "5432")),
                database=os.getenv("SUPABASE_DB_NAME", "postgres").strip(),
                query={"sslmode": os.getenv("SUPABASE_DB_SSLMODE", "require").strip() or "require"},
            ),
            pool_pre_ping=True,
            future=True,
        )

    with engine.connect() as conn:
        row = conn.execute(text(
            "SELECT current_database(), inet_server_addr()::text, current_user"
        )).first()
    logger.info("Supabase connected: database=%s user=%s", row[0], row[2])
    return engine


def ensure_business_insights_schema(engine) -> None:
    """
    Create the ba_* and kam_merchant_month objects if they are absent.

    This mirrors supabase/schema_v3.sql exactly and is safe to re-run. The SQL
    file stays the authoritative reference; this function only guarantees a
    fresh environment can run the job without a manual step.
    """
    ddl = f"""
    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.kam_merchant_month (
        business_id bigint NOT NULL,
        report_month date NOT NULL,
        business_name text NOT NULL DEFAULT '',
        kam_name text NOT NULL DEFAULT '',
        lead_name text NOT NULL DEFAULT '',
        acquisition_type text NOT NULL DEFAULT '',
        orders_month bigint NOT NULL DEFAULT 0,
        orders_prev_month bigint NOT NULL DEFAULT 0,
        orders_last_week bigint NOT NULL DEFAULT 0,
        orders_prev_day bigint NOT NULL DEFAULT 0,
        active_days_month integer NOT NULL DEFAULT 0,
        revenue_month numeric(20,2) NOT NULL DEFAULT 0,
        revenue_prev_month numeric(20,2) NOT NULL DEFAULT 0,
        discount_month numeric(20,2) NOT NULL DEFAULT 0,
        gross_fee_month numeric(20,2) NOT NULL DEFAULT 0,
        first_order_date date,
        last_order_date date,
        last_order_before_month date,
        first_order_in_month date,
        churn_gap_days integer,
        classification text NOT NULL DEFAULT 'Inactive',
        is_active_30d boolean NOT NULL DEFAULT false,
        refreshed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, report_month)
    );

    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.ba_cohort_daily (
        report_date date NOT NULL,
        business_id bigint NOT NULL,
        business_name text NOT NULL DEFAULT '',
        kam_name text NOT NULL DEFAULT '',
        lead_name text NOT NULL DEFAULT '',
        processed bigint NOT NULL DEFAULT 0,
        delivered bigint NOT NULL DEFAULT 0,
        returned bigint NOT NULL DEFAULT 0,
        lost_damage bigint NOT NULL DEFAULT 0,
        in_process bigint NOT NULL DEFAULT 0,
        within_sla bigint NOT NULL DEFAULT 0,
        sla_breached bigint NOT NULL DEFAULT 0,
        collectable_amount numeric(20,2) NOT NULL DEFAULT 0,
        collected_amount numeric(20,2) NOT NULL DEFAULT 0,
        delivery_fee numeric(20,2) NOT NULL DEFAULT 0,
        discount numeric(20,2) NOT NULL DEFAULT 0,
        cod_fee numeric(20,2) NOT NULL DEFAULT 0,
        final_fee numeric(20,2) NOT NULL DEFAULT 0,
        adjustment numeric(20,2) NOT NULL DEFAULT 0,
        revenue numeric(20,2) NOT NULL DEFAULT 0,
        overall_aging numeric(20,4) NOT NULL DEFAULT 0,
        refreshed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (report_date, business_id)
    );

    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.ba_forward_terminal (
        report_date date NOT NULL,
        business_id bigint NOT NULL,
        delivery_region text NOT NULL DEFAULT 'Unknown',
        delivery_division text NOT NULL DEFAULT 'Unknown',
        business_name text NOT NULL DEFAULT '',
        kam_name text NOT NULL DEFAULT '',
        lead_name text NOT NULL DEFAULT '',
        b1 bigint NOT NULL DEFAULT 0, b2 bigint NOT NULL DEFAULT 0,
        b3 bigint NOT NULL DEFAULT 0, b4 bigint NOT NULL DEFAULT 0,
        b5 bigint NOT NULL DEFAULT 0, b6 bigint NOT NULL DEFAULT 0,
        b7 bigint NOT NULL DEFAULT 0, b7_plus bigint NOT NULL DEFAULT 0,
        total bigint NOT NULL DEFAULT 0,
        refreshed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (report_date, business_id, delivery_region, delivery_division)
    );

    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.ba_reverse_terminal (
        report_date date NOT NULL,
        business_id bigint NOT NULL,
        rid_type text NOT NULL DEFAULT 'Reverse',
        delivery_region text NOT NULL DEFAULT 'Unknown',
        delivery_division text NOT NULL DEFAULT 'Unknown',
        business_name text NOT NULL DEFAULT '',
        kam_name text NOT NULL DEFAULT '',
        lead_name text NOT NULL DEFAULT '',
        b1 bigint NOT NULL DEFAULT 0, b2 bigint NOT NULL DEFAULT 0,
        b3 bigint NOT NULL DEFAULT 0, b4 bigint NOT NULL DEFAULT 0,
        b5 bigint NOT NULL DEFAULT 0, b6 bigint NOT NULL DEFAULT 0,
        b7 bigint NOT NULL DEFAULT 0, b7_plus bigint NOT NULL DEFAULT 0,
        total bigint NOT NULL DEFAULT 0,
        refreshed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (report_date, business_id, rid_type, delivery_region, delivery_division)
    );

    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.ba_fid_inprocess (
        snapshot_date date NOT NULL,
        business_id bigint NOT NULL,
        system_status text NOT NULL DEFAULT 'Unknown',
        aging_bracket text NOT NULL DEFAULT 'Unknown',
        business_name text NOT NULL DEFAULT '',
        kam_name text NOT NULL DEFAULT '',
        lead_name text NOT NULL DEFAULT '',
        parcels bigint NOT NULL DEFAULT 0,
        refreshed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (snapshot_date, business_id, system_status, aging_bracket)
    );

    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.ba_rid_inprocess (
        snapshot_date date NOT NULL,
        business_id bigint NOT NULL,
        rid_type text NOT NULL DEFAULT 'Unknown',
        system_status text NOT NULL DEFAULT 'Unknown',
        rid_aging_bracket text NOT NULL DEFAULT 'Unknown',
        business_name text NOT NULL DEFAULT '',
        kam_name text NOT NULL DEFAULT '',
        lead_name text NOT NULL DEFAULT '',
        cids bigint NOT NULL DEFAULT 0,
        refreshed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (snapshot_date, business_id, rid_type, system_status, rid_aging_bracket)
    );

    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.ba_fid_detail (
        cid text PRIMARY KEY,
        business_id bigint NOT NULL,
        business_name text NOT NULL DEFAULT '',
        kam_name text NOT NULL DEFAULT '',
        lead_name text NOT NULL DEFAULT '',
        system_status text NOT NULL DEFAULT '',
        attempt_count integer NOT NULL DEFAULT 0,
        first_attempt_at timestamp,
        attempt_status text NOT NULL DEFAULT '',
        city_name text NOT NULL DEFAULT '',
        zone_name text NOT NULL DEFAULT '',
        weight numeric(20,3),
        pickup_hub text NOT NULL DEFAULT '',
        pickup_division text NOT NULL DEFAULT '',
        pickup_region text NOT NULL DEFAULT '',
        delivery_hub text NOT NULL DEFAULT '',
        delivery_division text NOT NULL DEFAULT '',
        delivery_region text NOT NULL DEFAULT '',
        created_at_bd timestamp,
        sorted_at_bd timestamp,
        lmh_at_bd timestamp,
        transfer_status_updated_bd timestamp,
        snapshot_date date,
        aging_bracket text NOT NULL DEFAULT '',
        first_attempt_aging numeric(20,4),
        refreshed_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.ba_rid_detail (
        cid text PRIMARY KEY,
        rid_type text NOT NULL DEFAULT '',
        business_id bigint NOT NULL,
        business_name text NOT NULL DEFAULT '',
        kam_name text NOT NULL DEFAULT '',
        lead_name text NOT NULL DEFAULT '',
        system_status text NOT NULL DEFAULT '',
        created_at_bd timestamp,
        sorted_at_bd timestamp,
        transfer_status_updated_bd timestamp,
        corresponding_fid text NOT NULL DEFAULT '',
        fid_sorted_at_bd timestamp,
        city_name text NOT NULL DEFAULT '',
        zone_name text NOT NULL DEFAULT '',
        weight numeric(20,3),
        pickup_hub text NOT NULL DEFAULT '',
        pickup_division text NOT NULL DEFAULT '',
        pickup_region text NOT NULL DEFAULT '',
        delivery_hub text NOT NULL DEFAULT '',
        delivery_division text NOT NULL DEFAULT '',
        delivery_region text NOT NULL DEFAULT '',
        snapshot_date date,
        rid_aging_bracket text NOT NULL DEFAULT '',
        entire_aging numeric(20,4),
        entire_aging_bracket text NOT NULL DEFAULT '',
        refreshed_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS {SUPABASE_SCHEMA}.ba_refresh_log (
        id bigserial PRIMARY KEY,
        window_start date NOT NULL,
        window_end date NOT NULL,
        merchants integer NOT NULL DEFAULT 0,
        cohort_rows integer NOT NULL DEFAULT 0,
        fwd_rows integer NOT NULL DEFAULT 0,
        rev_rows integer NOT NULL DEFAULT 0,
        fid_rows integer NOT NULL DEFAULT 0,
        rid_rows integer NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'ok',
        message text NOT NULL DEFAULT '',
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz
    );
    """
    with engine.begin() as conn:
        conn.execute(text(ddl))
    logger.info("Business Insights schema verified.")


# ------------------------------------------------------------
# Merchant scope: every merchant currently assigned to a KAM
# ------------------------------------------------------------
def load_merchant_scope(engine) -> pd.DataFrame:
    """
    Read the merchant book from kam_daily_report, which the KAMP job refreshes
    from the Merchant Information worksheet, and attach the Lead/Team from
    kam_team_directory. The directory is the single source of truth for
    lead_name: kam_daily_report.lead_name is a mirror and can lag by one run.
    """
    sql = f"""
    SELECT
        d.business_id,
        COALESCE(NULLIF(btrim(d.business_name), ''), '') AS business_name,
        COALESCE(NULLIF(btrim(d.kam_name), ''), 'Not Specified') AS kam_name,
        COALESCE(NULLIF(btrim(t.lead_name), ''), NULLIF(btrim(d.lead_name), ''), '')
            AS lead_name,
        COALESCE(d.acquisition_type, '') AS acquisition_type
    FROM {SUPABASE_SCHEMA}.kam_daily_report d
    LEFT JOIN {SUPABASE_SCHEMA}.kam_team_directory t
           ON lower(btrim(t.kam_name)) = lower(btrim(d.kam_name))
    ORDER BY d.business_id
    """
    with engine.connect() as conn:
        df = pd.read_sql_query(text(sql), con=conn)
    df["business_id"] = pd.to_numeric(df["business_id"], errors="coerce").astype("Int64")
    df = df.dropna(subset=["business_id"]).drop_duplicates(subset=["business_id"])
    df["business_id"] = df["business_id"].astype(int)
    logger.info("Merchant scope loaded from Supabase: %s merchants", len(df))
    if df.empty:
        raise RuntimeError(
            "kam_daily_report is empty. Run the KAMP merchant-information job "
            "first so the merchant book exists."
        )
    return df.reset_index(drop=True)


# ------------------------------------------------------------
# Monthly merchant state (Home KPIs)
# ------------------------------------------------------------
MONTHLY_STATE_SQL = """
WITH filtered AS (
    SELECT
        o.business_id,
        o.consignment_id,
        o.transfer_status_id,
        COALESCE(o.sorted_at, o.created_at)::date AS business_date,
        ROUND(
            CASE
                WHEN o.transfer_status_id = 17
                    THEN (COALESCE(o.delivery_fee, 0) - COALESCE(o.discount, 0))
                ELSE (COALESCE(o.delivery_fee, 0) + COALESCE(o.cod_fee, 0)
                      - COALESCE(o.discount, 0))
            END / 100.0, 2) AS final_fee_tk,
        ROUND(COALESCE(o.discount, 0) / 100.0, 2) AS discount_tk,
        ROUND((COALESCE(o.delivery_fee, 0) + COALESCE(o.cod_fee, 0)) / 100.0, 2)
            AS gross_fee_tk
    FROM orders o
    WHERE o.business_id IN :business_ids
      AND o.transfer_status_id IN :processed_status_ids
      AND COALESCE(o.sorted_at, o.created_at) <  CAST(:cutoff_utc AS timestamp)
),
lifetime AS (
    SELECT business_id,
           MIN(business_date) AS first_order_date,
           MAX(business_date) AS last_order_date
    FROM filtered
    GROUP BY 1
),
this_month AS (
    SELECT business_id,
           COUNT(DISTINCT consignment_id) AS orders_month,
           COUNT(DISTINCT business_date)  AS active_days_month,
           MIN(business_date)             AS first_order_in_month,
           COALESCE(SUM(final_fee_tk) FILTER (
               WHERE transfer_status_id IN :revenue_status_ids), 0) AS revenue_month,
           COALESCE(SUM(discount_tk) FILTER (
               WHERE transfer_status_id IN :revenue_status_ids), 0) AS discount_month,
           COALESCE(SUM(gross_fee_tk) FILTER (
               WHERE transfer_status_id IN :revenue_status_ids), 0) AS gross_fee_month
    FROM filtered
    WHERE business_date >= CAST(:month_start AS date)
      AND business_date <  CAST(:cutoff_date AS date)
    GROUP BY 1
),
prev_month AS (
    SELECT business_id,
           COUNT(DISTINCT consignment_id) AS orders_prev_month,
           COALESCE(SUM(final_fee_tk) FILTER (
               WHERE transfer_status_id IN :revenue_status_ids), 0) AS revenue_prev_month
    FROM filtered
    WHERE business_date >= CAST(:prev_month_start AS date)
      AND business_date <  CAST(:month_start AS date)
    GROUP BY 1
),
before_month AS (
    SELECT business_id, MAX(business_date) AS last_order_before_month
    FROM filtered
    WHERE business_date < CAST(:month_start AS date)
    GROUP BY 1
),
last_week AS (
    SELECT business_id, COUNT(DISTINCT consignment_id) AS orders_last_week
    FROM filtered
    WHERE business_date >= CAST(:week_start AS date)
      AND business_date <  CAST(:week_end AS date)
    GROUP BY 1
),
prev_day AS (
    SELECT business_id, COUNT(DISTINCT consignment_id) AS orders_prev_day
    FROM filtered
    WHERE business_date = CAST(:report_date AS date)
    GROUP BY 1
),
active_30 AS (
    SELECT DISTINCT business_id
    FROM filtered
    WHERE business_date >= CAST(:active_start AS date)
      AND business_date <  CAST(:cutoff_date AS date)
)
SELECT
    l.business_id,
    l.first_order_date,
    l.last_order_date,
    COALESCE(tm.orders_month, 0)          AS orders_month,
    COALESCE(tm.active_days_month, 0)     AS active_days_month,
    tm.first_order_in_month,
    COALESCE(tm.revenue_month, 0)         AS revenue_month,
    COALESCE(tm.discount_month, 0)        AS discount_month,
    COALESCE(tm.gross_fee_month, 0)       AS gross_fee_month,
    COALESCE(pm.orders_prev_month, 0)     AS orders_prev_month,
    COALESCE(pm.revenue_prev_month, 0)    AS revenue_prev_month,
    bm.last_order_before_month,
    COALESCE(lw.orders_last_week, 0)      AS orders_last_week,
    COALESCE(pd.orders_prev_day, 0)       AS orders_prev_day,
    (a30.business_id IS NOT NULL)         AS is_active_30d
FROM lifetime l
LEFT JOIN this_month  tm ON tm.business_id = l.business_id
LEFT JOIN prev_month  pm ON pm.business_id = l.business_id
LEFT JOIN before_month bm ON bm.business_id = l.business_id
LEFT JOIN last_week   lw ON lw.business_id = l.business_id
LEFT JOIN prev_day    pd ON pd.business_id = l.business_id
LEFT JOIN active_30  a30 ON a30.business_id = l.business_id
"""


def classify_merchant(row: pd.Series, month_start: date) -> Tuple[str, Optional[int]]:
    """
    Mutually exclusive classification, priority New Onboard > Churn Win >
    Existing > Inactive. Returns (classification, churn_gap_days).
    """
    orders_month = int(row.get("orders_month") or 0)
    if orders_month <= 0:
        return "Inactive", None

    first_ever = row.get("first_order_date")
    if pd.notna(first_ever) and pd.Timestamp(first_ever).date() >= month_start:
        return "New Onboard", None

    last_before = row.get("last_order_before_month")
    first_in = row.get("first_order_in_month")
    if pd.notna(last_before) and pd.notna(first_in):
        gap = (pd.Timestamp(first_in).date() - pd.Timestamp(last_before).date()).days
        if gap >= CHURN_WIN_GAP_DAYS:
            return "Churn Win", int(gap)
        return "Existing", int(gap)
    return "Existing", None


def build_merchant_month(
    oms_engine,
    df_scope: pd.DataFrame,
    cutoff_date: date,
    batch_size: int,
    retries: int,
    retry_sleep_sec: int,
) -> pd.DataFrame:
    """
    One row per merchant for the current report month. cutoff_date is the
    exclusive 06:00 BD boundary, so the report day is cutoff_date - 1.
    """
    report_date = cutoff_date - timedelta(days=1)
    month_start = cutoff_date.replace(day=1)
    prev_month_start = (month_start - timedelta(days=1)).replace(day=1)
    # Last COMPLETED Monday-start BD week.
    this_week_start = report_date - timedelta(days=(report_date.weekday()))
    week_start = this_week_start - timedelta(days=7)
    week_end = this_week_start
    active_start = cutoff_date - timedelta(days=ACTIVE_WINDOW_DAYS)

    logger.info(
        "Merchant month window: month %s -> %s | prev month from %s | "
        "last completed week %s -> %s | active window from %s",
        month_start, cutoff_date, prev_month_start, week_start, week_end, active_start,
    )

    ids = df_scope["business_id"].tolist()
    parts: List[pd.DataFrame] = []
    for batch_no, batch in enumerate(chunked_ids(ids, batch_size), start=1):
        logger.info("Merchant month batch %s (%s merchants)", batch_no, len(batch))
        parts.append(
            fetch_df_with_retry(
                oms_engine,
                MONTHLY_STATE_SQL,
                {
                    "business_ids": list(batch),
                    "processed_status_ids": list(MONTHLY_PROCESSED_STATUS_IDS),
                    "revenue_status_ids": list(MONTHLY_REVENUE_STATUS_IDS),
                    "cutoff_utc": datetime.combine(cutoff_date, datetime.min.time()),
                    "cutoff_date": cutoff_date,
                    "month_start": month_start,
                    "prev_month_start": prev_month_start,
                    "week_start": week_start,
                    "week_end": week_end,
                    "report_date": report_date,
                    "active_start": active_start,
                },
                ["business_ids", "processed_status_ids", "revenue_status_ids"],
                retries,
                retry_sleep_sec,
                f"merchant month batch {batch_no}",
            )
        )

    df_metrics = concat_nonempty(parts)
    out = df_scope.merge(df_metrics, on="business_id", how="left")

    numeric_defaults = {
        "orders_month": 0, "orders_prev_month": 0, "orders_last_week": 0,
        "orders_prev_day": 0, "active_days_month": 0, "revenue_month": 0,
        "revenue_prev_month": 0, "discount_month": 0, "gross_fee_month": 0,
    }
    for column, default in numeric_defaults.items():
        if column not in out.columns:
            out[column] = default
        out[column] = pd.to_numeric(out[column], errors="coerce").fillna(default)
    for column in ["first_order_date", "last_order_date",
                   "last_order_before_month", "first_order_in_month"]:
        if column not in out.columns:
            out[column] = pd.NaT
        out[column] = pd.to_datetime(out[column], errors="coerce")
    if "is_active_30d" not in out.columns:
        out["is_active_30d"] = False
    out["is_active_30d"] = out["is_active_30d"].fillna(False).astype(bool)

    classified = out.apply(lambda r: classify_merchant(r, month_start), axis=1)
    out["classification"] = [c for c, _ in classified]
    out["churn_gap_days"] = [g for _, g in classified]
    out["report_month"] = month_start

    counts = out["classification"].value_counts().to_dict()
    logger.info("Merchant classification for %s: %s", month_start, counts)
    return out


# ------------------------------------------------------------
# Supabase writers
# ------------------------------------------------------------
def _clean_records(df: pd.DataFrame, columns: Sequence[str]) -> List[Dict[str, Any]]:
    """DataFrame -> list of dicts with NaN/NaT normalised to None."""
    if df.empty:
        return []
    frame = df.reindex(columns=list(columns))
    frame = frame.astype(object).where(pd.notnull(frame), None)
    return frame.to_dict(orient="records")


def _executemany(engine, sql: str, records: Sequence[Mapping[str, Any]],
                 chunk: int = 1000) -> int:
    if not records:
        return 0
    written = 0
    with engine.begin() as conn:
        for start in range(0, len(records), chunk):
            part = records[start:start + chunk]
            conn.execute(text(sql), part)
            written += len(part)
    return written


def replace_window(engine, table: str, date_column: str,
                   start_date: date, end_date_excl: date) -> None:
    """Delete the rows the current run is about to rebuild, and only those."""
    with engine.begin() as conn:
        conn.execute(
            text(f"DELETE FROM {SUPABASE_SCHEMA}.{table} "
                 f"WHERE {date_column} >= :start AND {date_column} < :end"),
            {"start": start_date, "end": end_date_excl},
        )


def sync_merchant_month(engine, df: pd.DataFrame) -> int:
    columns = [
        "business_id", "report_month", "business_name", "kam_name", "lead_name",
        "acquisition_type", "orders_month", "orders_prev_month", "orders_last_week",
        "orders_prev_day", "active_days_month", "revenue_month", "revenue_prev_month",
        "discount_month", "gross_fee_month", "first_order_date", "last_order_date",
        "last_order_before_month", "first_order_in_month", "churn_gap_days",
        "classification", "is_active_30d",
    ]
    sql = f"""
    INSERT INTO {SUPABASE_SCHEMA}.kam_merchant_month
        ({', '.join(columns)}, refreshed_at)
    VALUES ({', '.join(':' + c for c in columns)}, now())
    ON CONFLICT (business_id, report_month) DO UPDATE SET
        {', '.join(f"{c} = EXCLUDED.{c}" for c in columns if c not in ('business_id', 'report_month'))},
        refreshed_at = now()
    """
    written = _executemany(engine, sql, _clean_records(df, columns))
    logger.info("kam_merchant_month rows upserted: %s", written)
    return written


AGING_COLUMN_MAP = {
    "1": "b1", "2": "b2", "3": "b3", "4": "b4",
    "5": "b5", "6": "b6", "7": "b7", "7+": "b7_plus", "Total": "total",
}


def _attach_assignment(df: pd.DataFrame, df_scope: pd.DataFrame,
                       id_column: str) -> pd.DataFrame:
    """Denormalise kam_name / lead_name onto an output frame."""
    if df.empty:
        return df
    lookup = df_scope[["business_id", "business_name", "kam_name", "lead_name"]].rename(
        columns={"business_name": "_scope_business_name"}
    )
    out = df.copy()
    out[id_column] = pd.to_numeric(out[id_column], errors="coerce")
    out = out.dropna(subset=[id_column])
    out[id_column] = out[id_column].astype("int64")
    out = out.merge(lookup, left_on=id_column, right_on="business_id", how="inner")
    out["kam_name"] = out["kam_name"].fillna("")
    out["lead_name"] = out["lead_name"].fillna("")
    return out


def sync_cohort(engine, df: pd.DataFrame, df_scope: pd.DataFrame,
                start_date: date, end_date_excl: date) -> int:
    frame = _attach_assignment(df, df_scope, "Business ID")
    if frame.empty:
        replace_window(engine, "ba_cohort_daily", "report_date", start_date, end_date_excl)
        return 0
    frame = frame.rename(columns={
        "Date": "report_date", "Business Name": "business_name",
        "Processed": "processed", "Delivered": "delivered", "Return": "returned",
        "Lost & Damage": "lost_damage", "In Process": "in_process",
        "Within SLA": "within_sla", "SLA Breached": "sla_breached",
        "Collectable Amount": "collectable_amount", "Collected Amount": "collected_amount",
        "Delivery Fee": "delivery_fee", "Discount": "discount", "COD Fee": "cod_fee",
        "Final Fee": "final_fee", "Adjustment": "adjustment", "Revenue": "revenue",
        "Overall Aging": "overall_aging",
    })
    frame["report_date"] = pd.to_datetime(frame["report_date"], errors="coerce").dt.date
    frame = frame.dropna(subset=["report_date"])
    columns = [
        "report_date", "business_id", "business_name", "kam_name", "lead_name",
        "processed", "delivered", "returned", "lost_damage", "in_process",
        "within_sla", "sla_breached", "collectable_amount", "collected_amount",
        "delivery_fee", "discount", "cod_fee", "final_fee", "adjustment",
        "revenue", "overall_aging",
    ]
    sql = f"""
    INSERT INTO {SUPABASE_SCHEMA}.ba_cohort_daily ({', '.join(columns)}, refreshed_at)
    VALUES ({', '.join(':' + c for c in columns)}, now())
    ON CONFLICT (report_date, business_id) DO UPDATE SET
        {', '.join(f"{c} = EXCLUDED.{c}" for c in columns[2:])},
        refreshed_at = now()
    """
    replace_window(engine, "ba_cohort_daily", "report_date", start_date, end_date_excl)
    written = _executemany(engine, sql, _clean_records(frame, columns))
    logger.info("ba_cohort_daily rows written: %s", written)
    return written


def sync_terminal(engine, df: pd.DataFrame, df_scope: pd.DataFrame, reverse: bool,
                  start_date: date, end_date_excl: date) -> int:
    table = "ba_reverse_terminal" if reverse else "ba_forward_terminal"
    replace_window(engine, table, "report_date", start_date, end_date_excl)
    frame = _attach_assignment(df, df_scope, "Business ID")
    if frame.empty:
        return 0
    frame = frame.rename(columns={
        "Date": "report_date", "Business Name": "business_name",
        "Delivery Region": "delivery_region", "Delivery Division": "delivery_division",
        "RID Type": "rid_type", **AGING_COLUMN_MAP,
    })
    frame["report_date"] = pd.to_datetime(frame["report_date"], errors="coerce").dt.date
    frame = frame.dropna(subset=["report_date"])
    for column in ["delivery_region", "delivery_division"]:
        frame[column] = frame[column].fillna("").replace("", "Unknown")
    if reverse:
        frame["rid_type"] = frame["rid_type"].fillna("").replace("", "Reverse")

    bucket_cols = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b7_plus", "total"]
    key_cols = (["report_date", "business_id", "rid_type", "delivery_region", "delivery_division"]
                if reverse else
                ["report_date", "business_id", "delivery_region", "delivery_division"])
    columns = key_cols + ["business_name", "kam_name", "lead_name"] + bucket_cols
    sql = f"""
    INSERT INTO {SUPABASE_SCHEMA}.{table} ({', '.join(columns)}, refreshed_at)
    VALUES ({', '.join(':' + c for c in columns)}, now())
    ON CONFLICT ({', '.join(key_cols)}) DO UPDATE SET
        {', '.join(f"{c} = EXCLUDED.{c}" for c in columns if c not in key_cols)},
        refreshed_at = now()
    """
    written = _executemany(engine, sql, _clean_records(frame, columns))
    logger.info("%s rows written: %s", table, written)
    return written


def _snapshot_date_series(df: pd.DataFrame) -> pd.Series:
    """COALESCE(Sorted at, Created at) as a BD calendar date, matching Code.gs."""
    sorted_at = pd.to_datetime(df.get("Sorted at"), errors="coerce")
    created_at = pd.to_datetime(df.get("Created at"), errors="coerce")
    return sorted_at.fillna(created_at).dt.date


def sync_fid(engine, df: pd.DataFrame, df_scope: pd.DataFrame,
             store_detail: bool) -> int:
    frame = _attach_assignment(df, df_scope, "Business ID")
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE TABLE {SUPABASE_SCHEMA}.ba_fid_inprocess"))
        if store_detail:
            conn.execute(text(f"TRUNCATE TABLE {SUPABASE_SCHEMA}.ba_fid_detail"))
    if frame.empty:
        return 0

    frame["snapshot_date"] = _snapshot_date_series(frame)
    frame = frame[frame["snapshot_date"].notna()].copy()
    frame["system_status"] = frame["System Status"].fillna("").replace("", "Unknown")
    frame["aging_bracket"] = frame["Aging Bracket"].fillna("").replace("", "Unknown")

    agg = (frame.groupby(
        ["snapshot_date", "business_id", "system_status", "aging_bracket",
         "business_name", "kam_name", "lead_name"], dropna=False)["CID"]
        .nunique().reset_index(name="parcels"))
    columns = ["snapshot_date", "business_id", "system_status", "aging_bracket",
               "business_name", "kam_name", "lead_name", "parcels"]
    sql = f"""
    INSERT INTO {SUPABASE_SCHEMA}.ba_fid_inprocess ({', '.join(columns)}, refreshed_at)
    VALUES ({', '.join(':' + c for c in columns)}, now())
    ON CONFLICT (snapshot_date, business_id, system_status, aging_bracket)
    DO UPDATE SET parcels = EXCLUDED.parcels, refreshed_at = now()
    """
    written = _executemany(engine, sql, _clean_records(agg, columns))
    logger.info("ba_fid_inprocess rows written: %s", written)

    if store_detail:
        detail = frame.rename(columns={
            "CID": "cid", "Attempt Count": "attempt_count",
            "1st Attempt At": "first_attempt_at", "Attempt Status": "attempt_status",
            "City Name": "city_name", "Zone Name": "zone_name", "Weight": "weight",
            "Pickup Hub": "pickup_hub", "Pickup Division": "pickup_division",
            "Pickup Region": "pickup_region", "Delivery Hub": "delivery_hub",
            "Delivery Division": "delivery_division", "Delivery Region": "delivery_region",
            "Created at": "created_at_bd", "Sorted at": "sorted_at_bd",
            "LMH at": "lmh_at_bd", "Transfer Status Updated at": "transfer_status_updated_bd",
            "1st Attempt Aging": "first_attempt_aging",
        })
        detail = detail.drop_duplicates(subset=["cid"], keep="last")
        detail_cols = [
            "cid", "business_id", "business_name", "kam_name", "lead_name",
            "system_status", "attempt_count", "first_attempt_at", "attempt_status",
            "city_name", "zone_name", "weight", "pickup_hub", "pickup_division",
            "pickup_region", "delivery_hub", "delivery_division", "delivery_region",
            "created_at_bd", "sorted_at_bd", "lmh_at_bd", "transfer_status_updated_bd",
            "snapshot_date", "aging_bracket", "first_attempt_aging",
        ]
        detail_sql = f"""
        INSERT INTO {SUPABASE_SCHEMA}.ba_fid_detail ({', '.join(detail_cols)}, refreshed_at)
        VALUES ({', '.join(':' + c for c in detail_cols)}, now())
        ON CONFLICT (cid) DO UPDATE SET
            {', '.join(f"{c} = EXCLUDED.{c}" for c in detail_cols[1:])},
            refreshed_at = now()
        """
        logger.info("ba_fid_detail rows written: %s",
                    _executemany(engine, detail_sql, _clean_records(detail, detail_cols)))
    return written


def sync_rid(engine, df: pd.DataFrame, df_scope: pd.DataFrame,
             store_detail: bool) -> int:
    frame = _attach_assignment(df, df_scope, "Business ID")
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE TABLE {SUPABASE_SCHEMA}.ba_rid_inprocess"))
        if store_detail:
            conn.execute(text(f"TRUNCATE TABLE {SUPABASE_SCHEMA}.ba_rid_detail"))
    if frame.empty:
        return 0

    frame["snapshot_date"] = _snapshot_date_series(frame)
    frame = frame[frame["snapshot_date"].notna()].copy()
    frame["rid_type"] = frame["RID Type"].fillna("").replace("", "Unknown")
    frame["system_status"] = frame["System Status"].fillna("").replace("", "Unknown")
    frame["rid_aging_bracket"] = frame["RID Aging Bracket"].fillna("").replace("", "Unknown")

    agg = (frame.groupby(
        ["snapshot_date", "business_id", "rid_type", "system_status",
         "rid_aging_bracket", "business_name", "kam_name", "lead_name"],
        dropna=False)["CID"].nunique().reset_index(name="cids"))
    columns = ["snapshot_date", "business_id", "rid_type", "system_status",
               "rid_aging_bracket", "business_name", "kam_name", "lead_name", "cids"]
    sql = f"""
    INSERT INTO {SUPABASE_SCHEMA}.ba_rid_inprocess ({', '.join(columns)}, refreshed_at)
    VALUES ({', '.join(':' + c for c in columns)}, now())
    ON CONFLICT (snapshot_date, business_id, rid_type, system_status, rid_aging_bracket)
    DO UPDATE SET cids = EXCLUDED.cids, refreshed_at = now()
    """
    written = _executemany(engine, sql, _clean_records(agg, columns))
    logger.info("ba_rid_inprocess rows written: %s", written)

    if store_detail:
        detail = frame.rename(columns={
            "CID": "cid", "Created at": "created_at_bd", "Sorted at": "sorted_at_bd",
            "Transfer Status Updated at": "transfer_status_updated_bd",
            "Corresponding FID": "corresponding_fid", "FID Sorted At": "fid_sorted_at_bd",
            "City Name": "city_name", "Zone Name": "zone_name", "Weight": "weight",
            "Pickup Hub": "pickup_hub", "Pickup Division": "pickup_division",
            "Pickup Region": "pickup_region", "Delivery Hub": "delivery_hub",
            "Delivery Division": "delivery_division", "Delivery Region": "delivery_region",
            "Entire Aging": "entire_aging", "Entire Aging Bracket": "entire_aging_bracket",
        })
        detail = detail.drop_duplicates(subset=["cid"], keep="last")
        detail_cols = [
            "cid", "rid_type", "business_id", "business_name", "kam_name", "lead_name",
            "system_status", "created_at_bd", "sorted_at_bd",
            "transfer_status_updated_bd", "corresponding_fid", "fid_sorted_at_bd",
            "city_name", "zone_name", "weight", "pickup_hub", "pickup_division",
            "pickup_region", "delivery_hub", "delivery_division", "delivery_region",
            "snapshot_date", "rid_aging_bracket", "entire_aging", "entire_aging_bracket",
        ]
        detail_sql = f"""
        INSERT INTO {SUPABASE_SCHEMA}.ba_rid_detail ({', '.join(detail_cols)}, refreshed_at)
        VALUES ({', '.join(':' + c for c in detail_cols)}, now())
        ON CONFLICT (cid) DO UPDATE SET
            {', '.join(f"{c} = EXCLUDED.{c}" for c in detail_cols[1:])},
            refreshed_at = now()
        """
        logger.info("ba_rid_detail rows written: %s",
                    _executemany(engine, detail_sql, _clean_records(detail, detail_cols)))
    return written


# ------------------------------------------------------------
# Pipeline
# ------------------------------------------------------------
def chunked_ids(values: Sequence[int], size: int) -> Iterable[Sequence[int]]:
    for start in range(0, len(values), size):
        yield values[start:start + size]


def build_batch_reports(
    args,
    business_ids: Sequence[int],
    start_bd: datetime,
    end_bd: datetime,
    oms_engine,
    peg_engine,
    moh_engine,
    df_hubs: pd.DataFrame,
) -> Dict[str, pd.DataFrame]:
    """
    The original five-tab pipeline, unchanged in logic, running for one batch
    of merchants instead of the hardcoded twenty.
    """
    df_biz = fetch_pegasus_businesses(
        peg_engine=peg_engine,
        business_ids=business_ids,
        retries=args.db_retries,
        retry_sleep_sec=args.retry_sleep_sec,
    )

    outputs: Dict[str, pd.DataFrame] = {
        TAB_FORWARD_AGING_TERMINAL: pd.DataFrame(columns=AGING_TERMINAL_COLS),
        TAB_REVERSE_AGING_TERMINAL: pd.DataFrame(columns=REVERSE_AGING_TERMINAL_COLS),
        TAB_SORTED_COHORT: pd.DataFrame(columns=SORTED_COHORT_COLS),
        TAB_FID: pd.DataFrame(columns=FID_OUTPUT_COLUMNS),
        TAB_RID: pd.DataFrame(columns=RID_OUTPUT_COLUMNS),
    }

    # One current F/E in-process snapshot drives both the FID detail and the
    # Sorted Cohort In Process column.
    raw_fid = fetch_df_with_retry(
        oms_engine, FID_SQL, {"business_ids": list(business_ids)},
        None, args.db_retries, args.retry_sleep_sec, "FID detail/shared snapshot"
    )
    enriched_fid = enrich_inprocess_detail(raw_fid, df_biz, df_hubs, FID_OUTPUT_COLUMNS)
    outputs[TAB_FID] = filter_fid_to_cohort_scope(enriched_fid, start_bd, end_bd)

    df_orders = fetch_oms_orders_all_candidates(
        oms_engine=oms_engine,
        start_bd=start_bd,
        end_bd=end_bd,
        business_ids=business_ids,
        chunk_days=args.chunk_days,
        retries=args.db_retries,
        retry_sleep_sec=args.retry_sleep_sec,
    )

    if not df_orders.empty:
        df_orders = add_dimensions(df_orders, df_biz, df_hubs)
        df_fin = fetch_mohajon_financials(
            moh_engine=moh_engine,
            business_ids=business_ids,
            retries=args.db_retries,
            retry_sleep_sec=args.retry_sleep_sec,
        )
        df = prepare_base_dataframe(df_orders=df_orders, df_fin=df_fin)

        outputs[TAB_FORWARD_AGING_TERMINAL] = build_aging_analysis_terminal(
            df, "Forward", start_bd, end_bd)
        outputs[TAB_REVERSE_AGING_TERMINAL] = build_aging_analysis_terminal(
            df, "Reverse", start_bd, end_bd)
        outputs[TAB_SORTED_COHORT] = build_sorted_cohort_summary(
            df, outputs[TAB_FID], start_bd, end_bd)

    validate_fid_cohort_reconciliation(outputs[TAB_FID], outputs[TAB_SORTED_COHORT])

    raw_rid = fetch_df_with_retry(
        oms_engine, RID_SQL, {"business_ids": list(business_ids)},
        None, args.db_retries, args.retry_sleep_sec, "RID detail"
    )
    outputs[TAB_RID] = enrich_inprocess_detail(raw_rid, df_biz, df_hubs, RID_OUTPUT_COLUMNS)
    return outputs


def resolve_window(args) -> Tuple[datetime, datetime]:
    """
    Rolling window. --days 30 (default) ends at the latest completed 06:00 BD
    boundary; explicit --start/--end override it.
    """
    if args.start and args.end:
        return parse_bd_dt(args.start), parse_bd_dt(args.end)
    now = bd_now()
    cutoff = now.date() if now.hour >= 6 else now.date() - timedelta(days=1)
    end_bd = datetime.combine(cutoff, datetime.min.time())
    start_bd = end_bd - timedelta(days=args.days)
    return start_bd, end_bd


def run_pipeline(args) -> None:
    start_bd, end_bd = resolve_window(args)
    if start_bd >= end_bd:
        raise ValueError("Window start must be earlier than window end")
    start_date, end_date_excl = report_date_bounds(start_bd, end_bd)
    cutoff_date = end_date_excl

    logger.info("Business Insights window BD: %s -> %s exclusive",
                dt_text(start_bd), dt_text(end_bd))

    sb_engine = get_supabase_engine()
    ensure_business_insights_schema(sb_engine)
    df_scope = load_merchant_scope(sb_engine)

    if args.limit_merchants:
        df_scope = df_scope.head(args.limit_merchants).copy()
        logger.warning("Merchant scope truncated to %s merchants (--limit-merchants)",
                       len(df_scope))

    business_ids = df_scope["business_id"].tolist()
    oms_engine = get_engine("OMS")
    peg_engine = get_engine("PEGASUS")
    moh_engine = get_engine("MOHAJON")

    run_id = None
    with sb_engine.begin() as conn:
        run_id = conn.execute(text(f"""
            INSERT INTO {SUPABASE_SCHEMA}.ba_refresh_log
                (window_start, window_end, merchants, status)
            VALUES (:s, :e, :m, 'running') RETURNING id
        """), {"s": start_date, "e": end_date_excl, "m": len(business_ids)}).scalar()

    try:
        # ---- 1. Monthly merchant state (Home KPIs) ----
        if not args.skip_merchant_month:
            df_month = build_merchant_month(
                oms_engine, df_scope, cutoff_date,
                args.merchant_batch, args.db_retries, args.retry_sleep_sec,
            )
            sync_merchant_month(sb_engine, df_month)

        # ---- 2. Five analytics datasets, batched ----
        collected: Dict[str, List[pd.DataFrame]] = {
            TAB_FORWARD_AGING_TERMINAL: [], TAB_REVERSE_AGING_TERMINAL: [],
            TAB_SORTED_COHORT: [], TAB_FID: [], TAB_RID: [],
        }
        df_hubs = fetch_hub_info(args.sheet_id)

        batches = list(chunked_ids(business_ids, args.merchant_batch))
        for batch_no, batch in enumerate(batches, start=1):
            logger.info("Analytics batch %s/%s (%s merchants)",
                        batch_no, len(batches), len(batch))
            outputs = build_batch_reports(
                args, batch, start_bd, end_bd,
                oms_engine, peg_engine, moh_engine, df_hubs,
            )
            for tab, frame in outputs.items():
                if not frame.empty:
                    collected[tab].append(frame)

        merged = {tab: concat_nonempty(parts) for tab, parts in collected.items()}
        for tab, frame in merged.items():
            logger.info("Merged '%s': %s rows", tab, len(frame))

        # ---- 3. Write to Supabase ----
        cohort_rows = sync_cohort(sb_engine, merged[TAB_SORTED_COHORT], df_scope,
                                  start_date, end_date_excl)
        fwd_rows = sync_terminal(sb_engine, merged[TAB_FORWARD_AGING_TERMINAL], df_scope,
                                 False, start_date, end_date_excl)
        rev_rows = sync_terminal(sb_engine, merged[TAB_REVERSE_AGING_TERMINAL], df_scope,
                                 True, start_date, end_date_excl)
        fid_rows = sync_fid(sb_engine, merged[TAB_FID], df_scope, args.store_detail)
        rid_rows = sync_rid(sb_engine, merged[TAB_RID], df_scope, args.store_detail)

        # ---- 4. Optional file copies for validation ----
        if args.output_mode == "csv":
            write_outputs_to_csv(args.out_dir, merged)
        elif args.output_mode == "excel":
            write_outputs_to_excel(args.excel_path, merged)

        with sb_engine.begin() as conn:
            conn.execute(text(f"""
                UPDATE {SUPABASE_SCHEMA}.ba_refresh_log
                SET cohort_rows = :c, fwd_rows = :f, rev_rows = :r,
                    fid_rows = :fi, rid_rows = :ri,
                    status = 'ok', finished_at = now()
                WHERE id = :id
            """), {"c": cohort_rows, "f": fwd_rows, "r": rev_rows,
                   "fi": fid_rows, "ri": rid_rows, "id": run_id})
        logger.info("Done. Business Insights refreshed for %s merchants.", len(business_ids))

    except Exception as exc:
        with sb_engine.begin() as conn:
            conn.execute(text(f"""
                UPDATE {SUPABASE_SCHEMA}.ba_refresh_log
                SET status = 'failed', message = :m, finished_at = now()
                WHERE id = :id
            """), {"m": str(exc)[:500], "id": run_id})
        raise


def parse_args():
    parser = argparse.ArgumentParser(
        description="CarryBee Business Insights refresh (all KAM merchants -> Supabase)")
    parser.add_argument("--days", type=int, default=DEFAULT_WINDOW_DAYS,
                        help="Rolling window length in days (default 30)")
    parser.add_argument("--start", default="",
                        help="Explicit BD window start, 'YYYY-MM-DD HH:MM:SS'")
    parser.add_argument("--end", default="",
                        help="Explicit BD window end, exclusive")
    parser.add_argument("--sheet-id", default=DEFAULT_SHEET_ID,
                        help="Google Sheet holding the authoritative 'Hub Info' tab")
    parser.add_argument("--merchant-batch", type=int, default=DEFAULT_MERCHANT_BATCH,
                        help="Merchants per database batch (default 400)")
    parser.add_argument("--limit-merchants", type=int, default=0,
                        help="Debug only: process the first N merchants")
    parser.add_argument("--store-detail", action="store_true", default=True,
                        help="Store parcel-level FID/RID rows for CSV export")
    parser.add_argument("--no-store-detail", dest="store_detail", action="store_false")
    parser.add_argument("--skip-merchant-month", action="store_true",
                        help="Skip the Home-KPI monthly state rebuild")
    parser.add_argument("--output-mode", choices=["none", "csv", "excel"], default="none",
                        help="Optional local copy of the five datasets for validation")
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    parser.add_argument("--excel-path", default=DEFAULT_EXCEL_PATH)
    parser.add_argument("--chunk-days", type=int, default=DEFAULT_CHUNK_DAYS)
    parser.add_argument("--db-retries", type=int, default=DEFAULT_DB_RETRIES)
    parser.add_argument("--retry-sleep-sec", type=int, default=DEFAULT_RETRY_SLEEP_SEC)
    return parser.parse_args()


def main() -> None:
    run_pipeline(parse_args())


if __name__ == "__main__":
    main()
