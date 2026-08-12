import { useEffect, useState } from "react";
import { api } from "../api.js";

/**
 * The 7 KAM buttons. A KAM account sees the other six locked;
 * the Lead and Admins can open every book.
 */
export default function KamButtons({ user, selected, onSelect }) {
  const [kams, setKams] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/kams")
      .then((body) => {
        setKams(body.kams);
        const first = body.kams.find((k) => !k.locked);
        if (first && !selected) onSelect(first.kam_name);
      })
      .catch((err) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="panel">
      <h2>Key Account Managers</h2>
      <p className="sub">
        {user.role === "kam"
          ? "Your book is unlocked. Other KAMs' books are locked for your account."
          : "Open any KAM's book."}
      </p>
      <div className="kam-grid">
        {kams.map((kam) => (
          <button
            key={kam.kam_name}
            className={`kam-btn ${selected === kam.kam_name ? "selected" : ""} ${
              kam.locked ? "locked" : ""
            }`}
            disabled={kam.locked}
            onClick={() => onSelect(kam.kam_name)}
            title={kam.locked ? "Locked for your account" : kam.full_name}
          >
            <span className="lock">{kam.locked ? "🔒" : "🐝"}</span>
            {kam.full_name}
          </button>
        ))}
      </div>
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
