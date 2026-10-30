import { createHmac, randomBytes } from "node:crypto";

import { and, eq, lt, sql } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { ulid } from "ulidx";

import log from "~/utils/log";

import {
  authSessions,
  localAdminUsers,
  localAuthEvents,
  localAuthLimits,
  users,
} from "../db/schema";
import { err, ok } from "../result";
import { hashPassword, validPassword, verifyPassword } from "./passwords";
import { capsForRole } from "./roles";

export function normalizeUsername(username: string): string | undefined {
  // No trimming, Unicode folding or confusable characters.
  if (
    username.length < 3 ||
    username.length > 64 ||
    /[^A-Za-z0-9._-]/.test(username) ||
    !/^[A-Za-z0-9]/.test(username)
  )
    return;
  return username.toLowerCase();
}

export function createLocalAuthService(db: NodeSQLiteDatabase, secret: string) {
  let dummyHash: Promise<string> | undefined;
  let inFlight = 0;

  function event(kind: string, userId?: string) {
    db.insert(localAuthEvents)
      .values({ id: ulid(), kind, user_id: userId, created_at: new Date() })
      .run();
    log.info("auth", "Local authentication: %s (account %s)", kind, userId ?? "unknown");
  }

  function lookup(username: string) {
    const normalized = normalizeUsername(username);
    return normalized
      ? db
          .select()
          .from(localAdminUsers)
          .where(eq(localAdminUsers.normalized_username, normalized))
          .get()
      : undefined;
  }

  function available() {
    return !!db
      .select({ id: localAdminUsers.user_id })
      .from(localAdminUsers)
      .where(eq(localAdminUsers.enabled, true))
      .limit(1)
      .get();
  }

  function list() {
    return db
      .select({
        username: localAdminUsers.username,
        enabled: localAdminUsers.enabled,
        displayName: users.name,
        role: users.role,
        lastLoginAt: users.last_login_at,
      })
      .from(localAdminUsers)
      .innerJoin(users, eq(localAdminUsers.user_id, users.id))
      .all();
  }

  async function create(username: string, displayName: string, password: string) {
    const normalized = normalizeUsername(username);
    if (!normalized)
      return err(
        "Use 3–64 ASCII letters, digits, dots, underscores or hyphens; start with a letter or digit.",
      );
    if (!validPassword(password))
      return err("Use a password of 12–256 characters without NUL characters.");
    if (!displayName.trim() || displayName.length > 128)
      return err("Use a display name of 1–128 characters.");
    const passwordHash = await hashPassword(password);
    return db.transaction((tx) => {
      if (lookup(username)) return err("That username is already registered.");
      const id = ulid();
      tx.insert(users)
        .values({
          id,
          sub: `local:${id}`,
          name: displayName.trim(),
          role: "admin",
          caps: capsForRole("admin"),
        })
        .run();
      tx.insert(localAdminUsers)
        .values({
          user_id: id,
          username,
          normalized_username: normalized,
          password_hash: passwordHash,
          password_changed_at: new Date(),
        })
        .run();
      event("created", id);
      return ok(id);
    });
  }

  function key(value: string) {
    return createHmac("sha256", secret).update(value).digest("hex");
  }

  // Reserve attempts before expensive work, transactionally across processes.
  // A denied request never extends a lock. Expired locks allow another attempt.
  function reserve(account: string, address?: string) {
    const now = Date.now();
    return db.transaction((tx) => {
      tx.delete(localAuthLimits)
        .where(lt(localAuthLimits.window_start, now - 900_000))
        .run();
      const buckets = [
        { key: "global", max: 60, window: 60_000, account: false },
        ...(address
          ? [{ key: key(`ip:${address}`), max: 20, window: 60_000, account: false }]
          : []),
        { key: key(`account:${account}`), max: 5, window: 900_000, account: true },
      ];
      const states = buckets.map((bucket) => {
        const previous = tx
          .select()
          .from(localAuthLimits)
          .where(eq(localAuthLimits.key, bucket.key))
          .get();
        const state =
          previous && now - previous.window_start < bucket.window ? previous : undefined;
        return { bucket, state };
      });
      if (
        states.some(
          ({ bucket, state }) =>
            state && (state.locked_until > now || (!bucket.account && state.hits >= bucket.max)),
        )
      )
        return false;
      for (const { bucket, state } of states) {
        const hits = (state?.hits ?? 0) + 1;
        const values = {
          hits,
          window_start: state?.window_start ?? now,
          locked_until:
            bucket.account && hits >= bucket.max
              ? now + Math.min(60_000, 1000 * 2 ** Math.min(hits - bucket.max, 6))
              : 0,
        };
        tx.insert(localAuthLimits)
          .values({ key: bucket.key, ...values })
          .onConflictDoUpdate({ target: localAuthLimits.key, set: values })
          .run();
      }
      return true;
    });
  }

  function throttledEvent() {
    db.transaction((tx) => {
      const now = Date.now();
      const state = tx
        .select()
        .from(localAuthLimits)
        .where(eq(localAuthLimits.key, "throttle-audit"))
        .get();
      if (state && state.locked_until > now) return;
      const values = { window_start: now, hits: 1, locked_until: now + 60_000 };
      tx.insert(localAuthLimits)
        .values({ key: "throttle-audit", ...values })
        .onConflictDoUpdate({ target: localAuthLimits.key, set: values })
        .run();
      event("login_refused");
    });
  }

  async function authenticate(username: string, password: string, address?: string) {
    const normalized = normalizeUsername(username) ?? "invalid-username";
    if (!reserve(normalized, address) || inFlight >= 2) {
      // Bound audit writes too: a flood of throttled requests must not fill disk.
      throttledEvent();
      return err("limited" as const);
    }
    inFlight++;
    try {
      const account = lookup(username);
      dummyHash ??= hashPassword(randomBytes(32).toString("hex"));
      const encoded = account?.password_hash ?? (await dummyHash);
      const checked = await verifyPassword(
        encoded,
        validPassword(password) ? password : "invalid-password",
      );
      if (!checked.valid || !validPassword(password) || !account?.enabled) {
        event("login_refused");
        return err("invalid" as const);
      }
      const replacement = checked.rehash
        ? await hashPassword(password, account.password_hash)
        : undefined;
      return db.transaction((tx) => {
        const updated = tx
          .update(localAdminUsers)
          .set({ password_hash: replacement ?? account.password_hash })
          .where(
            and(
              eq(localAdminUsers.user_id, account.user_id),
              eq(localAdminUsers.revision, account.revision),
              eq(localAdminUsers.enabled, true),
            ),
          )
          .returning({ id: localAdminUsers.user_id })
          .get();
        if (!updated) return err("invalid" as const);
        tx.delete(localAuthLimits)
          .where(eq(localAuthLimits.key, key(`account:${normalized}`)))
          .run();
        return ok({ userId: account.user_id, revision: account.revision });
      });
    } finally {
      inFlight--;
    }
  }

  function revoke(userId: string) {
    db.delete(authSessions)
      .where(and(eq(authSessions.kind, "local_admin"), eq(authSessions.user_id, userId)))
      .run();
    event("sessions_revoked", userId);
  }

  function setEnabled(username: string, enabled: boolean) {
    return db.transaction((tx) => {
      const account = lookup(username);
      if (!account) return err("Account not found.");
      tx.update(localAdminUsers)
        .set({ enabled, revision: sql`${localAdminUsers.revision} + 1` })
        .where(eq(localAdminUsers.user_id, account.user_id))
        .run();
      tx.update(users).set({ updated_at: new Date() }).where(eq(users.id, account.user_id)).run();
      revoke(account.user_id);
      event(enabled ? "enabled" : "disabled", account.user_id);
      return ok(undefined);
    });
  }

  async function replacePassword(
    username: string,
    password: string,
    current?: { password: string; userId: string },
    address?: string,
  ) {
    if (!validPassword(password))
      return err("Use a password of 12–256 characters without NUL characters.");
    const account = lookup(username);
    if (!account) return err("Invalid credentials");
    if (current) {
      if (current.userId !== account.user_id) return err("Invalid credentials");
      const checked = await authenticate(username, current.password, address);
      if (!checked.ok) return err("Invalid credentials");
    }
    const passwordHash = await hashPassword(password);
    return db.transaction((tx) => {
      const updated = tx
        .update(localAdminUsers)
        .set({
          password_hash: passwordHash,
          password_changed_at: new Date(),
          revision: account.revision + 1,
        })
        .where(
          and(
            eq(localAdminUsers.user_id, account.user_id),
            eq(localAdminUsers.revision, account.revision),
          ),
        )
        .returning({ id: localAdminUsers.user_id })
        .get();
      if (!updated) return err("Account changed. Try again.");
      tx.update(users).set({ updated_at: new Date() }).where(eq(users.id, account.user_id)).run();
      tx.delete(localAuthLimits)
        .where(eq(localAuthLimits.key, key(`account:${account.normalized_username}`)))
        .run();
      revoke(account.user_id);
      event(current ? "password_changed" : "password_reset", account.user_id);
      return ok(undefined);
    });
  }

  function revokeByUsername(username: string) {
    return db.transaction(() => {
      const account = lookup(username);
      if (!account) return err("Account not found.");
      // Bump revision so an in-flight password check cannot mint a new session.
      db.update(localAdminUsers)
        .set({ revision: sql`${localAdminUsers.revision} + 1` })
        .where(eq(localAdminUsers.user_id, account.user_id))
        .run();
      revoke(account.user_id);
      return ok(undefined);
    });
  }

  return {
    available,
    list,
    create,
    authenticate,
    setEnabled,
    replacePassword,
    revokeByUsername,
  };
}
