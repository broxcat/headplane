import { cp, readdir } from "node:fs/promises";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-sqlite";
import { expect, test } from "vitest";

import { migrate } from "~/server/db/migrate";
import { guests } from "~/server/db/schema";
import { createInvitationService } from "~/server/guest-invitations";
import type { GuestMail } from "~/server/guest-mail";
import { ok } from "~/server/result";

import { tempDir } from "../../support/temp";

test("the invitation migration preserves phase-one drafts and revocations and a mailbox challenge survives reopening SQLite", async () => {
  const dir = await tempDir();
  const path = join(dir, "persist.db");
  const prior = join(dir, "migrations");
  const folders = (await readdir("drizzle")).sort();
  const next = folders.find((folder) => folder.endsWith("_guest_invitations"))!;
  for (const folder of folders.filter((folder) => folder < next))
    await cp(join("drizzle", folder), join(prior, folder), { recursive: true });
  const db = drizzle(path);
  migrate(db, { migrationsFolder: prior });
  const now = new Date();
  db.insert(guests)
    .values([
      {
        id: "legacy-draft",
        email: "legacy@example.test",
        requested_duration_seconds: 86400,
        created_at: now,
        updated_at: now,
        notes: "Preserve this note",
        revision: 8,
      },
      {
        id: "legacy-revoked",
        email: "revoked@example.test",
        requested_duration_seconds: 172800,
        status: "revoked",
        revoked_at: now,
        created_at: now,
        updated_at: now,
        revision: 4,
      },
    ])
    .run();
  const before = db.select().from(guests).all();
  migrate(db, { migrationsFolder: "./drizzle" });
  expect(db.select().from(guests).all()).toEqual(before);
  const messages: GuestMail[] = [];
  const options = {
    mailer: {
      enabled: true,
      async send(message: GuestMail) {
        messages.push(message);
        return ok(undefined);
      },
    },
    secret: "test-secret",
    publicUrl: "https://example.test/admin/invite",
  };
  const invitations = createInvitationService({ ...options, db });
  expect((await invitations.send("legacy-revoked", 4, 24, null)).ok).toBe(false);
  expect((await invitations.send("legacy-draft", 8, 24, null)).ok).toBe(true);
  const token = messages[0].text.match(/#token=([A-Za-z0-9_-]{43})/)![1];
  const session = invitations.exchange(token);
  if (!session.ok) throw new Error(session.error.message);
  expect((await invitations.sendCode(session.value)).ok).toBe(true);
  const code = messages[1].text.match(/code is (\d{8})/)![1];
  db.$client.close();
  const reopened = drizzle(path);
  try {
    migrate(reopened, { migrationsFolder: "./drizzle" });
    const service = createInvitationService({ ...options, db: reopened });
    expect(service.accept(session.value, code).ok).toBe(true);
    expect(service.exchange(token).ok).toBe(false);
    expect(
      reopened
        .select()
        .from(guests)
        .all()
        .find((row) => row.id === "legacy-revoked"),
    ).toEqual(before.find((row) => row.id === "legacy-revoked"));
  } finally {
    reopened.$client.close();
  }
});
