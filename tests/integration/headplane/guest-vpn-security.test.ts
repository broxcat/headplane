import { eq } from "drizzle-orm";
import { expect, test } from "vitest";

import { action as guestAction } from "~/routes/guests/detail";
import { action as portalAction, loader as portalLoader } from "~/routes/guests/onboarding";
import { vpnCookie } from "~/routes/guests/vpn-session.server";
import { machineAction } from "~/routes/machines/machine-actions";
import { authKeysAction } from "~/routes/settings/auth-keys/actions";
import { userAction } from "~/routes/users/user-actions";
import { guestVpnAccess } from "~/server/db/schema";
import { invitationCsrf } from "~/server/invitation-tokens";

import { statusOf } from "../../support/app";
import { createGuestTailnet as createTailnet } from "../../support/guest-tailnet";
import {
  invited,
  provisionWithPreview,
  requireVpnResult as value,
  vpnState as state,
} from "../../support/guest-vpn";

test("guest portal sessions, Origin/CSRF, rate limits and reserved identities cannot be bypassed through dashboard routes", async () => {
  await using tailnet = await createTailnet({ policy: { grants: [] } });
  const app = await tailnet.headplane({
    config: {
      server: { base_path: "/custom-guests", base_url: "http://localhost:3099" },
      guest_invitations: { enabled: true, transport: "file" },
      guest_vpn: { enabled: true, single_policy_writer: true },
    },
  });
  const owner = await app.signIn("owner");
  const resource = await tailnet.node({ name: "security-resource", user: "security-operator" });
  const address = (await resource.machine()).ipAddresses[0];
  await tailnet.api.policy.set(
    JSON.stringify({
      tagOwners: { "tag:reserved-service": ["security-operator@"] },
      grants: [{ src: ["tag:reserved-service"], dst: ["*"], ip: ["*"] }],
    }),
  );
  const guest = await invited(
    app,
    [{ kind: "node", node_id: resource.id, address, route: null, protocol: "tcp", ports: "8006" }],
    "security-guest@example.test",
  );
  const another = await invited(app, [], "other-guest@example.test");
  const before = { users: await tailnet.api.users.list(), policy: await tailnet.api.policy.get() };
  for (const role of ["it_admin", "network_admin", "auditor", "viewer", "member"] as const) {
    const as = (await app.signIn(role)).cookie;
    expect(
      statusOf(
        await app.call(guestAction, `/guests/${guest.id}`, {
          as,
          params: { id: guest.id },
          headers: { Origin: "http://localhost:3099" },
          form: { intent: "provision_access", revision: String(guest.revision) },
        }),
      ),
      role,
    ).toBe(403);
    expect(statusOf(await app.call(portalLoader, "/guest-access", { as })), role).toBe(401);
  }
  expect({ users: await tailnet.api.users.list(), policy: await tailnet.api.policy.get() }).toEqual(
    before,
  );
  value(await provisionWithPreview(app.ctx.guestVpn, guest.id, guest.revision));
  const a = state(app, guest.id);
  const as = (await vpnCookie(app.ctx.config).serialize(guest.portal!)).split(";")[0];
  const headers = { Origin: "http://localhost:3099" };
  const csrf = invitationCsrf(app.ctx.config.server.cookie_secret, guest.portal!);
  expect(
    statusOf(
      await app.call(portalAction, "/guest-access", {
        as,
        headers,
        form: { intent: "register", auth_id: "x".repeat(4096), csrf },
      }),
    ),
  ).toBe(413);
  expect(await app.call(portalLoader, "/guest-access", { as })).toMatchObject({
    data: { state: "provisioning", nodes: [] },
  });
  const otherCookie = (await vpnCookie(app.ctx.config).serialize(another.portal!)).split(";")[0];
  expect(await app.call(portalLoader, "/guest-access", { as: otherCookie })).toMatchObject({
    data: { state: "not_provisioned", nodes: [] },
  });
  const forgedHeaders: Record<string, string>[] = [{}, { Origin: "https://other.example.test" }];
  for (const forged of forgedHeaders)
    expect(
      statusOf(
        await app.call(portalAction, "/guest-access", {
          as,
          headers: forged,
          form: { intent: "register", auth_id: "not-real", csrf },
        }),
      ),
    ).toBe(403);
  expect(
    statusOf(
      await app.call(portalAction, "/guest-access", {
        as,
        headers,
        form: { intent: "register", auth_id: "not-real", csrf: "invalid" },
      }),
    ),
  ).toBe(403);
  for (let attempt = 0; attempt < 6; attempt++)
    expect(
      statusOf(
        await app.call(portalAction, "/guest-access", {
          as,
          headers,
          form: { intent: "register", auth_id: "not-real", csrf },
        }),
      ),
    ).toBe(attempt < 5 ? 400 : 429);
  // Lost create reply: the reserved name must protect the numeric identity
  // even before its Headplane mapping is committed.
  app.ctx.db
    .update(guestVpnAccess)
    .set({ headscale_user_id: null })
    .where(eq(guestVpnAccess.guest_id, guest.id))
    .run();
  for (const [handler, path, form] of [
    [
      machineAction,
      "/machines",
      { intent: "register", register_key: "hskey-authreq-not-real-test-key", user: a.user_name },
    ],
    [
      authKeysAction,
      "/settings/auth-keys",
      { intent: "create", user_id: a.headscale_user_id!, expiry: "1", tags: [] as string[] },
    ],
    [
      userAction,
      "/users",
      { intent: "link", headplane_user_id: owner.userId, headscale_user_id: a.headscale_user_id! },
    ],
    [userAction, "/users", { intent: "delete", headscale_user_id: a.headscale_user_id! }],
  ] as const)
    expect(statusOf(await app.call(handler, path, { as: owner.cookie, headers, form }))).toBe(409);
  app.ctx.db
    .update(guestVpnAccess)
    .set({ headscale_user_id: a.headscale_user_id })
    .where(eq(guestVpnAccess.guest_id, guest.id))
    .run();
  expect((await tailnet.api.users.list({ id: a.headscale_user_id! }))[0].name).toBe(a.user_name);
  expect(await tailnet.api.policy.get()).toEqual(before.policy);
  const tagged = await tailnet.pendingNode({
    name: "unauthorized-guest-tag",
    tags: ["tag:reserved-service"],
  });
  const result = await app.ctx.guestVpn.register(
    guest.portal!,
    tagged.registerUrl.split("/register/")[1],
  );
  expect(result).toMatchObject({ ok: false });
  expect(
    (await tailnet.api.nodes.list()).filter((n) => n.name === "unauthorized-guest-tag"),
  ).toEqual([]);
  expect(await tailnet.api.policy.get()).toEqual(before.policy);
  await tailnet.node({ name: "unverified-private-device", user: a.user_name });
  await tailnet.api.users.rename(a.headscale_user_id!, "unverified-identity");
  expect(await app.call(portalLoader, "/guest-access", { as })).toMatchObject({
    data: { nodes: [], verified: false },
  });
});
