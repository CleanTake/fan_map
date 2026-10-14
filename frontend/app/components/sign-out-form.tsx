"use client";

import Link from "next/link";
import { useState } from "react";

export function SignOutForm({ email }: { email: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function signOut() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Sign out failed");
      window.location.assign("/");
    } catch {
      setError("We couldn’t sign you out. Please try again.");
      setPending(false);
    }
  }

  return (
    <>
      <div className="auth-heading">
        <span className="auth-mark" aria-hidden="true">↗</span>
        <h1>Sign out of FanMap?</h1>
        <p>You’re signed in as <strong className="signed-in-email">{email}</strong></p>
      </div>
      <p className="sign-out-note">You can keep exploring the map as a guest.</p>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="auth-submit" type="button" onClick={signOut} disabled={pending}>{pending ? "Signing out…" : "Sign out"}<span aria-hidden="true">→</span></button>
      <Link href="/" className="auth-cancel">Stay signed in</Link>
    </>
  );
}
