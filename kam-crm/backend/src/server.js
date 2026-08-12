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
  requireKamScope,
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

// ---------------------------------------------------------------------------
// Merchant Performance tab
// ---------------------------------------------------------------------------
app.get(
  "/api/merchants",
  authRequired,
  requireKamScope((req) => req.query.kam),
  async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT d.*,
                (fod.id IS NOT NULL) AS has_order_drop_feedback,
                (fv.id IS NOT NULL)  AS has_visit_feedback,
                (fi.id IS NOT NULL)  AS has_issue_feedback
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
         WHERE lower(btrim(d.kam_name)) = lower(btrim($1))
         ORDER BY d.business_id`,
        [req.query.kam]
      );
      res.json({ merchants: rows });
    } catch (err) {
      console.error("merchants:", err);
      res.status(500).json({ error: "Could not load merchants." });
    }
  }
);

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
app.get(
  "/api/kam-performance",
  authRequired,
  requireKamScope((req) => req.query.kam),
  async (req, res) => {
    try {
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
         WHERE lower(btrim(d.kam_name)) = lower(btrim($1))
           AND (d.order_gap_with_previous_day < 0
                OR lower(d.visit) IN ('call mandatory', 'must visit')
                OR lower(d.risk) <> 'no risk')
         ORDER BY d.business_id`,
        [req.query.kam]
      );
      res.json({ rows });
    } catch (err) {
      console.error("kam-performance:", err);
      res.status(500).json({ error: "Could not load KAM performance." });
    }
  }
);

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

// Weekly call tracker: all merchants of the KAM with this week's status.
app.get(
  "/api/weekly-calls",
  authRequired,
  requireKamScope((req) => req.query.kam),
  async (req, res) => {
    try {
      const weekStart = currentWeekStart();
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
               AND w.week_start = $2
         WHERE lower(btrim(d.kam_name)) = lower(btrim($1))
         ORDER BY COALESCE(w.status, 'Not Worked') DESC, d.business_id`,
        [req.query.kam, weekStart]
      );
      res.json({ week_start: weekStart, rows });
    } catch (err) {
      console.error("weekly-calls:", err);
      res.status(500).json({ error: "Could not load the weekly call tracker." });
    }
  }
);

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
