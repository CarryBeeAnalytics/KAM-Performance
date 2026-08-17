import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { IssueModal, OrderDropModal, VisitModal } from "./FeedbackModals.jsx";

function fmtDate(value) {
  return value ? String(value).slice(0, 10) : "";
}
function fmtDateTime(value) {
  return value ? String(value).replace("T", " ").slice(0, 19) : "";
}
function shortDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.toLocaleString("en", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()}`;
}
function monthName(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" });
}

// Approved activation rules.
export function orderDropActive(m) {
  return Number(m.order_gap_with_previous_day) < 0;
}
export function visitActive(m) {
  const v = String(m.visit || "").toLowerCase();
  return v === "call mandatory" || v === "must visit";
}
export function issueActive(m) {
  return String(m.risk || "").toLowerCase() !== "no risk";
}

function scopeQuery(scope) {
  if (!scope?.value) return "";
  return `${scope.type === "lead" ? "lead" : "kam"}=${encodeURIComponent(scope.value)}`;
}

/* ------------------------- Promised Order modal -------------------------- */
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
          The daily order volume this merchant has committed to. Avg. order is{" "}
          <b>{merchant.avg_order}</b> — the ratio column updates automatically.
        </div>
        <label>Promised order (per day)</label>
        <input
          type="number"
          min="0"
          step="0.01"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. 25"
          autoFocus
        />
        {error && <div className="error-text">{error}</div>}
        <div className="actions">
          {merchant.promised_order !== null &&
            merchant.promised_order !== undefined && (
              <button className="btn" onClick={() => save(true)} disabled={busy}>
                Clear
              </button>
            )}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            onClick={() => save(false)}
            disabled={busy || String(value).trim() === ""}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Lifetime table ---------------------------- */
function LifetimeTable({ merchants, loading, onPromise }) {
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
            <th>Promised Order</th>
            <th>Avg. Order / Promised</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={12} className="empty">Loading…</td></tr>
          ) : merchants.length === 0 ? (
            <tr><td colSpan={12} className="empty">No merchants to show.</td></tr>
          ) : (
            merchants.map((m) => {
              const ratio =
                m.avg_vs_promised === null || m.avg_vs_promised === undefined
                  ? null
                  : Number(m.avg_vs_promised);
              return (
                <tr key={m.business_id}>
                  <td className="sticky-col">{m.business_id}</td>
                  <td>{m.business_name}</td>
                  <td>{m.kam_name}</td>
                  <td>{m.lead_name}</td>
                  <td>{fmtDateTime(m.registration_date)}</td>
                  <td className="num">{Number(m.lifetime_order).toLocaleString()}</td>
                  <td className="num">{Number(m.lifetime_delivered).toLocaleString()}</td>
                  <td className="num">{Number(m.lifetime_returned).toLocaleString()}</td>
                  <td className="num">{m.lifetime_active_days}</td>
                  <td className="num">{m.avg_order}</td>
                  <td>
                    <button
                      className={`act-btn ${m.promised_order != null ? "done" : ""}`}
                      onClick={() => onPromise(m)}
                      title="Set or edit the promised order"
                    >
                      🎯 {m.promised_order != null
                        ? Number(m.promised_order).toLocaleString()
                        : "Set"}
                    </button>
                  </td>
                  <td className="num">
                    {ratio === null ? (
                      <span className="pill gray">—</span>
                    ) : (
                      <span className={`pill ${ratio >= 1 ? "green" : ratio >= 0.7 ? "amber" : "red"}`}>
                        {(ratio * 100).toFixed(1)}%
                      </span>
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------- Daily Performance table ----------------------- */
function DailyPerformanceTable({ merchants, loading, onAction }) {
  function actionButton(m, type) {
    const active =
      type === "order_drop" ? orderDropActive(m)
      : type === "visit" ? visitActive(m)
      : issueActive(m);
    const done =
      type === "order_drop" ? m.has_order_drop_feedback
      : type === "visit" ? m.has_visit_feedback
      : m.has_issue_feedback;
    const label =
      type === "order_drop" ? "Order Drop" : type === "visit" ? "Visit" : "Issues";
    return (
      <button
        className={`act-btn ${active && !done ? "flagged" : ""} ${done ? "done" : ""}`}
        disabled={!active}
        onClick={() => onAction(type, m)}
        title={
          !active
            ? "No action needed for this merchant today"
            : done
            ? "Feedback saved — open to view or edit"
            : "Action needed — open to add feedback"
        }
      >
        {active && !done ? "🚩" : done ? "✅" : ""} {label}
      </button>
    );
  }

  return (
    <div className="table-wrap" style={{ maxHeight: "62vh" }}>
      <table>
        <thead>
          <tr>
            <th className="sticky-col">Business ID</th>
            <th>Business Name</th>
            <th>Max Order in a Day</th>
            <th>Potentiality</th>
            <th>Last Order Date</th>
            <th>Visit</th>
            <th>Last Day Order</th>
            <th>Last 7 Day Order</th>
            <th>Reporting Date</th>
            <th>Risk</th>
            <th>Order Gap with Previous Day</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={12} className="empty">Loading…</td></tr>
          ) : merchants.length === 0 ? (
            <tr><td colSpan={12} className="empty">No merchants to show.</td></tr>
          ) : (
            merchants.map((m) => (
              <tr key={m.business_id}>
                <td className="sticky-col">{m.business_id}</td>
                <td>{m.business_name}</td>
                <td className="num">{m.max_order_in_a_day}</td>
                <td>{m.potentiality}</td>
                <td>{fmtDateTime(m.last_order_date)}</td>
                <td>
                  <span
                    className={`pill ${
                      visitActive(m)
                        ? String(m.visit).toLowerCase() === "must visit"
                          ? "red"
                          : "amber"
                        : "gray"
                    }`}
                  >
                    {m.visit}
                  </span>
                </td>
                <td className="num">{m.last_day_order}</td>
                <td className="num">{m.last_7_day_order}</td>
                <td>{fmtDate(m.reporting_date)}</td>
                <td>
                  <span className={`pill ${issueActive(m) ? "red" : "green"}`}>
                    {m.risk}
                  </span>
                </td>
                <td className={`num ${Number(m.order_gap_with_previous_day) < 0 ? "neg" : "pos"}`}>
                  {m.order_gap_with_previous_day}
                </td>
                <td style={{ display: "flex", gap: 6 }}>
                  {actionButton(m, "order_drop")}
                  {actionButton(m, "visit")}
                  {actionButton(m, "issue")}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------ DOD table -------------------------------- */
function DodTable({ scope }) {
  const [months, setMonths] = useState([]);
  const [month, setMonth] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
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
    if (!scope?.value) return;
    setLoading(true);
    setError("");
    const monthParam = month ? `month=${encodeURIComponent(month)}&` : "";
    api(`/api/dod?${monthParam}${scopeQuery(scope)}`)
      .then((body) => setRows(body.rows))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [scope, month]);

  const dayKeys = useMemo(() => {
    const keys = new Set();
    rows.forEach((row) => {
      Object.keys(row.day_values || {}).forEach((key) => keys.add(key));
    });
    return Array.from(keys).sort();
  }, [rows]);

  if (months.length === 0 && !loading) {
    return (
      <div className="empty">
        No DOD snapshot stored yet — the table fills after the next nightly
        script run (the updated script stores every month permanently).
        {error && <div className="error-text">{error}</div>}
      </div>
    );
  }

  return (
    <>
      <div className="toolbar">
        <select value={month} onChange={(e) => setMonth(e.target.value)}>
          {months.map((m) => (
            <option key={m} value={m}>{monthName(m)}</option>
          ))}
        </select>
        <div className="grow" />
        <span className="sub" style={{ margin: 0 }}>
          {rows.length.toLocaleString()} merchant(s) · {dayKeys.length} days
        </span>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="table-wrap" style={{ maxHeight: "62vh" }}>
        <table style={{ minWidth: 1200 }}>
          <thead>
            <tr>
              <th className="sticky-col">Business ID</th>
              <th>Business Name</th>
              <th>KAM</th>
              {dayKeys.map((key) => (
                <th key={key} className="num">{shortDay(key)}</th>
              ))}
              <th>Active Days</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={dayKeys.length + 4} className="empty">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={dayKeys.length + 4} className="empty">No merchants in this view.</td></tr>
            ) : (
              rows.map((row) => (
                <tr key={row.business_id}>
                  <td className="sticky-col">{row.business_id}</td>
                  <td>{row.business_name}</td>
                  <td>{row.kam_name}</td>
                  {dayKeys.map((key) => {
                    const value = Number(row.day_values?.[key] ?? 0);
                    return (
                      <td key={key} className="num" style={value === 0 ? { color: "var(--muted)" } : { fontWeight: 600 }}>
                        {value}
                      </td>
                    );
                  })}
                  <td className="num">{row.active_days}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ------------------------------ Page shell ------------------------------- */
export default function MerchantPerformance({ user, scope }) {
  const [view, setView] = useState("lifetime");
  const [merchants, setMerchants] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState(null); // {type, merchant}

  const load = useCallback(() => {
    if (!scope?.value) return;
    setLoading(true);
    setError("");
    api(`/api/merchants?${scopeQuery(scope)}`)
      .then((body) => setMerchants(body.merchants))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [scope]);

  useEffect(load, [load]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return merchants;
    return merchants.filter(
      (m) =>
        String(m.business_id).includes(term) ||
        String(m.business_name || "").toLowerCase().includes(term)
    );
  }, [merchants, search]);

  return (
    <>
      <div className="panel">
        <div className="seg">
          <button className={view === "lifetime" ? "active" : ""} onClick={() => setView("lifetime")}>
            Lifetime
          </button>
          <button className={view === "daily" ? "active" : ""} onClick={() => setView("daily")}>
            Daily Performance
          </button>
          <button className={view === "dod" ? "active" : ""} onClick={() => setView("dod")}>
            DOD Order Count
          </button>
        </div>

        {view !== "dod" && (
          <div className="toolbar">
            <input
              type="search"
              placeholder="Search business ID or name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="grow" />
            <span className="sub" style={{ margin: 0 }}>
              {filtered.length.toLocaleString()} merchant(s)
            </span>
          </div>
        )}
        {error && <div className="error-text">{error}</div>}

        {view === "lifetime" && (
          <LifetimeTable
            merchants={filtered}
            loading={loading}
            onPromise={(m) => setModal({ type: "promise", merchant: m })}
          />
        )}
        {view === "daily" && (
          <DailyPerformanceTable
            merchants={filtered}
            loading={loading}
            onAction={(type, m) => setModal({ type, merchant: m })}
          />
        )}
        {view === "dod" && <DodTable scope={scope} />}
      </div>

      {modal?.type === "promise" && (
        <PromisedOrderModal merchant={modal.merchant} onClose={() => setModal(null)} onSaved={load} />
      )}
      {modal?.type === "order_drop" && (
        <OrderDropModal merchant={modal.merchant} onClose={() => setModal(null)} onSaved={load} />
      )}
      {modal?.type === "visit" && (
        <VisitModal merchant={modal.merchant} onClose={() => setModal(null)} onSaved={load} />
      )}
      {modal?.type === "issue" && (
        <IssueModal merchant={modal.merchant} onClose={() => setModal(null)} onSaved={load} />
      )}
    </>
  );
}
