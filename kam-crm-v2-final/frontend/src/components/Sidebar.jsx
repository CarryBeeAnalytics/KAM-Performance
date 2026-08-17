import { useEffect, useState } from "react";
import { api } from "../api.js";

const NAV = [
  { id: "home", label: "Home", ico: "⌂" },
  { id: "merchant", label: "Merchant Performance", ico: "▦" },
  { id: "kam", label: "KAM Performance", ico: "◎" },
  { id: "summary", label: "Summery Report", ico: "≡" },
];

/**
 * Pipedrive-style left rail: main tabs on top; when Merchant / KAM
 * Performance is open, the Lead and KAM filters appear directly under it.
 * scope = { type: 'kam' | 'lead', value } drives every page query.
 */
export default function Sidebar({
  user,
  tab,
  setTab,
  scope,
  setScope,
  theme,
  setTheme,
  onSignOut,
  pendingAlerts,
}) {
  const [filters, setFilters] = useState({ kams: [], leads: [] });
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/filters")
      .then((body) => {
        setFilters(body);
        // Default scope: the first unlocked KAM (a KAM lands on their own book).
        if (!scope.value) {
          const first = body.kams.find((k) => !k.locked);
          if (first) setScope({ type: "kam", value: first.kam_name });
        }
      })
      .catch((err) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showFilters = tab === "merchant" || tab === "kam";
  const initials = (user.full_name || "?")
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <aside className="sidebar">
      <div className="side-brand">
        <div className="badge">CB</div>
        <div>
          <b>KAM CRM</b>
          <small>CarryBee · Business Development</small>
        </div>
      </div>

      <div className="side-section">
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`side-item ${tab === item.id ? "active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            <span className="ico">{item.ico}</span>
            {item.label}
            {item.id === "kam" && pendingAlerts > 0 && (
              <span className="badge-count">{pendingAlerts}</span>
            )}
          </button>
        ))}
      </div>

      {showFilters && (
        <div className="side-section">
          <div className="side-label">Leads</div>
          {filters.leads.length === 0 && (
            <div className="side-sub" style={{ cursor: "default" }}>No leads yet</div>
          )}
          {filters.leads.map((lead) => (
            <button
              key={lead.lead_name}
              className={`side-sub ${
                scope.type === "lead" && scope.value === lead.lead_name ? "active" : ""
              }`}
              disabled={lead.locked}
              title={lead.locked ? "Locked for your account" : `${lead.merchant_count} merchants`}
              onClick={() => setScope({ type: "lead", value: lead.lead_name })}
            >
              {lead.locked ? "🔒 " : ""}{lead.lead_name}
              <span className="mini">{lead.kam_count} KAM</span>
            </button>
          ))}

          <div className="side-label" style={{ marginTop: 6 }}>KAMs</div>
          {filters.kams.map((kam) => (
            <button
              key={kam.kam_name}
              className={`side-sub ${
                scope.type === "kam" && scope.value === kam.kam_name ? "active" : ""
              }`}
              disabled={kam.locked}
              title={kam.locked ? "Locked for your account" : kam.full_name}
              onClick={() => setScope({ type: "kam", value: kam.kam_name })}
            >
              {kam.locked ? "🔒 " : ""}{kam.full_name}
            </button>
          ))}
          {error && <div className="side-sub" style={{ color: "#ff6a57" }}>{error}</div>}
        </div>
      )}

      <div className="side-footer">
        <div className="side-user">
          <div className="avatar">{initials}</div>
          <div>
            <b>{user.full_name}</b>
            <small>{user.role}</small>
          </div>
        </div>
        <div className="side-actions">
          <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "☀ Normal" : "◐ Dark"}
          </button>
          <button onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    </aside>
  );
}
