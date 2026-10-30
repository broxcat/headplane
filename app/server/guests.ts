import { and, asc, count, desc, eq, getTableColumns, or, sql } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { ulid } from "ulidx";
import * as v from "valibot";

import { guestFields, type GuestQuery } from "~/routes/guests/schemas";
import { parseValues, type FormErrors } from "~/utils/form";
import { validateAccessDate } from "~/utils/guest-access";
import log from "~/utils/log";

import { guests, guestInvitations, type Guest } from "./db/schema";
import { err, ok, type Result } from "./result";

export interface GuestError {
  code: "validation" | "not_found" | "conflict" | "database";
  message: string;
  fields?: FormErrors;
}

export type GuestResult<T> = Result<T, GuestError>;
export const GUEST_PAGE_SIZE = 25;

export function createGuestService(db: NodeSQLiteDatabase) {
  function database<T>(operation: () => GuestResult<T>): GuestResult<T> {
    try {
      return operation();
    } catch (error) {
      // Do not log query parameters (administrative notes and email addresses).
      const code = error && typeof error === "object" && "code" in error ? error.code : "unknown";
      log.error("server", "Guest database operation failed (%s)", code);
      return err({ code: "database", message: "Couldn't save or load guests. Try again." });
    }
  }

  function get(id: string): GuestResult<Guest> {
    return database(() => {
      const guest = db.select().from(guests).where(eq(guests.id, id)).get();
      return guest
        ? ok(guest)
        : err({ code: "not_found", message: "This guest no longer exists." });
    });
  }

  function values(input: unknown) {
    const parsed = parseValues(v.object(guestFields), input);
    if (!parsed.ok) {
      return err<GuestError>({
        code: "validation",
        message: "Check the guest details.",
        fields: parsed.errors,
      });
    }

    const data = parsed.data;
    let date: Date | null = null;
    if (data.duration === "custom") {
      const converted = validateAccessDate(data.requested_expires_at, data.time_zone);
      if ("error" in converted) {
        return err<GuestError>({
          code: "validation",
          message: converted.error,
          fields: { requested_expires_at: converted.error },
        });
      }
      date = converted.date;
    } else if (data.requested_expires_at) {
      return err<GuestError>({
        code: "validation",
        message: "Choose either a relative duration or a custom date.",
        fields: {
          requested_expires_at: "A relative duration cannot also have an absolute expiry.",
        },
      });
    }

    return ok({
      email: data.email,
      display_name: data.display_name || null,
      notes: data.notes || null,
      requested_duration_seconds: data.duration === "custom" ? null : Number(data.duration),
      requested_expires_at: date,
    });
  }

  function create(input: unknown, createdBy: string | null): GuestResult<Guest> {
    const parsed = values(input);
    if (!parsed.ok) return parsed;
    return database(() => {
      const now = new Date();
      return ok(
        db
          .insert(guests)
          .values({
            ...parsed.value,
            id: ulid(),
            status: "draft",
            created_at: now,
            updated_at: now,
            created_by: createdBy,
          })
          .returning()
          .get(),
      );
    });
  }

  function change(id: string, revision: number, input?: unknown): GuestResult<Guest> {
    const current = get(id);
    if (!current.ok) return current;
    const invitation = database(() =>
      ok(
        db
          .select({ id: guestInvitations.id })
          .from(guestInvitations)
          .where(eq(guestInvitations.guest_id, id))
          .get(),
      ),
    );
    if (!invitation.ok) return invitation;
    if (invitation.value)
      return err({
        code: "conflict",
        message: "This guest has an invitation. Use its invitation actions or create a new draft.",
      });
    if (current.value.status !== "draft" || current.value.revision !== revision) {
      return err({
        code: "conflict",
        message: "This guest changed or was revoked. Reload before making changes.",
      });
    }
    const parsed = input === undefined ? ok({}) : values(input);
    if (!parsed.ok) return parsed;

    return database(() => {
      const now = new Date();
      // Compare-and-swap is one atomic statement, including the status change.
      // A stale edit cannot overwrite a revocation or another administrator's edit.
      const updated = db
        .update(guests)
        .set({
          ...parsed.value,
          ...(input === undefined ? { status: "revoked" as const, revoked_at: now } : {}),
          updated_at: now,
          revision: sql`${guests.revision} + 1`,
        })
        .where(and(eq(guests.id, id), eq(guests.status, "draft"), eq(guests.revision, revision)))
        .returning()
        .get();

      return updated
        ? ok(updated)
        : err({ code: "conflict", message: "This guest changed. Reload before making changes." });
    });
  }

  function list(query: GuestQuery) {
    return database(() => {
      const pattern = `%${query.q.replace(/[!%_]/g, "!$&")}%`;
      const where = and(
        query.status === "all"
          ? undefined
          : sql`coalesce(${guestInvitations.status}, ${guests.status}) = ${query.status}`,
        query.q
          ? or(
              sql`${guests.email} LIKE ${pattern} ESCAPE '!'`,
              sql`${guests.display_name} LIKE ${pattern} ESCAPE '!'`,
            )
          : undefined,
      );
      const total = db
        .select({ total: count() })
        .from(guests)
        .leftJoin(guestInvitations, eq(guestInvitations.guest_id, guests.id))
        .where(where)
        .get()!.total;
      const pages = Math.max(1, Math.ceil(total / GUEST_PAGE_SIZE));
      const page = Math.min(query.page, pages);
      const column = query.sort.startsWith("updated") ? guests.updated_at : guests.created_at;
      const order = query.sort.endsWith("asc") ? asc : desc;
      const rows = db
        .select({
          ...getTableColumns(guests),
          invitation_status: guestInvitations.status,
          invitation_expires_at: guestInvitations.expires_at,
          invitation_last_sent_at: guestInvitations.last_sent_at,
        })
        .from(guests)
        .leftJoin(guestInvitations, eq(guestInvitations.guest_id, guests.id))
        .where(where)
        .orderBy(order(column), order(guests.id))
        .limit(GUEST_PAGE_SIZE)
        .offset((page - 1) * GUEST_PAGE_SIZE)
        .all();
      return ok({ rows, total, page, pages });
    });
  }

  return {
    create,
    get,
    list,
    update: (id: string, revision: number, input: unknown) => change(id, revision, input),
    revoke: (id: string, revision: number) => change(id, revision),
  };
}

export type GuestService = ReturnType<typeof createGuestService>;
