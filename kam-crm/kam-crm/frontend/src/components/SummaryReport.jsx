import { useEffect, useState } from "react";
import { api } from "../api.js";

function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "";
}

/**
 * Summery Report: one daily snapshot per KAM, stored permanently by the
 * nightly job. The date selector browses any stored day.
 */
export default function SummaryReport({ user }) {
  const [dates, setDates] = useState([]);
  const [date, setDate] = useState("");
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api("/api/summary/dates")
      .then((body) => {
        setDates(body.dates);
        if (body.dates.length) setDate(body.dates[0]);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!date) return;
    setLoading(true);
    api(`/api/summary?date=${encodeURIComponent(date)}`)
      .then((body) => setRows(body.rows))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [date]);

  const totals = rows.reduce(
    (acc, row) => ({
      active: acc.active + Number(row.active_merchant),
      total: acc.total + Number(row.total_merchant),
      inactive: acc.inactive + Number(row.inactive_merchant),
      present: acc.present + Number(row.total_order_present_month),
      previous: acc.previous + Number(row.total_order_previous_month),
      today: acc.today + Number(row.todays_order),
      gap: acc.gap + Number(row.order_gap),
    }),
    { active: 0, total: 0, inactive: 0, present: 0, previous: 0, today: 0, gap: 0 }
  );

  return (
    <div className="panel">
      <h2>Summery Report</h2>
      <p className="sub">
        Daily snapshot per KAM, stored by the nightly refresh. Pick any stored day.
      </p>
      <div className="toolbar">
        <select value={date} onChange={(e) => setDate(e.target.value)}>
          {dates.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>KAM Name</th>
              <th>Active Merchant</th>
              <th>Total Merchant</th>
              <th>Active Merchant %</th>
              <th>Inactive Merchant</th>
              <th>Total Order (Present Month)</th>
              <th>Total Order (Previous Month)</th>
              <th>Today's Order</th>
              <th>Order Gap</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="empty">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={9} className="empty">No snapshot stored for this day yet.</td></tr>
            ) : (
              <>
                {rows.map((row) => (
                  <tr key={row.kam_name}>
                    <td>{row.kam_name}</td>
                    <td className="num">{row.active_merchant}</td>
                    <td className="num">{row.total_merchant}</td>
                    <td className="num">{pct(row.active_merchant_pct)}</td>
                    <td className="num">{row.inactive_merchant}</td>
                    <td className="num">{Number(row.total_order_present_month).toLocaleString()}</td>
                    <td className="num">{Number(row.total_order_previous_month).toLocaleString()}</td>
                    <td className="num">{Number(row.todays_order).toLocaleString()}</td>
                    <td className={`num ${Number(row.order_gap) < 0 ? "neg" : "pos"}`}>
                      {Number(row.order_gap).toLocaleString()}
                    </td>
                  </tr>
                ))}
                {rows.length > 1 && (
                  <tr style={{ fontWeight: 700 }}>
                    <td>Total</td>
                    <td className="num">{totals.active}</td>
                    <td className="num">{totals.total}</td>
                    <td className="num">
                      {totals.total ? `${((totals.active / totals.total) * 100).toFixed(1)}%` : ""}
                    </td>
                    <td className="num">{totals.inactive}</td>
                    <td className="num">{totals.present.toLocaleString()}</td>
                    <td className="num">{totals.previous.toLocaleString()}</td>
                    <td className="num">{totals.today.toLocaleString()}</td>
                    <td className={`num ${totals.gap < 0 ? "neg" : "pos"}`}>
                      {totals.gap.toLocaleString()}
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
