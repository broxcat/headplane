import { eq } from "drizzle-orm";

import { guestVpnAccess } from "~/server/db/schema";
import type { GuestVpnResult } from "~/server/guest-vpn";
import type { ResourceInput } from "~/utils/guest-resources";

import type { TestApp } from "./app";
import { guestMessages, mailCode, mailToken } from "./guest-mail";

export function requireVpnResult<T>(result: GuestVpnResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
export async function invited(app: TestApp, resource: ResourceInput[], email: string) {
  const created = app.ctx.guests.create({ email, duration: "43200" }, null, resource);
  if (!created.ok) throw new Error(created.error.message);
  const id = created.value.id;
  requireVpnResult(await app.ctx.invitations.send(id, 1, 24, null));
  const session = requireVpnResult(
    app.ctx.invitations.exchange(mailToken(await guestMessages(app.ctx.config.server.data_path))),
  );
  requireVpnResult(await app.ctx.invitations.sendCode(session));
  requireVpnResult(
    app.ctx.invitations.accept(
      session,
      mailCode(await guestMessages(app.ctx.config.server.data_path)),
    ),
  );
  return {
    id,
    portal: app.ctx.guestVpn.enabled
      ? requireVpnResult(app.ctx.guestVpn.openSession(session))
      : null,
    revision: requireVpnResult(app.ctx.guests.get(id)).revision,
  };
}
export function vpnState(app: TestApp, id: string) {
  return app.ctx.db.select().from(guestVpnAccess).where(eq(guestVpnAccess.guest_id, id)).get()!;
}
