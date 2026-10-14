import Link from "next/link";
import type { ReactNode } from "react";

export function AuthShell({ children, showGuestLink = true }: { children: ReactNode; showGuestLink?: boolean }) {
  return (
    <div className="auth-shell">
      <header className="topbar auth-topbar">
        <Link className="brand-link" href="/" aria-label="FanMap campus map">
          <span className="eyebrow">FANSHAWE COLLEGE</span>
          <span className="brand-name">FanMap</span>
        </Link>
        <Link className="back-to-map" href="/">
          <span aria-hidden="true">←</span> Back to map
        </Link>
      </header>
      <main className="auth-main">
        <div className="auth-content">
          <div className="auth-card">{children}</div>
          {showGuestLink && <p className="guest-link">
            Just exploring? <Link href="/">Continue as a guest <span aria-hidden="true">→</span></Link>
          </p>}
        </div>
      </main>
      <footer className="auth-footer">Find your way around Fanshawe.</footer>
    </div>
  );
}
