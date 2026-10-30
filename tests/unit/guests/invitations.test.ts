import { drizzle } from "drizzle-orm/node-sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { migrate } from "~/server/db/migrate";
import {
  guestInvitations,
  guestInvitationEvents,
  guestInvitationSessions,
  guests,
} from "~/server/db/schema";
import { createInvitationService, type InvitationResult } from "~/server/guest-invitations";
import type { GuestMail, GuestMailer } from "~/server/guest-mail";
import { createGuestService, type GuestResult } from "~/server/guests";
import { invitationToken, tokenHash, equalHash, codeHash } from "~/server/invitation-tokens";
import { err, ok } from "~/server/result";

function value<T>(result: InvitationResult<T> | GuestResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("secure administrative guest invitations", () => {
  let db: ReturnType<typeof drizzle>;
  let invitations: ReturnType<typeof createInvitationService>;
  let guestService: ReturnType<typeof createGuestService>;
  let messages: GuestMail[];
  let fail: boolean;
  let mailer: GuestMailer;
  const secret = "a-secret-that-never-enters-a-database";
  const revision = (id: string) => value(guestService.get(id)).revision;
  const guest = () =>
    value(guestService.create({ email: "Guest@example.com", duration: "86400" }, "administrator"));
  const latestToken = () =>
    messages
      .filter((message) => message.text.includes("#token="))
      .at(-1)!
      .text.match(/#token=([A-Za-z0-9_-]{43})/)![1];
  const latestCode = () => messages.at(-1)!.text.match(/code is (\d{8})/)![1];
  const history = (id: string) => value(invitations.get(id)).events.map((event) => event.kind);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T12:00:00Z"));
    db = drizzle(":memory:");
    migrate(db, { migrationsFolder: "./drizzle" });
    messages = [];
    fail = false;
    mailer = {
      enabled: true,
      async send(message) {
        messages.push(message);
        return fail ? err("delivery_failed") : ok(undefined);
      },
    };
    guestService = createGuestService(db);
    invitations = createInvitationService({
      db,
      mailer,
      secret,
      publicUrl: "https://headplane.test/custom/invite",
      maxValidityHours: 48,
    });
  });
  afterEach(() => {
    invitations.stop();
    db.$client.close();
    vi.useRealTimers();
  });

  test("issuance stores only token hashes, snapshots the recipient and audits delivery without credentials", async () => {
    const draft = guest();
    value(await invitations.send(draft.id, 1, 24, "admin"));
    const token = latestToken();
    const stored = db.select().from(guestInvitations).get()!;
    expect(stored).toMatchObject({
      status: "pending",
      email: "guest@example.com",
      token_hash: tokenHash(token),
      token_version: 1,
      send_count: 1,
      delivery_state: "sent",
      created_by: "admin",
    });
    expect(stored.expires_at!.getTime() - stored.issued_at!.getTime()).toBe(24 * 3600_000);
    const data = value(invitations.get(draft.id));
    expect(data.invitation).not.toHaveProperty("token_hash");
    expect(data.invitation).not.toHaveProperty("delivery_id");
    expect(history(draft.id)).toEqual(expect.arrayContaining(["created", "sent"]));
    expect(JSON.stringify(db.select().from(guestInvitationEvents).all())).not.toContain(token);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(value(guestService.get(draft.id))).toMatchObject({
      status: "draft",
      activated_at: null,
      expires_at: null,
    });
    expect(
      guestService.update(draft.id, revision(draft.id), {
        email: "other@example.com",
        duration: "86400",
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(guestService.revoke(draft.id, revision(draft.id))).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  test.for(["43200", "custom"])(
    "link validity and retention remain independent of the %s access plan",
    async (duration) => {
      const draft = value(
        guestService.create(
          {
            email: "plan@example.test",
            duration,
            ...(duration === "custom"
              ? { requested_expires_at: "2030-01-01T14:00", time_zone: "UTC" }
              : {}),
          },
          null,
        ),
      );
      value(await invitations.send(draft.id, 1, 24, null));
      const token = latestToken();
      expect(messages[0].text).toContain(
        duration === "custom"
          ? "Access expires at 2030-01-01T14:00:00.000Z"
          : "Planned access duration: 12 hours",
      );
      vi.advanceTimersByTime(13 * 3600_000);
      value(invitations.expire());
      expect(value(invitations.get(draft.id)).invitation?.status).toBe("pending");
      expect(value(guestService.get(draft.id))).toMatchObject({
        activated_at: null,
        expires_at: null,
        status: "draft",
      });
      value(invitations.revoke(draft.id, revision(draft.id), null));
      expect(invitations.exchange(token).ok).toBe(false);
      expect(value(invitations.get(draft.id)).invitation?.status).toBe("revoked");
      expect(value(guestService.get(draft.id))).toMatchObject({
        activated_at: null,
        expires_at: null,
      });
    },
  );

  test("possession of a link alone cannot accept and mailbox verification consumes an invitation exactly once", async () => {
    const draft = guest();
    value(await invitations.send(draft.id, 1, 24, null));
    const token = latestToken();
    const session = value(invitations.exchange(token));
    expect(invitations.accept(session, "00000000").ok).toBe(false);
    value(await invitations.sendCode(session));
    const code = latestCode();
    expect(db.select().from(guestInvitationSessions).get()).toMatchObject({
      id_hash: tokenHash(session),
      code_hash: codeHash(secret, session, code),
      code_ready: true,
    });
    value(invitations.accept(session, code));
    expect(invitations.accept(session, code).ok).toBe(false);
    expect(invitations.exchange(token).ok).toBe(false);
    expect(value(invitations.inspect(session)).stage).toBe("accepted");
    expect(history(draft.id).filter((kind) => kind === "accepted")).toHaveLength(1);
    expect(db.select().from(guestInvitations).get()).toMatchObject({
      status: "accepted",
      token_hash: null,
      accepted_at: new Date(),
    });
    expect((await invitations.send(draft.id, revision(draft.id), 24, null)).ok).toBe(false);
  });

  test("double acceptance from simultaneous requests produces one successful transition", async () => {
    const draft = guest();
    value(await invitations.send(draft.id, 1, 24, null));
    const session = value(invitations.exchange(latestToken()));
    value(await invitations.sendCode(session));
    const code = latestCode();
    const results = await Promise.all([
      Promise.resolve().then(() => invitations.accept(session, code)),
      Promise.resolve().then(() => invitations.accept(session, code)),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(history(draft.id).filter((kind) => kind === "accepted")).toHaveLength(1);
  });

  test("resending invalidates old links and every temporary session, including existing codes", async () => {
    const draft = guest();
    value(await invitations.send(draft.id, 1, 24, null));
    const oldToken = latestToken();
    const oldSession = value(invitations.exchange(oldToken));
    value(await invitations.sendCode(oldSession));
    const oldCode = latestCode();
    expect(await invitations.send(draft.id, revision(draft.id), 24, null)).toMatchObject({
      ok: false,
      error: { code: "rate_limited" },
    });
    vi.advanceTimersByTime(60_000);
    value(await invitations.send(draft.id, revision(draft.id), 48, null));
    expect(latestToken()).not.toBe(oldToken);
    expect(invitations.exchange(oldToken).ok).toBe(false);
    expect(invitations.inspect(oldSession).ok).toBe(false);
    expect(invitations.accept(oldSession, oldCode).ok).toBe(false);
    expect(invitations.exchange(latestToken()).ok).toBe(true);
    expect(history(draft.id)).toContain("resent");
  });

  test("revocation invalidates tokens and sessions atomically and is terminal", async () => {
    const draft = guest();
    value(await invitations.send(draft.id, 1, 24, null));
    const token = latestToken();
    const session = value(invitations.exchange(token));
    value(invitations.revoke(draft.id, revision(draft.id), "admin"));
    expect(invitations.exchange(token).ok).toBe(false);
    expect(invitations.inspect(session).ok).toBe(false);
    expect(value(guestService.get(draft.id)).status).toBe("revoked");
    expect(invitations.revoke(draft.id, revision(draft.id), null).ok).toBe(false);
    expect((await invitations.send(draft.id, revision(draft.id), 24, null)).ok).toBe(false);
    expect(history(draft.id).filter((kind) => kind === "revoked")).toHaveLength(1);
  });

  test("expiration is immediate without a worker and the restarted worker audits it only once", async () => {
    const draft = guest();
    value(await invitations.send(draft.id, 1, 1, null));
    const token = latestToken();
    const session = value(invitations.exchange(token));
    value(await invitations.sendCode(session));
    const code = latestCode();
    vi.advanceTimersByTime(3600_000);
    expect(invitations.accept(session, code).ok).toBe(false);
    invitations = createInvitationService({
      db,
      mailer,
      secret,
      publicUrl: "https://headplane.test/invite",
    });
    invitations.start();
    vi.advanceTimersByTime(90_000);
    expect(invitations.exchange(token).ok).toBe(false);
    expect(history(draft.id).filter((kind) => kind === "expired")).toHaveLength(1);
    expect(value(invitations.get(draft.id)).invitation?.status).toBe("expired");
    value(await invitations.send(draft.id, revision(draft.id), 1, "admin"));
    expect(value(invitations.get(draft.id)).invitation?.status).toBe("pending");
  });

  test("verification codes expire, are session-bound and lock after five guesses", async () => {
    const draft = guest();
    value(await invitations.send(draft.id, 1, 24, null));
    const token = latestToken();
    const session = value(invitations.exchange(token));
    const other = value(invitations.exchange(token));
    value(await invitations.sendCode(session));
    const code = latestCode();
    expect(invitations.accept(other, code).ok).toBe(false);
    for (let i = 0; i < 5; i++)
      expect(invitations.accept(session, code === "00000000" ? "11111111" : "00000000").ok).toBe(
        false,
      );
    expect(invitations.accept(session, code).ok).toBe(false);
    expect(history(draft.id).filter((kind) => kind === "verification_failed")).toHaveLength(5);
    vi.advanceTimersByTime(60_000);
    value(await invitations.sendCode(session));
    const fresh = latestCode();
    vi.advanceTimersByTime(10 * 60_000);
    expect(invitations.accept(session, fresh).ok).toBe(false);
  });

  test("delivery errors invalidate rotated links and can recover without leaking the transport error", async () => {
    const draft = guest();
    value(await invitations.send(draft.id, 1, 24, null));
    const token = latestToken();
    vi.advanceTimersByTime(60_000);
    fail = true;
    expect(await invitations.send(draft.id, revision(draft.id), 24, null)).toMatchObject({
      ok: false,
      error: { code: "delivery_failed" },
    });
    expect(invitations.exchange(token).ok).toBe(false);
    expect(invitations.exchange(latestToken()).ok).toBe(false);
    expect(value(invitations.get(draft.id)).invitation).toMatchObject({
      delivery_state: "failed",
      send_count: 1,
    });
    expect(history(draft.id)).toContain("delivery_failed");
    vi.advanceTimersByTime(60_000);
    fail = false;
    value(await invitations.send(draft.id, revision(draft.id), 24, null));
    expect(invitations.exchange(latestToken()).ok).toBe(true);
  });

  test("invalid validity, stale forms, disabled delivery and unknown links cannot issue or accept invitations", async () => {
    const draft = guest();
    for (const hours of [0, -1, 49, 1.5, Infinity])
      expect((await invitations.send(draft.id, 1, hours, null)).ok).toBe(false);
    expect((await invitations.send(draft.id, 999, 24, null)).ok).toBe(false);
    const disabled = createInvitationService({ db, mailer: { ...mailer, enabled: false }, secret });
    expect(await disabled.send(draft.id, 1, 24, null)).toMatchObject({
      ok: false,
      error: { code: "disabled" },
    });
    expect(invitations.exchange(invitationToken()).ok).toBe(false);
    expect(invitations.exchange("invalid").ok).toBe(false);
    expect(messages).toEqual([]);
  });

  test("rate limits survive service recreation and reset after their window", () => {
    for (let i = 0; i < 3; i++) expect(invitations.checkRate("test-client", 3).ok).toBe(true);
    const restarted = createInvitationService({ db, mailer, secret });
    expect(restarted.checkRate("test-client", 3)).toMatchObject({
      ok: false,
      error: { code: "rate_limited" },
    });
    vi.advanceTimersByTime(60_000);
    expect(restarted.checkRate("test-client", 3).ok).toBe(true);
  });

  test("cryptographic comparisons reject malformed hashes and a token never equals its stored fingerprint", () => {
    const token = invitationToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(equalHash(tokenHash(token), tokenHash(token))).toBe(true);
    expect(equalHash(tokenHash(token), tokenHash(invitationToken()))).toBe(false);
    expect(equalHash("malformed", "malformed")).toBe(false);
    expect(codeHash("first", "session", "12345678")).not.toBe(
      codeHash("second", "session", "12345678"),
    );
  });

  test("an interrupted SMTP delivery is recovered after its lease without resurrecting its token", async () => {
    const draft = guest();
    value(await invitations.send(draft.id, 1, 24, null));
    const token = latestToken();
    db.update(guestInvitations)
      .set({
        delivery_state: "sending",
        delivery_id: "interrupted",
        delivery_started_at: new Date(),
      })
      .run();
    vi.advanceTimersByTime(121_000);
    value(invitations.expire());
    expect(invitations.exchange(token).ok).toBe(false);
    expect(value(invitations.get(draft.id)).invitation?.delivery_state).toBe("failed");
    expect(history(draft.id).filter((kind) => kind === "delivery_failed")).toHaveLength(1);
  });

  test("a late SMTP completion cannot reactivate an invitation revoked during delivery", async () => {
    const draft = guest();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed = createInvitationService({
      db,
      secret,
      publicUrl: "https://example.test/invite",
      mailer: {
        enabled: true,
        async send(message) {
          messages.push(message);
          await wait;
          return ok(undefined);
        },
      },
    });
    const sending = delayed.send(draft.id, 1, 24, null);
    const token = latestToken();
    value(delayed.revoke(draft.id, revision(draft.id), "admin"));
    release();
    expect(await sending).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(delayed.exchange(token).ok).toBe(false);
    expect(value(delayed.get(draft.id)).invitation?.status).toBe("revoked");
    expect(history(draft.id)).not.toContain("sent");
  });

  test("a phase-one revocation made during a rollback invalidates pending invitations on upgrade", async () => {
    const draft = guest();
    value(await invitations.send(draft.id, 1, 24, null));
    const token = latestToken();
    const session = value(invitations.exchange(token));
    value(await invitations.sendCode(session));
    const code = latestCode();
    db.update(guests).set({ status: "revoked", revoked_at: new Date() }).run();
    expect(invitations.accept(session, code).ok).toBe(false);
    expect(invitations.exchange(token).ok).toBe(false);
    expect(invitations.inspect(session).ok).toBe(false);
    expect(value(invitations.get(draft.id)).invitation?.status).toBe("revoked");
    expect(history(draft.id).filter((kind) => kind === "revoked")).toHaveLength(1);
  });

  test("failed verification delivery invalidates previous codes and never makes a captured code usable", async () => {
    const draft = guest();
    value(await invitations.send(draft.id, 1, 24, null));
    const session = value(invitations.exchange(latestToken()));
    value(await invitations.sendCode(session));
    const oldCode = latestCode();
    vi.advanceTimersByTime(60_000);
    fail = true;
    expect(await invitations.sendCode(session)).toMatchObject({
      ok: false,
      error: { code: "delivery_failed" },
    });
    expect(invitations.accept(session, oldCode).ok).toBe(false);
    expect(invitations.accept(session, latestCode()).ok).toBe(false);
    expect(value(invitations.inspect(session)).codeSent).toBe(false);
  });

  test("database failures cannot send emails before a durable reservation succeeds", async () => {
    const draft = guest();
    db.$client.exec("PRAGMA query_only = ON");
    expect(await invitations.send(draft.id, 1, 24, null)).toMatchObject({
      ok: false,
      error: { code: "database" },
    });
    expect(messages).toEqual([]);
    db.$client.exec("PRAGMA query_only = OFF");
    value(await invitations.send(draft.id, 1, 24, null));
    expect(messages).toHaveLength(1);
  });
});
