import { drizzle } from "drizzle-orm/node-sqlite";
import { afterEach, expect, test } from "vitest";

import { migrate } from "~/server/db/migrate";
import { guestResources } from "~/server/db/schema";
import { previewGuestAcl } from "~/server/guest-acl-preview";
import { createGuestResourceService, validateResources } from "~/server/guest-resources";
import { createGuestService } from "~/server/guests";
import { canonicalPorts, type ResourceInput, type ResourceNode } from "~/utils/guest-resources";

const node: ResourceNode = {
  id: "1",
  name: "analytics",
  addresses: ["100.64.0.1", "fd7a::1"],
  owner: "operator",
  tags: [],
  online: true,
  announced: ["10.44.0.0/24"],
  approved: ["10.44.0.0/24"],
};
const resource: ResourceInput = {
  kind: "node",
  node_id: "1",
  address: "100.64.0.1",
  route: null,
  protocol: "tcp",
  ports: "22,443",
};
const raw = (r: ResourceInput = resource) => JSON.stringify([r]);

test.for(["0", "65536", "*", "22,*", "80-79", "1-101", "22,22", "20-30,25-40", "22;443", "", "-1"])(
  "refuses unsafe ports %s",
  (ports) => {
    expect(() => canonicalPorts(ports)).toThrow();
  },
);
test("normalizes explicit ports without inserting a wildcard and accepts the upper bound", () => {
  expect(canonicalPorts(" 443,22,8000-8010,65535")).toBe("22,443,8000-8010,65535");
});
test("validates both protocol families, canonicalizes IPv6 and rejects duplicate destinations", () => {
  const ipv6 = { ...resource, address: "fd7a:0:0:0:0:0:0:1", protocol: "udp" as const };
  expect(validateResources(raw(ipv6), [node])[0].address).toBe("fd7a::1");
  expect(() =>
    validateResources(raw({ ...resource, protocol: "icmp" } as unknown as ResourceInput), [node]),
  ).toThrow();
  expect(() => validateResources(JSON.stringify([resource, resource]), [node])).toThrow(
    /duplicate/,
  );
  expect(() => validateResources(JSON.stringify([{ ...resource, rogue: true }]), [node])).toThrow();
});
test("does not silently remap deleted machines or changed addresses", () => {
  expect(() => validateResources(raw(), [])).toThrow(/removed/);
  expect(() => validateResources(raw(), [{ ...node, addresses: ["100.64.0.2"] }])).toThrow(
    /address changed/,
  );
});
test("LAN declarations require a private address inside a currently announced AND approved non-exit route", () => {
  const lan: ResourceInput = {
    ...resource,
    kind: "lan",
    address: "10.44.0.8",
    route: "10.44.0.0/24",
  };
  expect(validateResources(raw(lan), [node])).toEqual([lan]);
  for (const broken of [
    { ...node, approved: [] },
    { ...node, announced: [] },
  ])
    expect(() => validateResources(raw(lan), [broken])).toThrow(/announced and approved/);
  for (const address of ["10.45.0.8", "127.0.0.1", "8.8.8.8", "10.44.0.8:22", "10.44.0.8/32"])
    expect(() => validateResources(raw({ ...lan, address }), [node])).toThrow();
  expect(() =>
    validateResources(raw({ ...lan, route: "0.0.0.0/0" }), [
      { ...node, announced: ["0.0.0.0/0"], approved: ["0.0.0.0/0"] },
    ]),
  ).toThrow();
});

const dbs: ReturnType<typeof drizzle>[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.$client.close();
});
test("atomic resource replacement shares the guest revision and cannot overwrite a revocation or stale edit", () => {
  const db = drizzle(":memory:");
  dbs.push(db);
  migrate(db, { migrationsFolder: "drizzle" });
  const guests = createGuestService(db);
  const plans = createGuestResourceService(db);
  const created = guests.create({ email: "resource@example.com", duration: "43200" }, null);
  if (!created.ok) throw new Error(created.error.message);
  const id = created.value.id;
  const updated = plans.save(id, 1, raw(), [node]);
  expect(updated).toMatchObject({ value: { revision: 2, activated_at: null, expires_at: null } });
  const stored = plans.list(id);
  if (!stored.ok) throw new Error(stored.error.message);
  const first = stored.value[0];
  expect(plans.save(id, 1, "[]", [node])).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(plans.list(id)).toMatchObject({ value: [first] });
  plans.save(id, 2, raw({ ...resource, ports: "8006" }), [node]);
  expect(plans.list(id)).toMatchObject({
    value: [
      {
        id: first.id,
        created_at: first.created_at,
        revision: 2,
        ports: "8006",
      },
    ],
  });
  // A DB constraint failure must restore both the plan and the guest revision.
  db.$client.exec(
    "CREATE TRIGGER fail_plan BEFORE INSERT ON guest_resources BEGIN SELECT RAISE(ABORT, 'test fault'); END",
  );
  expect(plans.save(id, 3, raw(), [node])).toMatchObject({
    ok: false,
    error: { code: "database" },
  });
  expect(guests.get(id)).toMatchObject({ value: { revision: 3 } });
  expect(plans.list(id)).toMatchObject({ value: [{ ports: "8006" }] });
  db.$client.exec("DROP TRIGGER fail_plan");
  expect(guests.revoke(id, 3).ok).toBe(true);
  expect(plans.save(id, 4, "[]", [node])).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(db.select().from(guestResources).all()).toHaveLength(1);
});

function preview(policy: string | null, resources: ResourceInput[] = [resource]) {
  return previewGuestAcl({
    policy,
    resources,
    nodes: [node],
    supportsGrants: true,
    versionKnown: true,
  });
}
test.for([
  '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}',
  '{"grants":[{"src":["*"],"dst":["*"],"ip":["*"]}]}',
  '{"acls":[{"action":"accept","src":["*"],"dst":["100.64.0.1:22"]}]}',
])("detects extra rights from permissive policies: %s", (policy) => {
  // Even the third rule widens TCP-only intentions by permitting UDP.
  expect(preview(policy).status).toBe("Existing policy conflict");
});
test("a narrow rule is not mislabeled as an extra permission, but unbound identity still prevents readiness", () => {
  const p = preview(
    '{"acls":[{"action":"accept","src":["*"],"dst":["100.64.0.1:22"],"proto":"tcp"}]}',
  );
  expect(p.conflicts).toEqual([]);
  expect(p.status).toBe("Cannot verify guest isolation");
  expect(p.proposed[0].src).toEqual(["<guest-identity:unbound>"]);
});
test("empty, invalid, unreadable and extended policies never prove isolation", () => {
  for (const p of [null, "", "broken", "{}", '{"acls":[],"nodeAttrs":[{}]}'])
    expect(preview(p).status).toBe("Cannot verify guest isolation");
});
test("groups, shared tags, subnet routes and unsupported grants remain explicit uncertainties", () => {
  const p = previewGuestAcl({
    resources: [{ ...resource, kind: "lan", address: "10.44.0.8", route: "10.44.0.0/24" }],
    nodes: [{ ...node, tags: ["tag:shared"] }],
    policy:
      '{"groups":{"group:staff":["user@"]},"grants":[{"src":["autogroup:member"],"dst":["*"],"ip":["*"]}]}',
    supportsGrants: false,
    versionKnown: false,
  });
  expect(p.status).toBe("Cannot verify guest isolation");
  expect(p.issues.map((i) => i.code)).toEqual(
    expect.arrayContaining([
      "group_membership",
      "shared_tags",
      "subnet",
      "wildcard",
      "unresolved_source",
      "incompatible_grants",
      "unknown_version",
    ]),
  );
});
test("stale addresses are retained as intentions but excluded from proposed rules", () => {
  const p = previewGuestAcl({
    resources: [resource],
    nodes: [],
    policy: '{"acls":[]}',
    supportsGrants: true,
    versionKnown: true,
  });
  expect(p.proposed).toEqual([]);
  expect(p.issues.some((i) => i.code === "stale_resource")).toBe(true);
});

test("guest creation and initial resources roll back together on a database failure", () => {
  const db = drizzle(":memory:");
  dbs.push(db);
  migrate(db, { migrationsFolder: "drizzle" });
  db.$client.exec(
    "CREATE TRIGGER reject_initial BEFORE INSERT ON guest_resources BEGIN SELECT RAISE(ABORT, 'test fault'); END",
  );
  const result = createGuestService(db).create(
    { email: "atomic@example.com", duration: "43200" },
    null,
    validateResources(raw(), [node]),
  );
  expect(result.ok).toBe(false);
  expect(db.$client.prepare("SELECT count(*) AS n FROM guests").get()?.n).toBe(0);
});

test("unresolved aliases resembling Object properties never crash or prove isolation", () => {
  const p = preview(
    '{"acls":[{"action":"accept","src":["*"],"dst":["constructor:22","__proto__:443"]}]}',
  );
  expect(p.status).toBe("Cannot verify guest isolation");
  expect(p.issues.some((i) => i.code === "unresolved_destination")).toBe(true);
});
test("via/app extensions are uncertain rather than reported as unconditional network grants", () => {
  const p = preview('{"grants":[{"src":["*"],"dst":["*"],"ip":["tcp:443"],"via":["tag:router"]}]}');
  expect(p.conflicts).toEqual([]);
  expect(p.issues.some((i) => i.code === "grant_extensions")).toBe(true);
});
