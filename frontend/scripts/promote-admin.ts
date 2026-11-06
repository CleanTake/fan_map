import nextEnv from "@next/env";
import { getAuthStore, normalizeEmail } from "../lib/auth/database.ts";

nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

const email = process.argv[2];
if (!email || process.argv.length !== 3) {
  console.error("Usage: npm run auth:admin -- existing-account@example.com");
  process.exitCode = 1;
} else {
  const store = getAuthStore();
  try {
    if (!store.promoteAdmin(email)) {
      console.error("No account found. Create the account through /sign-up first.");
      process.exitCode = 1;
    } else {
      console.log(`Admin access granted to ${normalizeEmail(email)}.`);
    }
  } finally {
    store.close();
  }
}
