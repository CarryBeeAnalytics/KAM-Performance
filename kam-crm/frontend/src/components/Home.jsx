import { useEffect, useState } from "react";
import { api, scopeQuery } from "../api.js";
import LineChart from "./LineChart.jsx";

const int = (v) => Number(v ?? 0).toLocaleString("en-US");
const money = (v) => `৳${Math.round(Number(v ?? 0)).toLocaleString("en-US")}`;
const percent = (v) => (v === null || v === undefined ? "—" : `${Number(v).toFixed(1)}%`);

function shortDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.toLocaleString("en", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()}`;
}

/* ---------------------------------------------------------------- cards --- */
function Kpi({ label, value, hint, tone = "", big = false }) {
  return (
    <div className={`kpi ${tone} ${big ? "kpi-big" : ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}

/* -------------------------------------------------------- target editor --- */
function TargetModal({ month, scope, onClose, onSaved }) {
  const [form, setForm] = useState({
    scope_type: scope.type === "kam" || scope.type === "lead" ? scope.type : "global",
    scope_value: scope.type === "kam" || scope.type === "lead" ? scope.value : "",
    target_revenue: "",
    unlock_threshold_pct: "100",
    incentive_pct: "2",
    incremental_target_pct: "",
    retention_target_pct: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api("/api/targets", {
        method: "PUT",
        body: JSON.stringify({ ...form, month }),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Set targets · {month}</h3>
        <div className="sub">
          A target set for a KAM overrides a lead target, which overrides the
          global target. Leave a field blank to inherit the level above.
        </div>

        <label>Applies to</label>
        <select value={form.scope_type} onChange={set("scope_type")}>
          <option value="global">Everyone (global)</option>
          <option value="lead">One lead</option>
          <option value="kam">One KAM</option>
        </select>

        {form.scope_type !== "global" && (
          <>
            <label>{form.scope_type === "lead" ? "Lead name" : "KAM name"}</label>
            <input
              value={form.scope_value}
              onChange={set("scope_value")}
              placeholder="Exact name as it appears in the sidebar"
            />
          </>
        )}

        <label>New Sales · target revenue (৳)</label>
        <input type="number" min="0" value={form.target_revenue}
               onChange={set("target_revenue")} placeholder="e.g. 4500000" />

        <label>Unlock the incentive card at Achievement % ≥</label>
        <input type="number" min="0" value={form.unlock_threshold_pct}
               onChange={set("unlock_threshold_pct")} />

        <label>Incentive rate (%) — the "% of Current Revenue" card</label>
        <input type="number" min="0" step="0.01" value={form.incentive_pct}
               onChange={set("incentive_pct")} />

        <label>Same Store Incremental · target growth (%)</label>
        <input type="number" min="0" step="0.01" value={form.incremental_target_pct}
               onChange={set("incremental_target_pct")} placeholder="e.g. 10" />

        <label>Same Store Retention · target retention (%)</label>
        <input type="number" min="0" step="0.01" value={form.retention_target_pct}
               onChange={set("retention_target_pct")} placeholder="e.g. 85" />

        {error && <div className="error-text">{error}</div>}
        <div className="actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save targets"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ tab --- */
export default function Home({ user, scope }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);

  const qs = scopeQuery(scope);

  function load() {
    setError("");
    api(`/api/home${qs ? `?${qs}` : ""}`)
      .then(setData)
      .catch((err) => setError(err.message));
  }

  useEffect(load, [qs]);

  if (error) return <div className="panel error-text">{error}</div>;
  if (!data) return <div className="panel empty">Loading dashboard…</div>;

  const c = data.cards;
  const ns = data.new_sales;
  const inc = data.incremental;
  const ret = data.retention;

  return (
    <>
      <div className="panel" style={{ paddingBottom: 12 }}>
        <h2>
          {user.role === "kam"
            ? `${user.full_name.split(" ")[0]} — your book at a glance`
            : "Team overview"}
        </h2>
        <p className="sub" style={{ marginBottom: 0 }}>
          Latest reporting day <b>{data.reporting_date || "—"}</b> · month{" "}
          <b>{data.report_month}</b> · call week from <b>{data.week_start}</b> ·{" "}
          <b>{data.scope.count}</b> KAM{data.scope.count === 1 ? "" : "s"} in view
        </p>
      </div>

      {/* ------------------------------ operational KPI cards ------------- */}
      <div className="kpi-grid">
        <Kpi label="Total Merchant" value={int(c.total_merchant)} hint="current book" />
        <Kpi label="Total Order (Previous Day)" value={int(c.total_order_prev_day)}
             hint="latest reporting day" />
        <Kpi label="Total Order This Month" value={int(c.total_order_month)}
             hint={data.report_month} />
        <Kpi label="Total Order Last Week" value={int(c.total_order_last_week)}
             hint="last completed Mon–Sun" />
        <Kpi label="Total Order Last Month" value={int(c.total_order_last_month)}
             hint="previous calendar month" />
        <Kpi label="Total Active Merchant" value={int(c.active_merchant)} tone="green"
             hint="ordered in the last 30 days" />
        <Kpi label="Total Inactive Merchant" value={int(c.inactive_merchant)} tone="red"
             hint="no order in 30 days" />
        <Kpi label="New Onboard Merchant" value={int(c.new_onboard)}
             hint="first ever order this month" />
        <Kpi label="Churn Win Merchant" value={int(c.churn_win)}
             hint="returned after a 30+ day gap" />
        <Kpi label="Total Alerts" value={int(c.total_alerts)} tone="dark"
             hint="order drop · call · visit" />
        <Kpi label="Worked On" value={int(c.worked_on)} tone="green"
             hint="alerts with feedback" />
        <Kpi label="Not Worked On" value={int(c.not_worked_on)} tone="red"
             hint="alerts still pending" />
        <Kpi label="Call Tracker Alerts" value={int(c.call_tracker_alerts)} tone="dark"
             hint={`${int(c.call_tracker_not_worked)} still pending this week`} />
      </div>

      {/* --------------------------------------------- NEW SALES ---------- */}
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>New Sales</h2>
            <p className="sub">
              Achievement revenue is this month's revenue from New Onboard and
              Churn Win merchants. Target resolved from the{" "}
              <b>{ns.resolved_from}</b> level.
            </p>
          </div>
          {data.can_edit_targets && (
            <button className="btn primary" onClick={() => setEditing(true)}>
              Set targets
            </button>
          )}
        </div>

        <div className="kpi-grid">
          <Kpi big label="Achievement %" value={percent(ns.achievement_pct)}
               tone={ns.achievement_pct >= 100 ? "green" : ""}
               hint={ns.target_revenue === null
                 ? "no target set for this month"
                 : `target ${money(ns.target_revenue)}`} />
          <Kpi label="Total Revenue" value={money(ns.total_revenue)}
               hint="all merchants in scope" />
          <Kpi label="Achievement Revenue" value={money(ns.achievement_revenue)}
               hint="New Onboard + Churn Win" />
          <Kpi
            label={`${Number(ns.incentive_pct).toFixed(0)}% of Current Revenue`}
            value={ns.unlocked ? money(ns.incentive_amount) : "Locked"}
            tone={ns.unlocked ? "green" : "dark"}
            hint={ns.unlocked
              ? "unlocked"
              : `unlocks at ${percent(ns.unlock_threshold_pct)} achievement`}
          />
          <Kpi label="New Onboard Merchant" value={int(ns.new_onboard)} />
          <Kpi label="Churn Win Merchant" value={int(ns.churn_win)} />
        </div>
      </div>

      {/* ------------------------------- SAME STORE INCREMENTAL ----------- */}
      <div className="panel">
        <h2>Same Store Incremental</h2>
        <p className="sub">
          Same store = merchants classified Existing that also ordered last
          month. Increment compares this month against the previous month for
          that same set, so new merchants cannot inflate it.
        </p>
        <div className="kpi-grid">
          <Kpi big label="Increment Achievement %" value={percent(inc.achievement_pct)}
               tone={inc.achievement_pct >= 100 ? "green" : ""}
               hint={inc.target_pct === null
                 ? "no growth target set"
                 : `growth ${percent(inc.growth_pct)} vs target ${percent(inc.target_pct)}`} />
          <Kpi label="Increment Order" value={int(inc.increment_order)}
               tone={inc.increment_order < 0 ? "red" : "green"}
               hint={`${int(inc.curr_orders)} vs ${int(inc.base_orders)} last month`} />
          <Kpi label="Increment Revenue" value={money(inc.increment_revenue)}
               tone={inc.increment_revenue < 0 ? "red" : "green"} />
          <Kpi label="Total Order (KAM merchants)" value={int(inc.total_orders)} />
          <Kpi label="Total Revenue (KAM merchants)" value={money(inc.total_revenue)} />
        </div>
      </div>

      {/* -------------------------------- SAME STORE RETENTION ------------ */}
      <div className="panel">
        <h2>Same Store Retention</h2>
        <p className="sub">
          Retention = merchants that ordered last month and ordered again this
          month, as a share of last month's ordering base.
        </p>
        <div className="kpi-grid">
          <Kpi big label="Retention Achievement %" value={percent(ret.achievement_pct)}
               tone={ret.achievement_pct >= 100 ? "green" : ""}
               hint={ret.target_pct === null
                 ? "no retention target set"
                 : `retention ${percent(ret.retention_pct)} vs target ${percent(ret.target_pct)}`} />
          <Kpi label="Retention Order" value={int(ret.retention_orders)}
               hint={`${int(ret.retained_merchants)} of ${int(ret.base_merchants)} merchants retained`} />
          <Kpi label="Retention Revenue" value={money(ret.retention_revenue)} />
          <Kpi label="Total Active Merchant" value={int(ret.active_merchant)} />
          <Kpi label="Total Retention Order" value={int(ret.retention_orders)} />
          <Kpi label="Total Retention Revenue" value={money(ret.retention_revenue)} />
          <Kpi label="Total Discount %" value={percent(ret.discount_pct)}
               hint="discount ÷ (delivery fee + COD fee)" />
        </div>
      </div>

      {/* ------------------------------------------------- trends --------- */}
      <div className="chart-grid">
        <div className="panel">
          <h2>Worked vs Not Worked</h2>
          <p className="sub">Alerts over the last 7 reporting days.</p>
          <LineChart
            labels={data.alert_trend.map((row) => shortDate(row.date))}
            series={[
              { name: "Worked", color: "var(--good)", values: data.alert_trend.map((r) => r.worked) },
              { name: "Not Worked", color: "var(--bad)", values: data.alert_trend.map((r) => r.not_worked) },
            ]}
          />
        </div>
        <div className="panel">
          <h2>Processed Order Trend</h2>
          <p className="sub">Last 14 days, from the Business Insights cohort.</p>
          <LineChart
            labels={data.order_trend.map((row) => shortDate(row.date))}
            series={[
              { name: "Processed", color: "var(--bee)", values: data.order_trend.map((r) => r.orders) },
            ]}
          />
        </div>
      </div>

      {editing && (
        <TargetModal
          month={data.report_month}
          scope={scope}
          onClose={() => setEditing(false)}
          onSaved={load}
        />
      )}
    </>
  );
}
