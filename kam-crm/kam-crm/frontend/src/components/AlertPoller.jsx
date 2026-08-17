import { useEffect, useState } from "react";
import { api } from "../api.js";

/**
 * Global 10-minute alert popup (approved B4).
 * A KAM sees their own pending count; the Lead and Admins see the
 * combined pending count across all KAMs.
 */
export default function AlertPoller({ user, goToAlerts }) {
  const [pending, setPending] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const body = await api("/api/alerts/count");
        if (cancelled) return;
        setPending(body.pending);
        if (body.pending > 0) setVisible(true);
      } catch {
        /* silent - retried on the next cycle */
      }
    }
    check();
    const timer = setInterval(check, 10 * 60 * 1000); // every 10 minutes
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [user]);

  if (!visible || pending === 0) return null;

  return (
    <div className="alert-pop">
      <h4>⚠️ Pending alerts</h4>
      <p>
        <span className="count">{pending}</span>{" "}
        {user.role === "kam"
          ? "of your merchants still need feedback."
          : "merchant actions across the team are still Not Worked."}
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="btn primary"
          onClick={() => {
            setVisible(false);
            goToAlerts();
          }}
        >
          Open board
        </button>
        <button className="btn" onClick={() => setVisible(false)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
