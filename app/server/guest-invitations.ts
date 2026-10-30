import { and, desc, eq, gt, inArray, lt, lte, ne, sql } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { ulid } from "ulidx";

import log from "~/utils/log";

import {
  guestInvitations as invitations,
  guestInvitationEvents as events,
  guestInvitationSessions as sessions,
  guestInvitationLimits as limits,
  guests,
} from "./db/schema";
import type { GuestInvitation } from "./db/schema";
import type { GuestMailer } from "./guest-mail";
import { invitationMail, verificationMail } from "./guest-mail";
import {
  codeHash,
  equalHash,
  invitationToken,
  tokenHash,
  validInvitationToken,
  verificationCode,
} from "./invitation-tokens";
import { err, ok, type Result } from "./result";

export interface InvitationError {
  code:
    | "unavailable"
    | "rate_limited"
    | "delivery_failed"
    | "disabled"
    | "conflict"
    | "database"
    | "validation";
  message: string;
}
export type InvitationResult<T> = Result<T, InvitationError>;
type Database = Pick<NodeSQLiteDatabase, "select" | "insert" | "update" | "delete">;
export interface InvitationDetails {
  invitation: Omit<GuestInvitation, "token_hash" | "delivery_id"> | null;
  events: (typeof events.$inferSelect)[];
}
interface PublicInvitation {
  stage: "verify" | "accepted";
  expires: Date | null;
  codeSent: boolean;
}
const failure = (code: InvitationError["code"], message: string) =>
  err<InvitationError>({ code, message });
const unavailable = () =>
  failure(
    "unavailable",
    "This invitation or verification code is unavailable. Request a new invitation from the administrator.",
  );

export interface InvitationOptions {
  db: NodeSQLiteDatabase;
  mailer: GuestMailer;
  secret: string;
  publicUrl?: string;
  serviceName?: string;
  maxValidityHours?: number;
  deliveryLeaseMs?: number;
}

export function createInvitationService({
  db,
  mailer,
  secret,
  publicUrl,
  serviceName = "Headplane",
  maxValidityHours = 168,
  deliveryLeaseMs = 120_000,
}: InvitationOptions) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const enabled = mailer.enabled && Boolean(publicUrl);

  function protect<T>(operation: () => InvitationResult<T>): InvitationResult<T> {
    try {
      return operation();
    } catch {
      return failure("database", "Couldn't load or save invitations. Try again.");
    }
  }
  function audit(
    tx: Database,
    id: string,
    kind: typeof events.$inferInsert.kind,
    actor: string | null = null,
  ) {
    tx.insert(events)
      .values({ id: ulid(), invitation_id: id, kind, actor_id: actor, created_at: new Date() })
      .run();
  }
  function bump(tx: Database, guestId: string) {
    tx.update(guests)
      .set({ updated_at: new Date(), revision: sql`${guests.revision} + 1` })
      .where(eq(guests.id, guestId))
      .run();
  }
  function clearSessions(tx: Database, id: string) {
    tx.delete(sessions).where(eq(sessions.invitation_id, id)).run();
  }

  function expire(): InvitationResult<number> {
    return protect(() =>
      ok(
        db.transaction((tx) => {
          const now = new Date();
          // An older Headplane can revoke the phase-one row during a rollback.
          // Reconcile that closure before using any previously issued link.
          const closed = tx
            .update(invitations)
            .set({
              status: "revoked",
              revoked_at: now,
              token_hash: null,
              delivery_id: null,
              delivery_state: "idle",
              revision: sql`${invitations.revision} + 1`,
            })
            .where(
              and(
                inArray(invitations.status, ["draft", "pending", "expired"]),
                inArray(
                  invitations.guest_id,
                  tx.select({ id: guests.id }).from(guests).where(eq(guests.status, "revoked")),
                ),
              ),
            )
            .returning()
            .all();
          for (const invitation of closed) {
            clearSessions(tx, invitation.id);
            audit(tx, invitation.id, "revoked");
            bump(tx, invitation.guest_id);
          }
          const expired = tx
            .update(invitations)
            .set({
              status: "expired",
              token_hash: null,
              delivery_state: "idle",
              delivery_id: null,
              revision: sql`${invitations.revision} + 1`,
            })
            .where(and(eq(invitations.status, "pending"), lte(invitations.expires_at, now)))
            .returning()
            .all();
          for (const invitation of expired) {
            clearSessions(tx, invitation.id);
            audit(tx, invitation.id, "expired");
            bump(tx, invitation.guest_id);
          }
          // Raw tokens are intentionally unrecoverable. A delivery interrupted by a
          // crash is closed after its lease; an administrator can explicitly resend.
          const abandoned = tx
            .update(invitations)
            .set({
              token_hash: null,
              delivery_state: "failed",
              delivery_id: null,
              revision: sql`${invitations.revision} + 1`,
            })
            .where(
              and(
                eq(invitations.delivery_state, "sending"),
                lt(invitations.delivery_started_at, new Date(Date.now() - deliveryLeaseMs)),
              ),
            )
            .returning()
            .all();
          for (const invitation of abandoned) {
            clearSessions(tx, invitation.id);
            audit(tx, invitation.id, "delivery_failed");
            bump(tx, invitation.guest_id);
          }
          tx.delete(sessions).where(lte(sessions.expires_at, now)).run();
          tx.delete(limits)
            .where(lt(limits.window_start, Math.floor(Date.now() / 60000) - 2))
            .run();
          return expired.length;
        }),
      ),
    );
  }

  function get(guestId: string): InvitationResult<InvitationDetails> {
    const expired = expire();
    if (!expired.ok) return expired;
    return protect<InvitationDetails>(() => {
      const record = db.select().from(invitations).where(eq(invitations.guest_id, guestId)).get();
      if (!record) return ok({ invitation: null, events: [] });
      const { token_hash: _token, delivery_id: _delivery, ...safe } = record;
      return ok({
        invitation: safe,
        events: db
          .select()
          .from(events)
          .where(eq(events.invitation_id, record.id))
          .orderBy(desc(events.created_at), desc(events.id))
          .limit(100)
          .all(),
      });
    });
  }

  function rate(key: string, max: number): boolean {
    const minute = Math.floor(Date.now() / 60_000);
    const keyHash = tokenHash(key);
    const row = db
      .insert(limits)
      .values({ key_hash: keyHash, window_start: minute, hits: 1 })
      .onConflictDoUpdate({
        target: limits.key_hash,
        set: {
          window_start: minute,
          hits: sql`CASE WHEN ${limits.window_start} = ${minute} THEN ${limits.hits} + 1 ELSE 1 END`,
        },
      })
      .returning()
      .get();
    return row.hits <= max;
  }

  function checkRate(key: string, max: number): InvitationResult<void> {
    return protect(() =>
      db.transaction(() => {
        if (!rate("public-global", 120) || !rate(key, max))
          return failure("rate_limited", "Too many requests. Try again in a minute.");
        return ok(undefined);
      }),
    );
  }

  async function send(
    guestId: string,
    revision: number,
    hours: number,
    actor: string | null,
  ): Promise<InvitationResult<void>> {
    if (!enabled)
      return failure(
        "disabled",
        "Invitation delivery is not configured. Configure guest_invitations and server.base_url first.",
      );
    if (!Number.isInteger(hours) || hours < 1 || hours > maxValidityHours)
      return failure("validation", `Choose a validity between 1 and ${maxValidityHours} hours.`);
    const swept = expire();
    if (!swept.ok) return swept;
    const token = invitationToken();
    const reserved = protect(() =>
      db.transaction((tx) => {
        const guest = tx.select().from(guests).where(eq(guests.id, guestId)).get();
        if (!guest || guest.status !== "draft" || guest.revision !== revision)
          return failure("conflict", "This guest changed or was revoked. Reload before sending.");
        let invitation = tx
          .select()
          .from(invitations)
          .where(eq(invitations.guest_id, guestId))
          .get();
        if (
          invitation &&
          (["accepted", "revoked"].includes(invitation.status) ||
            invitation.delivery_state === "sending")
        )
          return failure("conflict", "This invitation cannot be sent. Reload the page.");
        if (
          invitation?.delivery_started_at &&
          invitation.delivery_started_at.getTime() > Date.now() - 60_000
        )
          return failure("rate_limited", "Wait one minute before sending this invitation again.");
        if (!invitation) {
          invitation = tx
            .insert(invitations)
            .values({
              id: ulid(),
              guest_id: guestId,
              email: guest.email,
              created_by: actor,
              created_at: new Date(),
            })
            .returning()
            .get();
          audit(tx, invitation.id, "created", actor);
        }
        const issued = new Date();
        const expires = new Date(Date.now() + hours * 3600_000);
        const deliveryId = ulid();
        tx.update(invitations)
          .set({
            email: guest.email,
            status: "pending",
            token_hash: tokenHash(token),
            token_version: invitation.token_version + 1,
            issued_at: issued,
            expires_at: expires,
            verification_sent_at: null,
            delivery_state: "sending",
            delivery_id: deliveryId,
            delivery_started_at: issued,
            revision: invitation.revision + 1,
          })
          .where(eq(invitations.id, invitation.id))
          .run();
        clearSessions(tx, invitation.id);
        bump(tx, guestId);
        return ok({
          id: invitation.id,
          deliveryId,
          email: guest.email,
          name: guest.display_name ?? "guest",
          accessPlan: guest,
          expires,
          resent: invitation.send_count > 0,
        });
      }),
    );
    if (!reserved.ok) return reserved;
    const claim = reserved.value;
    let delivered = false;
    try {
      delivered = (
        await mailer.send(
          invitationMail(
            claim.email,
            claim.name,
            serviceName,
            claim.expires,
            `${publicUrl}#token=${token}`,
            claim.accessPlan,
          ),
        )
      ).ok;
    } catch {
      /* fixed error below */
    }
    return protect(() =>
      db.transaction((tx) => {
        const changed = tx
          .update(invitations)
          .set({
            delivery_state: delivered ? "sent" : "failed",
            delivery_id: null,
            ...(delivered
              ? { send_count: sql`${invitations.send_count} + 1`, last_sent_at: new Date() }
              : { token_hash: null }),
            revision: sql`${invitations.revision} + 1`,
          })
          .where(
            and(
              eq(invitations.id, claim.id),
              eq(invitations.delivery_id, claim.deliveryId),
              eq(invitations.status, "pending"),
            ),
          )
          .returning()
          .get();
        if (!changed)
          return failure(
            "conflict",
            "The invitation changed while delivery was in progress. Reload the page.",
          );
        audit(
          tx,
          claim.id,
          delivered ? (claim.resent ? "resent" : "sent") : "delivery_failed",
          actor,
        );
        bump(tx, guestId);
        return delivered
          ? ok(undefined)
          : failure(
              "delivery_failed",
              "Invitation delivery failed. Check the mail configuration, then resend. The previous link is no longer valid.",
            );
      }),
    );
  }

  function revoke(guestId: string, revision: number, actor: string | null): InvitationResult<void> {
    return protect(() =>
      db.transaction((tx) => {
        const guest = tx.select().from(guests).where(eq(guests.id, guestId)).get();
        const invitation = tx
          .select()
          .from(invitations)
          .where(eq(invitations.guest_id, guestId))
          .get();
        if (
          !guest ||
          !invitation ||
          guest.revision !== revision ||
          ["accepted", "revoked"].includes(invitation.status)
        )
          return failure(
            "conflict",
            "This invitation changed or is already closed. Reload the page.",
          );
        tx.update(invitations)
          .set({
            status: "revoked",
            revoked_at: new Date(),
            token_hash: null,
            delivery_id: null,
            delivery_state: "idle",
            revision: sql`${invitations.revision} + 1`,
          })
          .where(eq(invitations.id, invitation.id))
          .run();
        tx.update(guests)
          .set({
            status: "revoked",
            revoked_at: new Date(),
            updated_at: new Date(),
            revision: revision + 1,
          })
          .where(eq(guests.id, guestId))
          .run();
        clearSessions(tx, invitation.id);
        audit(tx, invitation.id, "revoked", actor);
        return ok(undefined);
      }),
    );
  }

  function exchange(token: string): InvitationResult<string> {
    const allowed = checkRate(`exchange:${tokenHash(token)}`, 10);
    if (!allowed.ok) return allowed;
    if (!validInvitationToken(token)) return unavailable();
    const swept = expire();
    if (!swept.ok) return swept;
    return protect(() =>
      db.transaction((tx) => {
        const invitation = tx
          .select()
          .from(invitations)
          .where(
            and(
              eq(invitations.token_hash, tokenHash(token)),
              eq(invitations.status, "pending"),
              eq(invitations.delivery_state, "sent"),
              gt(invitations.expires_at, new Date()),
            ),
          )
          .get();
        if (!invitation) return unavailable();
        const session = invitationToken();
        tx.insert(sessions)
          .values({
            id_hash: tokenHash(session),
            invitation_id: invitation.id,
            token_version: invitation.token_version,
            expires_at: new Date(Date.now() + 15 * 60_000),
          })
          .run();
        return ok(session);
      }),
    );
  }

  function sessionRecord(session: string, tx: Database = db) {
    if (!validInvitationToken(session)) return undefined;
    return tx
      .select({ session: sessions, invitation: invitations })
      .from(sessions)
      .innerJoin(invitations, eq(invitations.id, sessions.invitation_id))
      .innerJoin(guests, eq(guests.id, invitations.guest_id))
      .where(
        and(
          eq(sessions.id_hash, tokenHash(session)),
          gt(sessions.expires_at, new Date()),
          eq(sessions.token_version, invitations.token_version),
          eq(guests.status, "draft"),
        ),
      )
      .get();
  }

  function inspect(session: string): InvitationResult<PublicInvitation> {
    const swept = expire();
    if (!swept.ok) return swept;
    return protect<PublicInvitation>(() => {
      const row = sessionRecord(session);
      if (!row) return unavailable();
      if (row.invitation.status === "accepted")
        return ok({ stage: "accepted" as const, expires: null, codeSent: false });
      if (
        row.invitation.status !== "pending" ||
        row.invitation.delivery_state !== "sent" ||
        !row.invitation.expires_at ||
        row.invitation.expires_at.getTime() <= Date.now()
      )
        return unavailable();
      return ok({
        stage: "verify" as const,
        expires: row.invitation.expires_at,
        codeSent:
          row.session.code_ready &&
          Boolean(
            row.session.code_expires_at && row.session.code_expires_at.getTime() > Date.now(),
          ) &&
          row.session.attempts < 5,
      });
    });
  }

  async function sendCode(session: string): Promise<InvitationResult<void>> {
    if (!enabled)
      return failure(
        "disabled",
        "Email verification is temporarily unavailable. Contact the administrator.",
      );
    const allowed = checkRate(`code:${tokenHash(session)}`, 3);
    if (!allowed.ok) return allowed;
    const code = verificationCode();
    const hash = codeHash(secret, session, code);
    const reserved = protect(() =>
      db.transaction((tx) => {
        const row = sessionRecord(session, tx);
        if (
          !row ||
          row.invitation.status !== "pending" ||
          row.invitation.delivery_state !== "sent" ||
          !row.invitation.expires_at ||
          row.invitation.expires_at.getTime() <= Date.now()
        )
          return unavailable();
        if (
          row.invitation.verification_sent_at &&
          row.invitation.verification_sent_at.getTime() > Date.now() - 60_000
        )
          return failure("rate_limited", "Wait one minute before requesting another code.");
        // Invalidate every previous challenge for this invitation, including codes
        // issued in other browsers. Only the newest mailbox challenge is usable.
        tx.update(sessions)
          .set({ code_hash: null, code_ready: false })
          .where(eq(sessions.invitation_id, row.invitation.id))
          .run();
        tx.update(sessions)
          .set({
            code_hash: hash,
            code_expires_at: new Date(Date.now() + 10 * 60_000),
            attempts: 0,
          })
          .where(eq(sessions.id_hash, tokenHash(session)))
          .run();
        tx.update(invitations)
          .set({ verification_sent_at: new Date() })
          .where(eq(invitations.id, row.invitation.id))
          .run();
        return ok({ id: row.invitation.id, email: row.invitation.email });
      }),
    );
    if (!reserved.ok) return reserved;
    let delivered = false;
    try {
      delivered = (await mailer.send(verificationMail(reserved.value.email, serviceName, code))).ok;
    } catch {
      /* sanitized below */
    }
    return protect(() =>
      db.transaction((tx) => {
        const updated = tx
          .update(sessions)
          .set({ code_ready: delivered, ...(delivered ? {} : { code_hash: null }) })
          .where(and(eq(sessions.id_hash, tokenHash(session)), eq(sessions.code_hash, hash)))
          .returning()
          .get();
        if (!updated) return unavailable();
        audit(tx, reserved.value.id, delivered ? "verification_sent" : "delivery_failed");
        return delivered
          ? ok(undefined)
          : failure(
              "delivery_failed",
              "Verification email could not be delivered. Try again later.",
            );
      }),
    );
  }

  function accept(session: string, code: string): InvitationResult<void> {
    const allowed = checkRate(`accept:${tokenHash(session)}`, 8);
    if (!allowed.ok) return allowed;
    return protect(() =>
      db.transaction((tx) => {
        const row = sessionRecord(session, tx);
        if (
          !row ||
          row.invitation.status !== "pending" ||
          row.invitation.delivery_state !== "sent" ||
          !row.invitation.expires_at ||
          row.invitation.expires_at.getTime() <= Date.now()
        )
          return unavailable();
        if (
          !row.session.code_ready ||
          !row.session.code_hash ||
          !row.session.code_expires_at ||
          row.session.code_expires_at.getTime() <= Date.now() ||
          row.session.attempts >= 5
        )
          return unavailable();
        if (
          !/^\d{8}$/.test(code) ||
          !equalHash(row.session.code_hash, codeHash(secret, session, code))
        ) {
          tx.update(sessions)
            .set({
              attempts: row.session.attempts + 1,
              ...(row.session.attempts >= 4 ? { code_hash: null, code_ready: false } : {}),
            })
            .where(eq(sessions.id_hash, tokenHash(session)))
            .run();
          audit(tx, row.invitation.id, "verification_failed");
          return unavailable();
        }
        const accepted = tx
          .update(invitations)
          .set({
            status: "accepted",
            accepted_at: new Date(),
            token_hash: null,
            revision: sql`${invitations.revision} + 1`,
          })
          .where(
            and(
              eq(invitations.id, row.invitation.id),
              eq(invitations.status, "pending"),
              eq(invitations.token_version, row.session.token_version),
              gt(invitations.expires_at, new Date()),
            ),
          )
          .returning()
          .get();
        if (!accepted) return unavailable();
        tx.delete(sessions)
          .where(
            and(
              eq(sessions.invitation_id, row.invitation.id),
              ne(sessions.id_hash, tokenHash(session)),
            ),
          )
          .run();
        tx.update(sessions)
          .set({ code_hash: null, code_ready: false })
          .where(eq(sessions.id_hash, tokenHash(session)))
          .run();
        bump(tx, row.invitation.guest_id);
        audit(tx, row.invitation.id, "accepted");
        return ok(undefined);
      }),
    );
  }

  return {
    enabled,
    maxValidityHours,
    get,
    send,
    revoke,
    exchange,
    inspect,
    sendCode,
    accept,
    verifiedGuest(session: string): string | null {
      const row = sessionRecord(session);
      return row?.invitation.status === "accepted" ? row.invitation.guest_id : null;
    },
    expire,
    checkRate,
    start() {
      if (!timer) {
        const maintain = () => {
          const result = expire();
          if (!result.ok)
            log.error(
              "server",
              "Guest invitation maintenance failed; it will retry on the next interval.",
            );
        };
        maintain();
        timer = setInterval(maintain, 30_000);
        timer.unref();
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
export type InvitationService = ReturnType<typeof createInvitationService>;
