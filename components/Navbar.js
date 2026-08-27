"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Home", icon: "🏠" },
  { href: "/admin", label: "Admin", icon: "⚙️" },
  { href: "/test", label: "Test", icon: "🧪" },
];

export default function Navbar() {
  const pathname = usePathname();

  return (
    <nav className="navbar">
      <Link href="/" className="navbar-brand">
        <span>🌐</span>
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
      </div>
    </nav>
  );
}
