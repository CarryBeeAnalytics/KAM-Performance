import { useEffect, useMemo, useState } from "react";
import { api, scopeQuery } from "../api.js";

const int = (v) => Number(v ?? 0).toLocaleString("en-US");
const money = (v) => `৳${Math.round(Number(v ?? 0)).toLocaleString("en-US")}`;
const percent = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`);
const ratio = (a, b) => (Number(b) ? (Number(a) / Number(b)) * 100 : null);

function monthName(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" });
}
function shortDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()} ${d.toLocaleString("en", { month: "short", timeZone: "UTC" })}`;
}

const SUM_FIELDS = [
  "merchants", "new_onboard", "churn_win", "total_orders", "total_revenue",
  "new_sales_revenue", "ss_curr_orders", "ss_prev_orders", "ss_curr_revenue",
  "ss_prev_revenue", "base_merchants", "retained_merchants", "retention_orders",
  "retention_revenue",
];

/** A KAM row's own incentive: incentive % of New Sales once unlocked. */
function kamIncentive(row) {
  const achievement = ratio(row.new_sales_revenue, row.target_revenue);
  const unlocked = achievement !== null && achievement >= Number(row.unlock_threshold_pct ?? 100);
  return unlocked ? (Number(row.new_sales_revenue) * Number(row.incentive_pct ?? 2)) / 100 : 0;
}

/**
 * Add KAM rows together. Revenue targets and incentives are summed (each KAM
 * earns its own). Growth and retention targets are percentages, so a group's
 * target is the average of its KAMs' targets weighted by the same base the
 * percentage uses (last month's orders / last month's ordering merchants).
 */
function combine(label, rows) {
  const total = { label, kams: rows.length };
  SUM_FIELDS.forEach((field) => {
    total[field] = rows.reduce((s, r) => s + Number(r[field] ?? 0), 0);
  });
  const targeted = rows.filter((r) => r.target_revenue !== null && r.target_revenue !== undefined);
  total.target_revenue = targeted.length
    ? targeted.reduce((s, r) => s + Number(r.target_revenue), 0)
    : null;
  total.incentive = rows.reduce((s, r) => s + kamIncentive(r), 0);

  const weighted = (targetField, weightField) => {
    const withTarget = rows.filter((r) => r[targetField] !== null && r[targetField] !== undefined);
    const weight = withTarget.reduce((s, r) => s + Number(r[weightField] ?? 0), 0);
    if (!withTarget.length) return null;
    if (!weight) return withTarget.reduce((s, r) => s + Number(r[targetField]), 0) / withTarget.length;
    return withTarget.reduce((s, r) => s + Number(r[targetField]) * Number(r[weightField] ?? 0), 0) / weight;
  };
  total.incremental_target_pct = weighted("incremental_target_pct", "ss_prev_orders");
  total.retention_target_pct = weighted("retention_target_pct", "base_merchants");
  total.through_date = rows.reduce((d, r) => (r.through_date > d ? r.through_date : d), "");
  return total;
}

function derive(row) {
  const achievement = ratio(row.new_sales_revenue, row.target_revenue);
  const growth = ratio(row.ss_curr_orders - row.ss_prev_orders, row.ss_prev_orders);
  const retention = ratio(row.retained_merchants, row.base_merchants);
  return {
    achievement,
    growth,
    incAchievement:
      growth === null || !Number(row.incremental_target_pct)
        ? null
        : (growth / Number(row.incremental_target_pct)) * 100,
    incrementRevenue: Number(row.ss_curr_revenue) - Number(row.ss_prev_revenue),
    retention,
    retAchievement:
      retention === null || !Number(row.retention_target_pct)
        ? null
        : (retention / Number(row.retention_target_pct)) * 100,
  };
}

const GROUPS = [
  { id: "kam", label: "By KAM" },
  { id: "lead", label: "By Lead" },
  { id: "team", label: "By Team" },
];

function tone(value, goal = 100) {
  if (value === null || value === undefined) return "";
  return value >= goal ? "pos" : "neg";
}

export default function MonthlyReport({ scope }) {
  const [months, setMonths] = useState([]);
  const [month, setMonth] = useState("");
  const [rows, setRows] = useState(null);
  const [group, setGroup] = useState("kam");
  const [error, setError] = useState("");

  const qs = scopeQuery(scope);

  useEffect(() => {
    setError("");
    api(`/api/monthly-report/months${qs ? `?${qs}` : ""}`)
      .then((body) => {
        setMonths(body.months);
        setMonth((current) => (body.months.includes(current) ? current : body.months[0] || ""));
        if (!body.months.length) setRows([]);
      })
      .catch((err) => setError(err.message));
  }, [qs]);

  useEffect(() => {
    if (!month) return;
    setRows(null);
    api(`/api/monthly-report?month=${month}${qs ? `&${qs}` : ""}`)
      .then((body) => setRows(body.rows))
      .catch((err) => setError(err.message));
  }, [month, qs]);

  const table = useMemo(() => {
    if (!rows) return [];
    if (group === "kam") {
      return rows.map((r) => ({
        ...r,
        label: r.kam_name,
        sub: [r.lead_name, r.team_name].filter(Boolean).join(" · "),
        incentive: kamIncentive(r),
      }));
    }
    const key = group === "lead" ? "lead_name" : "team_name";
    const buckets = new Map();
    rows.forEach((r) => {
      const name = r[key] || "—";
      if (!buckets.has(name)) buckets.set(name, []);
      buckets.get(name).push(r);
    });
    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, members]) => ({
        ...combine(name, members),
        sub: `${members.length} KAM${members.length === 1 ? "" : "s"}`,
      }));
  }, [rows, group]);

  const total = useMemo(() => (rows && rows.length ? combine("Total", rows) : null), [rows]);

  if (error) return <div className="panel error-text">{error}</div>;

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>Monthly Report</h2>
          <p className="sub">
            Each month's New Sales, Same Store Incremental and Same Store
            Retention, saved per KAM every time KAMP runs. The last run of a
            month leaves its final numbers; <b>Through</b> shows the last day
            a row covers. Team and Lead rows add up their KAMs.
          </p>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <label>
            Month
            <select value={month} onChange={(e) => setMonth(e.target.value)}>
              {months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
            </select>
          </label>
          <div className="seg">
            {GROUPS.map((g) => (
              <button key={g.id} className={group === g.id ? "on" : ""} onClick={() => setGroup(g.id)}>
                {g.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {!rows ? (
        <div className="empty">Loading…</div>
      ) : !rows.length ? (
        <div className="empty">No saved months yet. They appear after the next KAMP run.</div>
      ) : (
        <div className="table-wrap" style={{ maxHeight: "68vh" }}>
          <table>
            <thead>
              <tr>
                <th className="sticky-col" rowSpan={2}>{GROUPS.find((g) => g.id === group).label.replace("By ", "")}</th>
                <th rowSpan={2}>Through</th>
                <th rowSpan={2}>Merchants</th>
                <th colSpan={7}>New Sales</th>
                <th colSpan={5}>Same Store Incremental</th>
                <th colSpan={5}>Same Store Retention</th>
                <th rowSpan={2}>Total Orders</th>
                <th rowSpan={2}>Total Revenue</th>
              </tr>
              <tr>
                <th>New Onboard</th>
                <th>Churn Win</th>
                <th>Achievement Revenue</th>
                <th>Target</th>
                <th>Achievement %</th>
                <th>Incentive</th>
                <th>Incentive Rate</th>
                <th>Orders (this / last)</th>
                <th>Growth %</th>
                <th>Target %</th>
                <th>Achievement %</th>
                <th>Increment Revenue</th>
                <th>Retained / Base</th>
                <th>Retention %</th>
                <th>Target %</th>
                <th>Achievement %</th>
                <th>Retention Revenue</th>
              </tr>
            </thead>
            <tbody>
              {[...table, ...(total ? [{ ...total, sub: `${total.kams} KAMs`, isTotal: true }] : [])].map((row) => {
                const d = derive(row);
                return (
                  <tr key={`${row.isTotal ? "total" : row.label}`} style={row.isTotal ? { fontWeight: 700 } : undefined}>
                    <td className="sticky-col">
                      {row.label}
                      {row.sub && <div className="muted" style={{ fontSize: 11 }}>{row.sub}</div>}
                    </td>
                    <td>{row.through_date ? shortDay(row.through_date) : "—"}</td>
                    <td>{int(row.merchants)}</td>
                    <td>{int(row.new_onboard)}</td>
                    <td>{int(row.churn_win)}</td>
                    <td>{money(row.new_sales_revenue)}</td>
                    <td>{row.target_revenue === null || row.target_revenue === undefined ? "—" : money(row.target_revenue)}</td>
                    <td className={tone(d.achievement)}>{percent(d.achievement)}</td>
                    <td>{row.incentive ? money(row.incentive) : "—"}</td>
                    <td>{group === "kam" && !row.isTotal ? `${Number(row.incentive_pct ?? 2)}% at ≥${Number(row.unlock_threshold_pct ?? 100)}%` : "per KAM"}</td>
                    <td>{int(row.ss_curr_orders)} / {int(row.ss_prev_orders)}</td>
                    <td className={tone(d.growth, 0)}>{percent(d.growth)}</td>
                    <td>{percent(row.incremental_target_pct === null ? null : Number(row.incremental_target_pct))}</td>
                    <td className={tone(d.incAchievement)}>{percent(d.incAchievement)}</td>
                    <td className={d.incrementRevenue < 0 ? "neg" : "pos"}>{money(d.incrementRevenue)}</td>
                    <td>{int(row.retained_merchants)} / {int(row.base_merchants)}</td>
                    <td>{percent(d.retention)}</td>
                    <td>{percent(row.retention_target_pct === null ? null : Number(row.retention_target_pct))}</td>
                    <td className={tone(d.retAchievement)}>{percent(d.retAchievement)}</td>
                    <td>{money(row.retention_revenue)}</td>
                    <td>{int(row.total_orders)}</td>
                    <td>{money(row.total_revenue)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
