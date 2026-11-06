import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/server";
import { AuthShell } from "../components/auth-shell";
import { AuthForm } from "../components/auth-form";

export const metadata: Metadata = { title: "Sign in | FanMap" };

export default async function SignInPage() {
  if (await getCurrentUser()) redirect("/");
  return <AuthShell><AuthForm mode="login" /></AuthShell>;
}
