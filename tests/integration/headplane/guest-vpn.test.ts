import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";

import { action as guestAction } from "~/routes/guests/detail";
import { guestVpnAccess, guestVpnEvents } from "~/server/db/schema";
import { guestPolicyIdentity, policyHash } from "~/server/guest-vpn-policy";
import type { ResourceInput } from "~/utils/guest-resources";

import { testedVersions } from "../../harness/versions";
import { statusOf } from "../../support/app";
import { createGuestTailnet as createTailnet } from "../../support/guest-tailnet";
import {
  invited,
  provisionWithPreview,
  requireVpnResult as value,
  vpnState as state,
} from "../../support/guest-vpn";

describe.for(testedVersions())("guest network lifecycle on Headscale %s", (version) => {
  for (const model of ["acls", "grants"] as const)
    test.runIf(version.startsWith("0.29."))(
      `${model} permissive policies block provisioning before user creation`,
      async () => {
        const broad = {
          [model]:
            model === "grants"
              ? [{ src: ["*"], dst: ["*"], ip: ["*"] }]
              : [{ action: "accept", src: ["*"], dst: ["*:*"] }],
        };
        await using tailnet = await createTailnet({ version, policy: broad });
        const resource = await tailnet.node({ name: "blocked-resource", user: "blocked-operator" });
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
          `blocked-${model}@example.test`,
        );
        const before = {
          users: await tailnet.api.users.list(),
          policy: await tailnet.api.policy.get(),
        };
        expect(
          await provisionWithPreview(app.ctx.guestVpn, guest.id, guest.revision),
        ).toMatchObject({
          ok: false,
          error: { code: "isolation" },
        });
        expect({
          users: await tailnet.api.users.list(),
          policy: await tailnet.api.policy.get(),
        }).toEqual(before);
        expect(state(app, guest.id)).toBeUndefined();
      },
    );
  test.runIf(!version.startsWith("0.29."))(
    "unsupported servers keep provisioning disabled without creating users or changing policy",
    async () => {
      await using tailnet = await createTailnet({ version, policy: { acls: [] } });
      const app = await tailnet.headplane({
        config: { guest_vpn: { enabled: true, single_policy_writer: true } },
      });
      const before = {
        users: await tailnet.api.users.list(),
        policy: await tailnet.api.policy.get(),
      };
      expect(await app.ctx.guestVpn.provision("01M66M24KNQ66SXYSB28KW5P2P", 1, null)).toMatchObject(
        { ok: false, error: { code: "disabled" } },
      );
      expect({
        users: await tailnet.api.users.list(),
        policy: await tailnet.api.policy.get(),
      }).toEqual(before);
    },
  );

  for (const model of ["acls", "grants"] as const)
    test.runIf(version.startsWith("0.29."))(
      `interactive onboarding, ${model} isolation, revocation and native expiry with real packets`,
      async () => {
        await using tailnet = await createTailnet({ version, policy: { [model]: [] } });
        const app = await tailnet.headplane({
          config: {
            server: { base_path: "/guest-console", base_url: "http://localhost:3099" },
            guest_invitations: { enabled: true, transport: "file" },
            guest_vpn: { enabled: true, single_policy_writer: true },
          },
        });
        const owner = (await app.signIn("owner")).cookie;
        const service = await tailnet.node({ name: `service-${model}`, user: `operator-${model}` });
        await service.serveHttp(8006);
        await service.serveHttp(8007);
        await service.serveUdp(5353);
        await service.serveUdp(5354);
        const router = await tailnet.node({
          name: `lan-router-${model}`,
          user: `operator-${model}`,
          routes: ["10.44.0.0/24"],
          lanAddress: "10.44.0.8",
        });
        await router.serveHttp(8006);
        await tailnet.api.nodes.approveRoutes(router.id, ["10.44.0.0/24"]);
        const lan: ResourceInput = {
          kind: "lan",
          node_id: router.id,
          address: "10.44.0.8",
          route: "10.44.0.0/24",
          protocol: "tcp",
          ports: "8006",
        };
        const destination = (await service.machine()).ipAddresses[0];
        const resource: ResourceInput = {
          kind: "node",
          node_id: service.id,
          address: destination,
          route: null,
          protocol: "tcp",
          ports: "8006",
        };
        const guestA = await invited(
          app,
          [resource, { ...resource, protocol: "udp", ports: "5353" }],
          `guest-a-${model}@example.test`,
        );
        const guestB = await invited(
          app,
          [{ ...resource, ports: "8007" }, { ...resource, protocol: "udp", ports: "5354" }, lan],
          `guest-b-${model}@example.test`,
        );
        const headers = { Origin: "http://localhost:3099" };
        expect(
          statusOf(
            await app.call(guestAction, `/guests/${guestA.id}`, {
              as: owner,
              params: { id: guestA.id },
              form: {
                intent: "provision_access",
                revision: String(guestA.revision),
                preview_hash: "0".repeat(64),
              },
            }),
          ),
        ).toBe(403);
        value(await provisionWithPreview(app.ctx.guestVpn, guestA.id, guestA.revision));
        const linkedId = state(app, guestA.id).headscale_user_id;
        value(await provisionWithPreview(app.ctx.guestVpn, guestA.id, guestA.revision));
        expect(state(app, guestA.id)).toMatchObject({
          state: "provisioning",
          phase: "awaiting_device",
          activated_at: null,
          expires_at: null,
          headscale_user_id: linkedId,
        });
        expect(
          (await tailnet.api.users.list({ name: guestPolicyIdentity(guestA.id).user })).map(
            (u) => u.id,
          ),
        ).toEqual([linkedId]);
        expect(await tailnet.api.policy.get()).toMatchObject({
          policy: JSON.stringify({ [model]: [] }, null, 2),
        });
        const pendingA = await tailnet.pendingNode({ name: `guest-a-device-${model}` });
        const authA = pendingA.registerUrl.split("/register/")[1];
        value(await app.ctx.guestVpn.register(guestA.portal!, authA));
        const nodeA = await pendingA.joined();
        expect(state(app, guestA.id)).toMatchObject({ state: "active" });
        const activated = state(app, guestA.id);
        expect(activated.expires_at!.getTime() - activated.activated_at!.getTime()).toBe(
          43_200_000,
        );
        expect((await nodeA.machine()).user?.id).toBe(linkedId);
        await vi.waitFor(async () => expect(await nodeA.canConnect(destination, 8006)).toBe(true), {
          timeout: 15_000,
        });
        expect(await nodeA.canConnect(destination, 8007)).toBe(false);
        await vi.waitFor(
          async () => expect(await nodeA.canConnectUdp(destination, 5353)).toBe(true),
          { timeout: 15_000 },
        );
        expect(await nodeA.canConnectUdp(destination, 5354)).toBe(false);
        // A stale or cross-guest Auth ID never registers a second device.
        value(await provisionWithPreview(app.ctx.guestVpn, guestB.id, guestB.revision));
        expect(await app.ctx.guestVpn.register(guestB.portal!, authA)).toMatchObject({
          ok: false,
          error: { code: "auth_consumed" },
        });
        const pendingB = await tailnet.pendingNode({ name: `guest-b-device-${model}` });
        value(
          await app.ctx.guestVpn.register(
            guestB.portal!,
            pendingB.registerUrl.split("/register/")[1],
          ),
        );
        const nodeB = await pendingB.joined();
        await nodeB.tailscale(["set", "--accept-routes=true"]);
        await vi.waitFor(async () => expect(await nodeB.canConnect(destination, 8007)).toBe(true), {
          timeout: 15_000,
        });
        expect(await nodeB.canConnect(destination, 8006)).toBe(false);
        await vi.waitFor(async () => expect(await nodeB.canConnect("10.44.0.8", 8006)).toBe(true), {
          timeout: 15_000,
        });
        expect(await nodeB.canConnectUdp(destination, 5354)).toBe(true);
        expect(await nodeA.canConnect("10.44.0.8", 8006)).toBe(false);
        expect(await nodeA.canConnect((await router.machine()).ipAddresses[0], 8006)).toBe(false);
        expect(app.ctx.guestResources.save(guestA.id, guestA.revision, "[]", [])).toMatchObject({
          ok: false,
          error: { code: "conflict" },
        });
        const current = await tailnet.api.policy.get();
        await expect(
          app.ctx.guestVpn.writer.edit(
            tailnet.api,
            policyHash(current.policy),
            JSON.stringify({
              [model]:
                model === "grants"
                  ? [{ src: ["*"], dst: ["*"], ip: ["*"] }]
                  : [{ action: "accept", src: ["*"], dst: ["*:*"] }],
            }),
          ),
        ).rejects.toThrow("Guest isolation cannot be guaranteed");
        expect(await tailnet.api.policy.get()).toEqual(current);
        expect(
          statusOf(
            await app.call(guestAction, `/guests/${guestA.id}`, {
              as: owner,
              params: { id: guestA.id },
              headers,
              form: { intent: "revoke_access", revision: "1" },
            }),
          ),
        ).toBe(409);
        await nodeA.startStream(destination, 8006);
        await nodeB.startStream(destination, 8007);
        await vi.waitFor(async () => {
          expect(Date.now() - (await nodeA.lastStreamPacket(8006))).toBeLessThan(1000);
          expect(Date.now() - (await nodeB.lastStreamPacket(8007))).toBeLessThan(1000);
        });
        value(
          await (model === "acls"
            ? app.ctx.guestVpn.expireDevice(
                guestA.id,
                state(app, guestA.id).revision,
                nodeA.id,
                null,
              )
            : app.ctx.guestVpn.revoke(guestA.id, state(app, guestA.id).revision, null)),
        );
        expect(state(app, guestA.id)).toMatchObject({ state: "revoked", permission: null });
        await vi.waitFor(
          async () => expect(await nodeA.canConnect(destination, 8006)).toBe(false),
          { timeout: 15_000 },
        );
        expect(await nodeA.canConnect(destination, 8007)).toBe(false);
        expect(await nodeA.canConnectUdp(destination, 5353)).toBe(false);
        await vi.waitFor(
          async () =>
            expect(Date.now() - (await nodeA.lastStreamPacket(8006))).toBeGreaterThan(1000),
          { timeout: 15_000 },
        );
        expect(new Date((await nodeA.machine()).expiry!).getTime()).toBeLessThanOrEqual(
          Date.now() + 1000,
        );
        expect(app.ctx.guests.get(guestA.id)).toMatchObject({ ok: true });
        expect(await nodeB.canConnect(destination, 8007)).toBe(true);
        expect(await nodeB.canConnectUdp(destination, 5354)).toBe(true);
        expect(Date.now() - (await nodeB.lastStreamPacket(8007))).toBeLessThan(1000);
        // Stop Headplane's worker: native Headscale expiry must still cut access.
        const end = new Date(Date.now() + 2000);
        await tailnet.api.nodes.expireAt(nodeB.id, end);
        app.ctx.db
          .update(guestVpnAccess)
          .set({ expires_at: end })
          .where(eq(guestVpnAccess.guest_id, guestB.id))
          .run();
        await vi.waitFor(
          async () => expect(await nodeB.canConnect(destination, 8007)).toBe(false),
          { timeout: 15_000 },
        );
        value(await app.ctx.guestVpn.reconcile());
        expect(state(app, guestB.id)).toMatchObject({ state: "expired", permission: null });
        expect(await nodeB.canConnect("10.44.0.8", 8006)).toBe(false);
        expect(await nodeB.canConnectUdp(destination, 5354)).toBe(false);
        await vi.waitFor(
          async () =>
            expect(Date.now() - (await nodeB.lastStreamPacket(8007))).toBeGreaterThan(1000),
          { timeout: 15_000 },
        );
        const audit = app.ctx.db.select().from(guestVpnEvents).all();
        expect(audit.map((e) => e.kind)).toEqual(
          expect.arrayContaining([
            "headscale_user_created",
            "device_registered",
            "policy_applied",
            "access_activated",
            "access_revoked",
            "access_expired",
          ]),
        );
        expect(JSON.stringify(audit)).not.toContain(authA);
        expect(
          app.ctx.db.$client
            .prepare("SELECT count(*) AS n FROM guest_vpn_sessions WHERE guest_id = ?")
            .get(guestA.id)?.n,
        ).toBe(0);
        // Even terminal identities remain protected against accidental revival.
        const clean = await tailnet.api.policy.get();
        const broad = JSON.stringify({
          [model]:
            model === "grants"
              ? [{ src: ["*"], dst: ["*"], ip: ["*"] }]
              : [{ action: "accept", src: ["*"], dst: ["*:*"] }],
        });
        await expect(
          app.ctx.guestVpn.writer.edit(tailnet.api, policyHash(clean.policy), broad),
        ).rejects.toThrow("Guest isolation cannot be guaranteed");
        expect(await tailnet.api.policy.get()).toEqual(clean);
      },
    );
});
