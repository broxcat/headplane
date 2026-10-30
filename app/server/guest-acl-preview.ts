import { createHash } from "node:crypto";
import { isIP } from "node:net";

import { hasPortSpec, parsePolicy } from "~/utils/acl-policy";
import { parseResourcePorts, type ResourceInput, type ResourceNode } from "~/utils/guest-resources";

import { canonicalAddress, validateResources } from "./guest-resources";

export interface PreviewIssue {
  code: string;
  message: string;
  rule?: string;
}
export function previewGuestAcl(options: {
  resources: ResourceInput[];
  nodes: ResourceNode[];
  catalogError?: string | null;
  policy: string | null;
  supportsGrants: boolean;
  versionKnown: boolean;
}) {
  const issues: PreviewIssue[] = [
    {
      code: "identity_unbound",
      message:
        "Cannot verify guest isolation: no dedicated Headscale guest identity or device has been provisioned. Email acceptance is not a network identity.",
    },
  ];
  const conflicts: PreviewIssue[] = [];
  const existing: {
    rule: string;
    sources: string[];
    destinations: string[];
    permissions: string[];
  }[] = [];
  const valid: ResourceInput[] = [];
  for (const resource of options.resources) {
    const { kind, node_id, address, route, protocol, ports } = resource;
    try {
      valid.push(
        ...validateResources(
          JSON.stringify([{ kind, node_id, address, route, protocol, ports }]),
          options.nodes,
        ),
      );
    } catch {
      issues.push({
        code: "stale_resource",
        message: `Resource ${address}: machine removed, address changed or subnet route no longer announced and approved. Reselect before future provisioning.`,
      });
    }
    const node = options.nodes.find((n) => n.id === node_id);
    if (node && !node.online)
      issues.push({
        code: "offline",
        message: `Machine ${node.name} is offline. Approval and route advertisement do not prove service reachability.`,
      });
    if (node?.tags.length)
      issues.push({
        code: "shared_tags",
        message: `Machine ${node.name} has tags. Shared-tag rules may include other machines; templates use literal addresses instead.`,
      });
    if (kind === "lan")
      issues.push({
        code: "subnet",
        message: `LAN resource ${address} depends on its router and route. SNAT, forwarding, local firewalls and return paths have not been verified.`,
      });
  }
  if (options.catalogError)
    issues.push({ code: "catalog_unavailable", message: options.catalogError });
  if (!options.resources.length)
    issues.push({
      code: "no_resources",
      message:
        "No resources requested. Empty intentions do not override existing network permissions.",
    });
  if (!options.versionKnown)
    issues.push({
      code: "unknown_version",
      message: "Headscale version is unknown; policy compatibility cannot be verified.",
    });

  function outsidePlan(target: string, ports: string, protocols: string[]): boolean | null {
    if (target === "*") return true;
    if (!isIP(target)) return null; // aliases, CIDRs, tags and users require the real policy engine
    let address: string;
    try {
      address = canonicalAddress(target);
    } catch {
      return null;
    }
    let ranges: number[][];
    if (ports === "*") ranges = [[1, 65535]];
    else {
      if (!/^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/.test(ports)) return null;
      ranges = ports.split(",").map((s) => {
        const [a, b = a] = s.split("-").map(Number);
        return [a, b];
      });
      if (ranges.some(([a, b]) => a < 1 || b > 65535 || a > b)) return null;
    }
    return protocols.some((proto) =>
      ranges.some(([a, b]) => {
        const allowed = valid
          .filter((r) => r.address === address && r.protocol === proto)
          .flatMap((r) => parseResourcePorts(r.ports));
        // Each stored plan is non-overlapping. A policy range must fit entirely.
        let cursor = a;
        for (const [low, high] of allowed.sort((x, y) => x[0] - y[0])) {
          if (low > cursor) break;
          if (high >= cursor) cursor = high + 1;
        }
        return cursor <= b;
      }),
    );
  }
  const raw = options.policy;
  let parsed: ReturnType<typeof parsePolicy> | null = null;
  try {
    parsed = raw !== null && raw.length <= 262144 ? parsePolicy(raw) : null;
  } catch {
    /* Malformed/deep policy input must fail closed. */
  }
  if (!parsed || !parsed.ok || !raw?.trim()) {
    issues.push({
      code: "policy_unavailable",
      message:
        "Current policy is missing, unreadable, too large or invalid. Do not assume an empty or default-deny policy.",
    });
  } else {
    const p = parsed.policy;
    if (p.grants.length && !options.supportsGrants)
      issues.push({
        code: "incompatible_grants",
        message: "The connected Headscale version does not support grants.",
      });
    if (Object.keys(p.extra).length || p.ssh.length || Object.keys(p.autoApprovers.extra).length)
      issues.push({
        code: "unassessed_semantics",
        message:
          "SSH, policy extensions, capabilities and other unmodeled semantics are not included in this network analysis.",
      });
    for (const [name, members] of Object.entries(p.groups)) {
      issues.push({
        code: "group_membership",
        message: `${name}: ${members.length} member selectors. Future guest membership and nested/cyclic groups have not been proven absent.`,
      });
    }
    if (Object.keys(p.tagOwners).length)
      issues.push({
        code: "tag_ownership",
        message:
          "Tag ownership and reusable shared tags can widen permissions. The future guest must not inherit a privileged tag or owner identity.",
      });
    for (const [index, rule] of p.acls.entries()) {
      const ref = `acls[${index}]`;
      existing.push({
        rule: ref,
        sources: rule.src,
        destinations: rule.dst,
        permissions: [rule.proto ?? "TCP and UDP"],
      });
      if (rule.action !== "accept" || Object.keys(rule.extra).length)
        issues.push({
          code: "unknown_acl",
          rule: ref,
          message: "Unknown ACL action or fields; evaluation is incomplete.",
        });
      const protocols =
        rule.proto === undefined
          ? ["tcp", "udp"]
          : rule.proto === "6"
            ? ["tcp"]
            : rule.proto === "17"
              ? ["udp"]
              : [rule.proto];
      for (const dst of rule.dst) {
        const split = hasPortSpec(dst) ? dst.lastIndexOf(":") : -1;
        const target = split < 0 ? dst : dst.slice(0, split);
        const ports = split < 0 ? "" : dst.slice(split + 1);
        if (target === "*" || ports.includes("*"))
          issues.push({
            code: "wildcard",
            rule: ref,
            message: `Broad destination or ports: ${dst}. Adding a narrower rule removes no existing permissions.`,
          });
        const outside = outsidePlan(
          Object.hasOwn(p.hosts, target) ? p.hosts[target] : target,
          ports,
          protocols,
        );
        if (
          rule.action === "accept" &&
          !Object.keys(rule.extra).length &&
          rule.src.includes("*") &&
          outside === true
        )
          conflicts.push({
            code: "universal_access",
            rule: ref,
            message: `Every source is allowed ${dst} (${protocols.join(", ")}) beyond this guest's requested plan.`,
          });
        if (outside === null)
          issues.push({
            code: "unresolved_destination",
            rule: ref,
            message: `Cannot fully resolve ${dst}; users, tags, CIDRs and aliases may expand beyond the selected machines.`,
          });
      }
      if (!rule.src.includes("*"))
        issues.push({
          code: "unresolved_source",
          rule: ref,
          message:
            "Source users, IPs, groups, tags or autogroups may match a future guest. No identity binding exists to exclude them.",
        });
    }
    for (const [index, rule] of p.grants.entries()) {
      const ref = `grants[${index}]`;
      existing.push({ rule: ref, sources: rule.src, destinations: rule.dst, permissions: rule.ip });
      if (rule.via.length || Object.keys(rule.extra).length)
        issues.push({
          code: "grant_extensions",
          rule: ref,
          message:
            "Grant via/app/extra semantics need Headscale evaluation and are not proven isolated.",
        });
      for (const target of rule.dst)
        for (const permission of rule.ip) {
          const match = /^(tcp|udp):(.*)$/.exec(permission);
          const outside =
            permission === "*"
              ? true
              : match
                ? outsidePlan(Object.hasOwn(p.hosts, target) ? p.hosts[target] : target, match[2], [
                    match[1],
                  ])
                : null;
          if (target === "*" || permission.includes("*"))
            issues.push({
              code: "wildcard",
              rule: ref,
              message: `Broad grant: ${target}, ${permission}. Restrictive additions do not cancel this permission.`,
            });
          if (
            !rule.via.length &&
            !Object.keys(rule.extra).length &&
            rule.src.includes("*") &&
            outside === true
          )
            conflicts.push({
              code: "universal_access",
              rule: ref,
              message: `This grant applies to every source and permits ${target} (${permission}) beyond the requested plan.`,
            });
          if (outside === null)
            issues.push({
              code: "unresolved_grant",
              rule: ref,
              message: "Grant destinations or protocols could not be fully resolved.",
            });
        }
      if (!rule.src.includes("*"))
        issues.push({
          code: "unresolved_source",
          rule: ref,
          message:
            "Grant source membership is unresolved for the future guest, including autogroups and shared tags.",
        });
    }
  }
  return {
    status: conflicts.length ? "Existing policy conflict" : "Cannot verify guest isolation",
    issues: issues.slice(0, 100),
    conflicts: conflicts.slice(0, 100),
    existing: existing.slice(0, 100),
    truncated: issues.length > 100 || conflicts.length > 100 || existing.length > 100,
    policyHash: raw === null ? null : createHash("sha256").update(raw).digest("hex"),
    checkedAt: new Date().toISOString(),
    proposed: valid.map((r) => ({
      action: "accept",
      src: ["<guest-identity:unbound>"],
      dst: [`${r.address}:${r.ports}`],
      proto: r.protocol,
    })),
  };
}
