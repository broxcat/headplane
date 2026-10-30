import { expect, test } from "vitest";

import { createGuestTailnet } from "../../support/guest-tailnet";
import { invited, requireVpnResult as value, vpnState } from "../../support/guest-vpn";

test("policy changes require a fresh administrator preview before preparation and device activation", async () => {
  await using tailnet = await createGuestTailnet({ policy: { grants: [] } });
  const resource = await tailnet.node({ name: "preview-resource", user: "preview-operator" });
  const app = await tailnet.headplane({
    config: {
      server: { base_url: "http://localhost:3099" },
      guest_invitations: { enabled: true, transport: "file" },
      guest_vpn: { enabled: true, single_policy_writer: true },
    },
  });
  const guest = await invited(
    app,
    [
      {
        kind: "node",
        node_id: resource.id,
        address: (await resource.machine()).ipAddresses[0],
        route: null,
        protocol: "tcp",
        ports: "8006",
      },
    ],
    "preview@example.test",
  );
  const preview = value(await app.ctx.guestVpn.preview(guest.id));
  const users = await tailnet.api.users.list();
  await tailnet.setPolicy({ grants: [], hosts: { approved: "100.64.0.15" } });
  expect(await app.ctx.guestVpn.provision(guest.id, guest.revision, null, preview)).toMatchObject({
    ok: false,
    error: { code: "preview_changed" },
  });
  expect(await tailnet.api.users.list()).toEqual(users);
  expect(vpnState(app, guest.id)).toBeUndefined();
  value(
    await app.ctx.guestVpn.provision(
      guest.id,
      guest.revision,
      null,
      value(await app.ctx.guestVpn.preview(guest.id)),
    ),
  );
  await tailnet.setPolicy({ grants: [], hosts: { approved: "100.64.0.16" } });
  const pending = await tailnet.pendingNode({ name: "preview-device" });
  const authId = pending.registerUrl.split("/register/")[1];
  expect(await app.ctx.guestVpn.register(guest.portal!, authId)).toMatchObject({
    ok: false,
    error: { code: "preview_changed" },
  });
  expect(
    (await tailnet.api.nodes.list()).filter(
      (n) => n.user?.id === vpnState(app, guest.id).headscale_user_id,
    ),
  ).toEqual([]);
  value(
    await app.ctx.guestVpn.provision(
      guest.id,
      guest.revision,
      null,
      value(await app.ctx.guestVpn.preview(guest.id)),
    ),
  );
  value(await app.ctx.guestVpn.register(guest.portal!, authId));
  const node = await pending.joined();
  expect((await node.machine()).user?.id).toBe(vpnState(app, guest.id).headscale_user_id);
  expect(vpnState(app, guest.id).state).toBe("active");
});
