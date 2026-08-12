import { useEffect, useState } from "react";
import { api, getToken, setToken } from "./api.js";
import Login from "./components/Login.jsx";
import MerchantPerformance from "./components/MerchantPerformance.jsx";
import KamPerformance from "./components/KamPerformance.jsx";
import SummaryReport from "./components/SummaryReport.jsx";
import AlertPoller from "./components/AlertPoller.jsx";

const TABS = [
  { id: "merchant", label: "Merchant Performance" },
  { id: "kam", label: "KAM Performance" },
  { id: "summary", label: "Summery Report" },
];

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(Boolean(getToken()));
  const [tab, setTab] = useState("merchant");
  const [theme, setTheme] = useState("dark");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!getToken()) return;
    api("/api/me")
      .then((body) => setUser(body.user))
      .catch(() => setToken(""))
      .finally(() => setChecking(false));
  }, []);

  function signOut() {
    setToken("");
    setUser(null);
  }

  if (checking) return <div className="login-wrap">Loading…</div>;
  if (!user) return <Login onSignedIn={setUser} theme={theme} setTheme={setTheme} />;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-badge">CB</div>
          <div>
            <h1>KAM CRM</h1>
            <small>CarryBee · Business Development</small>
          </div>
        </div>
        <div className="spacer" />
        <div className="userchip">
          <span className="role">{user.role}</span>
          <span>{user.full_name}</span>
        </div>
        <button
          className="icon-btn"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          title="Switch theme"
        >
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
        <button className="icon-btn" onClick={signOut}>
          Sign out
        </button>
      </header>

      <nav className="tabs">
        {TABS.map((item) => (
          <button
            key={item.id}
            className={`tab ${tab === item.id ? "active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main className="page">
        {tab === "merchant" && <MerchantPerformance user={user} />}
        {tab === "kam" && <KamPerformance user={user} />}
        {tab === "summary" && <SummaryReport user={user} />}
      </main>

      <AlertPoller user={user} goToAlerts={() => setTab("kam")} />
    </div>
  );
}
