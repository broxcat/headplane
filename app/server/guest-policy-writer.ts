import { randomUUID } from "node:crypto";

import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { ulid } from "ulidx";

import { guestVpnAccess, guestVpnEvents, guestVpnPolicyState as state } from "./db/schema";
import {
  GuestVpnError,
  policyHash,
  verifyIsolation,
  vpnAssert,
  type ManagedPermission,
} from "./guest-vpn-policy";
import type { HeadscaleClient } from "./headscale/api";

export function createGuestPolicyWriter(db: NodeSQLiteDatabase) {
  db.insert(state).values({ id: 1 }).onConflictDoNothing().run();
  const read = () => db.select().from(state).where(eq(state.id, 1)).get()!;
  const permissions = () =>
    db
      .select()
      .from(guestVpnAccess)
      .all()
      .flatMap((a) => (a.permission ? [a.permission] : []));

  async function locked<T>(operation: (lease: { check(): void }) => Promise<T>): Promise<T> {
    const owner = randomUUID();
    const claimed = db
      .update(state)
      .set({ owner, lease_until: new Date(Date.now() + 120_000) })
      .where(and(eq(state.id, 1), or(isNull(state.owner), lt(state.lease_until, new Date()))))
      .returning()
      .get();
    vpnAssert(
      claimed,
      "busy",
      "Another policy or guest operation is running. Retry after it finishes.",
    );
    const check = () => {
      const updated = db
        .update(state)
        .set({ lease_until: new Date(Date.now() + 120_000) })
        .where(and(eq(state.id, 1), eq(state.owner, owner), gt(state.lease_until, new Date())))
        .returning()
        .get();
      vpnAssert(updated, "lease_lost", "The policy lease was lost. Reconciliation is required.");
    };
    try {
      return await operation({ check });
    } finally {
      db.update(state).set({ owner: null, lease_until: null }).where(eq(state.owner, owner)).run();
    }
  }

  async function recover(api: HeadscaleClient, check: () => void, fromReply = false) {
    const stored = read();
    if (!stored.candidate_policy) return;
    check();
    const actual = policyHash((await api.policy.get()).policy);
    const candidate = policyHash(stored.candidate_policy);
    const before = stored.before_policy ? policyHash(stored.before_policy) : null;
    vpnAssert(
      actual === candidate || actual === before,
      "policy_drift",
      "Policy changed outside Headplane. Do not overwrite it; review the drift.",
    );
    vpnAssert(
      actual === candidate,
      "policy_uncertain",
      "The interrupted policy write is not confirmed. Operator review is required before releasing its journal; do not resend a potentially in-flight write.",
    );
    check();
    db.transaction((tx) => {
      if (actual === candidate && stored.pending_guest_id) {
        tx.update(guestVpnAccess)
          .set({
            permission: stored.pending_remove ? null : stored.pending_permission,
            phase: "policy_verified",
          })
          .where(eq(guestVpnAccess.guest_id, stored.pending_guest_id))
          .run();
        if (!fromReply)
          tx.insert(guestVpnEvents)
            .values({
              id: ulid(),
              guest_id: stored.pending_guest_id,
              kind: stored.pending_remove ? "policy_removed" : "policy_applied",
              code: "readback_recovery",
              created_at: new Date(),
            })
            .run();
      }
      tx.update(state)
        .set({
          expected_hash: actual,
          candidate_policy: null,
          pending_guest_id: null,
          pending_permission: null,
          pending_remove: false,
        })
        .where(eq(state.id, 1))
        .run();
    });
  }

  async function current(api: HeadscaleClient, check: () => void) {
    await recover(api, check);
    check();
    const readback = await api.policy.get();
    vpnAssert(
      readback.updatedAt,
      "policy_read_only",
      "Guest VPN access requires a policy stored in the Headscale database.",
    );
    const hash = policyHash(readback.policy);
    const stored = read();
    vpnAssert(
      !stored.expected_hash || stored.expected_hash === hash,
      "policy_drift",
      "Policy changed outside Headplane. Expire guest devices and review the drift before writing.",
    );
    return { ...readback, hash };
  }

  async function write(
    api: HeadscaleClient,
    check: () => void,
    expected: string,
    candidate: string,
    guestId?: string,
    permission?: ManagedPermission | null,
  ) {
    const before = await current(api, check);
    vpnAssert(
      before.hash === expected,
      "policy_conflict",
      "Policy changed. Recalculate before retrying.",
    );
    await api.policy.check(candidate);
    check();
    const fresh = await api.policy.get();
    vpnAssert(
      policyHash(fresh.policy) === expected,
      "policy_conflict",
      "Policy changed during validation. No policy was written.",
    );
    // The before image is retained for operator review, never automatically
    // restored over a newer policy. The pending candidate survives lost replies.
    db.update(state)
      .set({
        before_policy: fresh.policy,
        candidate_policy: candidate,
        pending_guest_id: guestId ?? null,
        pending_permission: permission ?? null,
        pending_remove: permission === null,
      })
      .where(eq(state.id, 1))
      .run();
    check();
    try {
      await api.policy.set(candidate);
    } catch {
      throw new GuestVpnError(
        "policy_uncertain",
        "Policy result is uncertain. Reconciliation will verify Headscale before any retry.",
      );
    }
    await recover(api, check, true);
    vpnAssert(
      read().expected_hash === policyHash(candidate),
      "policy_conflict",
      "Policy read-back did not confirm the candidate.",
    );
  }

  async function edit(api: HeadscaleClient, expected: string, candidate: string) {
    return locked(async ({ check }) => {
      const active = permissions();
      // Failed/revoked identities remain reserved too. A broad editor change
      // must not revive an authenticated device while cleanup is incomplete.
      for (const a of db.select().from(guestVpnAccess).all())
        verifyIsolation(candidate, a.user_name, active);
      const progressing = db
        .select()
        .from(guestVpnAccess)
        .all()
        .some((a) => ["provisioning", "revoking"].includes(a.state));
      vpnAssert(
        !progressing,
        "busy",
        "Finish guest provisioning or revocation before editing the policy.",
      );
      await write(api, check, expected, candidate);
    });
  }

  const status = () => ({ hash: read().expected_hash, pending: Boolean(read().candidate_policy) });
  return { locked, current, write, recover, permissions, edit, status };
}
export type GuestPolicyWriter = ReturnType<typeof createGuestPolicyWriter>;
