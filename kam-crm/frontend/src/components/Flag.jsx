import { useCallback, useEffect, useState } from "react";
import { api, scopeQuery } from "../api.js";
import {
  CallFollowUpModal,
  IssueModal,
  OrderDropModal,
  VisitModal,
} from "./FeedbackModals.jsx";

const int = (v) => Number(v ?? 0).toLocaleString("en-US");
const day = (v) => (v ? String(v).slice(0, 10) : "—");

/**
 * FLAG TAB
 *
 * Button rules, mutually exclusive so a row never shows both:
 *   Order Drop     order gap with the previous day is negative
 *   Call FollowUp  exactly 2 days since the last order
 *   Visit          3 or more days since the last order (or never ordered)
 *   Issue          always available; it does not raise an alert, it only
 *                  stores an explanation
 *
 * A button turns green once feedback exists for that merchant on that
 * reporting date.
 */
function ActionButton({ active, done, label, onClick }) {
  if (!active) return <span className="muted">—</span>;
  return (
    <button className={`act-btn ${done ? "done" : "todo"}`} onClick={onClick}>
      {done ? `✓ ${label}` : label}
    </button>
  );
}

function FlagTable({ rows, loading, onOpen }) {
  if (loading) return <div className="empty">Loading…</div>;
  if (!rows.length) return <div className="empty">Nothing flagged in this scope.</div>;
  return (
    <div className="table-wrap" style={{ maxHeight: "58vh" }}>
      <table>
        <thead>
          <tr>
            <th className="sticky-col">Business ID</th>
            <th>Business Name</th>
            <th>Order Gap Delta</th>
            <th>Order Drop</th>
            <th>Previous Day Order</th>
            <th>Call FollowUp</th>
            <th>Visit</th>
            <th>Last Order Date</th>
            <th>Last 7 Day Order</th>
            <th>Risk</th>
            <th>Issue</th>
            <th>Organic / Hunt</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.business_id}>
              <td className="sticky-col">{row.business_id}</td>
              <td>{row.business_name}</td>
              <td className={Number(row.order_gap_with_previous_day) < 0 ? "neg" : "pos"}>
                {int(row.order_gap_with_previous_day)}
              </td>
              <td>
                <ActionButton
                  active={row.order_drop_active}
                  done={row.has_order_drop_feedback}
                  label="Order drop"
                  onClick={() => onOpen("order_drop", row)}
                />
              </td>
              <td>{int(row.previous_day_order)}</td>
              <td>
                <ActionButton
                  active={row.call_followup_active}
                  done={row.has_call_followup_feedback}
                  label="Call"
                  onClick={() => onOpen("call_followup", row)}
                />
              </td>
              <td>
                <ActionButton
                  active={row.visit_active}
                  done={row.has_visit_feedback}
                  label="Visit"
                  onClick={() => onOpen("visit", row)}
                />
              </td>
              <td>
                {day(row.last_order_date)}
                {row.order_gap_days !== null && row.order_gap_days !== undefined && (
                  <small className="muted"> ({row.order_gap_days}d)</small>
                )}
              </td>
              <td>{int(row.last_7_day_order)}</td>
              <td>
                <span className={`pill ${String(row.risk).toLowerCase() === "no risk" ? "" : "warn"}`}>
                  {row.risk || "—"}
                </span>
              </td>
              <td>
                <button
                  className={`act-btn ${row.has_issue_feedback ? "done" : "neutral"}`}
                  onClick={() => onOpen("issue", row)}
                >
                  {row.has_issue_feedback ? "✓ Issue" : "Issue"}
                </button>
              </td>
              <td>{row.acquisition_type}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------ weekly call tracker ----- */
function CallTracker({ scopeQs, onSaved }) {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ note: "", drive_link: "" });
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api(`/api/weekly-calls${scopeQs ? `?${scopeQs}` : ""}`)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [scopeQs]);

  useEffect(load, [load]);

  async function save() {
    try {
      await api("/api/weekly-calls", {
        method: "POST",
        body: JSON.stringify({ business_id: editing.business_id, ...form }),
      });
      setEditing(null);
      setForm({ note: "", drive_link: "" });
      load();
      onSaved();
    } catch (err) {
      setError(err.message);
    }
  }

  if (error) return <div className="error-text">{error}</div>;
  if (!data) return <div className="empty">Loading call tracker…</div>;

  return (
    <>
      <p className="sub">
        Week starting <b>{data.week_start}</b>. Every merchant must be called at
        least once per week; saving a recording link marks the call Worked.
      </p>
      <div className="table-wrap" style={{ maxHeight: "42vh" }}>
        <table>
          <thead>
            <tr>
              <th className="sticky-col">Business ID</th>
              <th>Business Name</th>
              <th>KAM</th>
              <th>Call Record</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.business_id}>
                <td className="sticky-col">{row.business_id}</td>
                <td>{row.business_name}</td>
                <td>{row.kam_name}</td>
                <td>
                  {row.drive_link ? (
                    <a href={row.drive_link} target="_blank" rel="noreferrer">Recording</a>
                  ) : (
                    <button className="act-btn todo" onClick={() => setEditing(row)}>
                      Add call record
                    </button>
                  )}
                </td>
                <td>
                  <span className={`pill ${row.status === "Worked" ? "good" : "warn"}`}>
                    {row.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Weekly call · {editing.business_name}</h3>
            <label>Call recording drive link</label>
            <input value={form.drive_link} autoFocus
                   onChange={(e) => setForm({ ...form, drive_link: e.target.value })} />
            <label>Note</label>
            <textarea rows={3} maxLength={1000} value={form.note}
                      onChange={(e) => setForm({ ...form, note: e.target.value })} />
            <div className="actions">
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn primary" onClick={save}
                      disabled={!form.drive_link.trim()}>Save</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------------- the tab --- */
export default function Flag({ scope, onWorked }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [modal, setModal] = useState(null);

  const qs = scopeQuery(scope);
  const flagQs = [qs, showAll ? "all=1" : ""].filter(Boolean).join("&");

  const load = useCallback(() => {
    setLoading(true);
    api(`/api/flag${flagQs ? `?${flagQs}` : ""}`)
      .then((body) => setRows(body.rows))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [flagQs]);

  useEffect(load, [load]);

  function afterSave() {
    load();
    onWorked();
  }

  const MODALS = {
    order_drop: OrderDropModal,
    call_followup: CallFollowUpModal,
    visit: VisitModal,
    issue: IssueModal,
  };
  const Modal = modal ? MODALS[modal.type] : null;

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Flag Table</h2>
            <p className="sub">
              Call FollowUp appears at exactly 2 days without an order; Visit at
              3 days or more. Issue is always available and never raises an alert.
            </p>
          </div>
          <div className="seg">
            <button className={showAll ? "" : "on"} onClick={() => setShowAll(false)}>
              Flagged only
            </button>
            <button className={showAll ? "on" : ""} onClick={() => setShowAll(true)}>
              Whole book
            </button>
          </div>
        </div>
        {error && <div className="error-text">{error}</div>}
        <FlagTable
          rows={rows}
          loading={loading}
          onOpen={(type, merchant) => setModal({ type, merchant })}
        />
      </div>

      <div className="panel">
        <h2>Weekly Call Tracker</h2>
        <CallTracker scopeQs={qs} onSaved={afterSave} />
      </div>

      {Modal && (
        <Modal
          merchant={modal.merchant}
          onClose={() => setModal(null)}
          onSaved={afterSave}
        />
      )}
    </>
  );
}
