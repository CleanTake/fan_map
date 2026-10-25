import nextEnv from "@next/env";
import { getAuthStore } from "../lib/auth/database.ts";
import { hashPassword } from "../lib/auth/password.ts";

nextEnv.loadEnvConfig(process.cwd(), true);

const username = process.argv[2];
const password = process.env.FANMAP_ADMIN_PASSWORD;
if (process.env.NODE_ENV === "production") {
  console.error("This command is for local development only.");
  process.exitCode = 1;
} else if (!username || process.argv.length !== 3 || !password || password.length > 128) {
  console.error("Set FANMAP_ADMIN_PASSWORD, then run npm run auth:local-admin -- username");
  process.exitCode = 1;
} else {
  const store = getAuthStore();
  try {
    const user = store.setLocalAdmin(username, await hashPassword(password));
    console.log(`Local administrator ${user.username} is ready. Sign in at /sign-in.`);
  } finally {
    store.close();
  }
}
