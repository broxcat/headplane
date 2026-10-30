import { describe, expect, test } from "vitest";

import {
  changeGuestPermission,
  guestPolicyIdentity,
  parseVpnPolicy,
  policyHash,
  provisioningPreviewHash,
  verifyIsolation,
  type ManagedPermission,
} from "~/server/guest-vpn-policy";
import type { Machine } from "~/types";
import type { ResourceInput } from "~/utils/guest-resources";

const id = "01M66M24KNQ66SXYSB28KW5P2P";
const { user, group } = guestPolicyIdentity(id);
const permission: ManagedPermission = {
  user,
  group,
  section: "acls",
  rules: [{ action: "accept", src: [group], dst: ["100.64.0.5:8006"], proto: "tcp" }],
};

test("preview approval changes with resource ownership, tags, routes or Guest intentions, but not telemetry", () => {
  const guest = { id, revision: 1, requested_duration_seconds: 43200, requested_expires_at: null };
  const node: Machine = {
    id: "1",
    machineKey: "fixture-machine",
    nodeKey: "fixture-node",
    discoKey: "fixture-disco",
    ipAddresses: ["100.64.0.5"],
    name: "resource",
    givenName: "resource",
    online: true,
    lastSeen: "2026-10-30T00:00:00Z",
    expiry: null,
    createdAt: "2026-10-30T00:00:00Z",
    registerMethod: "REGISTER_METHOD_CLI",
    tags: [],
    approvedRoutes: [],
    availableRoutes: [],
    subnetRoutes: [],
    user: { id: "owner", name: "operator", createdAt: "2026-10-30T00:00:00Z" },
  };
  const selection: ResourceInput = {
    kind: "node",
    node_id: "1",
    address: "100.64.0.5",
    route: null,
    protocol: "tcp",
    ports: "8006",
  };
  const policy = '{"acls":[]}';
  const original = provisioningPreviewHash(guest, [selection], [node], policy);
  for (const changed of [
    { ...node, user: { ...node.user!, id: "different-owner" } },
    { ...node, tags: ["tag:resource"] },
    { ...node, approvedRoutes: ["10.44.0.0/24"] },
    { ...node, availableRoutes: ["10.44.0.0/24"] },
  ])
    expect(provisioningPreviewHash(guest, [selection], [changed], policy)).not.toBe(original);
  expect(
    provisioningPreviewHash(
      guest,
      [selection],
      [{ ...node, online: false, lastSeen: "later" }],
      policy,
    ),
  ).toBe(original);
  expect(provisioningPreviewHash(guest, [selection], [node, { ...node, id: "2" }], policy)).toBe(
    original,
  );
  expect(provisioningPreviewHash({ ...guest, revision: 2 }, [selection], [node], policy)).not.toBe(
    original,
  );
  expect(
    provisioningPreviewHash(guest, [{ ...selection, ports: "8007" }], [node], policy),
  ).not.toBe(original);
  expect(provisioningPreviewHash(guest, [selection], [node], '{"acls":[],"groups":{}}')).not.toBe(
    original,
  );
});

test("canonical policy hashes ignore formatting and object-key order but retain rule meaning", () => {
  expect(policyHash('{"acls":[],"groups":{}}')).toBe(
    policyHash('// comment\n{"groups": {}, "acls": [],}'),
  );
  expect(policyHash('{"acls":[]}')).not.toBe(policyHash('{"grants":[]}'));
});

test.each([
  '{"acls":[],"acls":[{"src":["*"]}]}',
  '{"acls":null}',
  '{"ssh": [{"src":["*"]}]}',
  '{"nodeAttrs":[]}',
  '{"acls":[{"action":"accept","src":["autogroup:internet"],"dst":["*:*"]}]}',
])("ambiguous or unsupported policy cannot be treated as isolated: %s", (policy) => {
  expect(() => verifyIsolation(policy, user, [])).toThrow("Guest isolation cannot be guaranteed");
});

describe("positive permissions cannot be narrowed by adding another rule", () => {
  test.each(["*", "autogroup:member", `${user}@`, user, "100.64.0.0/10", "autogroup:danger"])(
    'blocks source "%s"',
    (source) => {
      expect(() =>
        verifyIsolation(
          JSON.stringify({ acls: [{ action: "accept", src: [source], dst: ["*:*"] }] }),
          user,
          [],
        ),
      ).toThrow("Guest isolation cannot be guaranteed");
    },
  );
  test("blocks an indirect nested guest group and detects cycles", () => {
    for (const members of [[`${user}@`], ["group:outer"]]) {
      const policy = {
        groups: { "group:outer": ["group:inner"], "group:inner": members },
        grants: [{ src: ["group:outer"], dst: ["*"], ip: ["*"] }],
      };
      expect(() => verifyIsolation(JSON.stringify(policy), user, [])).toThrow(
        "Guest isolation cannot be guaranteed",
      );
    }
  });
  test("blocks tag acquisition through group ownership before registration", () => {
    const policy = {
      groups: { "group:guests": [`${user}@`] },
      tagOwners: { "tag:admin": ["group:guests"] },
      grants: [{ src: ["tag:admin"], dst: ["*"], ip: ["*"] }],
    };
    expect(() => verifyIsolation(JSON.stringify(policy), user, [])).toThrow(
      "guest can acquire a tag",
    );
  });
});

test("exact generated permissions are removable while unrelated manual rules survive", () => {
  const original =
    '{"groups":{"group:staff":["alice@"]},"acls":[{"action":"accept","src":["group:staff"],"dst":["*:*"]}]}';
  const candidate = changeGuestPermission(original, null, permission, []);
  expect(() => verifyIsolation(candidate, user, [permission])).not.toThrow();
  const removed = changeGuestPermission(candidate, permission, null, [permission]);
  expect(parseVpnPolicy(removed)).toEqual(parseVpnPolicy(original));
  expect(() => verifyIsolation(removed, user, [])).not.toThrow();
});

test("manual edits of managed rules or identity groups block cleanup instead of being overwritten", () => {
  const candidate = changeGuestPermission('{"acls":[]}', null, permission, []);
  for (const changed of [candidate.replace("8006", "*"), candidate.replace(`${user}@`, "alice@")])
    expect(() => changeGuestPermission(changed, permission, null, [permission])).toThrow(
      "Guest isolation cannot be guaranteed",
    );
});

test("a reserved generated-group collision is never adopted", () => {
  expect(() =>
    changeGuestPermission(
      JSON.stringify({ groups: { [group]: ["alice@"] }, acls: [] }),
      null,
      permission,
      [],
    ),
  ).toThrow("collides");
});

test("shared tags owned only by another user do not imply guest membership", () => {
  expect(() =>
    verifyIsolation(
      '{"tagOwners":{"tag:agent":["operator@"]},"grants":[{"src":["tag:agent"],"dst":["*"],"ip":["*"]}]}',
      user,
      [],
    ),
  ).not.toThrow();
});
