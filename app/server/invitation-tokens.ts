import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const invitationToken = () => randomBytes(32).toString("base64url");
export const validInvitationToken = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const verificationCode = () => String(randomInt(100_000_000)).padStart(8, "0");
export const codeHash = (secret: string, session: string, code: string) =>
  createHmac("sha256", secret).update(`guest-code:${session}:${code}`).digest("hex");
export const invitationCsrf = (secret: string, session: string) =>
  createHmac("sha256", secret).update(`guest-csrf:${session}`).digest("hex");

export function equalHash(first: string, second: string) {
  if (!/^[a-f0-9]{64}$/.test(first) || !/^[a-f0-9]{64}$/.test(second)) return false;
  return timingSafeEqual(Buffer.from(first, "hex"), Buffer.from(second, "hex"));
}
