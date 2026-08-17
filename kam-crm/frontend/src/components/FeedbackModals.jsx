import { useEffect, useState } from "react";
import { api } from "../api.js";

const MAX = 1000;

function Modal({ title, subtitle, onClose, children }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="sub">{subtitle}</div>
        {children}
      </div>
    </div>
  );
}

function CharCount({ value }) {
  return (
    <div className={`charcount ${value.length > MAX ? "over" : ""}`}>
      {value.length}/{MAX}
    </div>
  );
}

function History({ type, businessId, refreshKey }) {
  const [items, setItems] = useState([]);
  useEffect(() => {
    api(`/api/feedback/${type}/history?business_id=${businessId}`)
      .then((body) => setItems(body.history))
      .catch(() => setItems([]));
  }, [type, businessId, refreshKey]);
  if (!items.length) return null;
  return (
    <div className="history">
      <h4>Previous feedback</h4>
      {items.map((item) => (
        <div className="history-item" key={item.id}>
          {type === "visit" ? (
            <>
              {item.call_record_link && (
                <div>
                  Call record:{" "}
                  <a href={item.call_record_link} target="_blank" rel="noreferrer">
                    {item.call_record_link}
                  </a>
                </div>
              )}
              {item.visit_pic_link && (
                <div>
                  Visit picture:{" "}
                  <a href={item.visit_pic_link} target="_blank" rel="noreferrer">
                    {item.visit_pic_link}
                  </a>
                </div>
              )}
            </>
          ) : type === "issue" ? (
            <>
              <b>{item.reason}</b>
              {item.comment ? <div>{item.comment}</div> : null}
            </>
          ) : (
            item.comment
          )}
          <div className="meta">
            {String(item.reporting_date).slice(0, 10)} · by {item.created_by}
          </div>
        </div>
      ))}
    </div>
  );
}

export function OrderDropModal({ merchant, onClose, onSaved }) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api("/api/feedback/order-drop", {
        method: "POST",
        body: JSON.stringify({ business_id: merchant.business_id, comment }),
      });
      setRefreshKey((k) => k + 1);
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Order Drop · ${merchant.business_name}`}
      subtitle={`Gap vs previous day: ${merchant.order_gap_with_previous_day} · Reporting date ${String(
        merchant.reporting_date
      ).slice(0, 10)}`}
      onClose={onClose}
    >
      <label>Why did orders drop? (max {MAX} characters)</label>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={MAX}
        placeholder="Write what you found after talking to the merchant…"
      />
      <CharCount value={comment} />
      {error && <div className="error-text">{error}</div>}
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy || !comment.trim()}>
          {busy ? "Saving…" : "Save feedback"}
        </button>
      </div>
      <History type="order_drop" businessId={merchant.business_id} refreshKey={refreshKey} />
    </Modal>
  );
}

export function VisitModal({ merchant, onClose, onSaved }) {
  const [callLink, setCallLink] = useState("");
  const [picLink, setPicLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api("/api/feedback/visit", {
        method: "POST",
        body: JSON.stringify({
          business_id: merchant.business_id,
          call_record_link: callLink,
          visit_pic_link: picLink,
        }),
      });
      setRefreshKey((k) => k + 1);
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Visit · ${merchant.business_name}`}
      subtitle={`Status: ${merchant.visit} · Reporting date ${String(merchant.reporting_date).slice(0, 10)}`}
      onClose={onClose}
    >
      <label>Call record drive link</label>
      <input
        type="url"
        value={callLink}
        onChange={(e) => setCallLink(e.target.value)}
        placeholder="https://drive.google.com/…"
      />
      <label>Visit picture drive link</label>
      <input
        type="url"
        value={picLink}
        onChange={(e) => setPicLink(e.target.value)}
        placeholder="https://drive.google.com/…"
      />
      {error && <div className="error-text">{error}</div>}
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          onClick={save}
          disabled={busy || (!callLink.trim() && !picLink.trim())}
        >
          {busy ? "Saving…" : "Save visit"}
        </button>
      </div>
      <History type="visit" businessId={merchant.business_id} refreshKey={refreshKey} />
    </Modal>
  );
}

export function IssueModal({ merchant, onClose, onSaved }) {
  const [reasons, setReasons] = useState([]);
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    api("/api/issue-reasons")
      .then((body) => setReasons(body.reasons))
      .catch(() => setReasons([]));
  }, [refreshKey]);

  const finalReason = reason === "__custom__" ? customReason : reason;

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api("/api/feedback/issue", {
        method: "POST",
        body: JSON.stringify({
          business_id: merchant.business_id,
          reason: finalReason,
          comment,
        }),
      });
      setRefreshKey((k) => k + 1);
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Issues · ${merchant.business_name}`}
      subtitle={`Risk: ${merchant.risk} · Reporting date ${String(merchant.reporting_date).slice(0, 10)}`}
      onClose={onClose}
    >
      <label>Reason (pick one or write your own)</label>
      <select value={reason} onChange={(e) => setReason(e.target.value)}>
        <option value="">Select a reason…</option>
        {reasons.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
        <option value="__custom__">✏️ Write a new reason…</option>
      </select>
      {reason === "__custom__" && (
        <>
          <label>New reason</label>
          <input
            type="text"
            value={customReason}
            onChange={(e) => setCustomReason(e.target.value)}
            placeholder="Type the new reason — it will be added to the list"
          />
        </>
      )}
      <label>Details (max {MAX} characters)</label>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={MAX}
        placeholder="What is happening with this merchant?"
      />
      <CharCount value={comment} />
      {error && <div className="error-text">{error}</div>}
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy || !finalReason.trim()}>
          {busy ? "Saving…" : "Save issue"}
        </button>
      </div>
      <History type="issue" businessId={merchant.business_id} refreshKey={refreshKey} />
    </Modal>
  );
}
