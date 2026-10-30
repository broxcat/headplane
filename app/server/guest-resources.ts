import { BlockList, isIP } from "node:net";

import { and, eq, sql } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { ulid } from "ulidx";
import * as v from "valibot";

import type { Machine } from "~/types";
import { canonicalPorts, type ResourceInput, type ResourceNode } from "~/utils/guest-resources";

import type { Guest, GuestResource } from "./db/schema";
import { guests, guestResources, guestVpnAccess } from "./db/schema";
import type { GuestResult } from "./guests";
import { ok, err } from "./result";
import { ActionError } from "./web/actions";

const inputSchema = v.array(
  v.strictObject({
    kind: v.picklist(["node", "lan"]),
    node_id: v.pipe(v.string(), v.regex(/^[1-9]\d{0,19}$/)),
    address: v.pipe(v.string(), v.maxLength(64)),
    route: v.nullable(v.pipe(v.string(), v.maxLength(80))),
    protocol: v.picklist(["tcp", "udp"]),
    ports: v.pipe(v.string(), v.maxLength(512)),
  }),
);

export function resourceCatalog(nodes: Machine[]): ResourceNode[] {
  return nodes.map((n) => ({
    id: n.id,
    name: n.givenName || n.name,
    addresses: n.ipAddresses,
    owner: n.user?.displayName || n.user?.name || null,
    tags: n.tags,
    online: n.online,
    announced: n.availableRoutes ?? [],
    approved: n.approvedRoutes ?? [],
  }));
}

export function canonicalAddress(address: string) {
  if (address.includes("%") || !isIP(address))
    throw new ActionError("Use a literal IP address, without a zone, port or hostname.");
  return isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : address;
}

export function inRoute(address: string, route: string) {
  try {
    const [network, bits, ...rest] = route.split("/");
    if (
      rest.length ||
      !/^\d{1,3}$/.test(bits ?? "") ||
      !isIP(network) ||
      isIP(network) !== isIP(address)
    )
      return false;
    const prefix = Number(bits);
    if (prefix <= 0 || prefix > (isIP(network) === 4 ? 32 : 128)) return false;
    const list = new BlockList();
    const family = isIP(network) === 4 ? "ipv4" : "ipv6";
    list.addSubnet(network, prefix, family);
    return list.check(address, family);
  } catch {
    return false;
  }
}

export function validateResources(raw: string, nodes: ResourceNode[]): ResourceInput[] {
  if (raw.length > 24000) throw new ActionError("Use at most 50 resources.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ActionError("Invalid resource selection.");
  }
  const parsed = v.safeParse(inputSchema, value);
  if (!parsed.success || parsed.output.length > 50)
    throw new ActionError(
      "Check the resource type, machine, protocol and ports (at most 50 resources).",
    );
  const seen = new Set<string>();
  return parsed.output.map((item) => {
    const address = canonicalAddress(item.address);
    const node = nodes.find((n) => n.id === item.node_id);
    if (!node)
      throw new ActionError("A selected machine was removed. Reload the machine list.", 409);
    if (item.kind === "node") {
      if (item.route !== null || !node.addresses.some((ip) => canonicalAddress(ip) === address))
        throw new ActionError("A machine address changed. Reselect its current address.", 409);
    } else {
      // LAN declarations are explicit private IPs, never discovery or exit routes.
      if (
        !["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"].some((r) =>
          inRoute(address, r),
        )
      )
        throw new ActionError("LAN resources must use a private IPv4 or IPv6 ULA address.");
      if (nodes.some((n) => n.addresses.some((ip) => canonicalAddress(ip) === address)))
        throw new ActionError(
          "This address is a Headscale machine. Select it as a machine instead.",
        );
      if (
        !item.route ||
        !node.announced.includes(item.route) ||
        !node.approved.includes(item.route) ||
        !inRoute(address, item.route)
      )
        throw new ActionError(
          "Choose a currently announced and approved subnet route containing this address.",
          409,
        );
    }
    const key = `${address}/${item.protocol}`;
    if (seen.has(key))
      throw new ActionError("Combine duplicate targets and protocols into one resource.");
    seen.add(key);
    let ports: string;
    try {
      ports = canonicalPorts(item.ports);
    } catch (e) {
      throw new ActionError(e instanceof Error ? e.message : "Invalid ports.");
    }
    return { ...item, address, ports };
  });
}

export function createGuestResourceService(db: NodeSQLiteDatabase) {
  function list(id: string): GuestResult<GuestResource[]> {
    try {
      return ok(db.select().from(guestResources).where(eq(guestResources.guest_id, id)).all());
    } catch {
      return err({ code: "database", message: "Couldn't load resource intentions. Try again." });
    }
  }
  function save(
    id: string,
    revision: number,
    raw: string,
    nodes: ResourceNode[],
  ): GuestResult<Guest> {
    try {
      const resources = validateResources(raw, nodes);
      return ok(
        db.transaction((tx) => {
          const access = tx
            .select()
            .from(guestVpnAccess)
            .where(eq(guestVpnAccess.guest_id, id))
            .get();
          if (access && !["revoked", "expired", "not_provisioned"].includes(access.state))
            throw new ActionError(
              "Revoke and verify guest network access before changing resource intentions.",
              409,
            );
          const now = new Date();
          const changed = tx
            .update(guests)
            .set({ revision: sql`${guests.revision} + 1`, updated_at: now })
            .where(
              and(eq(guests.id, id), eq(guests.revision, revision), eq(guests.status, "draft")),
            )
            .returning()
            .get();
          if (!changed)
            throw new ActionError(
              "This guest changed or was revoked. Reload before saving resources.",
              409,
            );
          const previous = tx
            .select()
            .from(guestResources)
            .where(eq(guestResources.guest_id, id))
            .all();
          tx.delete(guestResources).where(eq(guestResources.guest_id, id)).run();
          for (const resource of resources) {
            const old = previous.find(
              (r) =>
                r.kind === resource.kind &&
                r.node_id === resource.node_id &&
                r.address === resource.address &&
                r.protocol === resource.protocol,
            );
            tx.insert(guestResources)
              .values({
                ...resource,
                id: old?.id ?? ulid(),
                guest_id: id,
                created_at: old?.created_at ?? now,
                updated_at: now,
                revision: (old?.revision ?? 0) + 1,
              })
              .run();
          }
          return changed;
        }),
      );
    } catch (e) {
      if (e instanceof ActionError)
        return err({ code: e.status === 409 ? "conflict" : "validation", message: e.message });
      return err({
        code: "database",
        message: "Couldn't save resource intentions. No changes were saved.",
      });
    }
  }
  return { list, save };
}
