import { useCallback, useEffect, useMemo, useState } from "react";
import { api, scopeQuery } from "../api.js";

const int = (v) => Number(v ?? 0).toLocaleString("en-US");
const day = (v) => (v ? String(v).slice(0, 10) : "—");

function shortDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.toLocaleString("en", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()}`;
}
function monthName(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" });
}

/* --------------------------------------------------- promised order ------ */
function PromisedOrderModal({ merchant, onClose, onSaved }) {
  const [value, setValue] = useState(
    merchant.promised_order === null || merchant.promised_order === undefined
      ? ""
      : String(merchant.promised_order)
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(clear = false) {
    setBusy(true);
    setError("");
    try {
      await api("/api/promised-order", {
        method: "PUT",
        body: JSON.stringify({
          business_id: merchant.business_id,
          promised_order: clear ? null : value,
        }),
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
        <h3>Promised order · {merchant.business_name}</h3>
        <div className="sub">
          Daily volume the merchant committed to. Average order is{" "}
          <b>{merchant.avg_order}</b>; the ratio column updates automatically.
        </div>
        <label>Promised order (per day)</label>
        <input type="number" min="0" step="0.01" value={value} autoFocus
               onChange={(e) => setValue(e.target.value)} placeholder="e.g. 25" />
        {error && <div className="error-text">{error}</div>}
        <div className="actions">
          {merchant.promised_order !== null && merchant.promised_order !== undefined && (
            <button className="btn" onClick={() => save(true)} disabled={busy}>Clear</button>
          )}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => save(false)}
                  disabled={busy || String(value).trim() === ""}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ lifetime table --- */
function LifetimeTable({ merchants, loading, onPromise }) {
  if (loading) return <div className="empty">Loading merchants…</div>;
  if (!merchants.length) return <div className="empty">No merchants in this scope.</div>;
  return (
    <div className="table-wrap" style={{ maxHeight: "62vh" }}>
      <table>
        <thead>
          <tr>
            <th className="sticky-col">Business ID</th>
            <th>Business Name</th>
            <th>KAM Name</th>
            <th>Lead Name</th>
            <th>Registration Date</th>
            <th>Lifetime Order</th>
            <th>Lifetime Delivered</th>
            <th>Lifetime Returned</th>
            <th>Lifetime Active Days</th>
            <th>Avg. Order</th>
            <th>Max Order in a Day</th>
            <th>Potentiality</th>
            <th>Promised Order</th>
            <th>Avg ÷ Promised</th>
            <th>Last Order Date</th>
            <th>Last Day Order</th>
            <th>Last 7 Day Order</th>
            <th>Risk</th>
          </tr>
        </thead>
        <tbody>
          {merchants.map((m) => (
            <tr key={m.business_id}>
              <td className="sticky-col">{m.business_id}</td>
              <td>{m.business_name}</td>
              <td>{m.kam_name}</td>
              <td>{m.lead_name}</td>
              <td>{day(m.registration_date)}</td>
              <td>{int(m.lifetime_order)}</td>
              <td>{int(m.lifetime_delivered)}</td>
              <td>{int(m.lifetime_returned)}</td>
              <td>{int(m.lifetime_active_days)}</td>
              <td>{Number(m.avg_order ?? 0).toFixed(2)}</td>
              <td>{int(m.max_order_in_a_day)}</td>
              <td><span className="pill">{m.potentiality || "—"}</span></td>
              <td>
                <button className="act-btn neutral" onClick={() => onPromise(m)}>
                  {m.promised_order === null || m.promised_order === undefined
                    ? "Set"
                    : Number(m.promised_order).toFixed(2)}
                </button>
              </td>
              <td>
                {m.avg_vs_promised === null || m.avg_vs_promised === undefined
                  ? "—"
                  : `${(Number(m.avg_vs_promised) * 100).toFixed(1)}%`}
              </td>
              <td>{day(m.last_order_date)}</td>
              <td>{int(m.last_day_order)}</td>
              <td>{int(m.last_7_day_order)}</td>
              <td>
                <span className={`pill ${String(m.risk).toLowerCase() === "no risk" ? "" : "warn"}`}>
                  {m.risk || "—"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------ DOD grid --- */
function DodTable({ scopeQs }) {
  const [months, setMonths] = useState([]);
  const [month, setMonth] = useState("");
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/dod/months")
      .then((body) => {
        setMonths(body.months);
        if (body.months.length && !month) setMonth(body.months[0]);
      })
      .catch((err) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const parts = [month ? `month=${month}` : "", scopeQs].filter(Boolean).join("&");
    api(`/api/dod${parts ? `?${parts}` : ""}`)
      .then((body) => setRows(body.rows))
      .catch((err) => setError(err.message));
  }, [month, scopeQs]);

  // Real dates come from the jsonb keys, so 28/29/30/31-day months all render
  // correctly instead of being forced into 30 fixed columns.
  const dayKeys = useMemo(() => {
    const keys = new Set();
    rows.forEach((row) => Object.keys(row.day_values || {}).forEach((k) => keys.add(k)));
    return [...keys].sort();
  }, [rows]);

  if (error) return <div className="error-text">{error}</div>;

  return (
    <>
      <div className="toolbar">
        <label>
          Month{" "}
          <select value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => (
              <option key={m} value={m}>{monthName(m)}</option>
            ))}
          </select>
        </label>
        <span className="sub">{rows.length} merchants · {dayKeys.length} days</span>
      </div>
      <div className="table-wrap" style={{ maxHeight: "58vh" }}>
        <table>
          <thead>
            <tr>
              <th className="sticky-col">Business ID</th>
              <th>Business Name</th>
              <th>KAM</th>
              <th>Active Days</th>
              {dayKeys.map((k) => <th key={k}>{shortDay(k)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.business_id}>
                <td className="sticky-col">{row.business_id}</td>
                <td>{row.business_name}</td>
                <td>{row.kam_name}</td>
                <td>{int(row.active_days)}</td>
                {dayKeys.map((k) => {
                  const value = Number(row.day_values?.[k] ?? 0);
                  return (
                    <td key={k} className={value === 0 ? "muted" : ""}>{value}</td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* -------------------------------------------------------------- the tab --- */
export default function MerchantPerformance({ scope }) {
  const [merchants, setMerchants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [promising, setPromising] = useState(null);

  const qs = scopeQuery(scope);

  const load = useCallback(() => {
    setLoading(true);
    api(`/api/merchants${qs ? `?${qs}` : ""}`)
      .then((body) => setMerchants(body.merchants))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [qs]);

  useEffect(load, [load]);

  return (
    <>
      <div className="panel">
        <h2>Lifetime Performance</h2>
        <p className="sub">
          Max Order in a Day and Potentiality now sit beside the lifetime
          figures, so the daily table no longer has to be opened to read them.
        </p>
        {error && <div className="error-text">{error}</div>}
        <LifetimeTable merchants={merchants} loading={loading} onPromise={setPromising} />
      </div>

      <div className="panel">
        <h2>DOD Order Count</h2>
        <DodTable scopeQs={qs} />
      </div>

      {promising && (
        <PromisedOrderModal
          merchant={promising}
          onClose={() => setPromising(null)}
          onSaved={load}
        />
      )}
    </>
  );
}
