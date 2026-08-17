import { useEffect, useState } from "react";
import { api } from "../api.js";
import LineChart from "./LineChart.jsx";

function shortDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.toLocaleString("en", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()}`;
}

const CARDS = [
  { key: "total_merchant", label: "Total Merchants", tone: "", hint: "assigned in current state" },
  { key: "total_order_prev_day", label: "Total Order (Prev. Day)", tone: "", hint: "latest reporting day" },
  { key: "total_reason_alerts", label: "Total Reason Alerts", tone: "dark", hint: "all stored alerts" },
  { key: "total_worked", label: "Total Worked On", tone: "green", hint: "alerts with feedback" },
  { key: "total_not_worked", label: "Total Not Worked On", tone: "red", hint: "alerts still pending" },
  { key: "call_tracker_alerts", label: "Call Tracker Alerts", tone: "dark", hint: "calls due this week" },
  { key: "call_tracker_not_worked", label: "Calls Not Worked On", tone: "red", hint: "this week, still pending" },
];

export default function Home({ user }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/home")
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <div className="panel error-text">{error}</div>;
  if (!data) return <div className="panel empty">Loading dashboard…</div>;

  const alertLabels = data.alert_trend.map((row) => shortDate(row.date));
  const orderLabels = data.order_trend.map((row) => shortDate(row.date));

  return (
    <>
      <div className="panel" style={{ paddingBottom: 12 }}>
        <h2>
          {user.role === "kam"
            ? `Welcome, ${user.full_name.split(" ")[0]} — your book at a glance`
            : "Team overview"}
        </h2>
        <p className="sub" style={{ marginBottom: 0 }}>
          Latest reporting day: <b>{data.reporting_date || "—"}</b> · Call week
          starts <b>{data.week_start}</b>
          {user.role !== "kam" ? " · showing all teams combined" : ""}
        </p>
      </div>

      <div className="kpi-grid">
        {CARDS.map((card) => (
          <div className={`kpi ${card.tone}`} key={card.key}>
            <div className="kpi-label">{card.label}</div>
            <div className="kpi-value">
              {Number(data.cards[card.key] ?? 0).toLocaleString()}
            </div>
            <div className="kpi-hint">{card.hint}</div>
          </div>
        ))}
      </div>

      <div className="chart-grid">
        <div className="panel">
          <h2>Daily Worked vs Not Worked</h2>
          <p className="sub">Reason alerts over the last 7 reporting days.</p>
          <LineChart
            labels={alertLabels}
            series={[
              {
                name: "Worked",
                color: "var(--good)",
                values: data.alert_trend.map((row) => row.worked),
              },
              {
                name: "Not Worked",
                color: "var(--bad)",
                values: data.alert_trend.map((row) => row.not_worked),
              },
            ]}
          />
        </div>
        <div className="panel">
          <h2>Total Order Trend</h2>
          <p className="sub">Daily processed orders over the last 7 reporting days.</p>
          <LineChart
            labels={orderLabels}
            series={[
              {
                name: "Total orders",
                color: "var(--bee)",
                values: data.order_trend.map((row) => row.orders),
              },
            ]}
          />
        </div>
      </div>
    </>
  );
}
