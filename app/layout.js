export const metadata = {
  title: "Personal AI Gateway",
  description: "Admin panel for your personal AI gateway",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" style={{ background: "#0b0e14" }}>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          fontFamily: "system-ui, -apple-system, sans-serif",
          background: "#0b0e14",
          color: "#e6e8eb",
        }}
      >
        <nav
          style={{
            position: "sticky",
            top: 0,
            zIndex: 100,
            display: "flex",
            gap: 16,
            padding: "12px 20px",
            background: "#141922",
            borderBottom: "1px solid #232b38",
          }}
        >
          <a href="/" style={navLinkStyle}>
            🏠 Home
          </a>
          <a href="/admin" style={navLinkStyle}>
            ⚙️ Admin
          </a>
          <a href="/test" style={navLinkStyle}>
            🧪 Test
          </a>
        </nav>
        {children}
      </body>
    </html>
  );
}

const navLinkStyle = {
  color: "#7dd3fc",
  textDecoration: "none",
  fontSize: 14,
  fontWeight: 500,
};
