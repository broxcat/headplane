CREATE TABLE `local_admin_users` (
	`user_id` text PRIMARY KEY,
	`username` text NOT NULL,
	`normalized_username` text NOT NULL UNIQUE,
	`password_hash` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`password_changed_at` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `fk_local_admin_users_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
	CONSTRAINT "local_admin_enabled" CHECK("enabled" IN (0, 1)),
	CONSTRAINT "local_admin_revision" CHECK("revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE `local_auth_events` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `local_auth_limits` (
	`key` text PRIMARY KEY,
	`window_start` integer NOT NULL,
	`hits` integer NOT NULL,
	`locked_until` integer NOT NULL
);
