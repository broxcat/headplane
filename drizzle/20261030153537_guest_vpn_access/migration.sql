CREATE TABLE `guest_vpn_access` (
	`guest_id` text PRIMARY KEY,
	`user_name` text NOT NULL UNIQUE,
	`user_marker` text NOT NULL,
	`headscale_user_id` text UNIQUE,
	`state` text DEFAULT 'not_provisioned' NOT NULL,
	`desired_state` text DEFAULT 'active' NOT NULL,
	`phase` text DEFAULT 'prepared' NOT NULL,
	`permission` text,
	`activated_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_sync_at` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer,
	`error_code` text,
	CONSTRAINT `fk_guest_vpn_access_guest_id_guests_id_fk` FOREIGN KEY (`guest_id`) REFERENCES `guests`(`id`),
	CONSTRAINT "guest_vpn_state" CHECK("state" IN ('not_provisioned','provisioning','active','revoking','revoked','expired','error')),
	CONSTRAINT "guest_vpn_desired" CHECK("desired_state" IN ('active','revoked','expired')),
	CONSTRAINT "guest_vpn_active_dates" CHECK("state" != 'active' OR ("headscale_user_id" IS NOT NULL AND "permission" IS NOT NULL AND "activated_at" IS NOT NULL AND "expires_at" > "activated_at")),
	CONSTRAINT "guest_vpn_counters" CHECK("revision" >= 1 AND "attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE `guest_vpn_auth_claims` (
	`auth_hash` text PRIMARY KEY,
	`guest_id` text NOT NULL,
	`state` text NOT NULL,
	`node_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_guest_vpn_auth_claims_guest_id_guests_id_fk` FOREIGN KEY (`guest_id`) REFERENCES `guests`(`id`),
	CONSTRAINT "guest_vpn_claim_state" CHECK("state" IN ('reserved','consumed','uncertain'))
);
--> statement-breakpoint
CREATE TABLE `guest_vpn_devices` (
	`node_id` text PRIMARY KEY,
	`guest_id` text NOT NULL,
	`machine_key_hash` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_guest_vpn_devices_guest_id_guests_id_fk` FOREIGN KEY (`guest_id`) REFERENCES `guests`(`id`),
	CONSTRAINT "guest_vpn_device_state" CHECK("state" IN ('registered','expired','missing'))
);
--> statement-breakpoint
CREATE TABLE `guest_vpn_events` (
	`id` text PRIMARY KEY,
	`guest_id` text NOT NULL,
	`kind` text NOT NULL,
	`code` text,
	`node_id` text,
	`actor_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_guest_vpn_events_guest_id_guests_id_fk` FOREIGN KEY (`guest_id`) REFERENCES `guests`(`id`)
);
--> statement-breakpoint
CREATE TABLE `guest_vpn_policy_state` (
	`id` integer PRIMARY KEY,
	`owner` text,
	`lease_until` integer,
	`expected_hash` text,
	`before_policy` text,
	`candidate_policy` text,
	`pending_guest_id` text,
	`pending_permission` text,
	`pending_remove` integer DEFAULT false NOT NULL,
	CONSTRAINT "guest_vpn_policy_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE TABLE `guest_vpn_sessions` (
	`id_hash` text PRIMARY KEY,
	`guest_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_guest_vpn_sessions_guest_id_guests_id_fk` FOREIGN KEY (`guest_id`) REFERENCES `guests`(`id`)
);
--> statement-breakpoint
CREATE INDEX `guest_vpn_due_idx` ON `guest_vpn_access` (`state`,`expires_at`,`retry_at`);--> statement-breakpoint
CREATE INDEX `guest_vpn_claim_guest_idx` ON `guest_vpn_auth_claims` (`guest_id`);--> statement-breakpoint
CREATE INDEX `guest_vpn_devices_guest_idx` ON `guest_vpn_devices` (`guest_id`);--> statement-breakpoint
CREATE INDEX `guest_vpn_events_guest_idx` ON `guest_vpn_events` (`guest_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `guest_vpn_sessions_expiry_idx` ON `guest_vpn_sessions` (`expires_at`);