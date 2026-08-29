"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const LINKS = [
  { href: "/", label: "Home", icon: "🏠" },
  { href: "/admin", label: "Admin", icon: "⚙️" },
  { href: "/test", label: "Test", icon: "🧪" },
];

const THEME_STORAGE_KEY = "aigateway_theme";

function useTheme() {
  const [theme, setTheme] = useState("dark");

  useEffect(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    const initial = stored === "light" || stored === "dark" ? stored : "dark";
    setTheme(initial);
    document.documentElement.setAttribute("data-theme", initial);
  }, []);

  function toggle() {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      localStorage.setItem(THEME_STORAGE_KEY, next);
      document.documentElement.setAttribute("data-theme", next);
      return next;
    });
  }

  return [theme, toggle];
}

export default function Navbar() {
  const pathname = usePathname();
  const [theme, toggleTheme] = useTheme();

  return (
    <nav className="navbar">
      <Link href="/" className="navbar-brand">
        <img
          src="/icon-32x32.png"
          alt="AI Gateway logo"
          width={22}
          height={22}
          style={{ borderRadius: 5, display: "block" }}
        />
        <span className="brand-text">AI Gateway</span>
      </Link>
      <div className="navbar-links">
        {LINKS.map((link) => {
          const isActive = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
          return (
            <Link key={link.href} href={link.href} className={`navbar-link${isActive ? " active" : ""}`}>
              <span>{link.icon}</span>
              <span className="link-text">{link.label}</span>
            </Link>
          );
        })}
        <button
          onClick={toggleTheme}
          className="navbar-link"
          type="button"
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          style={{ background: "none", border: "none", cursor: "pointer", font: "inherit" }}
        >
          <span>{theme === "dark" ? "☀️" : "🌙"}</span>
          <span className="link-text">{theme === "dark" ? "Light" : "Dark"}</span>
        </button>
      </div>
    </nav>
  );
}
