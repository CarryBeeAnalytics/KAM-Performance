import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import KamButtons from "./KamButtons.jsx";
import { IssueModal, OrderDropModal, VisitModal } from "./FeedbackModals.jsx";

function fmtDate(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function fmtDateTime(value) {
  if (!value) return "";
  return String(value).replace("T", " ").slice(0, 19);
}

// Button activation rules (approved):
//   Order Drop: gap with previous day < 0
//   Visit:      "Call Mandatory" or "Must visit"
//   Issues:     Risk is anything other than "No risk" (includes "No Order")
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

export default function MerchantPerformance({ user }) {
  const [kam, setKam] = useState("");
  const [merchants, setMerchants] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState(null); // {type, merchant}

  const load = useCallback(() => {
    if (!kam) return;
    setLoading(true);
    setError("");
    api(`/api/merchants?kam=${encodeURIComponent(kam)}`)
      .then((body) => setMerchants(body.merchants))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [kam]);

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
        onClick={() => setModal({ type, merchant: m })}
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
    <>
      <KamButtons user={user} selected={kam} onSelect={setKam} />
      <div className="panel">
        <h2>Merchant Performance {kam ? `· ${kam}` : ""}</h2>
        <p className="sub">
          🚩 means the button is active and still needs feedback for the reporting date.
          ✅ means feedback is already saved (open it to edit).
        </p>
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
        {error && <div className="error-text">{error}</div>}
        <div className="table-wrap" style={{ maxHeight: "62vh" }}>
          <table>
            <thead>
              <tr>
                <th>Business ID</th>
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
                <tr><td colSpan={20} className="empty">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={20} className="empty">No merchants to show.</td></tr>
              ) : (
                filtered.map((m) => (
                  <tr key={m.business_id}>
                    <td>{m.business_id}</td>
                    <td>{m.business_name}</td>
                    <td>{m.kam_name}</td>
                    <td>{m.lead_name}</td>
                    <td>{fmtDateTime(m.registration_date)}</td>
                    <td className="num">{Number(m.lifetime_order).toLocaleString()}</td>
                    <td className="num">{Number(m.lifetime_delivered).toLocaleString()}</td>
                    <td className="num">{Number(m.lifetime_returned).toLocaleString()}</td>
                    <td className="num">{m.lifetime_active_days}</td>
                    <td className="num">{m.avg_order}</td>
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
      </div>

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
