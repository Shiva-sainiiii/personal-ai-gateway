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
        {children}
      </body>
    </html>
  );
}
