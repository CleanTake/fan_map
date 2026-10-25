"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const isSignup = mode === "signup";
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error ?? "Please try again.");
        setPending(false);
        return;
      }
      // Reload the map so its account header reads the new server session.
      window.location.assign("/");
    } catch {
      setError("We couldn’t connect. Please try again.");
      setPending(false);
    }
  }

  return (
    <>
      <div className="auth-heading">
        <span className="auth-mark" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M18 10c0 4.5-6 10-6 10S6 14.5 6 10a6 6 0 1 1 12 0Z" stroke="currentColor" strokeWidth="1.7" />
            <circle cx="12" cy="10" r="2" stroke="currentColor" strokeWidth="1.7" />
          </svg>
        </span>
        <h1>{isSignup ? "Create your account" : "Welcome back"}</h1>
        <p>{isSignup ? "A little more connected to your campus." : "Sign in to your FanMap account."}</p>
      </div>
      <form className="auth-form" onSubmit={submit} aria-busy={pending}>
        <div className="auth-field">
          <label htmlFor="email">{isSignup ? "Email address" : "Email or username"}</label>
          <input id="email" name="email" type={isSignup ? "email" : "text"} autoComplete={isSignup ? "email" : "username"} placeholder={isSignup ? "you@example.com" : "Email address or username"} autoCapitalize="none" maxLength={254} required disabled={pending} />
        </div>
        <div className="auth-field">
          <label htmlFor="password">Password</label>
          <div className="password-field">
            <input id="password" name="password" type={showPassword ? "text" : "password"} autoComplete={isSignup ? "new-password" : "current-password"} minLength={isSignup ? 15 : undefined} maxLength={128} aria-describedby={isSignup ? "password-hint" : undefined} required disabled={pending} />
            <button type="button" className="password-toggle" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} disabled={pending}>{showPassword ? "Hide" : "Show"}</button>
          </div>
          {isSignup && <p className="field-hint" id="password-hint">Use 15–128 characters. A short phrase works well.</p>}
        </div>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="auth-submit" type="submit" disabled={pending}>{pending ? isSignup ? "Creating account…" : "Signing in…" : isSignup ? "Create account" : "Sign in"}<span aria-hidden="true">→</span></button>
      </form>
      {isSignup && <p className="auth-note">Save your favorite campus locations and find them again whenever you sign in.</p>}
      <p className="auth-switch">{isSignup ? "Already have an account?" : "New to FanMap?"} <Link href={isSignup ? "/sign-in" : "/sign-up"}>{isSignup ? "Sign in" : "Create an account"}</Link></p>
    </>
  );
}
