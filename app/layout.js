import "./globals.css";
import Navbar from "../components/Navbar.js";

export const metadata = {
  title: "Personal AI Gateway",
  description: "Personal AI Gateway — developed by Shiva Saini",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/icon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/icon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192x192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512x512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
    shortcut: "/favicon.ico",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        {/* Applies the saved theme before first paint, so switching pages or
            reloading doesn't flash dark-then-light (or vice versa) while
            Navbar's useEffect hasn't run yet. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("aigateway_theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <Navbar />
        {children}
        <footer
          style={{
            textAlign: "center",
            padding: "24px 16px",
            fontSize: 13,
            opacity: 0.55,
          }}
        >
          Developed by <strong>Shiva Saini</strong>
        </footer>
      </body>
    </html>
  );
}
