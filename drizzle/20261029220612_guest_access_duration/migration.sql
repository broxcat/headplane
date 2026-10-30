CREATE TABLE `__new_guests` (
	`id` text PRIMARY KEY,
	`email` text NOT NULL,
	`display_name` text,
	`notes` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`requested_duration_seconds` integer,
	`requested_expires_at` integer,
	`activated_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`revision` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "guests_phase_one_status" CHECK("status" IN ('draft', 'revoked')),
	CONSTRAINT "guests_no_activation" CHECK("activated_at" IS NULL AND "expires_at" IS NULL),
	CONSTRAINT "guests_requested_duration" CHECK(("requested_duration_seconds" IS NOT NULL AND "requested_duration_seconds" IN (43200, 86400, 172800, 604800)) OR ("requested_duration_seconds" IS NULL AND "requested_expires_at" IS NOT NULL)),
	CONSTRAINT "guests_revocation" CHECK(("status" = 'draft' AND "revoked_at" IS NULL) OR ("status" = 'revoked' AND "revoked_at" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_guests`(`id`, `email`, `display_name`, `notes`, `status`, `requested_duration_seconds`, `requested_expires_at`, `activated_at`, `expires_at`, `revoked_at`, `created_at`, `updated_at`, `created_by`, `revision`) SELECT `id`, `email`, `display_name`, `notes`, `status`, `requested_duration_seconds`, `requested_expires_at`, `activated_at`, `expires_at`, `revoked_at`, `created_at`, `updated_at`, `created_by`, `revision` FROM `guests`;--> statement-breakpoint
DROP TABLE `guests`;--> statement-breakpoint
ALTER TABLE `__new_guests` RENAME TO `guests`;--> statement-breakpoint
CREATE INDEX `guests_email_idx` ON `guests` (`email`);--> statement-breakpoint
CREATE INDEX `guests_created_idx` ON `guests` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `guests_status_created_idx` ON `guests` (`status`,`created_at`,`id`);
--> statement-breakpoint
-- Abort the official migrator transaction rather than commit broken references.
CREATE TEMP TABLE `__guest_fk_check` (`violations` integer NOT NULL CHECK (`violations` = 0));
--> statement-breakpoint
INSERT INTO `__guest_fk_check` SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE `__guest_fk_check`;
