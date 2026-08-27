"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { downloadText, timestampForFilename } from "../../lib/clientExport.js";

const PROVIDERS = ["openrouter", "googleAiStudio", "groq", "cerebras", "cloudflare", "pollinations"];
const KEY_OPTIONAL_PROVIDERS = new Set(["pollinations"]);
const SESSION_KEY = "aigateway_admin_password";

export default function AdminPage() {
  // authStage: "checking" (silent re-validate on mount) | "loggedOut" | "loggedIn"
  const [authStage, setAuthStage] = useState("checking");
  const [password, setPassword] = useState("");
  const [loginMsg, setLoginMsg] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);

  const [keys, setKeys] = useState([]);
  const [stats, setStats] = useState(null);
  const [msg, setMsg] = useState("");

  const [form, setForm] = useState({ provider: "openrouter", accountLabel: "acc1", apiKey: "", accountId: "" });
  const [masterKeyStatus, setMasterKeyStatus] = useState(null);
  const [generatedKeys, setGeneratedKeys] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [addingKey, setAddingKey] = useState(false);

  // Holds the password used for authenticated requests. Kept in a ref (not
  // just React state) so it survives re-renders without re-triggering effects.
  const pwRef = useRef("");

  const headers = useCallback(() => ({ "Content-Type": "application/json", "X-Admin-Password": pwRef.current }), []);

  // --- Session persistence -------------------------------------------------
  // Previously the admin password only lived in React state, so navigating
  // to /test and back (a full route change) reset the component and asked
  // for the password again every single time. Password is cached in
  // sessionStorage (cleared when the browser tab closes — never persisted
  // to disk) and silently re-validated against a real endpoint on mount, so
  // a stale/rotated password still correctly falls back to the login form.
  useEffect(() => {
    const cached = typeof window !== "undefined" ? sessionStorage.getItem(SESSION_KEY) : null;
    if (!cached) {
      setAuthStage("loggedOut");
      return;
    }
    pwRef.current = cached;
    (async () => {
      const res = await fetch("/api/admin/keys", { headers: { "X-Admin-Password": cached } });
      if (res.ok) {
        setAuthStage("loggedIn");
      } else {
        sessionStorage.removeItem(SESSION_KEY);
        pwRef.current = "";
        setAuthStage("loggedOut");
      }
    })();
  }, []);

  async function loadMasterKeyStatus() {
    const res = await fetch("/api/admin/master-keys", { headers: headers() });
    if (res.ok) setMasterKeyStatus((await res.json()).masterKeys);
  }

  async function generateMasterKeys(regenerate = []) {
    setGenerating(true);
    try {
      const res = await fetch("/api/admin/master-keys", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ regenerate }),
      });
      const json = await res.json();
      if (res.ok && Object.keys(json.generated || {}).length > 0) {
        setGeneratedKeys(json.generated);
      }
      await loadMasterKeyStatus();
    } finally {
      setGenerating(false);
    }
  }

  async function tryLogin(e) {
    e.preventDefault();
    setLoginBusy(true);
    setLoginMsg("");
    try {
      const res = await fetch("/api/admin/keys", { headers: { "X-Admin-Password": password } });
      if (res.ok) {
        pwRef.current = password;
        sessionStorage.setItem(SESSION_KEY, password);
        setAuthStage("loggedIn");
        setPassword("");
      } else {
        setLoginMsg(res.status === 401 ? "Wrong password." : `Server error (${res.status}).`);
      }
    } catch (err) {
      setLoginMsg(`Network error: ${err.message}`);
    } finally {
      setLoginBusy(false);
    }
  }

  function logout() {
    sessionStorage.removeItem(SESSION_KEY);
    pwRef.current = "";
    setAuthStage("loggedOut");
    setKeys([]);
    setStats(null);
    setMasterKeyStatus(null);
  }

  const loadAll = useCallback(async () => {
    const [keysRes, statsRes] = await Promise.all([
      fetch("/api/admin/keys", { headers: headers() }),
      fetch("/api/admin/stats", { headers: headers() }),
    ]);
    // Session may have been revoked/rotated server-side since login — bounce
    // back to the login screen instead of silently failing forever.
    if (keysRes.status === 401 || statsRes.status === 401) {
      logout();
      return;
    }
    if (keysRes.ok) setKeys((await keysRes.json()).keys);
    if (statsRes.ok) setStats(await statsRes.json());
  }, [headers]);

  useEffect(() => {
    if (authStage === "loggedIn") {
      loadAll();
      loadMasterKeyStatus();
      const interval = setInterval(loadAll, 15000); // live-ish refresh every 15s
      return () => clearInterval(interval);
    }
  }, [authStage, loadAll]);

  async function addKey(e) {
    e.preventDefault();
    setAddingKey(true);
    setMsg("Adding...");
    try {
      const res = await fetch("/api/admin/keys", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (res.ok) {
        setMsg(`✅ Added ${json.id}`);
        setForm((f) => ({ ...f, apiKey: "", accountId: "" }));
        loadAll();
      } else {
        setMsg(`❌ Error: ${json.error}`);
      }
    } catch (err) {
      setMsg(`❌ Network error: ${err.message}`);
    } finally {
      setAddingKey(false);
    }
  }

  async function removeKey(id) {
    if (!confirm(`Delete key ${id}?`)) return;
    await fetch(`/api/admin/keys?id=${id}`, { method: "DELETE", headers: headers() });
    loadAll();
  }

  async function reactivateKey(id) {
    await fetch("/api/admin/keys", { method: "PATCH", headers: headers(), body: JSON.stringify({ id }) });
    loadAll();
  }

  // Bundles everything currently on screen (keys, provider stats, model
  // scores, recent logs) into one JSON file — so instead of screenshotting
  // the whole page, it can just be downloaded and shared directly.
  function downloadReport() {
    const report = {
      generatedAt: new Date().toISOString(),
      last24h: stats?.last24h ?? null,
      byProvider: stats?.byProvider ?? null,
      modelScores: stats?.modelScores ?? null,
      keys: keys.map((k) => ({
        id: k.id,
        status: k.status,
        successCount: k.successCount,
        failCount: k.failCount,
        lastError: k.lastError ?? null,
      })),
      recentLogs: stats?.recentLogs ?? null,
    };
    downloadText(`ai-gateway-report-${timestampForFilename()}.json`, JSON.stringify(report, null, 2));
  }

  // --- Render --------------------------------------------------------------

  if (authStage === "checking") {
    return (
      <main className="center-page">
        <div className="row muted">
          <span className="spinner" /> Checking session...
        </div>
      </main>
    );
  }

  if (authStage === "loggedOut") {
    return (
      <main className="center-page">
        <form onSubmit={tryLogin} className="card" style={{ width: "100%", maxWidth: 360 }}>
          <h2>Admin Login</h2>
          <input
            type="password"
            placeholder="Admin password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
            autoFocus
          />
          <button className="btn" disabled={loginBusy || !password}>
            {loginBusy ? "Checking..." : "Enter"}
          </button>
          {loginMsg && (
            <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 10, marginBottom: 0 }}>{loginMsg}</p>
          )}
        </form>
      </main>
    );
  }

  const keyOptional = KEY_OPTIONAL_PROVIDERS.has(form.provider);

  return (
    <main className="page">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
        <h1 style={{ margin: 0 }}>AI Gateway Admin</h1>
        <div className="row" style={{ gap: 8 }}>
          <button onClick={downloadReport} disabled={!stats} className="btn btn-ghost btn-sm">
            Download Report
          </button>
          <button onClick={logout} className="btn btn-ghost btn-sm">
            Log out
          </button>
        </div>
      </div>

      <section className="card">
        <h2>Master Keys</h2>
        <p className="card-hint">
          Ye keys tere baaki projects use karenge gateway call karne ke liye. Sirf ek baar plaintext dikhti hain —
          turant copy kar lena.
        </p>
        {masterKeyStatus && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {["text", "image", "audio"].map((type) => (
                  <tr key={type}>
                    <td style={{ textTransform: "capitalize" }}>{type}</td>
                    <td>{masterKeyStatus[type]?.configured ? "✅ Configured" : "❌ Not set"}</td>
                    <td>
                      {masterKeyStatus[type]?.configured && (
                        <button onClick={() => generateMasterKeys([type])} disabled={generating} className="btn btn-danger btn-sm">
                          Regenerate
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <button onClick={() => generateMasterKeys([])} disabled={generating} className="btn" style={{ marginTop: 12 }}>
          {generating ? "Generating..." : "Generate Missing Master Keys"}
        </button>

        {generatedKeys && (
          <div
            style={{
              marginTop: 14,
              padding: 12,
              background: "#1a2e1a",
              borderRadius: 8,
              border: "1px solid var(--success-border)",
            }}
          >
            <p style={{ margin: "0 0 8px", fontWeight: "bold" }}>⚠️ Abhi copy kar lo — dobara nahi dikhengi:</p>
            {Object.entries(generatedKeys).map(([type, key]) => (
              <div key={type} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, opacity: 0.7, textTransform: "uppercase" }}>{type}</div>
                <code
                  style={{
                    display: "block",
                    padding: 8,
                    background: "#0b0e14",
                    borderRadius: 6,
                    wordBreak: "break-all",
                    fontSize: 13,
                  }}
                >
                  {key}
                </code>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Add API Key</h2>
        <p className="card-hint">
          Pollinations key <em>optional</em> hai — bina key ke bhi free tier chal jaayega, key dogey to rate limit
          zyada milega aur watermark hat jaayega.
        </p>
        <form onSubmit={addKey} className="stack">
          <div className="field-row two-col">
            <select
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}
              className="input"
              style={{ marginBottom: 0 }}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <input
              placeholder="accountLabel (acc1 / acc2 / acc3 / acc4)"
              value={form.accountLabel}
              onChange={(e) => setForm({ ...form, accountLabel: e.target.value })}
              className="input"
              style={{ marginBottom: 0 }}
            />
          </div>
          <input
            placeholder={keyOptional ? "API key (optional for Pollinations)" : "API key"}
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            className="input"
          />
          {form.provider === "cloudflare" && (
            <input
              placeholder="Cloudflare Account ID"
              value={form.accountId}
              onChange={(e) => setForm({ ...form, accountId: e.target.value })}
              className="input"
            />
          )}
          <button className="btn" disabled={addingKey}>
            {addingKey ? "Adding..." : "Add Key"}
          </button>
          {msg && <p className="muted" style={{ fontSize: 13 }}>{msg}</p>}
        </form>
      </section>

      {stats && (
        <section className="card">
          <h2>Live Stats</h2>
          <p className="muted" style={{ fontSize: 14 }}>
            Last 24h: {stats.last24h.success} success / {stats.last24h.failed} failed ({stats.last24h.total} total)
          </p>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Total</th>
                  <th>Active</th>
                  <th>Cooldown</th>
                  <th>Disabled</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(stats.byProvider).map(([p, s]) => (
                  <tr key={p}>
                    <td>{p}</td>
                    <td>{s.total}</td>
                    <td>{s.active || 0}</td>
                    <td>{s.cooldown || 0}</td>
                    <td>{s.disabled || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {stats?.modelScores?.length > 0 && (
        <section className="card">
          <h2>Model Scores (Self-Healing)</h2>
          <p className="card-hint">Higher score = tried first. Drops automatically on repeated failures.</p>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Score</th>
                  <th>Avg Latency</th>
                  <th>Calls</th>
                </tr>
              </thead>
              <tbody>
                {stats.modelScores.map((m) => (
                  <tr key={m.id}>
                    <td>{m.provider}</td>
                    <td style={{ fontSize: 12 }}>{m.model}</td>
                    <td style={{ color: m.score > 60 ? "var(--success)" : m.score > 30 ? "var(--warn)" : "var(--danger)" }}>
                      {m.score?.toFixed(1)}
                    </td>
                    <td>{m.avgLatencyMs}ms</td>
                    <td>{m.totalCalls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Keys ({keys.length})</h2>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Success</th>
                <th>Fail</th>
                <th>Last Error</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.id}</td>
                  <td>
                    <span className={`badge badge-${k.status === "disabled" ? "disabled" : k.status === "cooldown" ? "cooldown" : "active"}`}>
                      {k.status}
                    </span>
                  </td>
                  <td>{k.successCount}</td>
                  <td>{k.failCount}</td>
                  <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {k.lastError || "—"}
                  </td>
                  <td>
                    <div className="row" style={{ flexWrap: "nowrap" }}>
                      {k.status === "disabled" && (
                        <button onClick={() => reactivateKey(k.id)} className="btn btn-success btn-sm">
                          Reactivate
                        </button>
                      )}
                      <button onClick={() => removeKey(k.id)} className="btn btn-danger btn-sm">
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {stats?.recentLogs && (
        <section className="card">
          <h2>Recent Requests</h2>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>OK</th>
                  <th>Latency</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentLogs.map((l) => (
                  <tr key={l.id}>
                    <td>{l.type}</td>
                    <td>{l.provider}</td>
                    <td style={{ fontSize: 12 }}>{l.model}</td>
                    <td>{l.ok ? "✅" : "❌"}</td>
                    <td>{l.latencyMs}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
