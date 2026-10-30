import { createHash, randomBytes } from "node:crypto";

import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { ulid } from "ulidx";

import type { Machine } from "~/types";
import { accessDurationLabel } from "~/utils/guest-access";
import type { ResourceInput } from "~/utils/guest-resources";
import log from "~/utils/log";

import type { HeadplaneConfig } from "./config/config-schema";
import { ConfigError } from "./config/error";
import {
  guests,
  guestInvitations,
  guestResources,
  guestVpnAccess as access,
  guestVpnAuthClaims as claims,
  guestVpnDevices as devices,
  guestVpnEvents as events,
  guestVpnSessions as sessions,
  users as accounts,
  type GuestVpnAccess,
} from "./db/schema";
import { createGuestPolicyWriter } from "./guest-policy-writer";
import {
  accessDeadline,
  canTransition,
  retryDeadline,
  reconciliationDue,
  deviceHasExpired,
} from "./guest-vpn-lifecycle";
import {
  changeGuestPermission,
  GuestVpnError,
  guestPolicyIdentity,
  requestedPermission,
  provisioningPreviewHash,
  policyHash,
  verifyIsolation,
  vpnAssert,
} from "./guest-vpn-policy";
import type { Headscale } from "./headscale/api";
import { guestBuildCompatibility } from "./headscale/api/build-info";
import { invitationToken, tokenHash, validInvitationToken } from "./invitation-tokens";
import { err, ok, type Result } from "./result";

export type GuestVpnResult<T> = Result<T, { code: string; message: string }>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const safeNode = (n: Machine, tracked: boolean) => ({
  id: n.id,
  name: n.givenName || n.name,
  addresses: n.ipAddresses,
  online: n.online,
  lastSeen: n.lastSeen,
  expiry: !n.expiry || Date.parse(n.expiry) <= 0 ? null : n.expiry,
  tracked,
});
const resourceInput = ({
  kind,
  node_id,
  address,
  route,
  protocol,
  ports,
}: ResourceInput): ResourceInput => ({ kind, node_id, address, route, protocol, ports });

export function createGuestVpnService(options: {
  db: NodeSQLiteDatabase;
  headscale: Headscale;
  config: HeadplaneConfig;
  verifiedInvitation(session: string): string | null;
}) {
  const { db, headscale, config } = options;
  const approvals = config.headscale.compatibility?.approved_builds;
  const compatibility = guestBuildCompatibility(headscale.build, approvals);
  const compatible = ["supported_release", "approved_build"].includes(compatibility);
  const enabled = Boolean(
    config.guest_vpn?.enabled &&
    config.guest_vpn.single_policy_writer &&
    config.headscale.api_key &&
    compatible,
  );
  const reason = !config.guest_vpn?.enabled
    ? "Guest VPN provisioning is disabled."
    : !config.guest_vpn.single_policy_writer
      ? "Guest VPN requires the exclusive Headplane policy-writer contract."
      : !compatible
        ? `Guest VPN requires supported Headscale 0.29 or an explicitly approved build (${compatibility}).`
        : !config.headscale.api_key
          ? "Guest VPN requires a server-side Headscale API key for recovery and expiry."
          : null;
  const api = config.headscale.api_key
    ? headscale.client(config.headscale.api_key, { timeoutMs: 15_000 })
    : undefined;
  const writer = createGuestPolicyWriter(db);
  if (
    !enabled &&
    db
      .select()
      .from(access)
      .all()
      .some((a) => !["not_provisioned", "revoked", "expired"].includes(a.state))
  )
    throw ConfigError.from("INVALID_REQUIRED_FIELDS", {
      messages: [
        "Revoke and verify every guest VPN access before disabling guest_vpn, changing its policy-writer contract, removing its API key or using an unsupported Headscale build.",
      ],
    });
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<unknown> | undefined;
  let stopping = false;
  const record = (id: string) => db.select().from(access).where(eq(access.guest_id, id)).get();
  const selections = (id: string) =>
    db
      .select()
      .from(guestResources)
      .where(eq(guestResources.guest_id, id))
      .all()
      .map(resourceInput);
  function audit(
    id: string,
    kind: string,
    actor: string | null = null,
    node: string | null = null,
    code: string | null = null,
  ) {
    db.insert(events)
      .values({
        id: ulid(),
        guest_id: id,
        kind,
        actor_id: actor,
        node_id: node,
        code,
        created_at: new Date(),
      })
      .run();
  }
  function update(id: string, values: Partial<typeof access.$inferInsert>) {
    const previous = record(id);
    if (previous && values.state)
      vpnAssert(
        canTransition(previous.state, values.state),
        "state",
        "Invalid network access state transition.",
      );
    const changed = Object.keys(values).some((key) => key !== "last_sync_at");
    db.update(access)
      .set({
        ...values,
        ...(changed ? { updated_at: new Date(), revision: sql`${access.revision} + 1` } : {}),
      })
      .where(eq(access.guest_id, id))
      .run();
  }
  let loggedBuild: string | null = null;
  async function requireEnabled(verifyBuild = false) {
    vpnAssert(enabled && api, "disabled", reason ?? "Guest VPN is unavailable.");
    // Revocation requests must remain durable during a control-server outage.
    // Only operations that can grant access depend on a fresh build probe.
    if (!verifyBuild) return;
    const current = await headscale.inspectBuild();
    const status = guestBuildCompatibility(current, approvals);
    vpnAssert(
      ["supported_release", "approved_build"].includes(status),
      "build_unapproved",
      "The running Headscale build is not approved. No Guest operation was started.",
    );
    vpnAssert(
      current.version.raw === headscale.build.version.raw &&
        current.fingerprint === headscale.build.fingerprint,
      "build_changed",
      "Headscale changed since startup. Review compatibility and restart Headplane.",
    );
    if (status === "approved_build" && loggedBuild !== current.fingerprint) {
      log.warn(
        "api",
        "Explicitly approved custom Headscale build accepted: %s commit=%s fingerprint=%s",
        current.version.raw,
        current.commit,
        current.fingerprint,
      );
      loggedBuild = current.fingerprint;
    }
  }
  async function protect<T>(operation: () => Promise<T>): Promise<GuestVpnResult<T>> {
    try {
      return ok(await operation());
    } catch (error) {
      return err(
        error instanceof GuestVpnError
          ? { code: error.code, message: error.message }
          : {
              code: "unavailable",
              message:
                "Guest network operation could not be verified. No success is assumed; inspect the status and retry.",
            },
      );
    }
  }
  function accepted(id: string) {
    const guest = db.select().from(guests).where(eq(guests.id, id)).get();
    const invitation = db
      .select()
      .from(guestInvitations)
      .where(eq(guestInvitations.guest_id, id))
      .get();
    vpnAssert(
      guest?.status === "draft" && invitation?.status === "accepted",
      "invitation",
      "An accepted invitation and a retained guest record are required.",
    );
    vpnAssert(
      !guest.requested_expires_at || guest.requested_expires_at.getTime() > Date.now(),
      "expired",
      "The requested absolute access deadline has already passed.",
    );
    return guest;
  }
  function due(a: GuestVpnAccess) {
    const g = db.select().from(guests).where(eq(guests.id, a.guest_id)).get();
    return Boolean(
      (a.expires_at && a.expires_at.getTime() <= Date.now()) ||
      (g?.requested_expires_at && g.requested_expires_at.getTime() <= Date.now()),
    );
  }
  function owned(a: GuestVpnAccess, node: Machine) {
    vpnAssert(
      node.user?.id === a.headscale_user_id &&
        !node.tags.length &&
        !node.availableRoutes?.length &&
        !node.approvedRoutes?.length,
      "identity",
      "Guest device ownership, tags or routes could not be verified.",
    );
    const saved = db.select().from(devices).where(eq(devices.node_id, node.id)).get();
    vpnAssert(
      !saved || (saved.guest_id === a.guest_id && saved.machine_key_hash === hash(node.machineKey)),
      "identity",
      "The device identity does not match the saved guest mapping.",
    );
  }
  async function identity(a: GuestVpnAccess) {
    const users = await api!.users.list({ id: a.headscale_user_id ?? "0" });
    vpnAssert(
      users.length === 1 &&
        users[0].id === a.headscale_user_id &&
        users[0].name === a.user_name &&
        users[0].displayName === a.user_marker &&
        !users[0].providerId &&
        !users[0].email,
      "identity",
      "The dedicated Headscale guest user was removed or changed.",
    );
    vpnAssert(
      !db.select().from(accounts).where(eq(accounts.headscale_user_id, a.headscale_user_id!)).get(),
      "identity",
      "A guest network identity must not be linked to a Headplane account.",
    );
  }
  async function expireOwned(
    a: GuestVpnAccess,
    check: () => void,
    actor: string | null = null,
    only?: string,
  ) {
    const nodes = (await api!.nodes.list()).filter(
      (n) => n.user?.id === a.headscale_user_id && (!only || n.id === only),
    );
    if (only)
      vpnAssert(
        nodes.length === 1,
        "device_missing",
        "The selected device is missing or belongs to another identity.",
      );
    for (const node of nodes) {
      check();
      // Expiration is allowed for an unknown node owned by this verified user;
      // adopting it or announcing successful registration is not.
      await api!.nodes.expire(node.id);
      const after = await api!.nodes.get(node.id);
      vpnAssert(
        after.user?.id === a.headscale_user_id && deviceHasExpired(after.expiry, Date.now() + 1000),
        "expire_unconfirmed",
        "Headscale did not confirm device expiration.",
      );
      db.update(devices)
        .set({ state: "expired", updated_at: new Date() })
        .where(and(eq(devices.node_id, node.id), eq(devices.guest_id, a.guest_id)))
        .run();
      audit(a.guest_id, "device_expired", actor, node.id);
    }
  }
  function failed(id: string, error: unknown) {
    const a = record(id);
    if (!a) return;
    const code = error instanceof GuestVpnError ? error.code : "unavailable";
    const attempts = a.attempts + 1;
    update(id, {
      state: a.desired_state === "active" ? "error" : "revoking",
      error_code: code,
      attempts,
      retry_at: retryDeadline(attempts, Date.now()),
    });
    audit(id, "operation_failed", null, null, code);
  }

  async function neutralize(a: GuestVpnAccess, check: () => void) {
    // Permission cleanup is independent of user existence. A deleted/recreated
    // user must not inherit rules selected by the reserved historical name.
    try {
      const current = await writer.current(api!, check);
      const permission = record(a.guest_id)?.permission;
      if (permission) {
        const candidate = changeGuestPermission(
          current.policy,
          permission,
          null,
          writer.permissions(),
        );
        await writer.write(api!, check, current.hash, candidate, a.guest_id, null);
        audit(a.guest_id, "policy_removed");
      }
    } catch {
      /* Never overwrite an unknown policy to attempt cleanup. */
    }
    if (a.headscale_user_id)
      try {
        await identity(a);
        await expireOwned(a, check);
      } catch {
        /* durable retry */
      }
  }

  async function revokeLocked(
    id: string,
    check: () => void,
    target: "revoked" | "expired",
    actor: string | null,
  ) {
    let a = record(id);
    vpnAssert(a, "state", "This guest has no VPN access record.");
    if (a.state === target && !a.permission) return;
    update(id, {
      state: "revoking",
      desired_state: target,
      phase: "removing_policy",
      ...(a.desired_state !== target ? { attempts: 0, retry_at: null } : {}),
    });
    audit(id, target === "expired" ? "automatic_expiration" : "revocation_requested", actor);
    try {
      const current = await writer.current(api!, check);
      a = record(id)!; // recovery may have completed a previously uncertain write
      if (a.permission) {
        const candidate = changeGuestPermission(
          current.policy,
          a.permission,
          null,
          writer.permissions(),
        );
        await writer.write(api!, check, current.hash, candidate, id, null);
        audit(id, "policy_removed", actor);
      }
      const users = a.headscale_user_id
        ? await api!.users.list({ id: a.headscale_user_id })
        : await api!.users.list({ name: a.user_name });
      if (users.length) {
        if (!a.headscale_user_id) {
          vpnAssert(
            users.length === 1 &&
              users[0].displayName === a.user_marker &&
              !users[0].email &&
              !users[0].providerId,
            "identity_collision",
            "Cannot adopt the existing Headscale identity.",
          );
          update(id, { headscale_user_id: users[0].id });
          a = record(id)!;
        }
        await identity(a);
        await expireOwned(a, check, actor);
      }
      const actual = await writer.current(api!, check);
      verifyIsolation(actual.policy, a.user_name, writer.permissions());
      const remaining = (await api!.nodes.list()).filter(
        (n) => n.user?.id === a!.headscale_user_id,
      );
      vpnAssert(
        remaining.every((n) => deviceHasExpired(n.expiry, Date.now() + 1000)),
        "expire_unconfirmed",
        "Some guest devices are still authenticated.",
      );
      update(id, {
        state: target,
        permission: null,
        revoked_at: new Date(),
        phase: "verified",
        error_code: null,
        retry_at: null,
        attempts: 0,
        last_sync_at: new Date(),
      });
      db.delete(sessions).where(eq(sessions.guest_id, id)).run();
      audit(id, target === "expired" ? "access_expired" : "access_revoked", actor);
    } catch (error) {
      // Drift must never cause a blind policy overwrite. Try to cut this
      // identity's devices even if policy cleanup needs operator intervention.
      if (a.headscale_user_id) {
        try {
          await identity(a);
          await expireOwned(a, check, actor);
        } catch {
          /* retry persists below */
        }
      }
      failed(id, error);
      throw error;
    }
  }

  async function activate(id: string, check: () => void, actor: string | null) {
    const guest = accepted(id);
    let a = record(id)!;
    await identity(a);
    let nodes = await api!.nodes.list();
    const linked = db
      .select()
      .from(devices)
      .where(and(eq(devices.guest_id, id), eq(devices.state, "registered")))
      .all();
    const guestNodes = nodes.filter(
      (n) => n.user?.id === a.headscale_user_id && !deviceHasExpired(n.expiry),
    );
    vpnAssert(
      linked.length && guestNodes.length === linked.length,
      "device_unconfirmed",
      "Guest devices must be registered and verified before activation.",
    );
    for (const node of guestNodes) {
      owned(a, node);
      vpnAssert(
        linked.some((d) => d.node_id === node.id),
        "device_unconfirmed",
        "An unknown device belongs to this identity. Review it before activation.",
      );
    }
    const current = await writer.current(api!, check);
    a = record(id)!;
    vpnAssert(
      a.preview_hash === provisioningPreviewHash(guest, selections(id), nodes, current.policy),
      "preview_changed",
      "Policy or resource inventory changed. Refresh and approve a new provisioning preview.",
    );
    const permission = requestedPermission(id, selections(id), nodes, current.policy);
    const candidate = changeGuestPermission(
      current.policy,
      a.permission,
      permission,
      writer.permissions(),
    );
    // Native Headscale key expiry bounds access even if Headplane stops. Set
    // it BEFORE granting permissions; verify support through a real read-back.
    const provisionalEnd = accessDeadline(guest, new Date());
    for (const node of guestNodes) {
      check();
      await api!.nodes.expireAt(node.id, provisionalEnd);
      const after = await api!.nodes.get(node.id);
      owned(a, after);
      vpnAssert(
        after.expiry &&
          Math.abs(new Date(after.expiry).getTime() - provisionalEnd.getTime()) < 1000,
        "expiry_unsupported",
        "Headscale did not confirm the scheduled device expiry. No access can be granted.",
      );
    }
    accepted(id);
    update(id, { phase: "applying_policy" });
    await writer.write(api!, check, current.hash, candidate, id, permission);
    audit(id, "policy_applied", actor);
    const actual = await writer.current(api!, check);
    verifyIsolation(actual.policy, a.user_name, writer.permissions());
    const activated = new Date();
    const end = accessDeadline(guest, activated);
    vpnAssert(end.getTime() > Date.now(), "expired", "Access deadline passed during provisioning.");
    for (const node of guestNodes) {
      check();
      await api!.nodes.expireAt(node.id, end);
      const after = await api!.nodes.get(node.id);
      owned(a, after);
      vpnAssert(
        after.expiry && Math.abs(new Date(after.expiry).getTime() - end.getTime()) < 1000,
        "expiry_unconfirmed",
        "The final device deadline could not be verified.",
      );
    }
    nodes = await api!.nodes.list();
    vpnAssert(
      nodes.filter((n) => n.user?.id === a.headscale_user_id && !deviceHasExpired(n.expiry))
        .length === guestNodes.length,
      "device_unconfirmed",
      "Device inventory changed during provisioning.",
    );
    check();
    update(id, {
      state: "active",
      phase: "verified",
      permission,
      activated_at: activated,
      expires_at: end,
      error_code: null,
      retry_at: null,
      attempts: 0,
      last_sync_at: new Date(),
    });
    audit(id, "access_activated", actor);
  }

  async function provision(
    id: string,
    revision: number,
    actor: string | null,
    previewHash?: string,
  ): Promise<GuestVpnResult<void>> {
    return protect(async () => {
      await requireEnabled(true);
      await writer.locked(async ({ check }) => {
        const guest = accepted(id);
        vpnAssert(
          guest.revision === revision,
          "conflict",
          "This guest changed. Reload before provisioning.",
        );
        let a = record(id);
        if (a?.state === "active") {
          try {
            const current = await writer.current(api!, check);
            await identity(a);
            verifyIsolation(current.policy, a.user_name, writer.permissions());
          } catch (error) {
            await neutralize(a, check);
            failed(id, error);
            throw error;
          }
          return;
        }
        vpnAssert(
          !a ||
            (a.desired_state === "active" && !["revoked", "expired", "revoking"].includes(a.state)),
          "state",
          "Closed VPN access cannot be provisioned again.",
        );
        const current = await writer.current(api!, check);
        const nodes = await api!.nodes.list();
        const { user } = guestPolicyIdentity(id);
        verifyIsolation(current.policy, user, writer.permissions());
        requestedPermission(id, selections(id), nodes, current.policy);
        const currentPreview = provisioningPreviewHash(
          guest,
          selections(id),
          nodes,
          current.policy,
        );
        vpnAssert(
          previewHash === currentPreview,
          "preview_changed",
          "Policy or resource inventory changed. Refresh and approve a new provisioning preview.",
        );
        if (!a) {
          vpnAssert(
            (await api!.users.list({ name: user })).length === 0,
            "identity_collision",
            "The reserved Headscale identity already exists. Do not adopt it.",
          );
          db.transaction((tx) => {
            vpnAssert(
              accepted(id).revision === revision,
              "conflict",
              "Guest intentions changed during preflight. Recalculate before provisioning.",
            );
            tx.insert(access)
              .values({
                guest_id: id,
                user_name: user,
                user_marker: `Headplane Guest ${id} ${randomBytes(16).toString("hex")}`,
                state: "provisioning",
                phase: "creating_user",
                preview_hash: currentPreview,
                created_at: new Date(),
                updated_at: new Date(),
              })
              .run();
          });
          a = record(id)!;
        }
        audit(id, "provisioning_started", actor);
        try {
          update(id, {
            state: "provisioning",
            preview_hash: currentPreview,
            error_code: null,
            retry_at: null,
          });
          if (!a.headscale_user_id) {
            check();
            let found = await api!.users.list({ name: a.user_name });
            if (!found.length)
              found = [await api!.users.create({ name: a.user_name, displayName: a.user_marker })];
            vpnAssert(
              found.length === 1 &&
                found[0].name === a.user_name &&
                found[0].displayName === a.user_marker &&
                !found[0].providerId &&
                !found[0].email,
              "identity_collision",
              "The dedicated identity marker does not match this guest.",
            );
            update(id, { headscale_user_id: found[0].id, phase: "awaiting_device" });
            audit(id, "headscale_user_created", actor);
          }
          a = record(id)!;
          await identity(a);
          const saved = db
            .select()
            .from(devices)
            .where(and(eq(devices.guest_id, id), eq(devices.state, "registered")))
            .all();
          if (saved.length) await activate(id, check, actor);
          else update(id, { phase: "awaiting_device", last_sync_at: new Date() });
        } catch (error) {
          try {
            a = record(id)!;
          } catch {
            /* keep the verified identity for emergency expiration */
          }
          await neutralize(a, check);
          failed(id, error);
          throw error;
        }
      });
    });
  }

  async function register(session: string, authId: string): Promise<GuestVpnResult<void>> {
    return protect(async () => {
      await requireEnabled(true);
      const id = sessionGuest(session);
      vpnAssert(id, "session", "The onboarding session is unavailable. Contact the administrator.");
      vpnAssert(
        /^hskey-authreq-[A-Za-z0-9_-]{16,128}$/.test(authId),
        "validation",
        "Enter the Auth ID displayed by the Tailscale registration page.",
      );
      await writer.locked(async ({ check }) => {
        accepted(id);
        let a = record(id);
        vpnAssert(
          a?.state === "provisioning" && a.phase === "awaiting_device" && !a.permission,
          "state",
          "The administrator must prepare this guest identity before device registration.",
        );
        await identity(a);
        const current = await writer.current(api!, check);
        verifyIsolation(current.policy, a.user_name, writer.permissions());
        vpnAssert(
          a.preview_hash ===
            provisioningPreviewHash(
              accepted(id),
              selections(id),
              await api!.nodes.list(),
              current.policy,
            ),
          "preview_changed",
          "Policy or resource inventory changed. Ask the administrator to approve a new provisioning preview.",
        );
        vpnAssert(
          !db
            .select()
            .from(claims)
            .where(eq(claims.auth_hash, hash(authId)))
            .get(),
          "auth_consumed",
          "This Auth ID was already submitted. Start a new registration.",
        );
        const priorNodes = (await api!.nodes.list()).filter(
          (n) => n.user?.id === a!.headscale_user_id,
        );
        for (const node of priorNodes) {
          owned(a, node);
          vpnAssert(
            deviceHasExpired(node.expiry) &&
              db
                .select()
                .from(devices)
                .where(
                  and(
                    eq(devices.node_id, node.id),
                    eq(devices.guest_id, id),
                    eq(devices.state, "expired"),
                  ),
                )
                .get(),
            "device_unconfirmed",
            "Unexpected devices exist for this identity. Request an administrator review.",
          );
        }
        db.insert(claims)
          .values({
            auth_hash: hash(authId),
            guest_id: id,
            state: "reserved",
            created_at: new Date(),
          })
          .run();
        audit(id, "device_registration_requested");
        try {
          check();
          const node = await api!.auth.register(a.user_name, authId);
          owned(a, node);
          const confirmed = await api!.nodes.get(node.id);
          owned(a, confirmed);
          vpnAssert(
            node.machineKey === confirmed.machineKey && node.nodeKey === confirmed.nodeKey,
            "identity",
            "The registered device identity was not confirmed.",
          );
          db.transaction((tx) => {
            tx.insert(devices)
              .values({
                node_id: node.id,
                guest_id: id,
                machine_key_hash: hash(node.machineKey),
                state: "registered",
                created_at: new Date(),
                updated_at: new Date(),
              })
              .onConflictDoUpdate({
                target: devices.node_id,
                set: { state: "registered", updated_at: new Date() },
              })
              .run();
            tx.update(claims)
              .set({ state: "consumed", node_id: node.id })
              .where(eq(claims.auth_hash, hash(authId)))
              .run();
          });
          audit(id, "device_registered", null, node.id);
          await activate(id, check, null);
        } catch (error) {
          try {
            db.update(claims)
              .set({ state: "uncertain" })
              .where(and(eq(claims.auth_hash, hash(authId)), eq(claims.state, "reserved")))
              .run();
          } catch {
            /* emergency cleanup must not depend on this write */
          }
          try {
            a = record(id)!;
          } catch {
            /* keep the verified identity for emergency expiration */
          }
          await neutralize(a, check);
          failed(id, error);
          throw error;
        }
      });
    });
  }

  async function revoke(id: string, revision: number, actor: string | null) {
    return protect(async () => {
      await requireEnabled();
      await writer.locked(async ({ check }) => {
        const a = record(id);
        vpnAssert(
          a && (a.revision === revision || a.state === "revoked"),
          "conflict",
          "The access record changed. Reload before revoking.",
        );
        await revokeLocked(id, check, "revoked", actor);
      });
    });
  }

  async function expireDevice(id: string, revision: number, nodeId: string, actor: string | null) {
    return protect(async () => {
      await requireEnabled();
      await writer.locked(async ({ check }) => {
        const a = record(id);
        vpnAssert(
          a && a.revision === revision,
          "conflict",
          "The access record changed. Reload before expiring a device.",
        );
        vpnAssert(
          db
            .select()
            .from(devices)
            .where(and(eq(devices.node_id, nodeId), eq(devices.guest_id, id)))
            .get(),
          "device",
          "This device is not linked to this guest.",
        );
        await identity(a);
        await expireOwned(a, check, actor, nodeId);
        await revokeLocked(id, check, "revoked", actor); // currently one interactive device per guest
      });
    });
  }

  async function reconcile(): Promise<GuestVpnResult<void>> {
    return protect(async () => {
      await requireEnabled();
      await writer.locked(async ({ check }) => {
        // Recover a policy applied immediately before a process crash. It is
        // never sufficient evidence on its own to announce active access.
        let globalError: unknown;
        try {
          await writer.current(api!, check);
        } catch (error) {
          globalError = error;
        }
        for (let a of db.select().from(access).all()) {
          if (a.state === "not_provisioned") continue;
          if (!reconciliationDue(a, due(a))) continue;
          try {
            if (["revoked", "expired"].includes(a.state)) {
              if (!a.headscale_user_id) {
                const late = await api!.users.list({ name: a.user_name });
                if (!late.length) continue;
                vpnAssert(
                  late.length === 1 &&
                    late[0].displayName === a.user_marker &&
                    !late[0].providerId &&
                    !late[0].email,
                  "identity_collision",
                  "An unexpected identity uses the reserved guest name.",
                );
                update(a.guest_id, { headscale_user_id: late[0].id });
                audit(a.guest_id, "orphan_identity_detected");
                a = record(a.guest_id)!;
              }
              const unexpected = (await api!.nodes.list()).filter(
                (n) => n.user?.id === a.headscale_user_id && !deviceHasExpired(n.expiry),
              );
              if (!unexpected.length) continue;
              await identity(a);
              audit(a.guest_id, "orphan_device_detected");
              const target = a.desired_state === "expired" ? "expired" : "revoked";
              update(a.guest_id, { state: "revoking" });
              await revokeLocked(a.guest_id, check, target, null);
              continue;
            }
            if (due(a) || a.desired_state !== "active") {
              await revokeLocked(a.guest_id, check, due(a) ? "expired" : "revoked", null);
              continue;
            }
            if (globalError) throw globalError;
            if (!a.headscale_user_id) {
              // Do not create a second identity after an ambiguous create.
              const found = await api!.users.list({ name: a.user_name });
              if (
                found.length === 1 &&
                found[0].displayName === a.user_marker &&
                !found[0].providerId &&
                !found[0].email
              )
                update(a.guest_id, { headscale_user_id: found[0].id, phase: "awaiting_device" });
              else
                throw new GuestVpnError(
                  "identity_unconfirmed",
                  "Identity creation needs administrator retry.",
                );
              a = record(a.guest_id)!;
            }
            await identity(a);
            const nodes = (await api!.nodes.list()).filter(
              (n) => n.user?.id === a.headscale_user_id && !deviceHasExpired(n.expiry),
            );
            const linked = db
              .select()
              .from(devices)
              .where(and(eq(devices.guest_id, a.guest_id), eq(devices.state, "registered")))
              .all();
            for (const missing of linked.filter((d) => !nodes.some((n) => n.id === d.node_id)))
              db.update(devices)
                .set({ state: "missing", updated_at: new Date() })
                .where(eq(devices.node_id, missing.node_id))
                .run();
            vpnAssert(
              nodes.every((n) => linked.some((d) => d.node_id === n.id)) &&
                linked.every((d) => nodes.some((n) => n.id === d.node_id)),
              "device_drift",
              "Untracked or missing guest device detected.",
            );
            for (const node of nodes) owned(a, node);
            const current = await writer.current(api!, check);
            verifyIsolation(current.policy, a.user_name, writer.permissions());
            requestedPermission(
              a.guest_id,
              selections(a.guest_id),
              await api!.nodes.list(),
              current.policy,
            );
            if (a.state === "active") {
              vpnAssert(
                nodes.length &&
                  nodes.every(
                    (n) =>
                      n.expiry &&
                      a.expires_at &&
                      Math.abs(new Date(n.expiry).getTime() - a.expires_at.getTime()) < 1000,
                  ),
                "device_drift",
                "Device expiry no longer matches guest access.",
              );
            } else if (a.permission || nodes.length) {
              // An interrupted activation or registration is neutralized. A
              // fresh administrator decision is required to grant again.
              throw new GuestVpnError(
                "interrupted",
                "Interrupted onboarding requires review and retry.",
              );
            }
            update(a.guest_id, { last_sync_at: new Date() });
          } catch (error) {
            await neutralize(a, check);
            failed(a.guest_id, error);
          }
        }
        db.delete(sessions).where(lt(sessions.expires_at, new Date())).run();
      });
    });
  }

  function sessionGuest(session: string): string | null {
    if (!validInvitationToken(session)) return null;
    return (
      db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id_hash, tokenHash(session)), gt(sessions.expires_at, new Date())))
        .get()?.guest_id ?? null
    );
  }
  function openSession(verified: string): GuestVpnResult<string> {
    if (!enabled) return err({ code: "disabled", message: reason! });
    try {
      const id = options.verifiedInvitation(verified);
      if (!id)
        return err({
          code: "session",
          message: "Email verification is required for guest onboarding.",
        });
      const session = invitationToken();
      db.insert(sessions)
        .values({
          id_hash: tokenHash(session),
          guest_id: id,
          expires_at: new Date(Date.now() + 24 * 3600_000),
        })
        .run();
      return ok(session);
    } catch {
      return err({ code: "database", message: "Could not prepare the onboarding session." });
    }
  }
  async function preview(id: string): Promise<GuestVpnResult<string>> {
    return protect(async () => {
      await requireEnabled(true);
      const guest = accepted(id);
      const [current, nodes] = await Promise.all([api!.policy.get(), api!.nodes.list()]);
      const stored = writer.status();
      vpnAssert(
        current.updatedAt &&
          !stored.pending &&
          (!stored.hash || stored.hash === policyHash(current.policy)),
        "policy_drift",
        "Policy requires reconciliation before a new provisioning preview.",
      );
      verifyIsolation(current.policy, guestPolicyIdentity(id).user, writer.permissions());
      return provisioningPreviewHash(guest, selections(id), nodes, current.policy);
    });
  }
  async function get(id: string) {
    return protect(async () => {
      const a = record(id) ?? null;
      let nodes: ReturnType<typeof safeNode>[] = [];
      let inventoryError = false;
      let effectiveStatus = "Cannot verify guest isolation";
      if (enabled && a?.headscale_user_id)
        try {
          await identity(a);
          const inventory = await api!.nodes.list();
          const ownedNodes = inventory.filter((n) => n.user?.id === a.headscale_user_id);
          nodes = ownedNodes.map((n) =>
            safeNode(
              n,
              Boolean(
                db
                  .select()
                  .from(devices)
                  .where(and(eq(devices.node_id, n.id), eq(devices.guest_id, id)))
                  .get(),
              ),
            ),
          );
          if (a.state === "active" && a.permission && !a.error_code) {
            const current = await api!.policy.get();
            const stored = writer.status();
            vpnAssert(
              !stored.pending && stored.hash === policyHash(current.policy),
              "policy_drift",
              "Policy requires reconciliation.",
            );
            verifyIsolation(current.policy, a.user_name, writer.permissions());
            requestedPermission(id, selections(id), inventory, current.policy);
            const live = ownedNodes.filter((n) => !deviceHasExpired(n.expiry));
            const linked = db
              .select()
              .from(devices)
              .where(and(eq(devices.guest_id, id), eq(devices.state, "registered")))
              .all();
            vpnAssert(
              !due(a) && linked.length && live.length === linked.length,
              "device_drift",
              "Device inventory requires reconciliation.",
            );
            for (const node of live) {
              owned(a, node);
              vpnAssert(
                linked.some((d) => d.node_id === node.id) &&
                  node.expiry &&
                  a.expires_at &&
                  Math.abs(new Date(node.expiry).getTime() - a.expires_at.getTime()) < 1000,
                "device_drift",
                "Device expiry requires reconciliation.",
              );
            }
            effectiveStatus = "Verified managed permissions";
          }
        } catch {
          inventoryError = !nodes.length;
        }
      const history = db
        .select()
        .from(events)
        .where(eq(events.guest_id, id))
        .orderBy(desc(events.created_at), desc(events.id))
        .limit(100)
        .all();
      // The ownership marker is for recovery, not display or guest output.
      const safe = a ? { ...a, user_marker: undefined } : null;
      const approval = enabled ? await preview(id) : null;
      return {
        enabled,
        reason,
        access: safe,
        nodes,
        inventoryError,
        effectiveStatus,
        previewHash: approval?.ok ? approval.value : null,
        previewError: approval && !approval.ok ? approval.error.message : null,
        events: history,
      };
    });
  }
  async function portal(session: string) {
    return protect(async () => {
      await requireEnabled();
      const id = sessionGuest(session);
      vpnAssert(id, "session", "Onboarding session unavailable. Contact the administrator.");
      const a = record(id);
      const info = await get(id);
      vpnAssert(info.ok, "unavailable", "Device status could not be verified.");
      const guest = db.select().from(guests).where(eq(guests.id, id)).get();
      vpnAssert(guest, "session", "Guest record unavailable.");
      return {
        state: a?.state ?? "not_provisioned",
        phase: a?.phase ?? null,
        expires: a?.expires_at ?? null,
        nodes: info.value.nodes,
        verified: info.value.effectiveStatus === "Verified managed permissions",
        duration: accessDurationLabel(guest),
        plannedExpires: guest.requested_expires_at,
        usesSubnetRoutes: selections(id).some((r) => r.kind === "lan"),
        loginServer: config.headscale.public_url ?? config.headscale.url,
      };
    });
  }
  function start() {
    if (!enabled || timer) return;
    stopping = false;
    const scan = () => {
      if (!running && !stopping)
        running = reconcile().finally(() => {
          running = undefined;
        });
    };
    scan();
    timer = setInterval(scan, 10_000);
    timer.unref();
  }
  async function stop() {
    stopping = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    await running;
  }
  const reservesIdentities = () =>
    Boolean(config.guest_vpn?.enabled || db.select().from(access).limit(1).get());
  const isManagedUser = (idOrName: string) =>
    (reservesIdentities() && idOrName.toLowerCase().startsWith("hp-guest-")) ||
    db
      .select()
      .from(access)
      .all()
      .some((a) => a.headscale_user_id === idOrName || a.user_name === idOrName);
  return {
    enabled,
    reason,
    writer,
    isManagedUser,
    reservesIdentities,
    get,
    portal,
    openSession,
    sessionGuest,
    provision,
    preview,
    register,
    revoke,
    expireDevice,
    reconcile,
    start,
    stop,
  };
}
export type GuestVpnService = ReturnType<typeof createGuestVpnService>;
