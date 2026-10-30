import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";

import { guestVpnAccess, guestVpnPolicyState } from "~/server/db/schema";
import { createGuestVpnService } from "~/server/guest-vpn";
import { policyHash } from "~/server/guest-vpn-policy";

import { headscaleFaults } from "../../harness/headscale-faults";
import { createGuestTailnet as createTailnet } from "../../support/guest-tailnet";
import {
  invited,
  provisionWithPreview,
  requireVpnResult as value,
  vpnState as state,
} from "../../support/guest-vpn";

test("failed user creation can be cancelled after Headscale confirms that no dedicated user or permissions exist", async () => {
  await using tailnet = await createTailnet({ policy: { grants: [] } });
  await using faults = await headscaleFaults(tailnet);
  const resource = await tailnet.node({ name: "creation-resource", user: "creation-operator" });
  const app = await tailnet.headplane({
    config: {
      server: { base_url: "http://localhost:3099" },
      headscale: { url: faults.url },
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
    "create-failed@example.test",
  );
  faults.denyUserCreationOnce();
  expect(await provisionWithPreview(app.ctx.guestVpn, guest.id, guest.revision)).toMatchObject({
    ok: false,
  });
  expect(state(app, guest.id)).toMatchObject({ state: "error", headscale_user_id: null });
  value(await app.ctx.guestVpn.revoke(guest.id, state(app, guest.id).revision, null));
  expect(state(app, guest.id).state).toBe("revoked");
  expect(await tailnet.api.users.list({ name: state(app, guest.id).user_name })).toEqual([]);
});

test("lost policy replies, retries, restart recovery and drift never imply successful Guest activation or revocation", async () => {
  await using tailnet = await createTailnet({ policy: { grants: [] } });
  await using faults = await headscaleFaults(tailnet);
  const app = await tailnet.headplane({
    config: {
      server: { base_url: "http://localhost:3099" },
      headscale: { url: faults.url },
      guest_invitations: { enabled: true, transport: "file" },
      guest_vpn: { enabled: true, single_policy_writer: true },
    },
  });
  const service = await tailnet.node({ name: "recovery-resource", user: "recovery-operator" });
  await service.serveHttp(8006);
  const address = (await service.machine()).ipAddresses[0];
  const guest = await invited(
    app,
    [{ kind: "node", node_id: service.id, address, route: null, protocol: "tcp", ports: "8006" }],
    "recovery@example.test",
  );
  const original = await tailnet.api.policy.get();
  const gate = faults.pausePolicyValidation();
  const editing = app.ctx.guestVpn.writer.edit(
    app.api,
    policyHash(original.policy),
    '{"grants":[],"hosts":{}}',
  );
  const rejected = expect(editing).rejects.toThrow("Policy changed during validation");
  await gate.ready;
  const manual = '{"grants":[],"groups":{"group:operators":["recovery-operator@"]}}';
  await tailnet.api.policy.set(manual); // intentional external-writer fixture race
  gate.release();
  await rejected;
  expect((await tailnet.api.policy.get()).policy).toBe(manual);
  value(await provisionWithPreview(app.ctx.guestVpn, guest.id, guest.revision));
  const pending = await tailnet.pendingNode({ name: "recovery-first-device" });
  faults.dropPolicyReply();
  expect(
    await app.ctx.guestVpn.register(guest.portal!, pending.registerUrl.split("/register/")[1]),
  ).toMatchObject({ ok: false, error: { code: "policy_uncertain" } });
  const first = await pending.joined({ online: false });
  expect(state(app, guest.id)).toMatchObject({ state: "error", permission: null });
  expect(new Date((await first.machine()).expiry!).getTime()).toBeLessThanOrEqual(
    Date.now() + 1000,
  );
  expect(await first.canConnect(address, 8006)).toBe(false);
  expect(app.ctx.db.select().from(guestVpnPolicyState).get()?.candidate_policy).toBeNull();
  value(await provisionWithPreview(app.ctx.guestVpn, guest.id, guest.revision));
  const secondPending = await tailnet.pendingNode({ name: "recovery-second-device" });
  value(
    await app.ctx.guestVpn.register(
      guest.portal!,
      secondPending.registerUrl.split("/register/")[1],
    ),
  );
  const second = await secondPending.joined();
  expect(state(app, guest.id).state).toBe("active");
  await vi.waitFor(async () => expect(await second.canConnect(address, 8006)).toBe(true), {
    timeout: 15_000,
  });
  // Recreate the service over the persisted database and real client: closure
  // state from the previous lifecycle service is not needed for expiry/retry.
  const recovered = createGuestVpnService({
    db: app.ctx.db,
    headscale: app.ctx.headscale,
    config: app.ctx.config,
    verifiedInvitation: app.ctx.invitations.verifiedGuest,
  });
  faults.unavailable(true);
  expect(await recovered.revoke(guest.id, state(app, guest.id).revision, null)).toMatchObject({
    ok: false,
  });
  expect(state(app, guest.id)).toMatchObject({ state: "revoking", desired_state: "revoked" });
  expect(state(app, guest.id).retry_at!.getTime()).toBeGreaterThan(Date.now());
  faults.unavailable(false);
  // Simulate a restart after the persisted backoff becomes due. The new
  // service's startup scan completes revocation without another browser POST.
  app.ctx.db
    .update(guestVpnAccess)
    .set({ retry_at: new Date(Date.now() - 1) })
    .where(eq(guestVpnAccess.guest_id, guest.id))
    .run();
  recovered.start();
  await vi.waitFor(() => expect(state(app, guest.id).state).toBe("revoked"), { timeout: 15_000 });
  await recovered.stop();
  expect(state(app, guest.id).state).toBe("revoked");
  expect(await second.canConnect(address, 8006)).toBe(false);
  // An independently enrolled device under a retained, revoked identity is
  // drift, not a new automatically trusted Guest device.
  const orphan = await tailnet.node({
    name: "orphan-after-revocation",
    user: state(app, guest.id).user_name,
  });
  const orphanDetected = Date.now();
  value(await recovered.reconcile());
  expect(new Date((await orphan.machine()).expiry!).getTime()).toBeGreaterThan(
    orphanDetected - 1000,
  );
  expect(new Date((await orphan.machine()).expiry!).getTime()).toBeLessThanOrEqual(
    Date.now() + 1000,
  );
  expect(state(app, guest.id).state).toBe("revoked");

  const driftGuest = await invited(
    app,
    [{ kind: "node", node_id: service.id, address, route: null, protocol: "tcp", ports: "8006" }],
    "drift@example.test",
  );
  value(await provisionWithPreview(recovered, driftGuest.id, driftGuest.revision));
  const driftPending = await tailnet.pendingNode({ name: "drift-device" });
  value(
    await recovered.register(driftGuest.portal!, driftPending.registerUrl.split("/register/")[1]),
  );
  const driftNode = await driftPending.joined();
  const beforeDrift = await tailnet.api.policy.get();
  const external = JSON.parse(beforeDrift.policy);
  external.hosts = { "external-change": "100.64.100.100" };
  const externalPolicy = JSON.stringify(external);
  await tailnet.api.policy.set(externalPolicy); // deliberately violate the contract
  value(await recovered.reconcile());
  expect(state(app, driftGuest.id)).toMatchObject({ state: "error", error_code: "policy_drift" });
  expect(new Date((await driftNode.machine()).expiry!).getTime()).toBeLessThanOrEqual(
    Date.now() + 1000,
  );
  expect((await tailnet.api.policy.get()).policy).toBe(externalPolicy);
  await vi.waitFor(async () => expect(await driftNode.canConnect(address, 8006)).toBe(false), {
    timeout: 15_000,
  });
  // A policy applied before process loss is recoverable, but an unconfirmed
  // previous image cannot be resent automatically.
  await tailnet.api.policy.set(beforeDrift.policy); // operator fixture restores the reviewed baseline
  app.ctx.db
    .update(guestVpnAccess)
    .set({ retry_at: null })
    .where(eq(guestVpnAccess.guest_id, driftGuest.id))
    .run();
  value(await recovered.reconcile());
  expect(state(app, driftGuest.id).permission).toBeNull();
  expect(state(app, driftGuest.id).state).toBe("error");
});
