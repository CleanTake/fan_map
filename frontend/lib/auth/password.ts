import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const PARAMETERS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const PREFIX = "scrypt$v1$32768$8$3";
const KEY_BYTES = 32;

// Two scrypt jobs use about 64 MiB altogether. A busy server rejects excess
// work instead of building an unbounded queue of passwords in memory.
const shared = globalThis as typeof globalThis & { fanmapScryptJobs?: number };

export class PasswordWorkBusyError extends Error {
  constructor() {
    super("Sign in is busy. Please try again shortly.");
  }
}

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if ((shared.fanmapScryptJobs ?? 0) >= 2) throw new PasswordWorkBusyError();
  shared.fanmapScryptJobs = (shared.fanmapScryptJobs ?? 0) + 1;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, KEY_BYTES, PARAMETERS, (error, key) => {
        if (error) reject(error);
        else resolve(key);
      });
    });
  } finally {
    shared.fanmapScryptJobs -= 1;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `${PREFIX}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const match = /^scrypt\$v1\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(storedHash);
  if (!match) return false;
  const key = await derive(password, Buffer.from(match[1], "hex"));
  return timingSafeEqual(key, Buffer.from(match[2], "hex"));
}

// Unknown accounts still perform one full password check, so they do not take
// the visibly faster path. This is a valid encoded hash, not an account password.
export const DUMMY_PASSWORD_HASH = `${PREFIX}$${"00".repeat(16)}$${"00".repeat(KEY_BYTES)}`;
