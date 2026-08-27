"use client";

import { useState, useEffect } from "react";

// Keys are cached in sessionStorage purely for local testing convenience —
// cleared when the tab closes, never sent anywhere except this gateway.
const STORAGE_KEYS = { text: "aigateway_test_textKey", image: "aigateway_test_imageKey", audio: "aigateway_test_audioKey" };

function useStoredKey(storageKey) {
  const [value, setValue] = useState("");
  useEffect(() => {
    const cached = sessionStorage.getItem(storageKey);
    if (cached) setValue(cached);
  }, [storageKey]);
  function update(next) {
    setValue(next);
    if (next) sessionStorage.setItem(storageKey, next);
    else sessionStorage.removeItem(storageKey);
  }
  return [value, update];
}

export default function TestPage() {
  const [textKey, setTextKey] = useStoredKey(STORAGE_KEYS.text);
  const [imageKey, setImageKey] = useStoredKey(STORAGE_KEYS.image);
  const [audioKey, setAudioKey] = useStoredKey(STORAGE_KEYS.audio);

  const [prompt, setPrompt] = useState("Hello! Reply with one short sentence.");
  const [imgPrompt, setImgPrompt] = useState("a cute cat riding a bicycle");

  const [textResult, setTextResult] = useState(null);
  const [imageResult, setImageResult] = useState(null);
  const [audioResult, setAudioResult] = useState(null);
  const [audioFileName, setAudioFileName] = useState(null);

  const [loading, setLoading] = useState({ text: false, image: false, audio: false });

  async function runRequest({ url, init, setResult, loadingKey }) {
    setLoading((l) => ({ ...l, [loadingKey]: true }));
    setResult(null);
    const started = Date.now();
    try {
      const res = await fetch(url, init);
      const ms = Date.now() - started;
      let json;
      try {
        json = await res.json();
      } catch {
        json = { error: "Response was not valid JSON." };
      }
      setResult({ status: res.status, ms, body: json });
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setLoading((l) => ({ ...l, [loadingKey]: false }));
    }
  }

  function testText() {
    runRequest({
      url: "/api/v1/chat",
      init: {
        method: "POST",
        headers: { Authorization: `Bearer ${textKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
      },
      setResult: setTextResult,
      loadingKey: "text",
    });
  }

  function testImage() {
    runRequest({
      url: "/api/v1/image",
      init: {
        method: "POST",
        headers: { Authorization: `Bearer ${imageKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: imgPrompt }),
      },
      setResult: setImageResult,
      loadingKey: "image",
    });
  }

  function testAudioAuthOnly() {
    setAudioFileName(null);
    runRequest({
      url: "/api/v1/audio",
      init: {
        method: "POST",
        headers: { Authorization: `Bearer ${audioKey}`, "Content-Type": "audio/wav" },
        body: new Uint8Array([0, 0, 0, 0]),
      },
      setResult: setAudioResult,
      loadingKey: "audio",
    });
  }

  async function testAudioFile(file) {
    if (!file) return;
    setAudioFileName(file.name);
    const arrayBuffer = await file.arrayBuffer();
    runRequest({
      url: "/api/v1/audio",
      init: {
        method: "POST",
        headers: { Authorization: `Bearer ${audioKey}`, "Content-Type": file.type || "audio/wav" },
        body: arrayBuffer,
      },
      setResult: setAudioResult,
      loadingKey: "audio",
    });
  }

  const allKeysGiven = textKey && imageKey && audioKey;

  return (
    <main className="page">
      <h1>Gateway MVP Test</h1>
      <p className="muted">
        Apni teeno master keys yahan paste karo — sirf is browser tab me rehti hain (session khatam hote hi clear ho
        jaati hain), server pe kahin save nahi hoti. Har endpoint independently test ho sakta hai.
      </p>

      {!allKeysGiven && (
        <div className="result-box" style={{ background: "rgba(250, 204, 21, 0.08)", borderColor: "#5c5324", marginBottom: 18 }}>
          ⚠️ Teeno keys daalne ke baad hi puri tarah test ho payega. Admin panel se{" "}
          <code className="inline-code">Generate Missing Master Keys</code> se mil jaayengi.
        </div>
      )}

      {/* TEXT */}
      <section className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>1. Text</h2>
          <code className="inline-code">/api/v1/chat</code>
        </div>
        <div className="field-label" style={{ marginTop: 14 }}>Master Key (Text)</div>
        <input
          placeholder="MASTER_KEY_TEXT paste karo"
          value={textKey}
          onChange={(e) => setTextKey(e.target.value)}
          className="input"
          type="password"
        />
        <div className="field-label">Prompt</div>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} className="input" />
        <button onClick={testText} disabled={!textKey || loading.text} className="btn">
          {loading.text ? (
            <>
              <span className="spinner" /> Testing...
            </>
          ) : (
            "Test Text"
          )}
        </button>
        {textResult && <Result r={textResult} />}
      </section>

      {/* IMAGE */}
      <section className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>2. Image</h2>
          <code className="inline-code">/api/v1/image</code>
        </div>
        <div className="field-label" style={{ marginTop: 14 }}>Master Key (Image)</div>
        <input
          placeholder="MASTER_KEY_IMAGE paste karo"
          value={imageKey}
          onChange={(e) => setImageKey(e.target.value)}
          className="input"
          type="password"
        />
        <div className="field-label">Prompt</div>
        <input value={imgPrompt} onChange={(e) => setImgPrompt(e.target.value)} className="input" />
        <button onClick={testImage} disabled={!imageKey || loading.image} className="btn">
          {loading.image ? (
            <>
              <span className="spinner" /> Generating (can take up to ~30s)...
            </>
          ) : (
            "Test Image"
          )}
        </button>
        {imageResult && <Result r={imageResult} />}
        {imageResult?.body?.imageBase64 && (
          <img
            src={`data:${imageResult.body.contentType};base64,${imageResult.body.imageBase64}`}
            alt="generated"
            style={{ maxWidth: "100%", marginTop: 10, borderRadius: 8, border: "1px solid var(--border)" }}
          />
        )}
      </section>

      {/* AUDIO */}
      <section className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>3. Audio</h2>
          <code className="inline-code">/api/v1/audio</code>
        </div>
        <p className="card-hint" style={{ marginTop: 14 }}>
          Asli audio file upload karo real transcription test karne ke liye, ya bina file ke sirf auth/reachability
          check karo (dummy bytes bhejta hai — 401 nahi aana chahiye, ek decode/format error aana expected hai).
        </p>
        <div className="field-label">Master Key (Audio)</div>
        <input
          placeholder="MASTER_KEY_AUDIO paste karo"
          value={audioKey}
          onChange={(e) => setAudioKey(e.target.value)}
          className="input"
          type="password"
        />
        <div className="field-row two-col">
          <input
            type="file"
            accept="audio/*"
            onChange={(e) => testAudioFile(e.target.files?.[0])}
            disabled={!audioKey || loading.audio}
            className="input"
            style={{ padding: 8 }}
          />
          <button onClick={testAudioAuthOnly} disabled={!audioKey || loading.audio} className="btn btn-ghost">
            {loading.audio ? "Testing..." : "Auth-Only Check"}
          </button>
        </div>
        {audioFileName && <p className="muted" style={{ fontSize: 12, marginTop: -4 }}>File: {audioFileName}</p>}
        {audioResult && <Result r={audioResult} />}
      </section>
    </main>
  );
}

function Result({ r }) {
  const ok = r.status >= 200 && r.status < 300;
  return (
    <div className={`result-box ${r.error ? "result-fail" : ok ? "result-ok" : "result-fail"}`}>
      {r.error ? (
        <div>❌ Network error: {r.error}</div>
      ) : (
        <>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>
              {ok ? "✅" : "❌"} Status: {r.status}
            </span>
            <span className="muted">{r.ms}ms</span>
          </div>
          {!ok && r.body?.error && (
            <p style={{ color: "var(--danger)", fontWeight: 600, margin: "8px 0 0" }}>{String(r.body.error)}</p>
          )}
          {!ok && Array.isArray(r.body?.attempts) && r.body.attempts.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="field-label" style={{ marginBottom: 4 }}>
                Attempts ({r.body.attempts.length})
              </div>
              <div className="table-wrap">
                <table className="data-table" style={{ minWidth: 320 }}>
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Status/Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.body.attempts.map((a, i) => (
                      <tr key={i}>
                        <td>{a.provider}</td>
                        <td>{a.status ?? a.error ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: "pointer", fontSize: 12, opacity: 0.7 }}>Raw response</summary>
            <pre>{JSON.stringify(r.body, null, 2)}</pre>
          </details>
        </>
      )}
    </div>
  );
}
