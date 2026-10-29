import { cp, readdir } from "node:fs/promises";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-sqlite";
import { expect, test } from "vitest";

import { migrate } from "~/server/db/migrate";
import {
  guests,
  guestInvitations,
  guestInvitationEvents,
  guestInvitationSessions,
} from "~/server/db/schema";

import { tempDir } from "../../support/temp";

// Regression: rebuilding a referenced parent can delete or orphan invitations,
// invalidate challenges, or silently turn off foreign-key enforcement.
test("12-hour constraint upgrade preserves legacy records, invitation references and foreign keys", async () => {
  const dir = await tempDir();
  const prior = join(dir, "migrations");
  for (const folder of (await readdir("drizzle")).filter((f) => f < "20261029220612"))
    await cp(join("drizzle", folder), join(prior, folder), { recursive: true });
  const db = drizzle(join(dir, "copy.db"));
  try {
    migrate(db, { migrationsFolder: prior });
    const now = new Date();
    db.insert(guests)
      .values({
        id: "legacy",
        email: "legacy@example.test",
        requested_duration_seconds: 86400,
        requested_expires_at: new Date("2030-01-01"),
        created_at: now,
        updated_at: now,
        revision: 9,
      })
      .run();
    db.insert(guestInvitations)
      .values({
        id: "invitation",
        guest_id: "legacy",
        email: "legacy@example.test",
        created_at: now,
      })
      .run();
    db.insert(guestInvitationEvents)
      .values({ id: "event", invitation_id: "invitation", kind: "created", created_at: now })
      .run();
    db.insert(guestInvitationSessions)
      .values({
        id_hash: "session-hash",
        invitation_id: "invitation",
        token_version: 0,
        expires_at: new Date("2030-01-01"),
        code_hash: "challenge-hash",
        code_expires_at: new Date("2030-01-01"),
        code_ready: true,
        attempts: 2,
      })
      .run();
    const before = [
      db.select().from(guests).all(),
      db.select().from(guestInvitations).all(),
      db.select().from(guestInvitationEvents).all(),
      db.select().from(guestInvitationSessions).all(),
    ];
    expect(() =>
      db
        .insert(guests)
        .values({
          id: "too-early",
          email: "x@example.test",
          requested_duration_seconds: 43200,
          created_at: now,
          updated_at: now,
        })
        .run(),
    ).toThrow();
    migrate(db, { migrationsFolder: "./drizzle" });
    expect([
      db.select().from(guests).all(),
      db.select().from(guestInvitations).all(),
      db.select().from(guestInvitationEvents).all(),
      db.select().from(guestInvitationSessions).all(),
    ]).toEqual(before);
    expect(db.$client.prepare("pragma foreign_key_check").all()).toEqual([]);
    expect(db.$client.prepare("pragma foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    db.insert(guests)
      .values({
        id: "12-hours",
        email: "new@example.test",
        requested_duration_seconds: 43200,
        created_at: now,
        updated_at: now,
      })
      .run();
    expect(() =>
      db
        .insert(guestInvitations)
        .values({ id: "orphan", guest_id: "missing", email: "x@example.test", created_at: now })
        .run(),
    ).toThrow();
  } finally {
    db.$client.close();
  }
});

// Regression: a failed FK validation commits a half-upgraded schema or leaves
// the connection with integrity enforcement disabled.
test("a failed reference check rolls back the rebuild and restores enforcement", async () => {
  const dir = await tempDir();
  const prior = join(dir, "migrations");
  for (const folder of (await readdir("drizzle")).filter((f) => f < "20261029220612"))
    await cp(join("drizzle", folder), join(prior, folder), { recursive: true });
  const db = drizzle(":memory:");
  try {
    migrate(db, { migrationsFolder: prior });
    db.$client.exec("PRAGMA foreign_keys=OFF");
    db.insert(guestInvitations)
      .values({
        id: "bad-reference",
        guest_id: "missing",
        email: "x@example.test",
        created_at: new Date(),
      })
      .run();
    db.$client.exec("PRAGMA foreign_keys=ON");
    const before = db.$client.prepare("select sql from sqlite_master where name='guests'").get();
    expect(() => migrate(db, { migrationsFolder: "./drizzle" })).toThrow();
    expect(db.$client.prepare("select sql from sqlite_master where name='guests'").get()).toEqual(
      before,
    );
    expect(db.$client.prepare("pragma foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    expect(
      db.$client.prepare("select name from sqlite_master where name='__new_guests'").all(),
    ).toEqual([]);
    db.$client.exec("DELETE FROM guest_invitations WHERE id='bad-reference'");
    migrate(db, { migrationsFolder: "./drizzle" });
    expect(db.$client.prepare("pragma foreign_key_check").all()).toEqual([]);
  } finally {
    db.$client.close();
  }
});
