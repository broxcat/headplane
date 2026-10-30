import { describe, expect, test } from "vitest";

import { action as edit, loader as detail } from "~/routes/guests/detail";
import { action as create, loader as overview } from "~/routes/guests/overview";
import type { ResourceInput } from "~/utils/guest-resources";

import { createTailnet } from "../../harness/tailnet";
import { testedVersions } from "../../harness/versions";
import { statusOf } from "../../support/app";

// Real Headscale/node: no client stubs. Provisioning here is test-fixture setup only.
describe.for(testedVersions())("guest resource intentions on Headscale %s", (version) => {
  test("persists machine/LAN intentions and previews conflicts without changing the tailnet; enforces origin, roles and revisions", async () => {
    await using tailnet = await createTailnet({
      version,
      policy: '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}',
    });
    const router = await tailnet.node({
      name: "resource-router",
      user: "resource-operator",
      routes: ["10.44.0.0/24"],
    });
    await tailnet.api.nodes.approveRoutes(router.id, ["10.44.0.0/24"]);
    const app = await tailnet.headplane({ config: { server: { base_path: "/console" } } });
    const admin = (await app.signIn("admin")).cookie;
    const headers = { Origin: "http://headplane.test" };
    const nodes = await tailnet.api.nodes.list();
    const machine = nodes.find((n) => n.id === router.id)!;
    const before = {
      policy: await tailnet.api.policy.get(),
      users: await tailnet.api.users.list(),
      nodes: nodes.map((n) => ({
        id: n.id,
        addresses: n.ipAddresses,
        tags: n.tags,
        approved: n.approvedRoutes,
      })),
    };
    const plan: ResourceInput[] = [
      {
        kind: "node",
        node_id: router.id,
        address: machine.ipAddresses[0],
        route: null,
        protocol: "tcp",
        ports: "8006",
      },
      {
        kind: "lan",
        node_id: router.id,
        address: "10.44.0.8",
        route: "10.44.0.0/24",
        protocol: "udp",
        ports: "53",
      },
    ];
    const form = {
      intent: "create",
      email: "planned@example.com",
      duration: "43200",
      resources: JSON.stringify(plan),
    };
    expect(statusOf(await app.call(create, "/guests", { as: admin, headers, form }))).toBe(200);
    const listed = app.ctx.guests.list({
      q: "planned@example.com",
      status: "all",
      sort: "created-desc",
      page: 1,
    });
    if (!listed.ok) throw new Error(listed.error.message);
    const guest = listed.value.rows[0];
    const id = guest.id;
    const path = `/guests/${id}`;
    const params = { id };
    expect(guest).toMatchObject({
      resource_count: 2,
      revision: 1,
      activated_at: null,
      expires_at: null,
    });
    expect(await app.call(detail, path, { as: admin, params })).toMatchObject({
      resources: [{ ports: "8006" }, { ports: "53" }],
      preview: { status: "Existing policy conflict" },
    });
    const catalog = await app.call(overview, "/guests", { as: admin });
    expect(catalog).toMatchObject({
      catalog: {
        nodes: [{ id: router.id, announced: ["10.44.0.0/24"], approved: ["10.44.0.0/24"] }],
      },
    });
    expect(JSON.stringify(catalog)).not.toContain(machine.machineKey);
    const save = {
      intent: "save_resources",
      revision: "1",
      resources: JSON.stringify([{ ...plan[0], ports: "22,443" }]),
    };
    for (const origin of [undefined, "https://unrelated.example"]) {
      expect(
        statusOf(
          await app.call(edit, path, {
            as: admin,
            params,
            form: save,
            headers: origin ? { Origin: origin } : {},
          }),
        ),
      ).toBe(403);
    }
    for (const role of ["network_admin", "it_admin", "auditor", "viewer", "member"] as const) {
      const as = (await app.signIn(role)).cookie;
      expect(statusOf(await app.call(edit, path, { as, params, headers, form: save }))).toBe(403);
      expect(statusOf(await app.call(detail, path, { as, params }))).toBe(403);
    }
    expect(
      statusOf(
        await app.call(edit, path, {
          as: admin,
          params,
          headers,
          form: { ...save, resources: JSON.stringify([{ ...plan[0], ports: "*" }]) },
        }),
      ),
    ).toBe(400);
    expect(statusOf(await app.call(edit, path, { as: admin, params, headers, form: save }))).toBe(
      200,
    );
    expect(statusOf(await app.call(edit, path, { as: admin, params, headers, form: save }))).toBe(
      409,
    );
    expect(
      (await tailnet.api.nodes.list()).map((n) => ({
        id: n.id,
        addresses: n.ipAddresses,
        tags: n.tags,
        approved: n.approvedRoutes,
      })),
    ).toEqual(before.nodes);
    const unavailable = await tailnet.headplane({
      config: { headscale: { api_key: "invalid-isolated-test-key" } },
    });
    const unavailableAdmin = (await unavailable.signIn("admin")).cookie;
    const orphan = unavailable.ctx.guests.create(
      { email: "unavailable@example.com", duration: "43200" },
      null,
    );
    if (!orphan.ok) throw new Error(orphan.error.message);
    expect(
      await unavailable.call(detail, `/guests/${orphan.value.id}`, {
        as: unavailableAdmin,
        params: { id: orphan.value.id },
      }),
    ).toMatchObject({
      catalog: { error: expect.any(String) },
      preview: { status: "Cannot verify guest isolation", policyHash: null },
    });
    expect(
      statusOf(
        await unavailable.call(edit, `/guests/${orphan.value.id}`, {
          as: unavailableAdmin,
          params: { id: orphan.value.id },
          headers,
          form: { ...save, resources: "[]" },
        }),
      ),
    ).toBe(503);
    // Deleting the fixture machine must make existing references stale, never silently remap them.
    await tailnet.api.nodes.delete(router.id);
    expect(await app.call(detail, path, { as: admin, params })).toMatchObject({
      preview: {
        proposed: [],
        issues: expect.arrayContaining([expect.objectContaining({ code: "stale_resource" })]),
      },
    });
    expect(
      statusOf(
        await app.call(edit, path, {
          as: admin,
          params,
          headers,
          form: { ...save, revision: "2" },
        }),
      ),
    ).toBe(409);
    expect(
      statusOf(
        await app.call(edit, path, {
          as: admin,
          params,
          headers,
          form: { intent: "revoke", revision: "2" },
        }),
      ),
    ).toBe(200);
    expect(
      statusOf(
        await app.call(edit, path, {
          as: admin,
          params,
          headers,
          form: { ...save, revision: "3", resources: "[]" },
        }),
      ),
    ).toBe(409);
    expect(await tailnet.api.policy.get()).toEqual(before.policy);
    expect(await tailnet.api.users.list()).toEqual(before.users);
    // Only the deliberate fixture deletion above changed Headscale, never a Guest operation.
    expect((await tailnet.api.nodes.list()).map((n) => n.id)).toEqual(
      before.nodes.filter((n) => n.id !== router.id).map((n) => n.id),
    );
    expect(app.ctx.guests.get(id)).toMatchObject({
      value: { activated_at: null, expires_at: null, status: "revoked" },
    });
    if (tailnet.headscale.capabilities.policySupportsGrants) {
      // Deliberate fixture policy change, followed by another read-only Guest operation.
      await tailnet.setPolicy({ grants: [{ src: ["*"], dst: ["*"], ip: ["*"] }] });
      const grantsPolicy = await tailnet.api.policy.get();
      expect(await app.call(detail, path, { as: admin, params })).toMatchObject({
        preview: {
          status: "Existing policy conflict",
          existing: [{ rule: "grants[0]", permissions: ["*"] }],
        },
      });
      expect(await tailnet.api.policy.get()).toEqual(grantsPolicy);
    }
  });
});
