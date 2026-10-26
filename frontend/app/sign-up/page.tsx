import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/server";
import { AuthShell } from "../components/auth-shell";
import { AuthForm } from "../components/auth-form";

export const metadata: Metadata = { title: "Create an account | FanMap" };

export default async function SignUpPage() {
  if (await getCurrentUser()) redirect("/");
  return <AuthShell><AuthForm mode="signup" /></AuthShell>;
}
