import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken } from "./api.js";
import Login from "./components/Login.jsx";
import Sidebar from "./components/Sidebar.jsx";
import Home from "./components/Home.jsx";
import MerchantPerformance from "./components/MerchantPerformance.jsx";
import KamPerformance from "./components/KamPerformance.jsx";
import SummaryReport from "./components/SummaryReport.jsx";
import AlertPoller from "./components/AlertPoller.jsx";

const TITLES = {
  home: "Home",
  merchant: "Merchant Performance",
  kam: "KAM Performance",
  summary: "Summery Report",
};

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(Boolean(getToken()));
  const [tab, setTab] = useState("home");
  // scope drives Merchant/KAM Performance: {type:'kam'|'lead', value}
  const [scope, setScope] = useState({ type: "kam", value: "" });
  const [theme, setTheme] = useState("light"); // "normal" white theme default
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
    tab === "merchant" || tab === "kam"
      ? scope.value
        ? `${scope.type === "lead" ? "Lead" : "KAM"}: ${scope.value}`
        : ""
      : "";

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
            <div className="crumb">CarryBee · KAM CRM</div>
          </div>
          <div className="spacer" />
          {scopeLabel && <span className="chip">{scopeLabel}</span>}
        </header>
        <main className="content">
          {tab === "home" && <Home user={user} />}
          {tab === "merchant" && <MerchantPerformance user={user} scope={scope} />}
          {tab === "kam" && (
            <KamPerformance user={user} scope={scope} onWorked={refreshPending} />
          )}
          {tab === "summary" && <SummaryReport user={user} />}
        </main>
      </div>
      <AlertPoller user={user} goToAlerts={() => setTab("kam")} />
    </div>
  );
}
