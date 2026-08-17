import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

import { pool, query } from "./db.js";
import {
  authRequired,
  canAccessKam,
  canEditTarget,
  normalize,
  signToken,
} from "./auth.js";

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
  visit: "feedback_visit",
  issue: "feedback_issue",
};

/**
 * Resolve the kam=/lead= query filters into a SQL predicate on an aliased
 * kam_daily_report (or archive) table. Rules:
 *   - lead= is available to lead/admin only;
 *   - kam= must pass canAccessKam;
 *   - a kam-role user with no filter defaults to their own book;
 *   - lead/admin with no filter sees everything.
 * Returns {where, params} or an {error, status} object.
 */
function resolveScope(req, alias = "d", startIndex = 1) {
  const lead = String(req.query.lead || "").trim();
  const kam = String(req.query.kam || "").trim();
  if (lead) {
    if (req.user.role === "kam") {
      return { error: "Lead filters are locked for your account.", status: 403 };
    }
    return {
      where: `lower(btrim(${alias}.lead_name)) = lower(btrim($${startIndex}))`,
      params: [lead],
    };
  }
  const effectiveKam = kam || (req.user.role === "kam" ? req.user.kam_name : "");
  if (effectiveKam) {
    if (!canAccessKam(req.user, effectiveKam)) {
      return { error: "This KAM's data is locked for your account.", status: 403 };
    }
    return {
      where: `lower(btrim(${alias}.kam_name)) = lower(btrim($${startIndex}))`,
      params: [effectiveKam],
    };
  }
  return { where: "TRUE", params: [] };
}

/** Bangladesh "today" (calendar date in UTC+6). */
function bdToday() {
  const bd = new Date(Date.now() + 6 * 3600 * 1000);
  return new Date(Date.UTC(bd.getUTCFullYear(), bd.getUTCMonth(), bd.getUTCDate()));
}

/** Monday of the current Bangladesh week, as YYYY-MM-DD. */
function currentWeekStart() {
  const today = bdToday();
  const shift = (today.getUTCDay() + 6) % 7; // Monday = 0
  today.setUTCDate(today.getUTCDate() - shift);
  return today.toISOString().slice(0, 10);
}

function asDateString(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * A KAM may only touch merchants assigned to them in the current state.
 * Lead/admin may touch any merchant. Returns the merchant row or null.
 */
async function loadMerchantForUser(user, businessId) {
  const { rows } = await query(
    `SELECT business_id, business_name, kam_name, lead_name, reporting_date,
            visit, risk, order_gap_with_previous_day
     FROM kam_daily_report WHERE business_id = $1`,
    [businessId]
  );
  const merchant = rows[0];
  if (!merchant) return null;
  if (!canAccessKam(user, merchant.kam_name)) return "forbidden";
  return merchant;
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
    const token = signToken(user);
    res.json({
      token,
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
// KAM buttons (7 app-user KAMs; locked/unlocked per role)
// ---------------------------------------------------------------------------
app.get("/api/kams", authRequired, async (req, res) => {
  try {
    // 7 KAM buttons: the six role='kam' users plus the Lead (Akash Saha),
    // who also carries his own merchant book in kam_daily_report.
    const { rows } = await query(
      `SELECT full_name, kam_name FROM app_users
       WHERE role IN ('kam', 'lead') AND kam_name <> '' AND is_active
       ORDER BY full_name`
    );
    const kams = rows.map((row) => ({
      kam_name: row.kam_name || row.full_name,
      full_name: row.full_name,
      locked: !canAccessKam(req.user, row.kam_name || row.full_name),
    }));
    res.json({ kams });
  } catch (err) {
    console.error("kams:", err);
    res.status(500).json({ error: "Could not load the KAM list." });
  }
});

// Sidebar filters: the 7 KAM buttons plus Lead groups (with their KAMs).
app.get("/api/filters", authRequired, async (req, res) => {
  try {
    const kamsResult = await query(
      `SELECT full_name, kam_name FROM app_users
       WHERE role IN ('kam', 'lead') AND kam_name <> '' AND is_active
       ORDER BY full_name`
    );
    const kams = kamsResult.rows.map((row) => ({
      kam_name: row.kam_name || row.full_name,
      full_name: row.full_name,
      locked: !canAccessKam(req.user, row.kam_name || row.full_name),
    }));
    const leadsResult = await query(
      `SELECT lead_name,
              COUNT(DISTINCT kam_name)::int AS kam_count,
              COUNT(*)::int AS merchant_count
       FROM kam_daily_report
       WHERE lead_name <> ''
       GROUP BY lead_name
       ORDER BY lead_name`
    );
    const leads = leadsResult.rows.map((row) => ({
      lead_name: row.lead_name,
      kam_count: row.kam_count,
      merchant_count: row.merchant_count,
      locked: req.user.role === "kam",
    }));
    res.json({ kams, leads });
  } catch (err) {
    console.error("filters:", err);
    res.status(500).json({ error: "Could not load the sidebar filters." });
  }
});

// ---------------------------------------------------------------------------
// Home dashboard: KPI cards + last-7-day trendlines, scoped by role.
// ---------------------------------------------------------------------------
app.get("/api/home", authRequired, async (req, res) => {
  try {
    const isKam = req.user.role === "kam";
    const kamParams = isKam ? [req.user.kam_name] : [];
    const merchWhere = isKam
      ? `WHERE lower(btrim(kam_name)) = lower(btrim($1))`
      : "";
    const totalsResult = await query(
      `SELECT COUNT(*)::int AS total_merchant,
              COALESCE(SUM(last_day_order), 0)::bigint AS total_order_prev_day,
              MAX(reporting_date) AS reporting_date
       FROM kam_daily_report ${merchWhere}`,
      kamParams
    );

    const alertsResult = await query(
      `SELECT COUNT(*)::int AS total_alerts,
              COUNT(*) FILTER (WHERE status = 'Worked')::int AS worked,
              COUNT(*) FILTER (WHERE status = 'Not Worked')::int AS not_worked
       FROM kam_alerts ${isKam ? `WHERE lower(btrim(kam_name)) = lower(btrim($1))` : ""}`,
      kamParams
    );

    const weekStart = currentWeekStart();
    const callParams = isKam ? [weekStart, req.user.kam_name] : [weekStart];
    const callResult = await query(
      `SELECT
         (SELECT COUNT(*) FROM kam_daily_report d
           ${isKam ? `WHERE lower(btrim(d.kam_name)) = lower(btrim($2))` : ""})::int
             AS obligations,
         COUNT(*) FILTER (WHERE w.status = 'Worked')::int AS worked
       FROM weekly_call_log w
       WHERE w.week_start = $1
         ${isKam ? `AND lower(btrim(w.kam_name)) = lower(btrim($2))` : ""}`,
      callParams
    );
    const callObligations = callResult.rows[0].obligations;
    const callWorked = Math.min(callResult.rows[0].worked, callObligations);

    // Last-7-day alert trend: Worked vs Not Worked per reporting date.
    const alertTrendResult = await query(
      `SELECT reporting_date::text AS d,
              COUNT(*) FILTER (WHERE status = 'Worked')::int AS worked,
              COUNT(*) FILTER (WHERE status = 'Not Worked')::int AS not_worked
       FROM kam_alerts
       WHERE reporting_date >= (SELECT COALESCE(MAX(reporting_date), CURRENT_DATE)
                                FROM kam_alerts) - INTERVAL '6 days'
         ${isKam ? `AND lower(btrim(kam_name)) = lower(btrim($1))` : ""}
       GROUP BY reporting_date
       ORDER BY reporting_date`,
      kamParams
    );

    // Last-7-day total order trend from the daily summary snapshots.
    const orderTrendResult = await query(
      `SELECT reporting_date::text AS d,
              COALESCE(SUM(todays_order), 0)::bigint AS orders
       FROM kam_summary_daily
       WHERE reporting_date >= (SELECT COALESCE(MAX(reporting_date), CURRENT_DATE)
                                FROM kam_summary_daily) - INTERVAL '6 days'
         ${isKam ? `AND lower(btrim(kam_name)) = lower(btrim($1))` : ""}
       GROUP BY reporting_date
       ORDER BY reporting_date`,
      kamParams
    );

    res.json({
      reporting_date: asDateString(totalsResult.rows[0].reporting_date),
      cards: {
        total_merchant: totalsResult.rows[0].total_merchant,
        total_order_prev_day: Number(totalsResult.rows[0].total_order_prev_day),
        total_reason_alerts: alertsResult.rows[0].total_alerts,
        total_worked: alertsResult.rows[0].worked,
        total_not_worked: alertsResult.rows[0].not_worked,
        call_tracker_alerts: callObligations,
        call_tracker_not_worked: Math.max(callObligations - callWorked, 0),
      },
      week_start: weekStart,
      alert_trend: alertTrendResult.rows.map((row) => ({
        date: row.d,
        worked: row.worked,
        not_worked: row.not_worked,
      })),
      order_trend: orderTrendResult.rows.map((row) => ({
        date: row.d,
        orders: Number(row.orders),
      })),
    });
  } catch (err) {
    console.error("home:", err);
    res.status(500).json({ error: "Could not load the home dashboard." });
  }
});


// ---------------------------------------------------------------------------
// Merchant Performance tab (kam= or lead= scope)
// ---------------------------------------------------------------------------
app.get("/api/merchants", authRequired, async (req, res) => {
  try {
    const scope = resolveScope(req, "d");
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const { rows } = await query(
      `SELECT d.*,
              (fod.id IS NOT NULL) AS has_order_drop_feedback,
              (fv.id IS NOT NULL)  AS has_visit_feedback,
              (fi.id IS NOT NULL)  AS has_issue_feedback,
              mp.promised_order,
              CASE
                WHEN mp.promised_order IS NULL OR mp.promised_order = 0 THEN NULL
                ELSE ROUND(d.avg_order / mp.promised_order, 4)
              END AS avg_vs_promised
       FROM kam_daily_report d
       LEFT JOIN feedback_order_drop fod
              ON fod.business_id = d.business_id
             AND fod.reporting_date = d.reporting_date
       LEFT JOIN feedback_visit fv
              ON fv.business_id = d.business_id
             AND fv.reporting_date = d.reporting_date
       LEFT JOIN feedback_issue fi
              ON fi.business_id = d.business_id
             AND fi.reporting_date = d.reporting_date
       LEFT JOIN merchant_promised_order mp
              ON mp.business_id = d.business_id
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

// Promised order: KAM (own merchants), Lead, and Admin can set it.
app.put("/api/promised-order", authRequired, async (req, res) => {
  try {
    const { business_id, promised_order } = req.body || {};
    let value = null;
    if (
      promised_order !== null &&
      promised_order !== undefined &&
      String(promised_order).trim() !== ""
    ) {
      value = Number(String(promised_order).replace(/,/g, "").trim());
      if (!Number.isFinite(value) || value < 0) {
        return res
          .status(400)
          .json({ error: "Promised order must be a number of 0 or more." });
      }
    }
    const merchant = await loadMerchantForUser(req.user, Number(business_id));
    if (!merchant) return res.status(404).json({ error: "Merchant not found." });
    if (merchant === "forbidden") {
      return res
        .status(403)
        .json({ error: "This merchant is locked for your account." });
    }
    await query(
      `INSERT INTO merchant_promised_order
         (business_id, business_name, kam_name, promised_order, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (business_id)
       DO UPDATE SET promised_order = EXCLUDED.promised_order,
                     business_name = EXCLUDED.business_name,
                     kam_name = EXCLUDED.kam_name,
                     updated_by = EXCLUDED.updated_by,
                     updated_at = now()`,
      [
        merchant.business_id,
        merchant.business_name,
        merchant.kam_name,
        value,
        req.user.username,
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("promised-order:", err);
    res.status(500).json({ error: "Could not save the promised order." });
  }
});

// ---------------------------------------------------------------------------
// Merchant-wise DOD order counts (Aug 1, Aug 2, ... columns).
// Reads the permanent monthly archive so any stored month can be browsed;
// the current month is refreshed there on every nightly run.
// ---------------------------------------------------------------------------
app.get("/api/dod/months", authRequired, async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT DISTINCT report_month::text AS m
       FROM kam_dod_monthly ORDER BY m DESC LIMIT 36`
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
    const scope = resolveScope(req, "d", month ? 2 : 1);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const params = month ? [month, ...scope.params] : scope.params;
    const monthWhere = month
      ? `d.report_month = CAST($1 AS date)`
      : `d.report_month = (SELECT MAX(report_month) FROM kam_dod_monthly)`;
    const { rows } = await query(
      `SELECT d.business_id, d.business_name, d.kam_name,
              d.report_month::text AS report_month,
              d.day_values, d.active_days
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
// Feedback (order drop / visit / issue) - one editable entry per business per
// reporting date; submitting flips the matching alert to Worked.
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
      `SELECT * FROM ${table}
       WHERE business_id = $1
       ORDER BY reporting_date DESC, updated_at DESC
       LIMIT 60`,
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
      [
        merchant.business_id,
        merchant.business_name,
        merchant.kam_name,
        reportingDate,
        trimmed,
        req.user.username,
      ]
    );
    await flipAlertWorked(merchant.business_id, reportingDate, "order_drop");
    res.json({ ok: true });
  } catch (err) {
    console.error("order-drop:", err);
    res.status(500).json({ error: "Could not save the drop reason." });
  }
});

app.post("/api/feedback/visit", authRequired, async (req, res) => {
  try {
    const { business_id, call_record_link, visit_pic_link } = req.body || {};
    const callLink = String(call_record_link || "").trim();
    const picLink = String(visit_pic_link || "").trim();
    if (!callLink && !picLink) {
      return res
        .status(400)
        .json({ error: "Add the call record link or the visit picture link." });
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
      [
        merchant.business_id,
        merchant.business_name,
        merchant.kam_name,
        reportingDate,
        callLink,
        picLink,
        req.user.username,
      ]
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
       DO UPDATE SET reason = EXCLUDED.reason,
                     comment = EXCLUDED.comment,
                     updated_at = now()`,
      [
        merchant.business_id,
        merchant.business_name,
        merchant.kam_name,
        reportingDate,
        trimmedReason,
        trimmedComment,
        req.user.username,
      ]
    );
    // New reasons typed by KAMs grow the dropdown for everyone.
    await query(
      `INSERT INTO issue_reasons (reason) VALUES ($1) ON CONFLICT (reason) DO NOTHING`,
      [trimmedReason]
    );
    await flipAlertWorked(merchant.business_id, reportingDate, "issue");
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
// KAM Performance tab
// ---------------------------------------------------------------------------

// Merchants with any active button + feedback state + alert state.
app.get("/api/kam-performance", authRequired, async (req, res) => {
  try {
    const scope = resolveScope(req, "d");
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const { rows } = await query(
      `SELECT d.business_id,
                d.business_name,
                d.kam_name,
                d.reporting_date,
                d.visit,
                d.risk,
                d.order_gap_with_previous_day,
                (d.order_gap_with_previous_day < 0) AS order_drop_active,
                (lower(d.visit) IN ('call mandatory', 'must visit')) AS visit_active,
                (lower(d.risk) <> 'no risk') AS issue_active,
                (fod.id IS NOT NULL) AS has_order_drop_feedback,
                (fv.id IS NOT NULL)  AS has_visit_feedback,
                (fi.id IS NOT NULL)  AS has_issue_feedback,
                COALESCE(alerts.alerts, '[]'::json) AS alerts
         FROM kam_daily_report d
         LEFT JOIN feedback_order_drop fod
                ON fod.business_id = d.business_id
               AND fod.reporting_date = d.reporting_date
         LEFT JOIN feedback_visit fv
                ON fv.business_id = d.business_id
               AND fv.reporting_date = d.reporting_date
         LEFT JOIN feedback_issue fi
                ON fi.business_id = d.business_id
               AND fi.reporting_date = d.reporting_date
         LEFT JOIN LATERAL (
             SELECT json_agg(json_build_object(
                        'reporting_date', a.reporting_date,
                        'alert_type', a.alert_type,
                        'alert_reason', a.alert_reason,
                        'status', a.status
                    ) ORDER BY a.reporting_date DESC) AS alerts
             FROM kam_alerts a
             WHERE a.business_id = d.business_id
               AND (a.status = 'Not Worked'
                    OR a.reporting_date >= d.reporting_date - INTERVAL '7 days')
         ) alerts ON true
       WHERE ${scope.where}
         AND (d.order_gap_with_previous_day < 0
              OR lower(d.visit) IN ('call mandatory', 'must visit')
              OR lower(d.risk) <> 'no risk')
       ORDER BY d.business_id`,
      scope.params
    );
    res.json({ rows });
  } catch (err) {
    console.error("kam-performance:", err);
    res.status(500).json({ error: "Could not load KAM performance." });
  }
});

// Alerts list + count (10-minute global popup).
app.get("/api/alerts", authRequired, async (req, res) => {
  try {
    const kam = req.query.kam || (req.user.role === "kam" ? req.user.kam_name : "");
    if (kam && !canAccessKam(req.user, kam)) {
      return res.status(403).json({ error: "This KAM's alerts are locked for your account." });
    }
    const params = [];
    let where = "";
    if (kam) {
      params.push(kam);
      where = `WHERE lower(btrim(kam_name)) = lower(btrim($1))`;
    }
    const { rows } = await query(
      `SELECT * FROM kam_alerts ${where}
       ORDER BY status DESC, reporting_date DESC, business_id
       LIMIT 500`,
      params
    );
    res.json({ alerts: rows });
  } catch (err) {
    console.error("alerts:", err);
    res.status(500).json({ error: "Could not load alerts." });
  }
});

app.get("/api/alerts/count", authRequired, async (req, res) => {
  try {
    // KAM: own pending alerts. Lead/admin: combined pending count.
    const params = [];
    let where = `WHERE status = 'Not Worked'`;
    if (req.user.role === "kam") {
      params.push(req.user.kam_name);
      where += ` AND lower(btrim(kam_name)) = lower(btrim($1))`;
    }
    const { rows } = await query(
      `SELECT COUNT(*)::int AS pending FROM kam_alerts ${where}`,
      params
    );
    res.json({ pending: rows[0].pending });
  } catch (err) {
    console.error("alerts count:", err);
    res.status(500).json({ error: "Could not count alerts." });
  }
});

// Weekly call tracker: all merchants in scope with this week's status.
app.get("/api/weekly-calls", authRequired, async (req, res) => {
  try {
    const weekStart = currentWeekStart();
    const scope = resolveScope(req, "d", 2);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const { rows } = await query(
      `SELECT d.business_id,
              d.business_name,
              d.kam_name,
              w.note,
              w.drive_link,
              COALESCE(w.status, 'Not Worked') AS status,
              w.updated_at
       FROM kam_daily_report d
       LEFT JOIN weekly_call_log w
              ON w.business_id = d.business_id
             AND w.week_start = $1
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
       DO UPDATE SET note = EXCLUDED.note,
                     drive_link = EXCLUDED.drive_link,
                     status = 'Worked',
                     created_by = EXCLUDED.created_by,
                     updated_at = now()`,
      [
        merchant.business_id,
        merchant.business_name,
        merchant.kam_name,
        weekStart,
        trimmedNote,
        trimmedLink,
        req.user.username,
      ]
    );
    res.json({ ok: true, week_start: weekStart });
  } catch (err) {
    console.error("weekly-calls save:", err);
    res.status(500).json({ error: "Could not save the call record." });
  }
});

// Retention & Incremental table + Target editing (lead/admin only).
app.get("/api/retention", authRequired, async (req, res) => {
  try {
    const params = [];
    let where = "";
    if (req.user.role === "kam") {
      params.push(req.user.kam_name);
      where = `WHERE lower(btrim(kam_name)) = lower(btrim($1))`;
    }
    const { rows } = await query(
      `SELECT kam_name, report_month, per_active_merchant_count,
              curr_active_merchant_count, merchant_retention_pct,
              per_month_orders, per_month_rvn, curr_month_orders,
              curr_month_rvn, order_retention_pct, target, target_orders,
              target_rvn, target_achievement_order, target_achievement_rvn,
              achievement
       FROM kam_retention_target ${where}
       ORDER BY kam_name`,
      params
    );
    res.json({ rows, can_edit_target: canEditTarget(req.user) });
  } catch (err) {
    console.error("retention:", err);
    res.status(500).json({ error: "Could not load Retention & Incremental." });
  }
});

app.put("/api/retention/target", authRequired, async (req, res) => {
  try {
    if (!canEditTarget(req.user)) {
      return res.status(403).json({ error: "Only the Lead or an Admin can set targets." });
    }
    const { kam_name, target } = req.body || {};
    if (!kam_name) return res.status(400).json({ error: "kam_name is required." });
    let ratio = null;
    if (target !== null && target !== undefined && String(target).trim() !== "") {
      const numeric = Number(String(target).replace("%", "").trim());
      if (!Number.isFinite(numeric)) {
        return res.status(400).json({ error: "Target must be a number (10 means 10%)." });
      }
      ratio = numeric / 100; // Approved: 10 -> 10% -> 0.10 growth ratio.
    }
    const { rowCount } = await query(
      `UPDATE kam_retention_target
       SET target = $2, refreshed_at = now()
       WHERE lower(btrim(kam_name)) = lower(btrim($1))`,
      [kam_name, ratio]
    );
    if (!rowCount) return res.status(404).json({ error: "KAM not found in retention table." });
    res.json({ ok: true });
  } catch (err) {
    console.error("target:", err);
    res.status(500).json({ error: "Could not save the target." });
  }
});

// ---------------------------------------------------------------------------
// Summery Report tab (daily snapshots; ?date=YYYY-MM-DD for history)
// ---------------------------------------------------------------------------
app.get("/api/summary/dates", authRequired, async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT DISTINCT reporting_date FROM kam_summary_daily
       ORDER BY reporting_date DESC LIMIT 120`
    );
    res.json({ dates: rows.map((row) => asDateString(row.reporting_date)) });
  } catch (err) {
    console.error("summary dates:", err);
    res.status(500).json({ error: "Could not load summary dates." });
  }
});

app.get("/api/summary", authRequired, async (req, res) => {
  try {
    const params = [];
    let where = "";
    if (req.query.date) {
      params.push(req.query.date);
      where = `WHERE reporting_date = $${params.length}`;
    } else {
      where = `WHERE reporting_date = (SELECT MAX(reporting_date) FROM kam_summary_daily)`;
    }
    if (req.user.role === "kam") {
      params.push(req.user.kam_name);
      where += ` AND lower(btrim(kam_name)) = lower(btrim($${params.length}))`;
    }
    const { rows } = await query(
      `SELECT kam_name, reporting_date, active_merchant, total_merchant,
              active_merchant_pct, inactive_merchant,
              total_order_present_month, total_order_previous_month,
              todays_order, order_gap
       FROM kam_summary_daily ${where}
       ORDER BY kam_name`,
      params
    );
    res.json({ rows });
  } catch (err) {
    console.error("summary:", err);
    res.status(500).json({ error: "Could not load the summary report." });
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
app.listen(port, () => {
  console.log(`KAM CRM backend listening on :${port}`);
});

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
