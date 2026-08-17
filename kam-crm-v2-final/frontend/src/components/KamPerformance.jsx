import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { IssueModal, OrderDropModal, VisitModal } from "./FeedbackModals.jsx";

const MAX = 1000;

function fmtDate(value) {
  return value ? String(value).slice(0, 10) : "";
}
function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : "";
}
function scopeQuery(scope) {
  if (!scope?.value) return "";
  return `${scope.type === "lead" ? "lead" : "kam"}=${encodeURIComponent(scope.value)}`;
}

/* -------------------------------------------------------------------------
   1) Action & Alert board with the eye-catching reason buttons: a pending
   reason pulses solid YELLOW; a completed one turns solid green.
--------------------------------------------------------------------------*/
function ReasonAlertTable({ scope, refreshKey, onOpen }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!scope?.value) return;
    setLoading(true);
    api(`/api/kam-performance?${scopeQuery(scope)}`)
      .then((body) => setRows(body.rows))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [scope, refreshKey]);

  function reasonButton(row, type) {
    const active =
      type === "order_drop" ? row.order_drop_active
      : type === "visit" ? row.visit_active
      : row.issue_active;
    const has =
      type === "order_drop" ? row.has_order_drop_feedback
      : type === "visit" ? row.has_visit_feedback
      : row.has_issue_feedback;
    if (!active) return null;
    const label =
      type === "order_drop" ? "Order Drop" : type === "visit" ? "Visit" : "Issues";
    return (
      <button
        className={`reason-btn ${has ? "done" : "pending"}`}
        onClick={() => onOpen(type, row)}
        title={has ? "Feedback saved — open to view or edit" : "Needs feedback — open to add"}
      >
        {has ? "✓" : "⚠"} {label}
      </button>
    );
  }

  return (
    <div className="panel">
      <h2>Action &amp; Alert Board</h2>
      <p className="sub">
        Every merchant that needs work today. A pulsing yellow button still
        needs feedback; green means done. Stored alerts show Worked / Not
        Worked from the nightly job.
      </p>
      {error && <div className="error-text">{error}</div>}
      <div className="table-wrap" style={{ maxHeight: "48vh" }}>
        <table>
          <thead>
            <tr>
              <th>Business ID</th>
              <th>Business Name</th>
              <th>KAM</th>
              <th>Reporting Date</th>
              <th>Reasons</th>
              <th>Alerts</th>
              <th>Alert Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="empty">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={7} className="empty">Nothing needs work. 🐝</td></tr>
            ) : (
              rows.map((row) => {
                const alerts = row.alerts || [];
                const pending = alerts.filter((a) => a.status === "Not Worked");
                return (
                  <tr key={row.business_id} className={pending.length ? "alert-row" : ""}>
                    <td>{row.business_id}</td>
                    <td>{row.business_name}</td>
                    <td>{row.kam_name}</td>
                    <td>{fmtDate(row.reporting_date)}</td>
                    <td style={{ display: "flex", gap: 8 }}>
                      {reasonButton(row, "order_drop")}
                      {reasonButton(row, "visit")}
                      {reasonButton(row, "issue")}
                    </td>
                    <td>
                      {alerts.length === 0
                        ? "—"
                        : alerts.slice(0, 3).map((a, idx) => (
                            <div key={idx} style={{ fontSize: 12 }}>
                              {fmtDate(a.reporting_date)} · {a.alert_reason}
                            </div>
                          ))}
                    </td>
                    <td>
                      {alerts.length === 0 ? (
                        <span className="pill gray">No alert</span>
                      ) : pending.length ? (
                        <span className="pill red">Not Worked ({pending.length})</span>
                      ) : (
                        <span className="pill green">Worked</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
   2) Weekly Call Tracker (resets every Monday, BD week).
--------------------------------------------------------------------------*/
function WeeklyCallTracker({ scope }) {
  const [rows, setRows] = useState([]);
  const [weekStart, setWeekStart] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [entry, setEntry] = useState(null);
  const [note, setNote] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState("");

  const load = useCallback(() => {
    if (!scope?.value) return;
    setLoading(true);
    api(`/api/weekly-calls?${scopeQuery(scope)}`)
      .then((body) => {
        setRows(body.rows);
        setWeekStart(body.week_start);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [scope]);

  useEffect(load, [load]);

  function openEntry(row) {
    setEntry(row);
    setNote(row.note || "");
    setLink(row.drive_link || "");
    setModalError("");
  }

  async function save() {
    setBusy(true);
    setModalError("");
    try {
      await api("/api/weekly-calls", {
        method: "POST",
        body: JSON.stringify({
          business_id: entry.business_id,
          note,
          drive_link: link,
        }),
      });
      setEntry(null);
      load();
    } catch (err) {
      setModalError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const worked = rows.filter((row) => row.status === "Worked").length;

  return (
    <div className="panel">
      <h2>Weekly Call Tracker</h2>
      <p className="sub">
        Week of {weekStart} (resets every Monday). Saving the call recording
        drive link marks a merchant Worked. {worked}/{rows.length} done.
      </p>
      {error && <div className="error-text">{error}</div>}
      <div className="table-wrap" style={{ maxHeight: "48vh" }}>
        <table>
          <thead>
            <tr>
              <th>Business ID</th>
              <th>Business Name</th>
              <th>KAM</th>
              <th>Call Record</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="empty">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={5} className="empty">No merchants assigned.</td></tr>
            ) : (
              rows.map((row) => (
                <tr key={row.business_id} className={row.status !== "Worked" ? "alert-row" : ""}>
                  <td>{row.business_id}</td>
                  <td>{row.business_name}</td>
                  <td>{row.kam_name}</td>
                  <td>
                    <button
                      className={`act-btn ${row.status === "Worked" ? "done" : "flagged"}`}
                      onClick={() => openEntry(row)}
                    >
                      {row.status === "Worked" ? "✅ View / edit call" : "📞 Log this week's call"}
                    </button>
                  </td>
                  <td>
                    <span className={`pill ${row.status === "Worked" ? "green" : "red"}`}>
                      {row.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {entry && (
        <div className="modal-backdrop" onClick={() => setEntry(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Weekly call · {entry.business_name}</h3>
            <div className="sub">Week of {weekStart} · saving the drive link marks this Worked</div>
            <label>Call notes (max {MAX} characters)</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={MAX}
              placeholder="What was discussed on the call?"
            />
            <div className={`charcount ${note.length > MAX ? "over" : ""}`}>
              {note.length}/{MAX}
            </div>
            <label>Call recording drive link (required for Worked)</label>
            <input
              type="url"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://drive.google.com/…"
            />
            {modalError && <div className="error-text">{modalError}</div>}
            <div className="actions">
              <button className="btn" onClick={() => setEntry(null)}>Cancel</button>
              <button className="btn primary" onClick={save} disabled={busy || !link.trim()}>
                {busy ? "Saving…" : "Save call"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
   3) Retention & Incremental with the Target button (Lead/Admin only).
--------------------------------------------------------------------------*/
function RetentionTable({ refreshSignal }) {
  const [rows, setRows] = useState([]);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState("");

  const load = useCallback(() => {
    api("/api/retention")
      .then((body) => {
        setRows(body.rows);
        setCanEdit(body.can_edit_target);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(load, [load, refreshSignal]);

  async function saveTarget() {
    setBusy(true);
    setModalError("");
    try {
      await api("/api/retention/target", {
        method: "PUT",
        body: JSON.stringify({ kam_name: editing.kam_name, target: value }),
      });
      setEditing(null);
      load();
    } catch (err) {
      setModalError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Retention &amp; Incremental</h2>
      <p className="sub">
        Merchant and order retention against the previous month.{" "}
        {canEdit
          ? "Set each KAM's growth target — entering 10 means 10%."
          : "Targets are set by the Lead / Admin; your view is read-only."}
      </p>
      {error && <div className="error-text">{error}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>KAM Name</th>
              <th>Per. Active Merchant</th>
              <th>Curr. Active Merchant</th>
              <th>Merchant Retention %</th>
              <th>Per. Month Orders</th>
              <th>Per. Month RVN</th>
              <th>Curr. Month Orders</th>
              <th>Curr. Month RVN</th>
              <th>Order Retention %</th>
              <th>Target</th>
              <th>Target Orders</th>
              <th>Target RVN</th>
              <th>Achv. (Order)</th>
              <th>Achv. (RVN)</th>
              <th>Achievement</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={15} className="empty">No retention rows yet.</td></tr>
            ) : (
              rows.map((row) => (
                <tr key={row.kam_name}>
                  <td>{row.kam_name}</td>
                  <td className="num">{row.per_active_merchant_count}</td>
                  <td className="num">{row.curr_active_merchant_count}</td>
                  <td className="num">{pct(row.merchant_retention_pct)}</td>
                  <td className="num">{Number(row.per_month_orders).toLocaleString()}</td>
                  <td className="num">{Number(row.per_month_rvn).toLocaleString()}</td>
                  <td className="num">{Number(row.curr_month_orders).toLocaleString()}</td>
                  <td className="num">{Number(row.curr_month_rvn).toLocaleString()}</td>
                  <td className="num">{pct(row.order_retention_pct)}</td>
                  <td>
                    {canEdit ? (
                      <button
                        className="act-btn"
                        onClick={() => {
                          setEditing(row);
                          setValue(
                            row.target === null || row.target === undefined
                              ? ""
                              : String(Number(row.target) * 100)
                          );
                          setModalError("");
                        }}
                      >
                        🎯 {row.target == null ? "Set target" : pct(row.target)}
                      </button>
                    ) : (
                      <span className="pill gray">
                        {row.target == null ? "—" : pct(row.target)}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {row.target_orders == null ? "—" : Number(row.target_orders).toLocaleString()}
                  </td>
                  <td className="num">
                    {row.target_rvn == null ? "—" : Number(row.target_rvn).toLocaleString()}
                  </td>
                  <td className="num">{Number(row.target_achievement_order).toLocaleString()}</td>
                  <td className="num">{Number(row.target_achievement_rvn).toLocaleString()}</td>
                  <td className="num">{row.achievement == null ? "—" : pct(row.achievement)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Set target · {editing.kam_name}</h3>
            <div className="sub">Enter the growth percentage. 10 means 10% above last month.</div>
            <label>Target %</label>
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="10"
            />
            {modalError && <div className="error-text">{modalError}</div>}
            <div className="actions">
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn primary" onClick={saveTarget} disabled={busy}>
                {busy ? "Saving…" : "Save target"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function KamPerformance({ user, scope, onWorked }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [modal, setModal] = useState(null);

  function openFeedback(type, row) {
    setModal({
      type,
      merchant: {
        business_id: row.business_id,
        business_name: row.business_name,
        reporting_date: row.reporting_date,
        visit: row.visit,
        risk: row.risk,
        order_gap_with_previous_day: row.order_gap_with_previous_day,
      },
    });
  }

  function handleSaved() {
    setRefreshKey((k) => k + 1);
    if (onWorked) onWorked();
  }

  return (
    <>
      <ReasonAlertTable scope={scope} refreshKey={refreshKey} onOpen={openFeedback} />
      <WeeklyCallTracker scope={scope} />
      <RetentionTable refreshSignal={refreshKey} />

      {modal?.type === "order_drop" && (
        <OrderDropModal merchant={modal.merchant} onClose={() => setModal(null)} onSaved={handleSaved} />
      )}
      {modal?.type === "visit" && (
        <VisitModal merchant={modal.merchant} onClose={() => setModal(null)} onSaved={handleSaved} />
      )}
      {modal?.type === "issue" && (
        <IssueModal merchant={modal.merchant} onClose={() => setModal(null)} onSaved={handleSaved} />
      )}
    </>
  );
}
