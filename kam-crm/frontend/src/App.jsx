import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken } from "./api.js";
import Login from "./components/Login.jsx";
import Sidebar from "./components/Sidebar.jsx";
import Home from "./components/Home.jsx";
import Flag from "./components/Flag.jsx";
import MerchantPerformance from "./components/MerchantPerformance.jsx";
import BusinessInsights from "./components/BusinessInsights.jsx";

const TITLES = {
  home: "Home",
  flag: "Flag",
  merchant: "Merchant Performance",
  insights: "Business Insights",
};

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(Boolean(getToken()));
  const [tab, setTab] = useState("home");
  // scope drives every tab: { type: 'all' | 'team' | 'lead' | 'kam', value }
  const [scope, setScope] = useState({ type: "all", value: "" });
  const [theme, setTheme] = useState("light");
  const [pendingAlerts, setPendingAlerts] = useState(0);

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

  const refreshPending = useCallback(() => {
    api("/api/alerts/count")
      .then((body) => setPendingAlerts(body.pending))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (user) refreshPending();
  }, [user, tab, refreshPending]);

  function signOut() {
    setToken("");
    setUser(null);
  }

  if (checking) return <div className="login-wrap">Loading…</div>;
  if (!user) return <Login onSignedIn={setUser} theme={theme} setTheme={setTheme} />;

  const scopeLabel =
    scope.type === "all"
      ? user.role === "admin"
        ? "All teams"
        : "My scope"
      : `${scope.type === "kam" ? "KAM" : scope.type === "lead" ? "Lead" : "Team"}: ${scope.value}`;

  return (
    <div className="shell">
      <Sidebar
        user={user}
        tab={tab}
        setTab={setTab}
        scope={scope}
        setScope={setScope}
        theme={theme}
        setTheme={setTheme}
        onSignOut={signOut}
        pendingAlerts={pendingAlerts}
      />
      <div className="main">
        <header className="mainbar">
          <div>
            <h1>{TITLES[tab]}</h1>
            <div className="crumb">TQM Merchant Health Tracker</div>
          </div>
          <div className="spacer" />
          <span className="chip">{scopeLabel}</span>
        </header>
        <main className="content">
          {tab === "home" && <Home user={user} scope={scope} />}
          {tab === "flag" && (
            <Flag user={user} scope={scope} onWorked={refreshPending} />
          )}
          {tab === "merchant" && <MerchantPerformance user={user} scope={scope} />}
          {tab === "insights" && <BusinessInsights user={user} scope={scope} />}
        </main>
      </div>
    </div>
  );
}
