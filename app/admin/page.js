"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { downloadText, timestampForFilename } from "../../lib/clientExport.js";

const PROVIDERS = ["openrouter", "googleAiStudio", "groq", "cerebras", "cloudflare", "pollinations"];
const KEY_OPTIONAL_PROVIDERS = new Set(["pollinations"]);
const SESSION_KEY = "aigateway_admin_password";

// Best-effort decode of a stored lastError string into a short, human
// readable reason. lastError is stored as JSON.stringify(providerErrorBody)
// or a plain error message — providers don't agree on shape, so this tries
// a few common fields before falling back to the raw text.
function decodeErrorReason(lastError) {
  if (!lastError) return null;
  let parsed;
  try {
    parsed = JSON.parse(lastError);
  } catch {
    return { summary: lastError, code: null };
  }
  const status = parsed.status ?? parsed.code ?? null;
  const message =
    parsed?.error?.message ||
    parsed?.error?.errors?.[0]?.message ||
    parsed?.message ||
    parsed?.errors?.[0]?.message ||
    null;

  const KNOWN = {
    401: "Invalid/revoked API key — copy-paste galti ya key revoke ho gayi. Naya key lagao.",
    402: "Payment required — account ka free credit/balance khatam. Naya account ya billing add karo.",
    404: "Model not found — model ka naam badal gaya ya provider ke paas access nahi. Model list check karo.",
    429: "Rate limited — bahut zyada requests. 10 min me apne aap theek ho jaayega (cooldown).",
    403: "Forbidden/rate limited — key ke paas is resource ki permission nahi, ya rate limit.",
  };
  const known = KNOWN[status] || KNOWN[parsed?.status] || null;

  return { summary: message || lastError, code: status, known };
}

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
  const [errorModalKey, setErrorModalKey] = useState(null); // key doc currently shown in the error-detail modal

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
      usageByProvider: stats?.usageByProvider ?? null,
      activeAccountsByProvider: stats?.activeAccountsByProvider ?? null,
      dailyFreeLimits: stats?.dailyFreeLimits ?? null,
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

      {stats && (
        <section className="card">
          <h2>Free Tier Usage (Today)</h2>
          <p className="muted" style={{ fontSize: 14 }}>
            Har provider ka daily free limit uske active accounts ki sankhya se multiply hota hai (har account ki apni
            alag bucket hoti hai). Rolling last-24h data hai, exact UTC-midnight reset se thoda mismatch ho sakta hai.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 14 }}>
            {Object.entries(stats.dailyFreeLimits || {}).map(([provider, limitInfo]) => {
              const accounts = stats.activeAccountsByProvider?.[provider] ?? 0;
              const usage = stats.usageByProvider?.[provider] ?? { requests: 0, totalTokens: 0 };
              if (accounts === 0 && usage.requests === 0) return null; // provider not configured at all — skip

              const isTokenBased = limitInfo.unit === "tokens";
              const used = isTokenBased ? usage.totalTokens : usage.requests;
              const effectiveLimit = limitInfo.amount != null ? limitInfo.amount * Math.max(accounts, 1) : null;
              const pct = effectiveLimit ? Math.min(100, Math.round((used / effectiveLimit) * 100)) : null;
              const barColor = pct == null ? "var(--border)" : pct >= 90 ? "var(--danger)" : pct >= 60 ? "#e0a530" : "var(--success)";

              return (
                <div key={provider}>
                  <div className="row" style={{ justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                    <strong>{provider}</strong>
                    <span className="muted">
                      {effectiveLimit != null
                        ? `${used.toLocaleString()} / ${effectiveLimit.toLocaleString()} ${limitInfo.unit} (${accounts} account${accounts === 1 ? "" : "s"})`
                        : `${used.toLocaleString()} ${limitInfo.unit} used — no published daily cap`}
                    </span>
                  </div>
                  <div style={{ background: "var(--border)", borderRadius: 6, height: 8, overflow: "hidden" }}>
                    <div
                      style={{
                        width: pct != null ? `${pct}%` : "100%",
                        height: "100%",
                        background: barColor,
                        opacity: pct == null ? 0.3 : 1,
                      }}
                    />
                  </div>
                  <p className="muted" style={{ fontSize: 11, marginTop: 3, marginBottom: 0 }}>{limitInfo.note}</p>
                </div>
              );
            })}
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
                  <td style={{ maxWidth: 220 }}>
                    {k.lastError ? (
                      <button
                        onClick={() => setErrorModalKey(k)}
                        className="btn btn-ghost btn-sm"
                        style={{ textAlign: "left", whiteSpace: "normal", maxWidth: "100%" }}
                        type="button"
                      >
                        {decodeErrorReason(k.lastError)?.code ? `${decodeErrorReason(k.lastError).code} — ` : ""}
                        {(decodeErrorReason(k.lastError)?.summary || k.lastError).slice(0, 40)}
                        {(decodeErrorReason(k.lastError)?.summary || k.lastError).length > 40 ? "…" : ""}
                      </button>
                    ) : (
                      "—"
                    )}
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
                  <tr
                    key={l.id}
                    onClick={() => !l.ok && l.errorMessage && setErrorModalKey({ id: `${l.provider} · ${l.model}`, status: "failed", lastError: l.errorMessage })}
                    style={!l.ok && l.errorMessage ? { cursor: "pointer" } : undefined}
                  >
                    <td>{l.type}</td>
                    <td>{l.provider}</td>
                    <td style={{ fontSize: 12 }}>{l.model}</td>
                    <td>{l.ok ? "✅" : l.errorMessage ? "❌ (tap for detail)" : "❌"}</td>
                    <td>{l.latencyMs}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {errorModalKey && (
        <ErrorDetailModal keyDoc={errorModalKey} onClose={() => setErrorModalKey(null)} />
      )}
    </main>
  );
}

function ErrorDetailModal({ keyDoc, onClose }) {
  const decoded = decodeErrorReason(keyDoc.lastError);
  let prettyJson = keyDoc.lastError;
  try {
    prettyJson = JSON.stringify(JSON.parse(keyDoc.lastError), null, 2);
  } catch {
    // lastError wasn't JSON — show as-is
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: 20,
        overflowY: "auto",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ maxWidth: 560, width: "100%", marginTop: 40 }}
      >
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16 }}>{keyDoc.id}</h2>
            <span className={`badge badge-${keyDoc.status === "disabled" ? "disabled" : keyDoc.status === "cooldown" ? "cooldown" : "active"}`}>
              {keyDoc.status}
            </span>
          </div>
          <button onClick={onClose} className="btn btn-ghost btn-sm" type="button">
            Close
          </button>
        </div>

        {decoded?.code && (
          <p style={{ marginTop: 14 }}>
            <strong>HTTP Status:</strong> {decoded.code}
          </p>
        )}
        {decoded?.known && (
          <p style={{ color: "var(--danger)", fontWeight: 600 }}>{decoded.known}</p>
        )}
        {!decoded?.known && decoded?.summary && (
          <p style={{ marginTop: 6 }}>{decoded.summary}</p>
        )}

        <div className="field-label" style={{ marginTop: 12 }}>Raw error (full)</div>
        <pre style={{ maxHeight: 300, overflow: "auto" }}>{prettyJson}</pre>
      </div>
    </div>
  );
}
