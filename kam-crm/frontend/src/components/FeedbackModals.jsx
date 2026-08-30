import { useEffect, useState } from "react";
import { api } from "../api.js";

/**
 * Four feedback modals, one per Flag-tab button.
 *
 * Order Drop / Call FollowUp / Visit flip their matching alert to Worked as
 * soon as they save. Issue does not: in v3 it never raises an alert and only
 * stores an explanation, so saving it changes nothing on the alert counters.
 */

function History({ type, businessId }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api(`/api/feedback/${type}/history?business_id=${businessId}`)
      .then((body) => setRows(body.history))
      .catch(() => setRows([]));
  }, [type, businessId]);

  if (!rows) return <div className="history empty">Loading history…</div>;
  if (!rows.length) return <div className="history empty">No earlier entries.</div>;
  return (
    <div className="history">
      {rows.map((row) => (
        <div className="history-item" key={row.id}>
          <b>{String(row.reporting_date).slice(0, 10)}</b>{" "}
          {row.comment || row.reason || row.call_record_link || row.visit_pic_link}
          <small> · {row.created_by}</small>
        </div>
      ))}
    </div>
  );
}

function Shell({ title, sub, children, onClose, onSave, busy, error, canSave }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {sub && <div className="sub">{sub}</div>}
        {children}
        {error && <div className="error-text">{error}</div>}
        <div className="actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={onSave} disabled={busy || !canSave}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function useSaver(path, onSaved, onClose) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(body) {
    setBusy(true);
    setError("");
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, save };
}

export function OrderDropModal({ merchant, onClose, onSaved }) {
  const [comment, setComment] = useState("");
  const { busy, error, save } = useSaver("/api/feedback/order-drop", onSaved, onClose);
  return (
    <Shell
      title={`Order drop · ${merchant.business_name}`}
      sub={`Orders fell by ${Math.abs(Number(merchant.order_gap_with_previous_day))} versus the previous day. Record why.`}
      onClose={onClose}
      onSave={() => save({ business_id: merchant.business_id, comment })}
      busy={busy}
      error={error}
      canSave={comment.trim().length > 0}
    >
      <label>Reason for the drop</label>
      <textarea rows={4} maxLength={1000} value={comment} autoFocus
                onChange={(e) => setComment(e.target.value)} />
      <div className="charcount">{comment.length}/1000</div>
      <History type="order_drop" businessId={merchant.business_id} />
    </Shell>
  );
}

export function CallFollowUpModal({ merchant, onClose, onSaved }) {
  const [link, setLink] = useState("");
  const [comment, setComment] = useState("");
  const { busy, error, save } = useSaver("/api/feedback/call-followup", onSaved, onClose);
  return (
    <Shell
      title={`Call follow-up · ${merchant.business_name}`}
      sub="No order for two days. Call the merchant and store the recording link or a short note."
      onClose={onClose}
      onSave={() =>
        save({ business_id: merchant.business_id, call_record_link: link, comment })
      }
      busy={busy}
      error={error}
      canSave={link.trim().length > 0 || comment.trim().length > 0}
    >
      <label>Call recording link</label>
      <input value={link} onChange={(e) => setLink(e.target.value)}
             placeholder="https://drive.google.com/…" autoFocus />
      <label>Note</label>
      <textarea rows={3} maxLength={1000} value={comment}
                onChange={(e) => setComment(e.target.value)} />
      <div className="charcount">{comment.length}/1000</div>
      <History type="call_followup" businessId={merchant.business_id} />
    </Shell>
  );
}

export function VisitModal({ merchant, onClose, onSaved }) {
  const [callLink, setCallLink] = useState("");
  const [picLink, setPicLink] = useState("");
  const { busy, error, save } = useSaver("/api/feedback/visit", onSaved, onClose);
  return (
    <Shell
      title={`Visit · ${merchant.business_name}`}
      sub={`No order for ${merchant.order_gap_days ?? "3+"} days. Record the visit.`}
      onClose={onClose}
      onSave={() =>
        save({
          business_id: merchant.business_id,
          call_record_link: callLink,
          visit_pic_link: picLink,
        })
      }
      busy={busy}
      error={error}
      canSave={callLink.trim().length > 0 || picLink.trim().length > 0}
    >
      <label>Call record link</label>
      <input value={callLink} onChange={(e) => setCallLink(e.target.value)} autoFocus />
      <label>Visit picture link</label>
      <input value={picLink} onChange={(e) => setPicLink(e.target.value)} />
      <History type="visit" businessId={merchant.business_id} />
    </Shell>
  );
}

export function IssueModal({ merchant, onClose, onSaved }) {
  const [reasons, setReasons] = useState([]);
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const { busy, error, save } = useSaver("/api/feedback/issue", onSaved, onClose);

  useEffect(() => {
    api("/api/issue-reasons")
      .then((body) => setReasons(body.reasons))
      .catch(() => setReasons([]));
  }, []);

  return (
    <Shell
      title={`Issue · ${merchant.business_name}`}
      sub="Stored for the record only — logging an issue does not raise an alert."
      onClose={onClose}
      onSave={() => save({ business_id: merchant.business_id, reason, comment })}
      busy={busy}
      error={error}
      canSave={reason.trim().length > 0}
    >
      <label>Reason</label>
      <input list="issue-reason-list" value={reason} autoFocus
             onChange={(e) => setReason(e.target.value)}
             placeholder="Pick one or type a new reason" />
      <datalist id="issue-reason-list">
        {reasons.map((item) => <option key={item} value={item} />)}
      </datalist>
      <label>Explanation</label>
      <textarea rows={4} maxLength={1000} value={comment}
                onChange={(e) => setComment(e.target.value)} />
      <div className="charcount">{comment.length}/1000</div>
      <History type="issue" businessId={merchant.business_id} />
    </Shell>
  );
}
