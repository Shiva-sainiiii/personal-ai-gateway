"use client";

import { useState, useEffect } from "react";
import { copyText, downloadText, timestampForFilename } from "../../lib/clientExport.js";

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

  const [loading, setLoading] = useState({ text: false, imageGen: false, vision: false, audio: false });

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

  function testImageGeneration() {
    runRequest({
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
        {textResult && <Result r={textResult} filePrefix="text" />}
      </section>

      {/* IMAGE GENERATION */}
      <section className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>2. Image Generation</h2>
          <code className="inline-code">/api/v1/image</code>
        </div>
        <p className="card-hint" style={{ marginTop: 14 }}>
          Text se image banwata hai (Pollinations primary, Cloudflare fallback). Google AI Studio image model bhi
          secondary attempt ke roop me try hota hai, par free-tier Google keys aksar generation entitled nahi hoti —
          isliye niche alag se "Image Vision" section hai jahan Google reliably kaam karta hai.
        </p>
        <div className="field-label">Master Key (Image)</div>
        <input
          placeholder="MASTER_KEY_IMAGE paste karo"
          value={imageKey}
          onChange={(e) => setImageKey(e.target.value)}
          className="input"
          type="password"
        />
        <div className="field-label">Prompt</div>
        <input value={imgGenPrompt} onChange={(e) => setImgGenPrompt(e.target.value)} className="input" />
        <button onClick={testImageGeneration} disabled={!imageKey || loading.imageGen} className="btn">
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
          <code className="inline-code">/api/v1/audio</code>
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
        {audioResult && <Result r={audioResult} filePrefix="audio-listen" />}
      </section>
    </main>
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
