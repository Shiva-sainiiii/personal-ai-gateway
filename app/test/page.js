"use client";

import { useState, useEffect } from "react";
import { copyText, downloadText, timestampForFilename } from "../../lib/clientExport.js";

// Keys are cached in localStorage — persists across tabs and browser
// restarts on this device (unlike sessionStorage, which cleared on every
// tab close and meant re-pasting all 3 master keys every single test
// session). Still device-local only, never sent anywhere except this
// gateway's own API — same trust boundary as before, just longer-lived.
// A "Clear saved keys" button (below) lets you wipe them from this browser
// on demand, e.g. before using a shared/public device.
const STORAGE_KEYS = { text: "aigateway_test_textKey", image: "aigateway_test_imageKey", audio: "aigateway_test_audioKey" };

function useStoredKey(storageKey) {
  const [value, setValue] = useState("");
  useEffect(() => {
    const cached = localStorage.getItem(storageKey);
    if (cached) setValue(cached);
  }, [storageKey]);
  function update(next) {
    setValue(next);
    if (next) localStorage.setItem(storageKey, next);
    else localStorage.removeItem(storageKey);
  }
  return [value, update];
}

// Turns a File into { base64, mimeType } for vision requests.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      resolve({ base64, mimeType: file.type || "application/octet-stream" });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function TestPage() {
  const [textKey, setTextKey] = useStoredKey(STORAGE_KEYS.text);
  const [imageKey, setImageKey] = useStoredKey(STORAGE_KEYS.image);
  const [audioKey, setAudioKey] = useStoredKey(STORAGE_KEYS.audio);

  const [prompt, setPrompt] = useState("Hello! Reply with one short sentence.");
  const [imgGenPrompt, setImgGenPrompt] = useState("a cute cat riding a bicycle");
  const [visionPrompt, setVisionPrompt] = useState("What is in this image?");
  const [visionFile, setVisionFile] = useState(null);
  const [visionPreviewUrl, setVisionPreviewUrl] = useState(null);

  const [textResult, setTextResult] = useState(null);
  const [imageGenResult, setImageGenResult] = useState(null);
  const [visionResult, setVisionResult] = useState(null);
  const [audioResult, setAudioResult] = useState(null);
  const [audioFileName, setAudioFileName] = useState(null);
  const [streamText, setStreamText] = useState("");
  const [streamMeta, setStreamMeta] = useState(null);
  const streamAbortRef = useState({ current: null })[0];

  const [loading, setLoading] = useState({ text: false, imageGen: false, vision: false, audio: false, stream: false });

  // --- Manual provider/model picker -----------------------------------
  // Off by default (normal auto-routed test). When on for a given section,
  // that section's test hits /api/v1/test with an explicit provider+model
  // instead of the usual auto-routed endpoint, and the result is saved to
  // the admin Test History automatically once it completes.
  const [modelCatalog, setModelCatalog] = useState(null); // { modelsByProvider, providerKinds } | null while loading
  const [manual, setManual] = useState({
    text: { on: false, provider: "", model: "" },
    imageGen: { on: false, provider: "", model: "" },
    audio: { on: false, provider: "", model: "" },
  });

  // Loads the provider/model catalog once any key is available — needs
  // *a* master key (any one) to authenticate, see /api/admin/models's auth
  // note for why a master key is accepted there alongside the admin password.
  useEffect(() => {
    const anyKey = textKey || imageKey || audioKey;
    if (!anyKey || modelCatalog) return;
    fetch("/api/admin/models", { headers: { Authorization: `Bearer ${anyKey}` } })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => json && setModelCatalog(json))
      .catch(() => {});
  }, [textKey, imageKey, audioKey, modelCatalog]);

  function setManualSection(section, patch) {
    setManual((m) => ({ ...m, [section]: { ...m[section], ...patch } }));
  }

  // Saves a completed manual test to the admin Test History collection.
  // Fire-and-forget — a failed save shouldn't block or alter the test
  // result already shown on screen.
  function saveToHistory({ testType, provider, model, ok, status, latencyMs, input, output, errorMessage, attempts }) {
    const anyKey = textKey || imageKey || audioKey;
    if (!anyKey) return;
    fetch("/api/admin/test-history", {
      method: "POST",
      headers: { Authorization: `Bearer ${anyKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ testType, provider, model, ok, status, latencyMs, input, output, errorMessage, attempts }),
    }).catch(() => {});
  }

  async function runRequest({ url, init, setResult, loadingKey, history }) {
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
      if (history) {
        const ok = res.status >= 200 && res.status < 300;
        saveToHistory({
          ...history,
          ok,
          status: res.status,
          latencyMs: ms,
          output: ok ? json.text || (json.imageBase64 ? "[image generated]" : JSON.stringify(json).slice(0, 500)) : null,
          errorMessage: !ok ? json.error || "Unknown error" : null,
          attempts: json.attempts,
        });
      }
    } catch (err) {
      setResult({ error: err.message });
      if (history) {
        saveToHistory({ ...history, ok: false, status: null, latencyMs: Date.now() - started, errorMessage: err.message });
      }
    } finally {
      setLoading((l) => ({ ...l, [loadingKey]: false }));
    }
  }

  function testText() {
    const m = manual.text;
    if (m.on && m.provider && m.model) {
      return runRequest({
        url: "/api/v1/test",
        init: {
          method: "POST",
          headers: { Authorization: `Bearer ${textKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ type: "text", provider: m.provider, model: m.model, messages: [{ role: "user", content: prompt }] }),
        },
        setResult: setTextResult,
        loadingKey: "text",
        history: { testType: "text", provider: m.provider, model: m.model, input: prompt },
      });
    }
    return runRequest({
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

  async function testStream() {
    setLoading((l) => ({ ...l, stream: true }));
    setStreamText("");
    setStreamMeta(null);
    const controller = new AbortController();
    streamAbortRef.current = controller;
    const started = Date.now();

    try {
      const res = await fetch("/api/v1/chat/stream", {
        method: "POST",
        headers: { Authorization: `Bearer ${textKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({ error: "Stream request failed." }));
        setStreamMeta({ status: res.status, error: json.error, attempts: json.attempts });
        setLoading((l) => ({ ...l, stream: false }));
        return;
      }

      let firstTokenMs = null;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const json = JSON.parse(trimmed.slice(5).trim());
          if (json.delta) {
            if (firstTokenMs === null) firstTokenMs = Date.now() - started;
            setStreamText((t) => t + json.delta);
          }
          if (json.done) {
            setStreamMeta({ status: 200, totalMs: Date.now() - started, firstTokenMs });
          }
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        setStreamMeta({ error: err.message });
      }
    } finally {
      setLoading((l) => ({ ...l, stream: false }));
    }
  }

  function stopStream() {
    streamAbortRef.current?.abort();
  }

  function testImageGeneration() {
    const m = manual.imageGen;
    if (m.on && m.provider && m.model) {
      return runRequest({
        url: "/api/v1/test",
        init: {
          method: "POST",
          headers: { Authorization: `Bearer ${imageKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ type: "image", provider: m.provider, model: m.model, prompt: imgGenPrompt }),
        },
        setResult: setImageGenResult,
        loadingKey: "imageGen",
        history: { testType: "image", provider: m.provider, model: m.model, input: imgGenPrompt },
      });
    }
    return runRequest({
      url: "/api/v1/image",
      init: {
        method: "POST",
        headers: { Authorization: `Bearer ${imageKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: imgGenPrompt }),
      },
      setResult: setImageGenResult,
      loadingKey: "imageGen",
    });
  }

  async function onVisionFileChange(file) {
    setVisionFile(file || null);
    if (visionPreviewUrl) URL.revokeObjectURL(visionPreviewUrl);
    setVisionPreviewUrl(file ? URL.createObjectURL(file) : null);
  }

  // Revoke the object URL on unmount too, not just on next-file-change —
  // otherwise navigating away from this page while a preview is showing
  // leaks the blob for the remainder of the session.
  useEffect(() => {
    return () => {
      if (visionPreviewUrl) URL.revokeObjectURL(visionPreviewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visionPreviewUrl]);

  async function testVision() {
    if (!visionFile) return;
    const { base64, mimeType } = await fileToBase64(visionFile);
    runRequest({
      url: "/api/v1/chat",
      init: {
        method: "POST",
        headers: { Authorization: `Bearer ${textKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: visionPrompt }],
          imageBase64: base64,
          imageMimeType: mimeType,
        }),
      },
      setResult: setVisionResult,
      loadingKey: "vision",
    });
  }

  const [runningAll, setRunningAll] = useState(false);

  // Runs every test that doesn't need a manually-picked file (Vision and
  // Audio-file transcription are excluded since there's no file to pick
  // automatically). Sequential rather than parallel so results land one at
  // a time and are easy to read as they complete, and so the "Run All"
  // spinner reflects genuine overall progress rather than a burst of
  // simultaneous requests hitting the same keys at once.
  async function runAllTests() {
    setRunningAll(true);
    try {
      if (textKey) await testText();
      if (textKey) await testStream();
      if (imageKey) await testImageGeneration();
      if (audioKey) await testAudioAuthOnly();
    } finally {
      setRunningAll(false);
    }
  }

  function testAudioAuthOnly() {
    setAudioFileName(null);
    const m = manual.audio;
    if (m.on && m.provider && m.model) {
      return runRequest({
        url: `/api/v1/test?type=audio&provider=${encodeURIComponent(m.provider)}&model=${encodeURIComponent(m.model)}`,
        init: {
          method: "POST",
          headers: { Authorization: `Bearer ${audioKey}`, "Content-Type": "audio/wav" },
          body: new Uint8Array([0, 0, 0, 0]),
        },
        setResult: setAudioResult,
        loadingKey: "audio",
        history: { testType: "audio", provider: m.provider, model: m.model, input: "[auth-only dummy bytes]" },
      });
    }
    return runRequest({
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
    const m = manual.audio;
    if (m.on && m.provider && m.model) {
      return runRequest({
        url: `/api/v1/test?type=audio&provider=${encodeURIComponent(m.provider)}&model=${encodeURIComponent(m.model)}`,
        init: {
          method: "POST",
          headers: { Authorization: `Bearer ${audioKey}`, "Content-Type": file.type || "audio/wav" },
          body: arrayBuffer,
        },
        setResult: setAudioResult,
        loadingKey: "audio",
        history: { testType: "audio", provider: m.provider, model: m.model, input: `[file: ${file.name}]` },
      });
    }
    return runRequest({
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

  function clearSavedKeys() {
    if (!confirm("Saare saved master keys is browser se hata dein? Dobara paste karni padengi.")) return;
    setTextKey("");
    setImageKey("");
    setAudioKey("");
  }

  return (
    <main className="page">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>Gateway MVP Test</h1>
          <p className="muted" style={{ margin: 0 }}>
            Apni teeno master keys ek baar yahan paste karo — is browser me saved rehti hain (localStorage — tab band
            karne ya restart karne pe bhi yaad rahengi), server pe kahin save nahi hoti. Har endpoint independently
            test ho sakta hai.
          </p>
        </div>
        {allKeysGiven && (
          <button onClick={clearSavedKeys} className="btn btn-ghost btn-sm" style={{ whiteSpace: "nowrap" }}>
            Clear Saved Keys
          </button>
        )}
      </div>

      {!allKeysGiven && (
        <div className="result-box" style={{ background: "rgba(250, 204, 21, 0.08)", borderColor: "#5c5324", marginBottom: 18, marginTop: 14 }}>
          ⚠️ Teeno keys daalne ke baad hi puri tarah test ho payega (ek baar daalne ke baad dobara nahi maangega — is
          browser me save ho jaayengi). Admin panel se <code className="inline-code">Generate Missing Master Keys</code>{" "}
          se mil jaayengi.
        </div>
      )}

      <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <strong>Run All Tests</strong>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Text, Stream, aur Image Generation ek ke baad ek chalayega (jinki key di hai). Vision aur
            Audio-file test alag se chalane honge kyunki unme manually file choose karni padti hai.
          </p>
        </div>
        <button onClick={runAllTests} disabled={runningAll || (!textKey && !imageKey && !audioKey)} className="btn">
          {runningAll ? (
            <>
              <span className="spinner" /> Running...
            </>
          ) : (
            "▶ Run All"
          )}
        </button>
      </div>

      {/* TEXT */}
      <section className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>1. Text</h2>
          <code className="inline-code">{manual.text.on ? "/api/v1/test" : "/api/v1/chat"}</code>
        </div>
        <div className="field-label" style={{ marginTop: 14 }}>Master Key (Text)</div>
        <input
          placeholder="MASTER_KEY_TEXT paste karo"
          value={textKey}
          onChange={(e) => setTextKey(e.target.value)}
          className="input"
          type="password"
        />
        <ManualPicker section="text" testKind="text" manual={manual} setManualSection={setManualSection} modelCatalog={modelCatalog} />
        <div className="field-label">Prompt</div>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} className="input" />
        <button
          onClick={testText}
          disabled={!textKey || loading.text || (manual.text.on && (!manual.text.provider || !manual.text.model))}
          className="btn"
        >
          {loading.text ? (
            <>
              <span className="spinner" /> Testing...
            </>
          ) : (
            "Test Text"
          )}
        </button>
        {textResult && <Result r={textResult} filePrefix="text" />}
      </section>

      {/* STREAMING */}
      <section className="card">
        <h2 style={{ marginTop: 0 }}>1b. Real Streaming (/api/v1/chat/stream)</h2>
        <p className="hint">
          Same prompt (upar wale se), lekin real token-by-token streaming — text turant type hote
          hue dikhega, poora response wait nahi karna padega.
        </p>
        <div className="row">
          <button onClick={testStream} disabled={!textKey || loading.stream} className="btn">
            {loading.stream ? (
              <>
                <span className="spinner" /> Streaming...
              </>
            ) : (
              "Test Stream"
            )}
          </button>
          {loading.stream && (
            <button onClick={stopStream} className="btn btn-danger">
              Stop
            </button>
          )}
        </div>
        {(streamText || streamMeta) && (
          <div className="result-box result-ok" style={{ marginTop: 10 }}>
            {streamMeta?.firstTokenMs != null && (
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
                First token: {streamMeta.firstTokenMs}ms · Total: {streamMeta.totalMs}ms
              </div>
            )}
            {streamMeta?.error && <div style={{ color: "#f87171" }}>Error: {streamMeta.error}</div>}
            <div style={{ whiteSpace: "pre-wrap" }}>{streamText}</div>
          </div>
        )}
      </section>

      {/* IMAGE GENERATION */}
      <section className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>2. Image Generation</h2>
          <code className="inline-code">{manual.imageGen.on ? "/api/v1/test" : "/api/v1/image"}</code>
        </div>
        <p className="card-hint" style={{ marginTop: 14 }}>
          Text se image banwata hai (Pollinations primary, Cloudflare fallback). Google AI Studio ab is pool me
          nahi hai — free-tier Google keys ka generation quota hamesha 0 nikla (logs se confirm), so wo sirf har
          request ko dead attempt ke saath slow karta tha. Google Vision ke liye niche "Image Vision" section use karo.
        </p>
        <div className="field-label">Master Key (Image)</div>
        <input
          placeholder="MASTER_KEY_IMAGE paste karo"
          value={imageKey}
          onChange={(e) => setImageKey(e.target.value)}
          className="input"
          type="password"
        />
        <ManualPicker section="imageGen" testKind="image" manual={manual} setManualSection={setManualSection} modelCatalog={modelCatalog} />
        <div className="field-label">Prompt</div>
        <input value={imgGenPrompt} onChange={(e) => setImgGenPrompt(e.target.value)} className="input" />
        <button
          onClick={testImageGeneration}
          disabled={!imageKey || loading.imageGen || (manual.imageGen.on && (!manual.imageGen.provider || !manual.imageGen.model))}
          className="btn"
        >
          {loading.imageGen ? (
            <>
              <span className="spinner" /> Generating (can take up to ~30s)...
            </>
          ) : (
            "Test Image Generation"
          )}
        </button>
        {imageGenResult && <Result r={imageGenResult} filePrefix="image-generation" />}
        {imageGenResult?.body?.imageBase64 && (
          <img
            src={`data:${imageGenResult.body.contentType};base64,${imageGenResult.body.imageBase64}`}
            alt="generated"
            style={{ maxWidth: "100%", marginTop: 10, borderRadius: 8, border: "1px solid var(--border)" }}
          />
        )}
      </section>

      {/* IMAGE VISION */}
      <section className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>3. Image Vision</h2>
          <code className="inline-code">/api/v1/chat (imageBase64)</code>
        </div>
        <p className="card-hint" style={{ marginTop: 14 }}>
          Image upload karo, model use dekh kar text me jawab dega (Google AI Studio Gemini vision). Ye Text master
          key use karta hai, Image key nahi — kyunki backend me ye chat/vision pipeline se hi jaata hai.
        </p>
        <div className="field-label">Master Key (Text)</div>
        <input
          placeholder="MASTER_KEY_TEXT paste karo"
          value={textKey}
          onChange={(e) => setTextKey(e.target.value)}
          className="input"
          type="password"
        />
        <div className="field-label">Image</div>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => onVisionFileChange(e.target.files?.[0])}
          disabled={!textKey || loading.vision}
          className="input"
          style={{ padding: 8 }}
        />
        {visionPreviewUrl && (
          <img
            src={visionPreviewUrl}
            alt="preview"
            style={{ maxWidth: 160, marginTop: 8, borderRadius: 8, border: "1px solid var(--border)", display: "block" }}
          />
        )}
        <div className="field-label">Prompt</div>
        <input value={visionPrompt} onChange={(e) => setVisionPrompt(e.target.value)} className="input" />
        <button onClick={testVision} disabled={!textKey || !visionFile || loading.vision} className="btn">
          {loading.vision ? (
            <>
              <span className="spinner" /> Analyzing...
            </>
          ) : (
            "Test Image Vision"
          )}
        </button>
        {visionResult && <Result r={visionResult} filePrefix="image-vision" />}
      </section>

      {/* AUDIO */}
      <section className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>4. Audio (Listen / Transcription)</h2>
          <code className="inline-code">{manual.audio.on ? "/api/v1/test" : "/api/v1/audio"}</code>
        </div>
        <p className="card-hint" style={{ marginTop: 14 }}>
          Abhi gateway sirf audio-to-text (transcription/"listen") support karta hai — Cloudflare Whisper primary,
          Google AI Studio Gemini fallback. Text-to-speech/audio generation ka backend abhi banaya nahi hai, isliye
          yahan alag category nahi dikha raha — jab banega tab yeh section split ho jaayega.
        </p>
        <p className="card-hint">
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
        <ManualPicker
          section="audio"
          testKind="audio"
          manual={manual}
          setManualSection={setManualSection}
          modelCatalog={modelCatalog}
          providerFilter={(p) => p === "cloudflare" || p === "googleAiStudio"}
        />
        <div className="field-row two-col">
          <input
            type="file"
            accept="audio/*"
            onChange={(e) => testAudioFile(e.target.files?.[0])}
            disabled={!audioKey || loading.audio || (manual.audio.on && (!manual.audio.provider || !manual.audio.model))}
            className="input"
            style={{ padding: 8 }}
          />
          <button
            onClick={testAudioAuthOnly}
            disabled={!audioKey || loading.audio || (manual.audio.on && (!manual.audio.provider || !manual.audio.model))}
            className="btn btn-ghost"
          >
            {loading.audio ? "Testing..." : "Auth-Only Check"}
          </button>
        </div>
        {audioFileName && <p className="muted" style={{ fontSize: 12, marginTop: -4 }}>File: {audioFileName}</p>}
        {audioResult && <Result r={audioResult} filePrefix="audio-listen" />}
      </section>
    </main>
  );
}

// Manual provider/model picker — toggled per-section. When on, the parent
// section's test button hits /api/v1/test with the chosen provider+model
// instead of the normal auto-routed endpoint, and the result is saved to
// the admin Test History automatically (see saveToHistory in TestPage).
//
// `testKind` filters which providers make sense for this section: "image"
// only shows providers with a `kind` of "image" or "mixed", "text" only
// shows "text"/"mixed", and audio callers pass an explicit providerFilter
// since only cloudflare + googleAiStudio support transcription in this
// codebase today (not every "mixed" provider does).
function ManualPicker({ section, testKind, manual, setManualSection, modelCatalog, providerFilter }) {
  const state = manual[section];

  const providerOptions = modelCatalog
    ? Object.keys(modelCatalog.modelsByProvider)
        .filter((p) => {
          if (providerFilter) return providerFilter(p);
          const kind = modelCatalog.providerKinds[p];
          if (testKind === "image") return kind === "image" || kind === "mixed";
          if (testKind === "audio") return kind === "mixed";
          return kind === "text" || kind === "mixed";
        })
        .sort()
    : [];

  const modelOptions = modelCatalog && state.provider ? modelCatalog.modelsByProvider[state.provider] || [] : [];

  return (
    <div className="result-box" style={{ marginBottom: 12, background: "rgba(96, 165, 250, 0.06)", borderColor: "#1e3a5c" }}>
      <label className="row" style={{ gap: 8, alignItems: "center", cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={state.on}
          onChange={(e) => setManualSection(section, { on: e.target.checked })}
        />
        <strong style={{ fontSize: 13 }}>Manual provider/model select karo</strong>
      </label>
      {state.on && (
        <div className="field-row two-col" style={{ marginTop: 10 }}>
          <div>
            <div className="field-label" style={{ marginTop: 0 }}>Provider</div>
            {modelCatalog ? (
              <select
                value={state.provider}
                onChange={(e) => setManualSection(section, { provider: e.target.value, model: "" })}
                className="input"
              >
                <option value="">-- provider chuno --</option>
                {providerOptions.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            ) : (
              <p className="muted" style={{ fontSize: 12 }}>Master key daalo pehle, list load hogi...</p>
            )}
          </div>
          <div>
            <div className="field-label" style={{ marginTop: 0 }}>Model</div>
            <select
              value={state.model}
              onChange={(e) => setManualSection(section, { model: e.target.value })}
              className="input"
              disabled={!state.provider}
            >
              <option value="">-- model chuno --</option>
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

function Result({ r, filePrefix = "result" }) {
  const ok = r.status >= 200 && r.status < 300;
  const [copied, setCopied] = useState(false);

  const jsonText = JSON.stringify(r.error ? { error: r.error } : r.body, null, 2);

  async function handleCopy() {
    const success = await copyText(jsonText);
    setCopied(success);
    setTimeout(() => setCopied(false), 1500);
  }

  function handleDownload() {
    downloadText(`${filePrefix}-${r.status ?? "network-error"}-${timestampForFilename()}.json`, jsonText);
  }

  return (
    <div className={`result-box ${r.error ? "result-fail" : ok ? "result-ok" : "result-fail"}`}>
      {r.error ? (
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div>❌ Network error: {r.error}</div>
          <CopyDownloadButtons onCopy={handleCopy} onDownload={handleDownload} copied={copied} />
        </div>
      ) : (
        <>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <span>
              {ok ? "✅" : "❌"} Status: {r.status}
            </span>
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <span className="muted">{r.ms}ms</span>
              <CopyDownloadButtons onCopy={handleCopy} onDownload={handleDownload} copied={copied} />
            </div>
          </div>
          {!ok && r.body?.error && (
            <p style={{ color: "var(--danger)", fontWeight: 600, margin: "8px 0 0" }}>{String(r.body.error)}</p>
          )}
          {ok && (r.body?.pool || r.body?.model) && (
            // Routing transparency: shows which complexity tier this request was
            // classified as and which pool/model actually served it — makes the
            // complexity-based routing (SIMPLE vs TEXT vs TEXT_COMPLEX) visible
            // instead of a black box.
            <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              {r.body.complexity && <span className="badge badge-active">complexity: {r.body.complexity}</span>}
              {r.body.pool && <span className="badge badge-active">pool: {r.body.pool}</span>}
              {r.body.provider && <span className="badge badge-active">{r.body.provider}</span>}
              {r.body.model && (
                <span className="muted" style={{ fontSize: 12 }}>
                  {r.body.model}
                </span>
              )}
            </div>
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
          {ok && r.body?.text && (
            <p style={{ margin: "8px 0 0", whiteSpace: "pre-wrap" }}>{r.body.text}</p>
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

function CopyDownloadButtons({ onCopy, onDownload, copied }) {
  return (
    <div className="row" style={{ gap: 6 }}>
      <button onClick={onCopy} className="btn btn-ghost btn-sm" type="button">
        {copied ? "Copied!" : "Copy"}
      </button>
      <button onClick={onDownload} className="btn btn-ghost btn-sm" type="button">
        Download
      </button>
    </div>
  );
}
