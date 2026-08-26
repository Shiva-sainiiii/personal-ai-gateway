export default function Home() {
  return (
    <main style={{ padding: 40, maxWidth: 640, margin: "0 auto" }}>
      <h1>Personal AI Gateway</h1>
      <p style={{ opacity: 0.8, lineHeight: 1.6 }}>
        This is the API backend for your personal AI gateway. Use the admin panel to
        manage provider keys and view stats.
      </p>
      <p>
        <a href="/admin" style={{ color: "#7dd3fc" }}>
          Go to Admin Panel →
        </a>
      </p>
      <hr style={{ borderColor: "#1f2733", margin: "24px 0" }} />
      <h3>API Endpoints</h3>
      <ul style={{ lineHeight: 2 }}>
        <li>
          <code>POST /api/v1/chat</code> — text (Bearer MASTER_KEY_TEXT)
        </li>
        <li>
          <code>POST /api/v1/image</code> — image (Bearer MASTER_KEY_IMAGE)
        </li>
        <li>
          <code>POST /api/v1/audio</code> — audio (Bearer MASTER_KEY_AUDIO)
        </li>
      </ul>
    </main>
  );
}
