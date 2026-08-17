import { useState } from "react";
import { api, setToken } from "../api.js";

export default function Login({ onSignedIn, theme, setTheme }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!username || !password || busy) return;
    setBusy(true);
    setError("");
    try {
      const body = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      setToken(body.token);
      onSignedIn(body.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand" style={{ marginBottom: 6 }}>
          <div className="brand-badge">CB</div>
        </div>
        <h1>KAM CRM</h1>
        <div className="sub">CarryBee · Sign in with your team account</div>
        <label>Username</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          autoFocus
        />
        <label>Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {error && <div className="error-text">{error}</div>}
        <button className="btn primary" onClick={submit} disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <button
          className="icon-btn"
          style={{ width: "100%", marginTop: 10 }}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
      </div>
    </div>
  );
}
