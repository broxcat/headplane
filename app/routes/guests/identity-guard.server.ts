import type { GuestVpnService } from "~/server/guest-vpn";
import type { HeadscaleClient } from "~/server/headscale/api";
import { ActionError } from "~/server/web/actions";

export async function requireNonGuestUser(vpn: GuestVpnService, api: HeadscaleClient, id: string) {
  if (!vpn.reservesIdentities()) return;
  if (vpn.isManagedUser(id))
    throw new ActionError("Manage dedicated guest identities through Guest Details.", 409);
  // A create response can be lost before its numeric ID is linked in SQLite.
  // Resolve the reserved name too, rather than allowing a key/account bypass.
  const users = await api.users.list({ id });
  if (users.some((user) => vpn.isManagedUser(user.name)))
    throw new ActionError(
      "The reserved guest identity cannot be managed through this action.",
      409,
    );
}
