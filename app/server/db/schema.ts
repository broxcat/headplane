import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { HostInfo } from "~/types";

export const hostInfo = sqliteTable("host_info", {
  host_id: text("host_id").primaryKey(),
  payload: text("payload", { mode: "json" }).$type<HostInfo>(),
  updated_at: integer("updated_at", { mode: "timestamp" }).$default(() => new Date()),
});

export type HostInfoRecord = typeof hostInfo.$inferSelect;
export type HostInfoInsert = typeof hostInfo.$inferInsert;

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  sub: text("sub").notNull().unique(),
  name: text("name"),
  email: text("email"),
  picture: text("picture"),
  role: text("role").notNull().default("member"),
  headscale_user_id: text("headscale_user_id").unique(),
  created_at: integer("created_at", { mode: "timestamp" }).$default(() => new Date()),
  updated_at: integer("updated_at", { mode: "timestamp" }).$default(() => new Date()),
  last_login_at: integer("last_login_at", { mode: "timestamp" }),

  // Deprecated: kept for migration compatibility, will be removed in 1.0
  caps: integer("caps").notNull().default(0),
});

export type HeadplaneUser = typeof users.$inferSelect;
export type HeadplaneUserInsert = typeof users.$inferInsert;

export const authSessions = sqliteTable("auth_sessions", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(), // 'oidc' | 'api_key' (proxy auth is request-scoped)
  user_id: text("user_id"),
  api_key_hash: text("api_key_hash"),
  api_key_display: text("api_key_display"),
  oidc_id_token: text("oidc_id_token"),
  expires_at: integer("expires_at", { mode: "timestamp" }).notNull(),
  created_at: integer("created_at", { mode: "timestamp" }).$default(() => new Date()),
});

export type AuthSessionRecord = typeof authSessions.$inferSelect;
export type AuthSessionInsert = typeof authSessions.$inferInsert;

export const guests = sqliteTable(
  "guests",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    display_name: text("display_name"),
    notes: text("notes"),
    status: text("status", { enum: ["draft", "pending", "active", "expired", "revoked"] })
      .notNull()
      .default("draft"),
    requested_duration_seconds: integer("requested_duration_seconds"),
    requested_expires_at: integer("requested_expires_at", { mode: "timestamp" }),
    activated_at: integer("activated_at", { mode: "timestamp" }),
    expires_at: integer("expires_at", { mode: "timestamp" }),
    revoked_at: integer("revoked_at", { mode: "timestamp" }),
    created_at: integer("created_at", { mode: "timestamp" }).notNull(),
    updated_at: integer("updated_at", { mode: "timestamp" }).notNull(),
    // Historical attribution, retained even if the account is later removed.
    // API key sessions have no local user ID and leave this null.
    created_by: text("created_by"),
    revision: integer("revision").notNull().default(1),
  },
  (table) => [
    index("guests_email_idx").on(table.email),
    index("guests_created_idx").on(table.created_at, table.id),
    index("guests_status_created_idx").on(table.status, table.created_at, table.id),
    // Phase 1 never represents a draft as provisioned network access.
    check("guests_phase_one_status", sql`${table.status} IN ('draft', 'revoked')`),
    check(
      "guests_no_activation",
      sql`${table.activated_at} IS NULL AND ${table.expires_at} IS NULL`,
    ),
    check(
      "guests_requested_duration",
      sql`(${table.requested_duration_seconds} IS NOT NULL AND ${table.requested_duration_seconds} IN (43200, 86400, 172800, 604800)) OR (${table.requested_duration_seconds} IS NULL AND ${table.requested_expires_at} IS NOT NULL)`,
    ),
    check(
      "guests_revocation",
      sql`(${table.status} = 'draft' AND ${table.revoked_at} IS NULL) OR (${table.status} = 'revoked' AND ${table.revoked_at} IS NOT NULL)`,
    ),
  ],
);

export type Guest = typeof guests.$inferSelect;

// No provisioning state or credential: these rows describe intentions only.
export const guestResources = sqliteTable(
  "guest_resources",
  {
    id: text("id").primaryKey(),
    guest_id: text("guest_id")
      .notNull()
      .references(() => guests.id),
    kind: text("kind", { enum: ["node", "lan"] }).notNull(),
    node_id: text("node_id").notNull(),
    address: text("address").notNull(),
    route: text("route"),
    protocol: text("protocol", { enum: ["tcp", "udp"] }).notNull(),
    ports: text("ports").notNull(),
    created_at: integer("created_at", { mode: "timestamp" }).notNull(),
    updated_at: integer("updated_at", { mode: "timestamp" }).notNull(),
    revision: integer("revision").notNull().default(1),
  },
  (t) => [
    index("guest_resources_guest_idx").on(t.guest_id),
    uniqueIndex("guest_resources_target_idx").on(t.guest_id, t.address, t.protocol),
    check("guest_resources_kind", sql`${t.kind} IN ('node','lan')`),
    check("guest_resources_protocol", sql`${t.protocol} IN ('tcp','udp')`),
    check(
      "guest_resources_route",
      sql`(${t.kind} = 'node' AND ${t.route} IS NULL) OR (${t.kind} = 'lan' AND ${t.route} IS NOT NULL)`,
    ),
    check(
      "guest_resources_ports",
      sql`length(${t.ports}) BETWEEN 1 AND 512 AND ${t.ports} NOT GLOB '*[^0-9,-]*'`,
    ),
    check("guest_resources_revision", sql`${t.revision} >= 1`),
  ],
);
export type GuestResource = typeof guestResources.$inferSelect;

export const guestInvitations = sqliteTable(
  "guest_invitations",
  {
    id: text("id").primaryKey(),
    guest_id: text("guest_id")
      .notNull()
      .unique()
      .references(() => guests.id),
    email: text("email").notNull(),
    status: text("status", { enum: ["draft", "pending", "accepted", "expired", "revoked"] })
      .notNull()
      .default("draft"),
    token_hash: text("token_hash").unique(),
    token_version: integer("token_version").notNull().default(0),
    created_at: integer("created_at", { mode: "timestamp" }).notNull(),
    issued_at: integer("issued_at", { mode: "timestamp" }),
    expires_at: integer("expires_at", { mode: "timestamp" }),
    accepted_at: integer("accepted_at", { mode: "timestamp" }),
    revoked_at: integer("revoked_at", { mode: "timestamp" }),
    send_count: integer("send_count").notNull().default(0),
    last_sent_at: integer("last_sent_at", { mode: "timestamp" }),
    verification_sent_at: integer("verification_sent_at", { mode: "timestamp" }),
    created_by: text("created_by"),
    revision: integer("revision").notNull().default(1),
    delivery_state: text("delivery_state", { enum: ["idle", "sending", "sent", "failed"] })
      .notNull()
      .default("idle"),
    delivery_id: text("delivery_id"),
    delivery_started_at: integer("delivery_started_at", { mode: "timestamp" }),
  },
  (table) => [
    index("guest_invitations_expiry_idx").on(table.status, table.expires_at),
    check(
      "guest_invitation_status",
      sql`${table.status} IN ('draft','pending','accepted','expired','revoked')`,
    ),
    check(
      "guest_invitation_delivery",
      sql`${table.delivery_state} IN ('idle','sending','sent','failed')`,
    ),
    check(
      "guest_invitation_terminal_token",
      sql`${table.status} IN ('draft','pending') OR ${table.token_hash} IS NULL`,
    ),
    check(
      "guest_invitation_pending_dates",
      sql`${table.status} != 'pending' OR (${table.issued_at} IS NOT NULL AND ${table.expires_at} IS NOT NULL AND ${table.expires_at} > ${table.issued_at})`,
    ),
    check(
      "guest_invitation_acceptance",
      sql`(${table.status} = 'accepted' AND ${table.accepted_at} IS NOT NULL) OR (${table.status} != 'accepted' AND ${table.accepted_at} IS NULL)`,
    ),
    check(
      "guest_invitation_revocation",
      sql`(${table.status} = 'revoked' AND ${table.revoked_at} IS NOT NULL) OR (${table.status} != 'revoked' AND ${table.revoked_at} IS NULL)`,
    ),
    check(
      "guest_invitation_counters",
      sql`${table.send_count} >= 0 AND ${table.token_version} >= 0 AND ${table.revision} >= 1`,
    ),
  ],
);
export type GuestInvitation = typeof guestInvitations.$inferSelect;

export const guestInvitationSessions = sqliteTable(
  "guest_invitation_sessions",
  {
    id_hash: text("id_hash").primaryKey(),
    invitation_id: text("invitation_id")
      .notNull()
      .references(() => guestInvitations.id),
    token_version: integer("token_version").notNull(),
    expires_at: integer("expires_at", { mode: "timestamp" }).notNull(),
    code_hash: text("code_hash"),
    code_expires_at: integer("code_expires_at", { mode: "timestamp" }),
    code_ready: integer("code_ready", { mode: "boolean" }).notNull().default(false),
    attempts: integer("attempts").notNull().default(0),
  },
  (table) => [
    index("guest_invitation_sessions_expiry_idx").on(table.expires_at),
    index("guest_invitation_sessions_invitation_idx").on(table.invitation_id),
    check(
      "guest_invitation_code_ready",
      sql`${table.code_ready} = 0 OR (${table.code_hash} IS NOT NULL AND ${table.code_expires_at} IS NOT NULL)`,
    ),
  ],
);

export const guestInvitationEvents = sqliteTable(
  "guest_invitation_events",
  {
    id: text("id").primaryKey(),
    invitation_id: text("invitation_id")
      .notNull()
      .references(() => guestInvitations.id),
    kind: text("kind", {
      enum: [
        "created",
        "sent",
        "resent",
        "accepted",
        "expired",
        "revoked",
        "delivery_failed",
        "verification_sent",
        "verification_failed",
      ],
    }).notNull(),
    created_at: integer("created_at", { mode: "timestamp" }).notNull(),
    actor_id: text("actor_id"),
  },
  (table) => [
    index("guest_invitation_events_invitation_idx").on(
      table.invitation_id,
      table.created_at,
      table.id,
    ),
  ],
);

export const guestInvitationLimits = sqliteTable("guest_invitation_limits", {
  key_hash: text("key_hash").primaryKey(),
  window_start: integer("window_start").notNull(),
  hits: integer("hits").notNull(),
});
