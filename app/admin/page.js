"use client";

import { useState, useEffect, useCallback } from "react";

const PROVIDERS = ["openrouter", "googleAiStudio", "groq", "cerebras", "cloudflare"];

export default function AdminPage() {
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(false);
  const [keys, setKeys] = useState([]);
  const [stats, setStats] = useState(null);
  const [msg, setMsg] = useState("");

  const [form, setForm] = useState({ provider: "openrouter", accountLabel: "acc1", apiKey: "", accountId: "" });
  const [masterKeyStatus, setMasterKeyStatus] = useState(null);
  const [generatedKeys, setGeneratedKeys] = useState(null);
  const [generating, setGenerating] = useState(false);

  const headers = useCallback(() => ({ "Content-Type": "application/json", "X-Admin-Password": password }), [password]);

  async function loadMasterKeyStatus() {
    const res = await fetch("/api/admin/master-keys", { headers: headers() });
    if (res.ok) setMasterKeyStatus((await res.json()).masterKeys);
  }

  async function generateMasterKeys(regenerate = []) {
    setGenerating(true);
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
    setGenerating(false);
  }

  async function tryLogin(e) {
    e.preventDefault();
    setMsg("Checking...");
    const res = await fetch("/api/admin/keys", { headers: headers() });
    if (res.ok) {
      setAuthed(true);
      setMsg("");
      loadAll();
      loadMasterKeyStatus();
    } else {
      setMsg("Wrong password.");
    }
  }

  const loadAll = useCallback(async () => {
    const [keysRes, statsRes] = await Promise.all([
      fetch("/api/admin/keys", { headers: headers() }),
      fetch("/api/admin/stats", { headers: headers() }),
    ]);
    if (keysRes.ok) setKeys((await keysRes.json()).keys);
    if (statsRes.ok) setStats(await statsRes.json());
  }, [headers]);

  useEffect(() => {
    if (authed) {
      const interval = setInterval(loadAll, 15000); // live-ish refresh every 15s
      return () => clearInterval(interval);
    }
  }, [authed, loadAll]);

  async function addKey(e) {
    e.preventDefault();
    setMsg("Adding...");
    const res = await fetch("/api/admin/keys", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(form),
    });
    const json = await res.json();
    if (res.ok) {
      setMsg(`Added ${json.id}`);
      setForm((f) => ({ ...f, apiKey: "", accountId: "" }));
      loadAll();
    } else {
      setMsg(`Error: ${json.error}`);
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

  if (!authed) {
    return (
      <main style={styles.center}>
        <form onSubmit={tryLogin} style={styles.card}>
          <h2>Admin Login</h2>
          <input
            type="password"
            placeholder="Admin password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={styles.input}
          />
          <button style={styles.button}>Enter</button>
          {msg && <p style={{ color: "#f87171" }}>{msg}</p>}
        </form>
      </main>
    );
  }

  return (
    <main style={{ padding: 24, maxWidth: 960, margin: "0 auto" }}>
      <h1>AI Gateway Admin</h1>

      <section style={styles.card}>
        <h2>Master Keys</h2>
        <p style={{ opacity: 0.7, fontSize: 13 }}>
          Ye keys tere baaki projects use karenge gateway call karne ke liye. Sirf ek baar plaintext dikhti hain — turant copy kar lena.
        </p>
        {masterKeyStatus && (
          <table style={styles.table}>
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
                      <button
                        onClick={() => generateMasterKeys([type])}
                        disabled={generating}
                        style={{ ...styles.button, background: "#7f1d1d", fontSize: 12, padding: "6px 10px" }}
                      >
                        Regenerate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button onClick={() => generateMasterKeys([])} disabled={generating} style={{ ...styles.button, marginTop: 10 }}>
          {generating ? "Generating..." : "Generate Missing Master Keys"}
        </button>

        {generatedKeys && (
          <div style={{ marginTop: 14, padding: 12, background: "#1a2e1a", borderRadius: 8, border: "1px solid #2e5c2e" }}>
            <p style={{ margin: "0 0 8px", fontWeight: "bold" }}>⚠️ Abhi copy kar lo — dobara nahi dikhengi:</p>
            {Object.entries(generatedKeys).map(([type, key]) => (
              <div key={type} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, opacity: 0.7, textTransform: "uppercase" }}>{type}</div>
                <code style={{ display: "block", padding: 8, background: "#0b0e14", borderRadius: 6, wordBreak: "break-all", fontSize: 13 }}>
                  {key}
                </code>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={styles.card}>
        <h2>Add API Key</h2>
        <form onSubmit={addKey} style={{ display: "grid", gap: 10 }}>
          <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} style={styles.input}>
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
            style={styles.input}
          />
          <input
            placeholder="API key"
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            style={styles.input}
          />
          {form.provider === "cloudflare" && (
            <input
              placeholder="Cloudflare Account ID"
              value={form.accountId}
              onChange={(e) => setForm({ ...form, accountId: e.target.value })}
              style={styles.input}
            />
          )}
          <button style={styles.button}>Add Key</button>
          {msg && <p style={{ opacity: 0.8 }}>{msg}</p>}
        </form>
      </section>

      {stats && (
        <section style={styles.card}>
          <h2>Live Stats</h2>
          <p>
            Last 24h: {stats.last24h.success} success / {stats.last24h.failed} failed ({stats.last24h.total} total)
          </p>
          <table style={styles.table}>
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
        </section>
      )}

      {stats?.modelScores?.length > 0 && (
        <section style={styles.card}>
          <h2>Model Scores (Self-Healing)</h2>
          <p style={{ opacity: 0.7, fontSize: 13 }}>Higher score = tried first. Drops automatically on repeated failures.</p>
          <table style={styles.table}>
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
                  <td style={{ color: m.score > 60 ? "#4ade80" : m.score > 30 ? "#facc15" : "#f87171" }}>
                    {m.score?.toFixed(1)}
                  </td>
                  <td>{m.avgLatencyMs}ms</td>
                  <td>{m.totalCalls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section style={styles.card}>
        <h2>Keys ({keys.length})</h2>
        <table style={styles.table}>
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
                <td style={{ color: k.status === "disabled" ? "#f87171" : k.status === "cooldown" ? "#facc15" : "#4ade80" }}>
                  {k.status}
                </td>
                <td>{k.successCount}</td>
                <td>{k.failCount}</td>
                <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {k.lastError || "—"}
                </td>
                <td style={{ display: "flex", gap: 6 }}>
                  {k.status === "disabled" && (
                    <button onClick={() => reactivateKey(k.id)} style={{ ...styles.button, background: "#166534", fontSize: 12, padding: "6px 10px" }}>
                      Reactivate
                    </button>
                  )}
                  <button onClick={() => removeKey(k.id)} style={{ ...styles.button, background: "#7f1d1d" }}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {stats?.recentLogs && (
        <section style={styles.card}>
          <h2>Recent Requests</h2>
          <table style={styles.table}>
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
        </section>
      )}
    </main>
  );
}

const styles = {
  center: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" },
  card: {
    position: "relative",
    zIndex: 1,
    background: "#141922",
    border: "1px solid #232b38",
    borderRadius: 12,
    padding: 20,
    marginBottom: 20,
    overflow: "hidden",
    isolation: "isolate",
  },
  input: {
    position: "relative",
    zIndex: 1,
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid #2a3341",
    background: "#0b0e14",
    color: "#e6e8eb",
    fontSize: 14,
    width: "100%",
    boxSizing: "border-box",
  },
  button: {
    position: "relative",
    zIndex: 1,
    padding: "10px 16px",
    borderRadius: 8,
    border: "none",
    background: "#2563eb",
    color: "white",
    cursor: "pointer",
    fontSize: 14,
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
};
