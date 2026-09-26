import { useEffect, useState } from "react";
import { api } from "../api.js";

const NAV = [
  { id: "home", label: "Home", ico: "⌂" },
  { id: "flag", label: "Flag", ico: "⚑" },
  { id: "merchant", label: "Merchant Performance", ico: "▦" },
  { id: "insights", label: "Business Insights", ico: "◎" },
];

/**
 * Pipedrive-style left rail. The filter list is built from /api/filters, which
 * already returns only what this account may open — a KAM sees a single entry,
 * a lead sees their team, an admin sees everything. Nothing here is hardcoded,
 * so moving a KAM between leads in kam_team_directory is picked up on reload.
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
  const [filters, setFilters] = useState({ teams: [], leads: [], kams: [] });
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/filters")
      .then((body) => {
        setFilters(body);
        // A KAM lands on their own book; a lead or admin starts on everything
        // they may see, which is what "All" means for that account.
        if (user.role === "kam" && body.kams.length === 1) {
          setScope({ type: "kam", value: body.kams[0].kam_name });
        }
      })
      .catch((err) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const initials = (user.full_name || "?")
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const isActive = (type, value) => scope.type === type && scope.value === value;
  const showAll = user.role !== "kam";

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
            {item.id === "flag" && pendingAlerts > 0 && (
              <span className="badge-count">{pendingAlerts}</span>
            )}
          </button>
        ))}
      </div>

      <div className="side-section side-scroll">
        {showAll && (
          <button
            className={`side-sub ${scope.type === "all" ? "active" : ""}`}
            onClick={() => setScope({ type: "all", value: "" })}
          >
            {user.role === "admin" ? "All teams" : "My whole team"}
          </button>
        )}

        {filters.teams.length > 1 && (
          <>
            <div className="side-label">Teams</div>
            {filters.teams.map((team) => (
              <button
                key={team.team_name}
                className={`side-sub ${isActive("team", team.team_name) ? "active" : ""}`}
                onClick={() => setScope({ type: "team", value: team.team_name })}
              >
                {team.team_name}
                <span className="mini">{team.kams} KAM</span>
              </button>
            ))}
          </>
        )}

        {filters.leads.length > 1 && (
          <>
            <div className="side-label">Leads</div>
            {filters.leads.map((lead) => (
              <button
                key={lead.lead_name}
                className={`side-sub ${isActive("lead", lead.lead_name) ? "active" : ""}`}
                onClick={() => setScope({ type: "lead", value: lead.lead_name })}
              >
                {lead.lead_name}
                <span className="mini">{lead.kams} KAM</span>
              </button>
            ))}
          </>
        )}

        <div className="side-label">KAMs</div>
        {filters.kams.map((kam) => (
          <button
            key={kam.kam_name}
            className={`side-sub ${isActive("kam", kam.kam_name) ? "active" : ""}`}
            title={`${kam.team_name} · lead ${kam.lead_name}`}
            onClick={() => setScope({ type: "kam", value: kam.kam_name })}
          >
            {kam.kam_name}
            <span className="mini">{kam.merchants}</span>
          </button>
        ))}
        {error && <div className="side-sub" style={{ color: "#ff6a57" }}>{error}</div>}
      </div>

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
