"""
KAMP_merchant_information.py - v3 patch
=======================================

Two changes are needed in the existing KAMP job so it matches the v3 CRM.
Both are drop-in replacements: copy each function over the current one of the
same name. Nothing else in KAMP changes.

WHY
---
1. Alert rules. In v3 the Flag tab has four buttons and only three of them
   alert:
       order_drop     order gap with the previous day is negative
       call_followup  EXACTLY 2 days since the last order
       visit          3 or more days since the last order, or never ordered
       issue          informational only - it must NOT create an alert
   The old function alerted on the free-text `visit` column ('Call Mandatory' /
   'Must visit') and on `risk`, which produced both a visit alert and an issue
   alert for the same merchant on the same day.

2. Acquisition type. kam_daily_report now carries acquisition_type so the
   Flag table can show Organic / Hunt. The value comes from the Merchant
   Information worksheet's existing "Type" column.

The day gap is computed the same way the app computes it:
    reporting_date - last_order_date::date
so the button a KAM sees and the alert stored overnight can never disagree.
"""
from datetime import timedelta  # noqa: F401  (already imported in KAMP)

from sqlalchemy import text  # noqa: F401  (already imported in KAMP)


# ---------------------------------------------------------------------------
# 1. REPLACE generate_pending_alerts WITH THIS
# ---------------------------------------------------------------------------
def generate_pending_alerts(engine) -> int:
    """
    Store 'Not Worked' alerts for every merchant with a live Flag button whose
    KAM submitted no matching feedback for the CURRENT rows in
    kam_daily_report.

    Must run BEFORE sync_supabase_current_state: the rows still carry the
    previous reporting_date, i.e. the business day the KAM has just had a full
    day to work on. ON CONFLICT keeps existing alert rows untouched.

    v3 rules (mutually exclusive, so one merchant never gets both a call and a
    visit alert on the same day):
        order_drop     order_gap_with_previous_day < 0
        call_followup  (reporting_date - last_order_date::date) = 2
        visit          (reporting_date - last_order_date::date) >= 3
                       or last_order_date IS NULL
        issue          never generated
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
            SELECT CASE
                       WHEN d.last_order_date IS NULL THEN NULL
                       ELSE (d.reporting_date - d.last_order_date::date)
                   END AS gap_days
        ) g
        CROSS JOIN LATERAL (
            VALUES
                (
                    'order_drop',
                    'Order gap ' || d.order_gap_with_previous_day::text
                        || ' vs previous day',
                    d.order_gap_with_previous_day < 0
                ),
                (
                    'call_followup',
                    'No order for 2 days',
                    g.gap_days = 2
                ),
                (
                    'visit',
                    CASE WHEN g.gap_days IS NULL
                         THEN 'Never ordered'
                         ELSE 'No order for ' || g.gap_days::text || ' days'
                    END,
                    g.gap_days IS NULL OR g.gap_days >= 3
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
                flags.alert_type = 'call_followup'
                AND EXISTS (
                    SELECT 1 FROM {SUPABASE_SCHEMA}.feedback_call_followup f
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
        ON CONFLICT (business_id, reporting_date, alert_type) DO NOTHING
        """
    )
    with engine.begin() as connection:
        result = connection.execute(sql)
        inserted = result.rowcount if result.rowcount is not None else 0
    print(f"Alert generation: {inserted:,} new 'Not Worked' alert(s) stored.")
    return inserted


# ---------------------------------------------------------------------------
# 2. ADD acquisition_type TO THE CURRENT-STATE SYNC
# ---------------------------------------------------------------------------
#
# a) In ensure_supabase_schema(), add this line to the DDL block so an existing
#    table gains the column:
#
#        ALTER TABLE {SUPABASE_SCHEMA}.{SUPABASE_DAILY_TABLE}
#            ADD COLUMN IF NOT EXISTS acquisition_type text NOT NULL DEFAULT '';
#
# b) read_kam_list() already reads the worksheet's "Type" column through
#    MERCHANT_SHEET_ALIASES. Carry it into the report frame:
#
#        report["Acquisition_type"] = kam_df["Type"].fillna("").astype(str).str.strip()
#
# c) In build_supabase_daily_rows(), add the field to each row dict:
#
#        "acquisition_type": str(row.get("Acquisition_type") or "").strip(),
#
# d) In sync_supabase_current_state(), add acquisition_type to the INSERT
#    column list, to the VALUES list, and to the ON CONFLICT DO UPDATE SET
#    list, exactly as the neighbouring text columns are handled.
#
# Nothing else in the sync changes: the column is a plain text mirror of the
# sheet and takes part in no calculation.
