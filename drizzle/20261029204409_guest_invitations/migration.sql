CREATE TABLE `guest_invitation_events` (
	`id` text PRIMARY KEY,
	`invitation_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT `fk_guest_invitation_events_invitation_id_guest_invitations_id_fk` FOREIGN KEY (`invitation_id`) REFERENCES `guest_invitations`(`id`)
);
--> statement-breakpoint
CREATE TABLE `guest_invitation_limits` (
	`key_hash` text PRIMARY KEY,
	`window_start` integer NOT NULL,
	`hits` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `guest_invitation_sessions` (
	`id_hash` text PRIMARY KEY,
	`invitation_id` text NOT NULL,
	`token_version` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`code_hash` text,
	`code_expires_at` integer,
	`code_ready` integer DEFAULT false NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_guest_invitation_sessions_invitation_id_guest_invitations_id_fk` FOREIGN KEY (`invitation_id`) REFERENCES `guest_invitations`(`id`),
	CONSTRAINT "guest_invitation_code_ready" CHECK("code_ready" = 0 OR ("code_hash" IS NOT NULL AND "code_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `guest_invitations` (
	`id` text PRIMARY KEY,
	`guest_id` text NOT NULL UNIQUE,
	`email` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`token_hash` text UNIQUE,
	`token_version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`issued_at` integer,
	`expires_at` integer,
	`accepted_at` integer,
	`revoked_at` integer,
	`send_count` integer DEFAULT 0 NOT NULL,
	`last_sent_at` integer,
	`verification_sent_at` integer,
	`created_by` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`delivery_state` text DEFAULT 'idle' NOT NULL,
	`delivery_id` text,
	`delivery_started_at` integer,
	CONSTRAINT `fk_guest_invitations_guest_id_guests_id_fk` FOREIGN KEY (`guest_id`) REFERENCES `guests`(`id`),
	CONSTRAINT "guest_invitation_status" CHECK("status" IN ('draft','pending','accepted','expired','revoked')),
	CONSTRAINT "guest_invitation_delivery" CHECK("delivery_state" IN ('idle','sending','sent','failed')),
	CONSTRAINT "guest_invitation_terminal_token" CHECK("status" IN ('draft','pending') OR "token_hash" IS NULL),
	CONSTRAINT "guest_invitation_pending_dates" CHECK("status" != 'pending' OR ("issued_at" IS NOT NULL AND "expires_at" IS NOT NULL AND "expires_at" > "issued_at")),
	CONSTRAINT "guest_invitation_acceptance" CHECK(("status" = 'accepted' AND "accepted_at" IS NOT NULL) OR ("status" != 'accepted' AND "accepted_at" IS NULL)),
	CONSTRAINT "guest_invitation_revocation" CHECK(("status" = 'revoked' AND "revoked_at" IS NOT NULL) OR ("status" != 'revoked' AND "revoked_at" IS NULL)),
	CONSTRAINT "guest_invitation_counters" CHECK("send_count" >= 0 AND "token_version" >= 0 AND "revision" >= 1)
);
--> statement-breakpoint
CREATE INDEX `guest_invitation_events_invitation_idx` ON `guest_invitation_events` (`invitation_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `guest_invitation_sessions_expiry_idx` ON `guest_invitation_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `guest_invitation_sessions_invitation_idx` ON `guest_invitation_sessions` (`invitation_id`);--> statement-breakpoint
CREATE INDEX `guest_invitations_expiry_idx` ON `guest_invitations` (`status`,`expires_at`);