/**
 * TQM Merchant Health Tracker - backend v3
 * Data Intelligence & Research
 *
 * Four tabs: Home, Flag, Merchant Performance, Business Insights.
 *
 * ACCESS MODEL (changed in v3)
 *   admin  Imtiaz, Ojhor, Muqtadir, Sufian, Mahir - every team
 *   lead   only the KAMs listed under them in kam_team_directory
 *   kam    only their own merchants
 * Every scoped query goes through resolveScope(), which returns an array
 * membership predicate on normalised kam_name. A ?kam= / ?lead= / ?team=
 * filter can only narrow what the role already allows, never widen it.
 */
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

import { pool, query } from "./db.js";
import { authRequired, isAdmin, normalize, signToken } from "./auth.js";
import {
  canAccessKam,
  loadDirectory,
  loadMerchantForUser,
  resolveScope,
  visibleKams,
} from "./scope.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "256kb" }));

const corsOrigins = (process.env.CORS_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(cors({ origin: corsOrigins }));

const FEEDBACK_TABLES = {
  order_drop: "feedback_order_drop",
  call_followup: "feedback_call_followup",
  visit: "feedback_visit",
  issue: "feedback_issue",
};

// ---------------------------------------------------------------------------
// Date helpers - Bangladesh calendar, 06:00-06:00 operational day.
// ---------------------------------------------------------------------------
function bdToday() {
  const bd = new Date(Date.now() + 6 * 3600 * 1000);
  return new Date(Date.UTC(bd.getUTCFullYear(), bd.getUTCMonth(), bd.getUTCDate()));
}
function currentWeekStart() {
  const today = bdToday();
  const shift = (today.getUTCDay() + 6) % 7; // Monday = 0
  today.setUTCDate(today.getUTCDate() - shift);
  return today.toISOString().slice(0, 10);
}
function currentMonthStart() {
  const today = bdToday();
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}
function asDateString(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function pct(numerator, denominator) {
  const d = num(denominator);
  return d === 0 ? null : (num(numerator) / d) * 100;
}

async function flipAlertWorked(businessId, reportingDate, alertType) {
  await query(
    `UPDATE kam_alerts
     SET status = 'Worked', worked_at = now()
     WHERE business_id = $1 AND reporting_date = $2 AND alert_type = $3
       AND status <> 'Worked'`,
    [businessId, reportingDate, alertType]
  );
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required." });
    }
    const { rows } = await query(
      `SELECT id, username, password_hash, full_name, role, kam_name
       FROM app_users WHERE lower(username) = lower($1) AND is_active`,
      [String(username).trim()]
    );
    const user = rows[0];
    const ok = user && (await bcrypt.compare(String(password), user.password_hash));
    if (!ok) return res.status(401).json({ error: "Wrong username or password." });
    res.json({
      token: signToken(user),
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        role: user.role,
        kam_name: user.kam_name,
      },
    });
  } catch (err) {
    console.error("login:", err);
    res.status(500).json({ error: "Sign-in failed. Try again." });
  }
});

app.get("/api/me", authRequired, (req, res) => res.json({ user: req.user }));

// ---------------------------------------------------------------------------
// Sidebar filters: teams -> leads -> KAMs, already limited to what the caller
// may open. Locked entries are simply not returned, so the UI cannot offer a
// filter that would 403.
// ---------------------------------------------------------------------------
app.get("/api/filters", authRequired, async (req, res) => {
  try {
    const directory = await loadDirectory();
    const allowed = new Set((await visibleKams(req.user)).map(normalize));
    const mine = directory.filter((row) => allowed.has(normalize(row.kam_name)));

    const teams = [...new Set(mine.map((row) => row.team_name))].sort();
    const leads = [...new Set(mine.map((row) => row.lead_name))].sort();
    const { rows: counts } = await query(
      `SELECT lower(btrim(kam_name)) AS k, COUNT(*)::int AS merchants
       FROM kam_daily_report GROUP BY 1`
    );
    const countByKam = new Map(counts.map((row) => [row.k, row.merchants]));

    res.json({
      role: req.user.role,
      teams: teams.map((team) => ({
        team_name: team,
        kams: mine.filter((row) => row.team_name === team).length,
      })),
      leads: leads.map((lead) => ({
        lead_name: lead,
        kams: mine.filter((row) => row.lead_name === lead).length,
      })),
      kams: mine.map((row) => ({
        kam_name: row.kam_name,
        lead_name: row.lead_name,
        team_name: row.team_name,
        merchants: countByKam.get(normalize(row.kam_name)) || 0,
      })),
    });
  } catch (err) {
    console.error("filters:", err);
    res.status(500).json({ error: "Could not load the filters." });
  }
});

// ---------------------------------------------------------------------------
// Targets. Resolution order kam -> lead -> global, per report month.
// Only an admin may write. incentive_pct defaults to 2 ("2% of Current
// Revenue"); unlock_threshold_pct is the Achievement % that unlocks it.
// ---------------------------------------------------------------------------
async function resolveTargets(reportMonth, { kam, lead }) {
  const { rows } = await query(
    `SELECT scope_type, scope_value, target_revenue, unlock_threshold_pct,
            incentive_pct, incremental_target_pct, retention_target_pct
     FROM kam_targets
     WHERE report_month = $1
       AND ( scope_type = 'global'
          OR (scope_type = 'kam'  AND lower(btrim(scope_value)) = lower(btrim($2)))
          OR (scope_type = 'lead' AND lower(btrim(scope_value)) = lower(btrim($3))) )`,
    [reportMonth, kam || "", lead || ""]
  );
  const byType = Object.fromEntries(rows.map((row) => [row.scope_type, row]));
  const pick = (field) =>
    byType.kam?.[field] ?? byType.lead?.[field] ?? byType.global?.[field] ?? null;
  return {
    target_revenue: pick("target_revenue") === null ? null : num(pick("target_revenue")),
    unlock_threshold_pct: num(pick("unlock_threshold_pct") ?? 100),
    incentive_pct: num(pick("incentive_pct") ?? 2),
    incremental_target_pct:
      pick("incremental_target_pct") === null ? null : num(pick("incremental_target_pct")),
    retention_target_pct:
      pick("retention_target_pct") === null ? null : num(pick("retention_target_pct")),
    resolved_from: byType.kam ? "kam" : byType.lead ? "lead" : byType.global ? "global" : "none",
  };
}

app.get("/api/targets", authRequired, async (req, res) => {
  try {
    const month = String(req.query.month || currentMonthStart()).slice(0, 10);
    const { rows } = await query(
      `SELECT * FROM kam_targets WHERE report_month = $1
       ORDER BY scope_type, scope_value`,
      [month]
    );
    res.json({ month, rows, can_edit: isAdmin(req.user) });
  } catch (err) {
    console.error("targets:", err);
    res.status(500).json({ error: "Could not load targets." });
  }
});

app.put("/api/targets", authRequired, async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: "Only an Admin can set targets." });
    }
    const {
      scope_type = "global",
      scope_value = "",
      month,
      target_revenue,
      unlock_threshold_pct,
      incentive_pct,
      incremental_target_pct,
      retention_target_pct,
    } = req.body || {};
    if (!["global", "lead", "kam"].includes(scope_type)) {
      return res.status(400).json({ error: "scope_type must be global, lead or kam." });
    }
    if (scope_type !== "global" && !String(scope_value).trim()) {
      return res.status(400).json({ error: "scope_value is required for a lead or kam target." });
    }
    const reportMonth = String(month || currentMonthStart()).slice(0, 10);
    const numeric = (value, fallback = null) => {
      if (value === null || value === undefined || String(value).trim() === "") return fallback;
      const parsed = Number(String(value).replace(/[,%]/g, "").trim());
      if (!Number.isFinite(parsed) || parsed < 0) return "invalid";
      return parsed;
    };
    const values = {
      target_revenue: numeric(target_revenue),
      unlock_threshold_pct: numeric(unlock_threshold_pct, 100),
      incentive_pct: numeric(incentive_pct, 2),
      incremental_target_pct: numeric(incremental_target_pct),
      retention_target_pct: numeric(retention_target_pct),
    };
    if (Object.values(values).includes("invalid")) {
      return res.status(400).json({ error: "Targets must be non-negative numbers." });
    }
    await query(
      `INSERT INTO kam_targets
         (scope_type, scope_value, report_month, target_revenue, unlock_threshold_pct,
          incentive_pct, incremental_target_pct, retention_target_pct, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (scope_type, scope_value, report_month) DO UPDATE SET
         target_revenue = EXCLUDED.target_revenue,
         unlock_threshold_pct = EXCLUDED.unlock_threshold_pct,
         incentive_pct = EXCLUDED.incentive_pct,
         incremental_target_pct = EXCLUDED.incremental_target_pct,
         retention_target_pct = EXCLUDED.retention_target_pct,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [
        scope_type,
        String(scope_value).trim(),
        reportMonth,
        values.target_revenue,
        values.unlock_threshold_pct,
        values.incentive_pct,
        values.incremental_target_pct,
        values.retention_target_pct,
        req.user.username,
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("targets save:", err);
    res.status(500).json({ error: "Could not save the target." });
  }
});

// ---------------------------------------------------------------------------
// HOME
//
// Definitions, all scoped to the caller's KAMs:
//   Total Merchant           merchants in the current merchant book
//   Total Order Prev. Day    sum of last_day_order on the latest reporting day
//   Total Order This Month   orders with a processed status, BD operational day
//                            inside the current month
//   Total Order Last Week    the last COMPLETED Monday-Sunday BD week
//   Total Order Last Month   the whole previous calendar month
//   Active / Inactive        at least one processed order in the trailing 30
//                            days ending at the cutoff / otherwise
//   New Onboard / Churn Win  mutually exclusive monthly classification
//   Total Alerts / Worked /  from kam_alerts (order_drop, call_followup, visit;
//   Not Worked               issue never raises an alert in v3)
//   Call Tracker Alerts      merchants owing a call in the current BD week
//
//   NEW SALES
//     Achievement Revenue    revenue this month from New Onboard + Churn Win
//     Total Revenue          revenue this month, all merchants in scope
//     Achievement %          Achievement Revenue / Target Revenue
//     2% of Current Revenue  incentive_pct% of Achievement Revenue, hidden
//                            until Achievement % >= unlock threshold
//   SAME STORE INCREMENTAL
//     Same store = classification 'Existing' with prior-month orders > 0
//     Increment Order/Revenue = current month - previous month for that set
//     Achievement % = actual growth % / target growth %
//   SAME STORE RETENTION
//     Base = merchants with orders last month; Retained = base with orders
//     this month. Retention % = retained / base.
//     Discount % = discount / (delivery fee + COD fee) on terminal parcels.
// ---------------------------------------------------------------------------
app.get("/api/home", authRequired, async (req, res) => {
  try {
    const scope = await resolveScope(req, "d");
    if (scope.error) return res.status(scope.status).json({ error: scope.error });

    const month = String(req.query.month || currentMonthStart()).slice(0, 10);
    const weekStart = currentWeekStart();

    const bookResult = await query(
      `SELECT COUNT(*)::int AS total_merchant,
              COALESCE(SUM(d.last_day_order), 0)::bigint AS total_order_prev_day,
              MAX(d.reporting_date) AS reporting_date
       FROM kam_daily_report d WHERE ${scope.where}`,
      scope.params
    );

    const monthResult = await query(
      `SELECT
         COUNT(*)::int AS merchants,
         COUNT(*) FILTER (WHERE d.is_active_30d)::int        AS active_merchant,
         COUNT(*) FILTER (WHERE NOT d.is_active_30d)::int    AS inactive_merchant,
         COUNT(*) FILTER (WHERE d.classification = 'New Onboard')::int AS new_onboard,
         COUNT(*) FILTER (WHERE d.classification = 'Churn Win')::int   AS churn_win,
         COALESCE(SUM(d.orders_month), 0)::bigint      AS orders_month,
         COALESCE(SUM(d.orders_prev_month), 0)::bigint AS orders_prev_month,
         COALESCE(SUM(d.orders_last_week), 0)::bigint  AS orders_last_week,
         COALESCE(SUM(d.revenue_month), 0)             AS revenue_month,
         COALESCE(SUM(d.revenue_month) FILTER (
             WHERE d.classification IN ('New Onboard', 'Churn Win')), 0) AS new_sales_revenue,
         COALESCE(SUM(d.orders_month) FILTER (
             WHERE d.classification = 'Existing' AND d.orders_prev_month > 0), 0)::bigint
             AS ss_curr_orders,
         COALESCE(SUM(d.orders_prev_month) FILTER (
             WHERE d.classification = 'Existing' AND d.orders_prev_month > 0), 0)::bigint
             AS ss_prev_orders,
         COALESCE(SUM(d.revenue_month) FILTER (
             WHERE d.classification = 'Existing' AND d.orders_prev_month > 0), 0)
             AS ss_curr_revenue,
         COALESCE(SUM(d.revenue_prev_month) FILTER (
             WHERE d.classification = 'Existing' AND d.orders_prev_month > 0), 0)
             AS ss_prev_revenue,
         COUNT(*) FILTER (WHERE d.orders_prev_month > 0)::int AS base_merchants,
         COUNT(*) FILTER (WHERE d.orders_prev_month > 0 AND d.orders_month > 0)::int
             AS retained_merchants,
         COALESCE(SUM(d.orders_month) FILTER (
             WHERE d.orders_prev_month > 0 AND d.orders_month > 0), 0)::bigint
             AS retention_orders,
         COALESCE(SUM(d.revenue_month) FILTER (
             WHERE d.orders_prev_month > 0 AND d.orders_month > 0), 0)
             AS retention_revenue,
         COALESCE(SUM(d.discount_month), 0)  AS discount_month,
         COALESCE(SUM(d.gross_fee_month), 0) AS gross_fee_month
       FROM kam_merchant_month d
       WHERE d.report_month = $${scope.params.length + 1} AND ${scope.where}`,
      [...scope.params, month]
    );

    const alertsResult = await query(
      `SELECT COUNT(*)::int AS total_alerts,
              COUNT(*) FILTER (WHERE a.status = 'Worked')::int AS worked,
              COUNT(*) FILTER (WHERE a.status = 'Not Worked')::int AS not_worked
       FROM kam_alerts a
       WHERE lower(btrim(a.kam_name)) = ANY($1::text[])`,
      scope.params
    );

    const callResult = await query(
      `SELECT
         (SELECT COUNT(*) FROM kam_daily_report d WHERE ${scope.where})::int AS obligations,
         COUNT(*) FILTER (WHERE w.status = 'Worked')::int AS worked
       FROM weekly_call_log w
       WHERE w.week_start = $2 AND lower(btrim(w.kam_name)) = ANY($1::text[])`,
      [...scope.params, weekStart]
    );
    const obligations = callResult.rows[0].obligations;
    const callsWorked = Math.min(callResult.rows[0].worked, obligations);

    // Previous month total: read the stored previous-month figure so the card
    // does not depend on last month's row still existing in kam_merchant_month.
    const prevMonthOrders = num(monthResult.rows[0].orders_prev_month);

    const trendResult = await query(
      `SELECT reporting_date::text AS d,
              COUNT(*) FILTER (WHERE status = 'Worked')::int AS worked,
              COUNT(*) FILTER (WHERE status = 'Not Worked')::int AS not_worked
       FROM kam_alerts
       WHERE lower(btrim(kam_name)) = ANY($1::text[])
         AND reporting_date >= (SELECT COALESCE(MAX(reporting_date), CURRENT_DATE)
                                FROM kam_alerts) - INTERVAL '6 days'
       GROUP BY 1 ORDER BY 1`,
      scope.params
    );

    const orderTrendResult = await query(
      `SELECT report_date::text AS d, COALESCE(SUM(processed), 0)::bigint AS orders
       FROM ba_cohort_daily
       WHERE lower(btrim(kam_name)) = ANY($1::text[])
         AND report_date >= (SELECT COALESCE(MAX(report_date), CURRENT_DATE)
                             FROM ba_cohort_daily) - INTERVAL '13 days'
       GROUP BY 1 ORDER BY 1`,
      scope.params
    );

    const m = monthResult.rows[0];
    const singleKam = scope.kams.length === 1 ? scope.kams[0] : "";
    const leadForTargets =
      req.user.role === "lead" ? req.user.kam_name : String(req.query.lead || "").trim();
    const targets = await resolveTargets(month, { kam: singleKam, lead: leadForTargets });

    const achievementRevenue = num(m.new_sales_revenue);
    const achievementPct = pct(achievementRevenue, targets.target_revenue);
    const unlocked =
      achievementPct !== null && achievementPct >= num(targets.unlock_threshold_pct);

    const ssPrevOrders = num(m.ss_prev_orders);
    const ssCurrOrders = num(m.ss_curr_orders);
    const ssPrevRevenue = num(m.ss_prev_revenue);
    const ssCurrRevenue = num(m.ss_curr_revenue);
    const growthPct = pct(ssCurrOrders - ssPrevOrders, ssPrevOrders);
    const retentionPct = pct(m.retained_merchants, m.base_merchants);

    res.json({
      reporting_date: asDateString(bookResult.rows[0].reporting_date),
      report_month: month,
      week_start: weekStart,
      scope: { kams: scope.kams, count: scope.kams.length },
      cards: {
        total_merchant: bookResult.rows[0].total_merchant,
        total_order_prev_day: num(bookResult.rows[0].total_order_prev_day),
        total_order_month: num(m.orders_month),
        total_order_last_week: num(m.orders_last_week),
        total_order_last_month: prevMonthOrders,
        active_merchant: m.active_merchant,
        inactive_merchant: m.inactive_merchant,
        new_onboard: m.new_onboard,
        churn_win: m.churn_win,
        total_alerts: alertsResult.rows[0].total_alerts,
        worked_on: alertsResult.rows[0].worked,
        not_worked_on: alertsResult.rows[0].not_worked,
        call_tracker_alerts: obligations,
        call_tracker_not_worked: Math.max(obligations - callsWorked, 0),
      },
      new_sales: {
        target_revenue: targets.target_revenue,
        achievement_revenue: achievementRevenue,
        total_revenue: num(m.revenue_month),
        achievement_pct: achievementPct,
        incentive_pct: targets.incentive_pct,
        incentive_amount: (achievementRevenue * num(targets.incentive_pct)) / 100,
        unlock_threshold_pct: targets.unlock_threshold_pct,
        unlocked,
        new_onboard: m.new_onboard,
        churn_win: m.churn_win,
        resolved_from: targets.resolved_from,
      },
      incremental: {
        target_pct: targets.incremental_target_pct,
        base_orders: ssPrevOrders,
        curr_orders: ssCurrOrders,
        increment_order: ssCurrOrders - ssPrevOrders,
        increment_revenue: ssCurrRevenue - ssPrevRevenue,
        growth_pct: growthPct,
        achievement_pct:
          growthPct === null || !targets.incremental_target_pct
            ? null
            : (growthPct / num(targets.incremental_target_pct)) * 100,
        total_orders: num(m.orders_month),
        total_revenue: num(m.revenue_month),
      },
      retention: {
        target_pct: targets.retention_target_pct,
        base_merchants: m.base_merchants,
        retained_merchants: m.retained_merchants,
        retention_pct: retentionPct,
        achievement_pct:
          retentionPct === null || !targets.retention_target_pct
            ? null
            : (retentionPct / num(targets.retention_target_pct)) * 100,
        retention_orders: num(m.retention_orders),
        retention_revenue: num(m.retention_revenue),
        active_merchant: m.active_merchant,
        discount_pct: pct(m.discount_month, m.gross_fee_month),
      },
      alert_trend: trendResult.rows.map((row) => ({
        date: row.d,
        worked: row.worked,
        not_worked: row.not_worked,
      })),
      order_trend: orderTrendResult.rows.map((row) => ({
        date: row.d,
        orders: num(row.orders),
      })),
      can_edit_targets: isAdmin(req.user),
    });
  } catch (err) {
    console.error("home:", err);
    res.status(500).json({ error: "Could not load the home dashboard." });
  }
});

// ---------------------------------------------------------------------------
// FLAG TAB
//
// Button rules (approved, mutually exclusive):
//   Order Drop     order_gap_with_previous_day < 0
//   Call FollowUp  order gap of exactly 2 days at zero
//   Visit          order gap of 3 or more days at zero (never ordered counts
//                  as Visit)
//   Issue          always available, never raises an alert - it only stores
//                  an explanation for the KAM and whoever reads it later
//
// order_gap_days = reporting_date - last_order_date (BD calendar days).
// ---------------------------------------------------------------------------
const FLAG_SELECT = `
  d.business_id,
  d.business_name,
  d.kam_name,
  d.lead_name,
  d.reporting_date,
  d.order_gap_with_previous_day,
  d.last_day_order AS previous_day_order,
  d.last_order_date,
  d.last_7_day_order,
  d.risk,
  d.visit,
  COALESCE(NULLIF(d.acquisition_type, ''), 'Not Specified') AS acquisition_type,
  CASE
    WHEN d.last_order_date IS NULL THEN NULL
    ELSE (d.reporting_date - d.last_order_date::date)
  END AS order_gap_days,
  (d.order_gap_with_previous_day < 0) AS order_drop_active,
  (d.last_order_date IS NOT NULL
   AND (d.reporting_date - d.last_order_date::date) = 2) AS call_followup_active,
  (d.last_order_date IS NULL
   OR (d.reporting_date - d.last_order_date::date) >= 3) AS visit_active,
  (fod.id IS NOT NULL) AS has_order_drop_feedback,
  (fcf.id IS NOT NULL) AS has_call_followup_feedback,
  (fv.id IS NOT NULL)  AS has_visit_feedback,
  (fi.id IS NOT NULL)  AS has_issue_feedback
`;

const FLAG_JOINS = `
  FROM kam_daily_report d
  LEFT JOIN feedback_order_drop fod
         ON fod.business_id = d.business_id AND fod.reporting_date = d.reporting_date
  LEFT JOIN feedback_call_followup fcf
         ON fcf.business_id = d.business_id AND fcf.reporting_date = d.reporting_date
  LEFT JOIN feedback_visit fv
         ON fv.business_id = d.business_id AND fv.reporting_date = d.reporting_date
  LEFT JOIN feedback_issue fi
         ON fi.business_id = d.business_id AND fi.reporting_date = d.reporting_date
`;

app.get("/api/flag", authRequired, async (req, res) => {
  try {
    const scope = await resolveScope(req, "d");
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    // ?all=1 returns the whole book; the default shows only rows with a live
    // button, which is what the Flag table is for.
    const onlyFlagged = String(req.query.all || "") !== "1";
    const flaggedFilter = onlyFlagged
      ? `AND ( d.order_gap_with_previous_day < 0
               OR d.last_order_date IS NULL
               OR (d.reporting_date - d.last_order_date::date) >= 2 )`
      : "";
    const { rows } = await query(
      `SELECT ${FLAG_SELECT} ${FLAG_JOINS}
       WHERE ${scope.where} ${flaggedFilter}
       ORDER BY d.order_gap_with_previous_day ASC, d.business_id`,
      scope.params
    );
    res.json({ rows });
  } catch (err) {
    console.error("flag:", err);
    res.status(500).json({ error: "Could not load the flag table." });
  }
});

// ---------------------------------------------------------------------------
// Feedback writes. Order drop / call follow-up / visit flip their alert to
// Worked; issue deliberately does not, because it no longer raises one.
// ---------------------------------------------------------------------------
app.get("/api/feedback/:type/history", authRequired, async (req, res) => {
  const table = FEEDBACK_TABLES[req.params.type];
  if (!table) return res.status(400).json({ error: "Unknown feedback type." });
  const businessId = Number(req.query.business_id);
  if (!Number.isInteger(businessId)) {
    return res.status(400).json({ error: "business_id is required." });
  }
  try {
    const merchant = await loadMerchantForUser(req.user, businessId);
    if (merchant === "forbidden") {
      return res.status(403).json({ error: "This merchant is locked for your account." });
    }
    const { rows } = await query(
      `SELECT * FROM ${table} WHERE business_id = $1
       ORDER BY reporting_date DESC, updated_at DESC LIMIT 60`,
      [businessId]
    );
    res.json({ history: rows });
  } catch (err) {
    console.error("feedback history:", err);
    res.status(500).json({ error: "Could not load feedback history." });
  }
});

app.post("/api/feedback/order-drop", authRequired, async (req, res) => {
  try {
    const { business_id, comment } = req.body || {};
    const trimmed = String(comment || "").trim();
    if (!trimmed) return res.status(400).json({ error: "Write the drop reason first." });
    if (trimmed.length > 1000) {
      return res.status(400).json({ error: "The reason is limited to 1000 characters." });
    }
    const merchant = await loadMerchantForUser(req.user, Number(business_id));
    if (!merchant) return res.status(404).json({ error: "Merchant not found." });
    if (merchant === "forbidden") {
      return res.status(403).json({ error: "This merchant is locked for your account." });
    }
    const reportingDate = asDateString(merchant.reporting_date);
    await query(
      `INSERT INTO feedback_order_drop
         (business_id, business_name, kam_name, reporting_date, comment, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (business_id, reporting_date)
       DO UPDATE SET comment = EXCLUDED.comment, updated_at = now()`,
      [merchant.business_id, merchant.business_name, merchant.kam_name,
       reportingDate, trimmed, req.user.username]
    );
    await flipAlertWorked(merchant.business_id, reportingDate, "order_drop");
    res.json({ ok: true });
  } catch (err) {
    console.error("order-drop:", err);
    res.status(500).json({ error: "Could not save the drop reason." });
  }
});

app.post("/api/feedback/call-followup", authRequired, async (req, res) => {
  try {
    const { business_id, call_record_link, comment } = req.body || {};
    const link = String(call_record_link || "").trim();
    const note = String(comment || "").trim();
    if (!link && !note) {
      return res
        .status(400)
        .json({ error: "Add the call recording link or a short note." });
    }
    if (note.length > 1000) {
      return res.status(400).json({ error: "The note is limited to 1000 characters." });
    }
    const merchant = await loadMerchantForUser(req.user, Number(business_id));
    if (!merchant) return res.status(404).json({ error: "Merchant not found." });
    if (merchant === "forbidden") {
      return res.status(403).json({ error: "This merchant is locked for your account." });
    }
    const reportingDate = asDateString(merchant.reporting_date);
    await query(
      `INSERT INTO feedback_call_followup
         (business_id, business_name, kam_name, reporting_date,
          call_record_link, comment, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (business_id, reporting_date)
       DO UPDATE SET call_record_link = EXCLUDED.call_record_link,
                     comment = EXCLUDED.comment,
                     updated_at = now()`,
      [merchant.business_id, merchant.business_name, merchant.kam_name,
       reportingDate, link, note, req.user.username]
    );
    await flipAlertWorked(merchant.business_id, reportingDate, "call_followup");
    res.json({ ok: true });
  } catch (err) {
    console.error("call-followup:", err);
    res.status(500).json({ error: "Could not save the call follow-up." });
  }
});

app.post("/api/feedback/visit", authRequired, async (req, res) => {
  try {
    const { business_id, call_record_link, visit_pic_link } = req.body || {};
    const callLink = String(call_record_link || "").trim();
    const picLink = String(visit_pic_link || "").trim();
    if (!callLink && !picLink) {
      return res.status(400).json({ error: "Add the call record link or the visit picture link." });
    }
    const merchant = await loadMerchantForUser(req.user, Number(business_id));
    if (!merchant) return res.status(404).json({ error: "Merchant not found." });
    if (merchant === "forbidden") {
      return res.status(403).json({ error: "This merchant is locked for your account." });
    }
    const reportingDate = asDateString(merchant.reporting_date);
    await query(
      `INSERT INTO feedback_visit
         (business_id, business_name, kam_name, reporting_date,
          call_record_link, visit_pic_link, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (business_id, reporting_date)
       DO UPDATE SET call_record_link = EXCLUDED.call_record_link,
                     visit_pic_link = EXCLUDED.visit_pic_link,
                     updated_at = now()`,
      [merchant.business_id, merchant.business_name, merchant.kam_name,
       reportingDate, callLink, picLink, req.user.username]
    );
    await flipAlertWorked(merchant.business_id, reportingDate, "visit");
    res.json({ ok: true });
  } catch (err) {
    console.error("visit:", err);
    res.status(500).json({ error: "Could not save the visit record." });
  }
});

app.post("/api/feedback/issue", authRequired, async (req, res) => {
  try {
    const { business_id, reason, comment } = req.body || {};
    const trimmedReason = String(reason || "").trim();
    const trimmedComment = String(comment || "").trim();
    if (!trimmedReason) return res.status(400).json({ error: "Pick or type a reason." });
    if (trimmedComment.length > 1000) {
      return res.status(400).json({ error: "The note is limited to 1000 characters." });
    }
    const merchant = await loadMerchantForUser(req.user, Number(business_id));
    if (!merchant) return res.status(404).json({ error: "Merchant not found." });
    if (merchant === "forbidden") {
      return res.status(403).json({ error: "This merchant is locked for your account." });
    }
    const reportingDate = asDateString(merchant.reporting_date);
    await query(
      `INSERT INTO feedback_issue
         (business_id, business_name, kam_name, reporting_date, reason, comment, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (business_id, reporting_date)
       DO UPDATE SET reason = EXCLUDED.reason, comment = EXCLUDED.comment, updated_at = now()`,
      [merchant.business_id, merchant.business_name, merchant.kam_name,
       reportingDate, trimmedReason, trimmedComment, req.user.username]
    );
    await query(
      `INSERT INTO issue_reasons (reason) VALUES ($1) ON CONFLICT (reason) DO NOTHING`,
      [trimmedReason]
    );
    // No flipAlertWorked: Issue is informational in v3 and never alerts.
    res.json({ ok: true });
  } catch (err) {
    console.error("issue:", err);
    res.status(500).json({ error: "Could not save the issue." });
  }
});

app.get("/api/issue-reasons", authRequired, async (_req, res) => {
  try {
    const { rows } = await query(`SELECT reason FROM issue_reasons ORDER BY reason`);
    res.json({ reasons: rows.map((row) => row.reason) });
  } catch (err) {
    console.error("issue-reasons:", err);
    res.status(500).json({ error: "Could not load issue reasons." });
  }
});

// ---------------------------------------------------------------------------
// Weekly call tracker (Flag tab, second table)
// ---------------------------------------------------------------------------
app.get("/api/weekly-calls", authRequired, async (req, res) => {
  try {
    const weekStart = String(req.query.week || currentWeekStart()).slice(0, 10);
    const scope = await resolveScope(req, "d", 2);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const { rows } = await query(
      `SELECT d.business_id, d.business_name, d.kam_name,
              w.note, w.drive_link,
              COALESCE(w.status, 'Not Worked') AS status,
              w.updated_at
       FROM kam_daily_report d
       LEFT JOIN weekly_call_log w
              ON w.business_id = d.business_id AND w.week_start = $1
       WHERE ${scope.where}
       ORDER BY COALESCE(w.status, 'Not Worked') DESC, d.business_id`,
      [weekStart, ...scope.params]
    );
    res.json({ week_start: weekStart, rows });
  } catch (err) {
    console.error("weekly-calls:", err);
    res.status(500).json({ error: "Could not load the weekly call tracker." });
  }
});

app.post("/api/weekly-calls", authRequired, async (req, res) => {
  try {
    const { business_id, note, drive_link } = req.body || {};
    const trimmedNote = String(note || "").trim();
    const trimmedLink = String(drive_link || "").trim();
    if (trimmedNote.length > 1000) {
      return res.status(400).json({ error: "The note is limited to 1000 characters." });
    }
    if (!trimmedLink) {
      return res
        .status(400)
        .json({ error: "Add the call recording drive link to mark this call Worked." });
    }
    const merchant = await loadMerchantForUser(req.user, Number(business_id));
    if (!merchant) return res.status(404).json({ error: "Merchant not found." });
    if (merchant === "forbidden") {
      return res.status(403).json({ error: "This merchant is locked for your account." });
    }
    const weekStart = currentWeekStart();
    await query(
      `INSERT INTO weekly_call_log
         (business_id, business_name, kam_name, week_start, note, drive_link,
          status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'Worked', $7)
       ON CONFLICT (business_id, week_start)
       DO UPDATE SET note = EXCLUDED.note, drive_link = EXCLUDED.drive_link,
                     status = 'Worked', created_by = EXCLUDED.created_by,
                     updated_at = now()`,
      [merchant.business_id, merchant.business_name, merchant.kam_name,
       weekStart, trimmedNote, trimmedLink, req.user.username]
    );
    res.json({ ok: true, week_start: weekStart });
  } catch (err) {
    console.error("weekly-calls save:", err);
    res.status(500).json({ error: "Could not save the call record." });
  }
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
app.get("/api/alerts", authRequired, async (req, res) => {
  try {
    const scope = await resolveScope(req, "a");
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const { rows } = await query(
      `SELECT * FROM kam_alerts a WHERE ${scope.where}
       ORDER BY status DESC, reporting_date DESC, business_id LIMIT 500`,
      scope.params
    );
    res.json({ alerts: rows });
  } catch (err) {
    console.error("alerts:", err);
    res.status(500).json({ error: "Could not load alerts." });
  }
});

app.get("/api/alerts/count", authRequired, async (req, res) => {
  try {
    const scope = await resolveScope(req, "a");
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const { rows } = await query(
      `SELECT COUNT(*)::int AS pending FROM kam_alerts a
       WHERE a.status = 'Not Worked' AND ${scope.where}`,
      scope.params
    );
    res.json({ pending: rows[0].pending });
  } catch (err) {
    console.error("alerts count:", err);
    res.status(500).json({ error: "Could not count alerts." });
  }
});

// ---------------------------------------------------------------------------
// MERCHANT PERFORMANCE
// Lifetime table (now carrying Max Order in a Day and Potentiality) plus the
// DOD order-count grid, unchanged in shape from v2.
// ---------------------------------------------------------------------------
app.get("/api/merchants", authRequired, async (req, res) => {
  try {
    const scope = await resolveScope(req, "d");
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const { rows } = await query(
      `SELECT d.*,
              mp.promised_order,
              CASE WHEN mp.promised_order IS NULL OR mp.promised_order = 0 THEN NULL
                   ELSE ROUND(d.avg_order / mp.promised_order, 4) END AS avg_vs_promised,
              mm.classification,
              mm.orders_month,
              mm.revenue_month
       FROM kam_daily_report d
       LEFT JOIN merchant_promised_order mp ON mp.business_id = d.business_id
       LEFT JOIN kam_merchant_month mm
              ON mm.business_id = d.business_id
             AND mm.report_month = date_trunc('month', CURRENT_DATE)::date
       WHERE ${scope.where}
       ORDER BY d.business_id`,
      scope.params
    );
    res.json({ merchants: rows });
  } catch (err) {
    console.error("merchants:", err);
    res.status(500).json({ error: "Could not load merchants." });
  }
});

app.put("/api/promised-order", authRequired, async (req, res) => {
  try {
    const { business_id, promised_order } = req.body || {};
    let value = null;
    if (promised_order !== null && promised_order !== undefined &&
        String(promised_order).trim() !== "") {
      value = Number(String(promised_order).replace(/,/g, "").trim());
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({ error: "Promised order must be a number of 0 or more." });
      }
    }
    const merchant = await loadMerchantForUser(req.user, Number(business_id));
    if (!merchant) return res.status(404).json({ error: "Merchant not found." });
    if (merchant === "forbidden") {
      return res.status(403).json({ error: "This merchant is locked for your account." });
    }
    await query(
      `INSERT INTO merchant_promised_order
         (business_id, business_name, kam_name, promised_order, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (business_id) DO UPDATE SET
         promised_order = EXCLUDED.promised_order,
         business_name = EXCLUDED.business_name,
         kam_name = EXCLUDED.kam_name,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [merchant.business_id, merchant.business_name, merchant.kam_name,
       value, req.user.username]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("promised-order:", err);
    res.status(500).json({ error: "Could not save the promised order." });
  }
});

app.get("/api/dod/months", authRequired, async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT DISTINCT report_month::text AS m FROM kam_dod_monthly ORDER BY m DESC LIMIT 36`
    );
    res.json({ months: rows.map((row) => row.m) });
  } catch (err) {
    console.error("dod months:", err);
    res.status(500).json({ error: "Could not load DOD months." });
  }
});

app.get("/api/dod", authRequired, async (req, res) => {
  try {
    const month = String(req.query.month || "").trim();
    const scope = await resolveScope(req, "d", month ? 2 : 1);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const params = month ? [month, ...scope.params] : scope.params;
    const monthWhere = month
      ? `d.report_month = CAST($1 AS date)`
      : `d.report_month = (SELECT MAX(report_month) FROM kam_dod_monthly)`;
    const { rows } = await query(
      `SELECT d.business_id, d.business_name, d.kam_name,
              d.report_month::text AS report_month, d.day_values, d.active_days
       FROM kam_dod_monthly d
       WHERE ${monthWhere} AND ${scope.where}
       ORDER BY d.business_id`,
      params
    );
    res.json({ rows });
  } catch (err) {
    console.error("dod:", err);
    res.status(500).json({ error: "Could not load DOD order counts." });
  }
});

// ---------------------------------------------------------------------------
// BUSINESS INSIGHTS
//
// Same views as the Top Merchant dashboard, rebuilt on Supabase and scoped to
// the caller's merchants. Everything is aggregated in SQL: an admin looking at
// every merchant must not pull a parcel-level payload into the browser.
//
// Terminal aging brackets are the fixed 1..7,7+ columns of the source tabs.
// FID/RID brackets are discovered from the stored values, exactly as the
// Apps Script version discovered them from the sheet.
// ---------------------------------------------------------------------------
const TERM_BRACKETS = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b7_plus"];
const TERM_LABELS = ["1", "2", "3", "4", "5", "6", "7", "7+"];

function dateRange(req) {
  const from = String(req.query.from || "").slice(0, 10);
  const to = String(req.query.to || "").slice(0, 10);
  return from && to ? { from, to, ok: true } : { ok: false };
}

app.get("/api/insights/meta", authRequired, async (req, res) => {
  try {
    const scope = await resolveScope(req, "c");
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const [run, span, merchants] = await Promise.all([
      query(
        `SELECT window_start::text, window_end::text, merchants, status,
                finished_at, message
         FROM ba_refresh_log ORDER BY id DESC LIMIT 1`
      ),
      query(
        `SELECT MIN(c.report_date)::text AS min_date, MAX(c.report_date)::text AS max_date
         FROM ba_cohort_daily c WHERE ${scope.where}`,
        scope.params
      ),
      query(
        `SELECT DISTINCT c.business_id, c.business_name
         FROM ba_cohort_daily c WHERE ${scope.where}
         ORDER BY c.business_name LIMIT 5000`,
        scope.params
      ),
    ]);
    res.json({
      last_run: run.rows[0] || null,
      date_min: span.rows[0]?.min_date || null,
      date_max: span.rows[0]?.max_date || null,
      term_brackets: TERM_LABELS,
      merchants: merchants.rows,
    });
  } catch (err) {
    console.error("insights meta:", err);
    res.status(500).json({ error: "Could not load Business Insights metadata." });
  }
});

/** Merchant overview: KPIs, daily trend, per-merchant health matrix. */
app.get("/api/insights/overview", authRequired, async (req, res) => {
  try {
    const range = dateRange(req);
    if (!range.ok) return res.json({ kpis: null, trend: [], merchants: [] });
    const scope = await resolveScope(req, "c", 3);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const biz = Number(req.query.business_id) || 0;
    const bizFilter = biz ? `AND c.business_id = $${scope.params.length + 3}` : "";
    const params = [range.from, range.to, ...scope.params, ...(biz ? [biz] : [])];

    const base = `FROM ba_cohort_daily c
      WHERE c.report_date >= $1 AND c.report_date <= $2 AND ${scope.where} ${bizFilter}`;

    const [kpis, trend, merchants] = await Promise.all([
      query(
        `SELECT COALESCE(SUM(processed),0)::bigint AS processed,
                COALESCE(SUM(delivered),0)::bigint AS delivered,
                COALESCE(SUM(returned),0)::bigint AS returned,
                COALESCE(SUM(lost_damage),0)::bigint AS lost_damage,
                COALESCE(SUM(in_process),0)::bigint AS in_process,
                COALESCE(SUM(sla_breached),0)::bigint AS sla_breached,
                COALESCE(SUM(revenue),0) AS revenue,
                COALESCE(SUM(collected_amount),0) AS gmv,
                COALESCE(SUM(overall_aging * processed),0) AS aging_weight
         ${base}`,
        params
      ),
      query(
        `SELECT report_date::text AS d,
                COALESCE(SUM(processed),0)::bigint AS processed,
                COALESCE(SUM(delivered),0)::bigint AS delivered,
                COALESCE(SUM(returned),0)::bigint AS returned,
                COALESCE(SUM(lost_damage),0)::bigint AS lost_damage,
                COALESCE(SUM(in_process),0)::bigint AS in_process,
                COALESCE(SUM(sla_breached),0)::bigint AS sla_breached
         ${base} GROUP BY 1 ORDER BY 1`,
        params
      ),
      query(
        `SELECT c.business_id, MAX(c.business_name) AS business_name,
                MAX(c.kam_name) AS kam_name,
                COALESCE(SUM(c.processed),0)::bigint AS processed,
                COALESCE(SUM(c.delivered),0)::bigint AS delivered,
                COALESCE(SUM(c.returned),0)::bigint AS returned,
                COALESCE(SUM(c.lost_damage),0)::bigint AS lost_damage,
                COALESCE(SUM(c.in_process),0)::bigint AS in_process,
                COALESCE(SUM(c.sla_breached),0)::bigint AS sla_breached,
                COALESCE(SUM(c.revenue),0) AS revenue,
                COALESCE(SUM(c.collected_amount),0) AS gmv,
                CASE WHEN SUM(c.processed) > 0
                     THEN SUM(c.overall_aging * c.processed) / SUM(c.processed)
                     ELSE 0 END AS avg_aging
         ${base} GROUP BY c.business_id
         ORDER BY processed DESC LIMIT 1000`,
        params
      ),
    ]);

    const k = kpis.rows[0];
    res.json({
      kpis: {
        ...k,
        avg_aging: num(k.processed) ? num(k.aging_weight) / num(k.processed) : 0,
      },
      trend: trend.rows,
      merchants: merchants.rows,
    });
  } catch (err) {
    console.error("insights overview:", err);
    res.status(500).json({ error: "Could not load the insights overview." });
  }
});

/** In-process status split for FID / Reverse / CR. */
app.get("/api/insights/status", authRequired, async (req, res) => {
  try {
    const range = dateRange(req);
    if (!range.ok) return res.json({ rows: [] });
    const feed = String(req.query.feed || "fid");
    const scope = await resolveScope(req, "t", 3);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });

    if (feed === "fid") {
      const { rows } = await query(
        `SELECT t.system_status AS name, COALESCE(SUM(t.parcels),0)::bigint AS value
         FROM ba_fid_inprocess t
         WHERE t.snapshot_date >= $1 AND t.snapshot_date <= $2 AND ${scope.where}
         GROUP BY 1 ORDER BY 2 DESC`,
        [range.from, range.to, ...scope.params]
      );
      return res.json({ rows });
    }
    const ridType = feed === "cr" ? "CR" : "Reverse";
    const { rows } = await query(
      `SELECT t.system_status AS name, COALESCE(SUM(t.cids),0)::bigint AS value
       FROM ba_rid_inprocess t
       WHERE t.snapshot_date >= $1 AND t.snapshot_date <= $2
         AND lower(t.rid_type) = lower($${scope.params.length + 3}) AND ${scope.where}
       GROUP BY 1 ORDER BY 2 DESC`,
      [range.from, range.to, ...scope.params, ridType]
    );
    res.json({ rows });
  } catch (err) {
    console.error("insights status:", err);
    res.status(500).json({ error: "Could not load the in-process status split." });
  }
});

/**
 * Aging for any feed.
 *   feed=fwdT | revT  terminal, fixed 1..7,7+ buckets
 *   feed=fid  | rid   in process, brackets discovered from the data
 * group=region | division | biz controls the breakdown table.
 * type= (revT/rid only) Reverse | CR
 */
app.get("/api/insights/aging", authRequired, async (req, res) => {
  try {
    const range = dateRange(req);
    if (!range.ok) return res.json({ brackets: [], dist: [], mix: [], table: [] });
    const feed = String(req.query.feed || "fwdT");
    const group = String(req.query.group || "biz");
    const ridType = String(req.query.type || "").trim();
    const scope = await resolveScope(req, "t", 3);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const biz = Number(req.query.business_id) || 0;

    if (feed === "fwdT" || feed === "revT") {
      const table = feed === "revT" ? "ba_reverse_terminal" : "ba_forward_terminal";
      const params = [range.from, range.to, ...scope.params];
      let extra = "";
      if (feed === "revT" && ridType) {
        params.push(ridType);
        extra += ` AND lower(t.rid_type) = lower($${params.length})`;
      }
      if (biz) {
        params.push(biz);
        extra += ` AND t.business_id = $${params.length}`;
      }
      if (req.query.region) {
        params.push(String(req.query.region));
        extra += ` AND t.delivery_region = $${params.length}`;
      }
      const where = `WHERE t.report_date >= $1 AND t.report_date <= $2
                       AND ${scope.where} ${extra}`;
      const sums = TERM_BRACKETS.map((c) => `COALESCE(SUM(t.${c}),0)::bigint AS ${c}`).join(", ");
      const groupExpr =
        group === "region" ? "t.delivery_region"
        : group === "division" ? "t.delivery_division"
        : "MAX(t.business_name)";
      const groupKey = group === "biz" ? "t.business_id" : groupExpr;

      const [dist, mix, breakdown, regions] = await Promise.all([
        query(`SELECT ${sums} FROM ${table} t ${where}`, params),
        query(
          `SELECT t.report_date::text AS d, ${sums} FROM ${table} t ${where}
           GROUP BY 1 ORDER BY 1`,
          params
        ),
        query(
          `SELECT ${groupKey} AS key,
                  ${group === "biz" ? "MAX(t.business_name)" : groupKey} AS name,
                  ${sums}
           FROM ${table} t ${where}
           GROUP BY ${groupKey} ORDER BY 3 DESC LIMIT 1000`,
          params
        ),
        query(
          `SELECT DISTINCT t.delivery_region FROM ${table} t ${where} ORDER BY 1`,
          params
        ),
      ]);
      return res.json({
        brackets: TERM_LABELS,
        dist: TERM_BRACKETS.map((c) => num(dist.rows[0][c])),
        mix: mix.rows.map((row) => ({
          period: row.d,
          values: TERM_BRACKETS.map((c) => num(row[c])),
        })),
        table: breakdown.rows.map((row) => ({
          name: String(row.name ?? "Unknown"),
          values: TERM_BRACKETS.map((c) => num(row[c])),
        })),
        regions: regions.rows.map((row) => row.delivery_region),
      });
    }

    // In-process feeds: bracket vocabulary is whatever the data holds.
    const isFid = feed === "fid";
    const table = isFid ? "ba_fid_inprocess" : "ba_rid_inprocess";
    const bracketCol = isFid ? "aging_bracket" : "rid_aging_bracket";
    const valueCol = isFid ? "parcels" : "cids";
    const params = [range.from, range.to, ...scope.params];
    let extra = "";
    if (!isFid && ridType) {
      params.push(ridType);
      extra += ` AND lower(t.rid_type) = lower($${params.length})`;
    }
    if (!isFid && req.query.stage) {
      // Pending = the three awaiting-pickup states; everything else is In Process.
      const stage = String(req.query.stage);
      const pending = `lower(regexp_replace(t.system_status, '[^a-zA-Z0-9]+', '_', 'g')) IN
        ('reverse_pickup_assigned','reverse_pickup_on_hold','reverse_pickup_requested',
         'return_assigned_for_pickup','return_on_hold_for_pickup','return_waiting_for_pickup')`;
      extra += stage === "pending" ? ` AND ${pending}` : ` AND NOT (${pending})`;
    }
    if (biz) {
      params.push(biz);
      extra += ` AND t.business_id = $${params.length}`;
    }
    const where = `WHERE t.snapshot_date >= $1 AND t.snapshot_date <= $2
                     AND ${scope.where} ${extra}`;

    const [dist, mix, breakdown] = await Promise.all([
      query(
        `SELECT t.${bracketCol} AS bracket, COALESCE(SUM(t.${valueCol}),0)::bigint AS v
         FROM ${table} t ${where} GROUP BY 1`,
        params
      ),
      query(
        `SELECT t.snapshot_date::text AS d, t.${bracketCol} AS bracket,
                COALESCE(SUM(t.${valueCol}),0)::bigint AS v
         FROM ${table} t ${where} GROUP BY 1, 2 ORDER BY 1`,
        params
      ),
      query(
        `SELECT t.business_id, MAX(t.business_name) AS name, t.${bracketCol} AS bracket,
                COALESCE(SUM(t.${valueCol}),0)::bigint AS v
         FROM ${table} t ${where} GROUP BY t.business_id, t.${bracketCol}`,
        params
      ),
    ]);

    const brackets = sortBrackets(dist.rows.map((row) => row.bracket));
    const index = new Map(brackets.map((label, i) => [label, i]));
    const zero = () => brackets.map(() => 0);

    const distArray = zero();
    dist.rows.forEach((row) => {
      distArray[index.get(row.bracket)] = num(row.v);
    });

    const mixMap = new Map();
    mix.rows.forEach((row) => {
      if (!mixMap.has(row.d)) mixMap.set(row.d, zero());
      mixMap.get(row.d)[index.get(row.bracket)] = num(row.v);
    });

    const tableMap = new Map();
    breakdown.rows.forEach((row) => {
      const key = row.business_id;
      if (!tableMap.has(key)) tableMap.set(key, { name: row.name, values: zero() });
      tableMap.get(key).values[index.get(row.bracket)] = num(row.v);
    });

    res.json({
      brackets,
      dist: distArray,
      mix: [...mixMap.entries()].sort().map(([period, values]) => ({ period, values })),
      table: [...tableMap.values()]
        .sort((a, b) => b.values.reduce((s, v) => s + v, 0) - a.values.reduce((s, v) => s + v, 0))
        .slice(0, 1000),
    });
  } catch (err) {
    console.error("insights aging:", err);
    res.status(500).json({ error: "Could not load the aging view." });
  }
});

/** '7+' sorts after '7'; a trailing 'Unknown' stays last. */
function sortBrackets(labels) {
  const known = labels.filter((l) => /^\d+\+?$/.test(String(l).trim()));
  const rest = labels.filter((l) => !/^\d+\+?$/.test(String(l).trim()));
  known.sort((a, b) => {
    const av = parseInt(a, 10);
    const bv = parseInt(b, 10);
    if (av !== bv) return av - bv;
    return (a.includes("+") ? 1 : 0) - (b.includes("+") ? 1 : 0);
  });
  return [...known, ...rest.sort()];
}

/** Parcel-level CSV export, always scoped. */
app.get("/api/insights/export", authRequired, async (req, res) => {
  try {
    const kind = String(req.query.kind || "fid") === "rid" ? "rid" : "fid";
    const scope = await resolveScope(req, "t", 1);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const params = [...scope.params];
    let extra = "";
    if (kind === "rid" && req.query.type) {
      params.push(String(req.query.type));
      extra += ` AND lower(t.rid_type) = lower($${params.length})`;
    }
    if (Number(req.query.business_id)) {
      params.push(Number(req.query.business_id));
      extra += ` AND t.business_id = $${params.length}`;
    }
    const table = kind === "rid" ? "ba_rid_detail" : "ba_fid_detail";
    const { rows, fields } = await query(
      `SELECT * FROM ${table} t WHERE ${scope.where} ${extra} LIMIT 200000`,
      params
    );
    const header = fields.map((f) => f.name);
    const escape = (value) => {
      if (value === null || value === undefined) return "";
      const text = value instanceof Date ? value.toISOString().replace("T", " ").slice(0, 19)
                                         : String(value);
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csv = [header.join(",")]
      .concat(rows.map((row) => header.map((name) => escape(row[name])).join(",")))
      .join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${kind.toUpperCase()}_In_Process_${Date.now()}.csv"`
    );
    res.send(`\uFEFF${csv}`);
  } catch (err) {
    console.error("insights export:", err);
    res.status(500).json({ error: "Could not build the export." });
  }
});

// ---------------------------------------------------------------------------
app.get("/api/health", async (_req, res) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`KAM CRM v3 backend listening on :${port}`));

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
