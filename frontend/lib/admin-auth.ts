import { timingSafeEqual } from "node:crypto";

export function isValidAdminKey(candidate: unknown) {
  const expected = process.env.ADMIN_API_KEY;
  if (typeof candidate !== "string" || !expected) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}
