"use client";

import { useState } from "react";

export default function TestPage() {
  const [textKey, setTextKey] = useState("");
  const [imageKey, setImageKey] = useState("");
  const [audioKey, setAudioKey] = useState("");
  const [prompt, setPrompt] = useState("Hello! Reply with one short sentence.");
  const [imgPrompt, setImgPrompt] = useState("a cute cat riding a bicycle");

  const [textResult, setTextResult] = useState(null);
  const [imageResult, setImageResult] = useState(null);
  const [audioResult, setAudioResult] = useState(null);

  const [loading, setLoading] = useState({ text: false, image: false, audio: false });

  async function testText() {
    setLoading((l) => ({ ...l, text: true }));
    setTextResult(null);
    const started = Date.now();
    try {
      const res = await fetch("/api/v1/chat", {
        method: "POST",
        headers: { Authorization: `Bearer ${textKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
      });
      const json = await res.json();
      setTextResult({ status: res.status, ms: Date.now() - started, body: json });
    } catch (err) {
      setTextResult({ error: err.message });
    }
    setLoading((l) => ({ ...l, text: false }));
  }

  async function testImage() {
    setLoading((l) => ({ ...l, image: true }));
    setImageResult(null);
    const started = Date.now();
    try {
      const res = await fetch("/api/v1/image", {
        method: "POST",
        headers: { Authorization: `Bearer ${imageKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: imgPrompt }),
      });
      const json = await res.json();
      setImageResult({ status: res.status, ms: Date.now() - started, body: json });
    } catch (err) {
      setImageResult({ error: err.message });
    }
    setLoading((l) => ({ ...l, image: false }));
  }

  async function testAudioAuthOnly() {
    // Just checks the master key + endpoint reachability (no mic recording in this MVP) —
    // sends an empty-ish request so you can confirm auth works without needing a real audio file.
    setLoading((l) => ({ ...l, audio: true }));
    setAudioResult(null);
    const started = Date.now();
    try {
      const res = await fetch("/api/v1/audio", {
        method: "POST",
        headers: { Authorization: `Bearer ${audioKey}`, "Content-Type": "audio/wav" },
        body: new Uint8Array([0, 0, 0, 0]), // tiny dummy payload — expect a provider-side decode error, NOT a 401
      });
      const json = await res.json();
      setAudioResult({ status: res.status, ms: Date.now() - started, body: json });
    } catch (err) {
      setAudioResult({ error: err.message });
    }
    setLoading((l) => ({ ...l, audio: false }));
  }

  return (
    <main style={{ padding: 24, maxWidth: 720, margin: "0 auto", fontFamily: "system-ui, sans-serif" }}>
      <h1>Gateway MVP Test</h1>
      <p style={{ opacity: 0.7 }}>
        Apni master keys yahan paste karo aur check karo gateway live hai ya nahi. Keys sirf tere browser me
        rehti hain, kahin save nahi hoti.
      </p>

      {/* TEXT */}
      <section style={box}>
        <h2>1. Text (/api/v1/chat)</h2>
        <input
          placeholder="MASTER_KEY_TEXT paste karo"
          value={textKey}
          onChange={(e) => setTextKey(e.target.value)}
          style={input}
        />
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ ...input, height: 60 }} />
        <button onClick={testText} disabled={!textKey || loading.text} style={button}>
          {loading.text ? "Testing..." : "Test Text"}
        </button>
        {textResult && <Result r={textResult} />}
      </section>

      {/* IMAGE */}
      <section style={box}>
        <h2>2. Image (/api/v1/image)</h2>
        <input
          placeholder="MASTER_KEY_IMAGE paste karo"
          value={imageKey}
          onChange={(e) => setImageKey(e.target.value)}
          style={input}
        />
        <input value={imgPrompt} onChange={(e) => setImgPrompt(e.target.value)} style={input} />
        <button onClick={testImage} disabled={!imageKey || loading.image} style={button}>
          {loading.image ? "Testing..." : "Test Image"}
        </button>
        {imageResult && <Result r={imageResult} />}
        {imageResult?.body?.imageBase64 && (
          <img
            src={`data:${imageResult.body.contentType};base64,${imageResult.body.imageBase64}`}
            alt="generated"
            style={{ maxWidth: "100%", marginTop: 10, borderRadius: 8 }}
          />
        )}
      </section>

      {/* AUDIO */}
      <section style={box}>
        <h2>3. Audio (/api/v1/audio) — auth check only</h2>
        <p style={{ fontSize: 13, opacity: 0.7 }}>
          Ye sirf master key aur endpoint reachability check karta hai (dummy bytes bhejta hai) — real
          transcription ke liye asli audio file chahiye hoti hai.
        </p>
        <input
          placeholder="MASTER_KEY_AUDIO paste karo"
          value={audioKey}
          onChange={(e) => setAudioKey(e.target.value)}
          style={input}
        />
        <button onClick={testAudioAuthOnly} disabled={!audioKey || loading.audio} style={button}>
          {loading.audio ? "Testing..." : "Test Audio Auth"}
        </button>
        {audioResult && <Result r={audioResult} />}
      </section>
    </main>
  );
}

function Result({ r }) {
  const ok = r.status >= 200 && r.status < 300;
  return (
    <div
      style={{
        marginTop: 10,
        padding: 10,
        borderRadius: 8,
        background: r.error ? "#4c1d1d" : ok ? "#14532d" : "#4c1d1d",
        fontSize: 13,
      }}
    >
      {r.error ? (
        <div>❌ Network error: {r.error}</div>
      ) : (
        <>
          <div>
            {ok ? "✅" : "❌"} Status: {r.status} · {r.ms}ms
          </div>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 6, fontSize: 12 }}>{JSON.stringify(r.body, null, 2)}</pre>
        </>
      )}
    </div>
  );
}

const box = { position: "relative", zIndex: 1, isolation: "isolate", overflow: "hidden", border: "1px solid #ddd", borderRadius: 10, padding: 16, marginBottom: 16, background: "#fff" };
const input = { display: "block", width: "100%", padding: 10, marginBottom: 8, borderRadius: 6, border: "1px solid #ccc", boxSizing: "border-box" };
const button = { padding: "10px 16px", borderRadius: 6, border: "none", background: "#2563eb", color: "white", cursor: "pointer" };
