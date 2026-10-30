import { isNoExpiry } from "~/utils/node-info";

import type { Guest, GuestVpnAccess } from "./db/schema";
import { vpnAssert } from "./guest-vpn-policy";

export function deviceHasExpired(expiry: string | null | undefined, now = Date.now()): boolean {
  if (isNoExpiry(expiry)) return false;
  const time = Date.parse(expiry!);
  // Unknown/invalid dates and normalized Go zero-times are never confirmation
  // of revocation. A successful expire call returns a contemporary timestamp.
  return Number.isFinite(time) && time > 0 && time <= now;
}

export function accessDeadline(
  guest: Pick<Guest, "requested_duration_seconds" | "requested_expires_at">,
  activated: Date,
): Date {
  const end =
    guest.requested_expires_at ??
    new Date(activated.getTime() + (guest.requested_duration_seconds ?? 0) * 1000);
  vpnAssert(
    Number.isFinite(end.getTime()) && end.getTime() > activated.getTime(),
    "expired",
    "Access deadline has already passed.",
  );
  return end;
}
export function retryDeadline(attempt: number, now: number) {
  return new Date(now + Math.min(300_000, 1000 * 2 ** Math.min(attempt, 8)));
}
export function canTransition(from: GuestVpnAccess["state"], to: GuestVpnAccess["state"]) {
  if (from === to) return true;
  switch (from) {
    case "not_provisioned":
      return to === "provisioning";
    case "provisioning":
      return ["active", "error", "revoking"].includes(to);
    case "active":
      return ["error", "revoking"].includes(to);
    case "error":
      return ["provisioning", "revoking"].includes(to);
    case "revoking":
      return ["revoked", "expired"].includes(to);
    case "revoked":
    case "expired":
      return to === "revoking"; // a newly discovered orphan needs cleanup, never activation
  }
}
