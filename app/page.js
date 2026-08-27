import Link from "next/link";

export default function Home() {
  return (
    <main className="page page-narrow">
      <h1>Personal AI Gateway</h1>
      <p className="muted" style={{ lineHeight: 1.6 }}>
        This is the API backend for your personal AI gateway. Use the admin panel to manage
        provider keys and view live stats, or the test page to sanity-check your master keys.
      </p>

      <div className="row" style={{ marginBottom: 24 }}>
        <Link href="/admin" className="btn">
          ⚙️ Open Admin Panel
        </Link>
        <Link href="/test" className="btn btn-ghost">
          🧪 Open Test Page
        </Link>
      </div>

      <section className="card">
        <h2>API Endpoints</h2>
        <div className="stack">
          <div>
            <code className="inline-code">POST /api/v1/chat</code>
            <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
              Text + vision — Bearer MASTER_KEY_TEXT
            </div>
          </div>
          <div>
            <code className="inline-code">POST /api/v1/chat/stream</code>
            <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
              Streaming text (SSE) — Bearer MASTER_KEY_TEXT
            </div>
          </div>
          <div>
            <code className="inline-code">POST /api/v1/image</code>
            <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
              Image generation — Bearer MASTER_KEY_IMAGE
            </div>
          </div>
          <div>
            <code className="inline-code">POST /api/v1/audio</code>
            <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
              Audio transcription — Bearer MASTER_KEY_AUDIO
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
