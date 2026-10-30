import { expect, test, vi } from "vitest";

import { createGuestVpnService } from "~/server/guest-vpn";

import { headscaleFaults } from "../../harness/headscale-faults";
import { createGuestTailnet } from "../../support/guest-tailnet";
import {
  invited,
  provisionWithPreview,
  requireVpnResult as value,
  vpnState,
} from "../../support/guest-vpn";

test("a short requested deadline cuts real traffic during a control outage and a restarted worker completes expiration", async () => {
  await using tailnet = await createGuestTailnet({ policy: { grants: [] } });
  await using faults = await headscaleFaults(tailnet);
  const resource = await tailnet.node({ name: "deadline-resource", user: "deadline-operator" });
  await resource.serveHttp(8006);
  const address = (await resource.machine()).ipAddresses[0];
  const app = await tailnet.headplane({
    config: {
      server: { base_url: "http://localhost:3099" },
      headscale: { url: faults.url },
      guest_invitations: { enabled: true, transport: "file" },
      guest_vpn: { enabled: true, single_policy_writer: true },
    },
  });
  // Exercise the supported custom-date workflow with a real, minute-resolution
  // deadline 60–120 seconds away. Never shorten SQLite or Headscale state by hand.
  const requested = new Date(Date.now() + 120_000).toISOString().slice(0, 16);
  const deadline = new Date(`${requested}:00Z`);
  const guest = await invited(
    app,
    [{ kind: "node", node_id: resource.id, address, route: null, protocol: "tcp", ports: "8006" }],
    "deadline@example.test",
    {
      duration: "custom",
      requested_expires_at: requested,
      time_zone: "UTC",
    },
  );
  value(await provisionWithPreview(app.ctx.guestVpn, guest.id, guest.revision));
  const pending = await tailnet.pendingNode({ name: "deadline-device" });
  value(await app.ctx.guestVpn.register(guest.portal!, pending.registerUrl.split("/register/")[1]));
  const node = await pending.joined();
  expect(vpnState(app, guest.id).expires_at).toEqual(deadline);
  expect(new Date((await node.machine()).expiry!)).toEqual(deadline);
  await vi.waitFor(async () => expect(await node.canConnect(address, 8006)).toBe(true), {
    timeout: 15_000,
  });
  await node.startStream(address, 8006);
  await vi.waitFor(async () =>
    expect(Date.now() - (await node.lastStreamPacket(8006))).toBeLessThan(1000),
  );
  const freshWorker = () =>
    createGuestVpnService({
      db: app.ctx.db,
      headscale: app.ctx.headscale,
      config: app.ctx.config,
      verifiedInvitation: app.ctx.invitations.verifiedGuest,
    });
  let worker = freshWorker();
  try {
    // Recreate the lifecycle over persisted state before expiration, then remove
    // control-plane connectivity. Native expiry must still stop the data plane.
    faults.unavailable(true);
    worker.start();
    await vi.waitFor(async () => expect(await node.canConnect(address, 8006)).toBe(false), {
      timeout: Math.max(1, deadline.getTime() - Date.now()) + 20_000,
      interval: 1000,
    });
    await vi.waitFor(
      () =>
        expect(vpnState(app, guest.id)).toMatchObject({
          state: "revoking",
          desired_state: "expired",
        }),
      { timeout: 15_000 },
    );
    expect(vpnState(app, guest.id).permission).not.toBeNull();
    await worker.stop();
    // Restart during the persisted cleanup and recover the real API connection.
    faults.unavailable(false);
    worker = freshWorker();
    worker.start();
    await vi.waitFor(
      () =>
        expect(vpnState(app, guest.id)).toMatchObject({
          state: "expired",
          permission: null,
        }),
      { timeout: 25_000 },
    );
    expect(await node.canConnect(address, 8006)).toBe(false);
    await vi.waitFor(async () =>
      expect(Date.now() - (await node.lastStreamPacket(8006))).toBeGreaterThan(1000),
    );
    expect(JSON.parse((await tailnet.api.policy.get()).policy).grants).toEqual([]);
  } finally {
    faults.unavailable(false);
    await worker.stop();
  }
}, 180_000);
