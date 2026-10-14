import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/server";
import { AuthShell } from "../components/auth-shell";
import { SignOutForm } from "../components/sign-out-form";

export const metadata: Metadata = { title: "Sign out | FanMap" };

export default async function SignOutPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  return <AuthShell showGuestLink={false}><SignOutForm email={user.email} /></AuthShell>;
}
