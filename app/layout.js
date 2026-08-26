export const metadata = {
  title: "Personal AI Gateway",
  description: "Admin panel for your personal AI gateway",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, sans-serif", background: "#0b0e14", color: "#e6e8eb" }}>
        {children}
      </body>
    </html>
  );
}
