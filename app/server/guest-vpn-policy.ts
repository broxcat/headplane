import { createHash } from "node:crypto";

import { parseTree, type Node, type ParseError } from "jsonc-parser";

import type { Machine } from "~/types";
import type { ResourceInput } from "~/utils/guest-resources";

import { resourceCatalog, validateResources } from "./guest-resources";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Document = { [key: string]: Json };
export interface ManagedPermission {
  group: string;
  user: string;
  section: "acls" | "grants";
  rules: Document[];
}

export class GuestVpnError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GuestVpnError";
  }
}

export function vpnAssert(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new GuestVpnError(code, message);
}
export const isolationMessage = "Guest isolation cannot be guaranteed";
const isolation = (detail: string): never => {
  throw new GuestVpnError("isolation", `${isolationMessage}: ${detail}`);
};

export function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

// Do not use the editor's permissive normalizer as a security parser: it can
// discard malformed entries and unknown fields. Duplicate keys are ambiguous.
export function parseVpnPolicy(raw: string): Document {
  if (!raw.trim() || raw.length > 262144) return isolation("policy unavailable or too large");
  const errors: ParseError[] = [];
  const tree = parseTree(raw, errors, { allowTrailingComma: true });
  if (!tree || errors.length || tree.type !== "object") return isolation("invalid policy");
  function read(node: Node, depth: number): Json {
    if (depth > 30) return isolation("policy nesting exceeds the supported limit");
    if (node.type === "object") {
      const value: Document = Object.create(null);
      for (const property of node.children ?? []) {
        const [key, child] = property.children ?? [];
        if (!key || !child || Object.hasOwn(value, key.value))
          return isolation("duplicate policy key");
        value[key.value] = read(child, depth + 1);
      }
      return value;
    }
    if (node.type === "array") return (node.children ?? []).map((n) => read(n, depth + 1));
    return node.value as Json;
  }
  return read(tree, 0) as Document;
}

export function policyHash(raw: string) {
  return createHash("sha256")
    .update(canonical(parseVpnPolicy(raw)))
    .digest("hex");
}
function object(value: Json | undefined): Document {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return isolation("expected a policy object");
  return value;
}
function strings(value: Json | undefined): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    return isolation("invalid selectors");
  return value as string[];
}
function rules(value: Json | undefined): Document[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return isolation("invalid rules");
  return value.map(object);
}

export function guestPolicyIdentity(id: string) {
  vpnAssert(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id), "validation", "Invalid guest identifier.");
  return { user: `hp-guest-${id.toLowerCase()}`, group: `group:hp-guest-${id.toLowerCase()}` };
}

export function requestedPermission(
  id: string,
  raw: ResourceInput[],
  nodes: Machine[],
  policy: string,
): ManagedPermission {
  let resources: ResourceInput[];
  try {
    resources = validateResources(
      JSON.stringify(
        raw.map(({ kind, node_id, address, route, protocol, ports }) => ({
          kind,
          node_id,
          address,
          route,
          protocol,
          ports,
        })),
      ),
      resourceCatalog(nodes),
    );
  } catch {
    throw new GuestVpnError(
      "resource_drift",
      "A resource, address, port or approved subnet route changed. Recheck the saved intentions before provisioning.",
    );
  }
  vpnAssert(resources.length, "resources", "Select at least one resource before provisioning.");
  const document = parseVpnPolicy(policy);
  const section = Object.hasOwn(document, "grants") ? "grants" : "acls";
  const { user, group } = guestPolicyIdentity(id);
  return {
    user,
    group,
    section,
    rules: resources.map((r): Document =>
      section === "grants"
        ? {
            src: [group],
            dst: [r.address],
            ip: r.ports.split(",").map((p) => `${r.protocol}:${p}`),
          }
        : {
            action: "accept",
            src: [group],
            dst: r.ports.split(",").map((p) => `${r.address}:${p}`),
            proto: r.protocol,
          },
    ),
  };
}

// Supported proof deliberately excludes unknown extensions. No restrictive
// addition can cancel an existing positive authorization.
export function verifyIsolation(raw: string, user: string, managed: ManagedPermission[]) {
  const document = parseVpnPolicy(raw);
  for (const key of Object.keys(document))
    if (
      !["groups", "tagOwners", "hosts", "acls", "grants", "ssh", "autoApprovers", "tests"].includes(
        key,
      )
    )
      isolation(`unsupported policy section ${key}`);
  if (rules(document.ssh).length) isolation("SSH rules require separate analysis");
  if (document.autoApprovers && Object.keys(object(document.autoApprovers)).length)
    isolation("automatic route approvals are not supported for guests");
  const groups =
    document.groups === undefined ? (Object.create(null) as Document) : object(document.groups);
  const reference = `${user}@`;
  function matches(selector: string, seen = new Set<string>()): boolean {
    if (document.hosts && Object.hasOwn(object(document.hosts), selector))
      return isolation("source host aliases require separate identity resolution");
    if (
      selector === reference ||
      selector === user ||
      selector === "*" ||
      selector === "autogroup:member"
    )
      return true;
    if (selector.startsWith("group:")) {
      if (seen.has(selector) || !Object.hasOwn(groups, selector))
        return isolation("unknown or cyclic group");
      return strings(groups[selector]).some((member) =>
        matches(member, new Set([...seen, selector])),
      );
    }
    if (selector.startsWith("tag:")) return false; // ownership is checked below; guest nodes must be untagged
    if (selector.endsWith("@") && /^[a-zA-Z0-9._@+-]+$/.test(selector)) return false;
    return isolation("unresolved source selector or autogroup");
  }
  if (document.tagOwners)
    for (const owners of Object.values(object(document.tagOwners)))
      if (strings(owners).some((owner) => matches(owner))) isolation("guest can acquire a tag");

  for (const permission of managed) {
    if (canonical(groups[permission.group] ?? null) !== canonical([`${permission.user}@`]))
      isolation("managed identity group changed");
    const actual = rules(document[permission.section]).filter((rule) =>
      strings(rule.src).includes(permission.group),
    );
    if (canonical(actual) !== canonical(permission.rules)) isolation("managed rules changed");
  }
  for (const section of ["acls", "grants"] as const) {
    for (const rule of rules(document[section])) {
      const sources = strings(rule.src);
      const owned = managed.some(
        (p) => p.section === section && p.rules.some((r) => canonical(r) === canonical(rule)),
      );
      if (sources.some((source) => matches(source)) && !owned)
        isolation("existing rule authorizes the guest outside managed permissions");
      // Unknown fields may change selector meaning, even on otherwise unrelated rules.
      const known = section === "acls" ? ["action", "src", "dst", "proto"] : ["src", "dst", "ip"];
      if (Object.keys(rule).some((key) => !known.includes(key)))
        isolation("unsupported rule extension");
      if (section === "acls" && rule.action !== "accept") isolation("unsupported ACL action");
      strings(rule.dst);
      if (section === "grants") strings(rule.ip);
    }
  }
  return document;
}

export function changeGuestPermission(
  raw: string,
  before: ManagedPermission | null,
  after: ManagedPermission | null,
  all: ManagedPermission[],
): string {
  const target = after ?? before;
  vpnAssert(target, "state", "No managed permission to change.");
  const document = verifyIsolation(raw, target.user, all);
  const groups =
    document.groups === undefined ? (Object.create(null) as Document) : object(document.groups);
  if (before) {
    document[before.section] = rules(document[before.section]).filter(
      (r) => !before.rules.some((old) => canonical(old) === canonical(r)),
    );
    delete groups[before.group];
  } else if (Object.hasOwn(groups, target.group))
    isolation("managed group collides with a manual group");
  if (after) {
    groups[after.group] = [`${after.user}@`];
    document[after.section] = [...rules(document[after.section]), ...after.rules];
  }
  document.groups = groups;
  const candidate = JSON.stringify(document, null, 2);
  const next = [...all.filter((p) => p.group !== target.group), ...(after ? [after] : [])];
  verifyIsolation(candidate, target.user, next);
  for (const permission of next) verifyIsolation(candidate, permission.user, next);
  return candidate;
}
