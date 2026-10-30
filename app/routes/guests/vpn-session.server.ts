import { createCookie } from "react-router";

import type { HeadplaneConfig } from "~/server/config/config-schema";
import { validInvitationToken } from "~/server/invitation-tokens";

export function vpnCookie(config: HeadplaneConfig) {
  return createCookie("_hp_guest_vpn", {
    secrets: [config.server.cookie_secret],
    httpOnly: true,
    sameSite: "strict",
    secure: config.server.cookie_secure,
    path: `${config.server.base_path}/`,
    maxAge: 24 * 3600,
  });
}
export async function readVpnSession(request: Request, config: HeadplaneConfig): Promise<string> {
  try {
    const value: unknown = await vpnCookie(config).parse(request.headers.get("cookie"));
    return typeof value === "string" && validInvitationToken(value) ? value : "";
  } catch {
    return "";
  }
}
