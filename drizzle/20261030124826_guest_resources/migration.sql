CREATE TABLE `guest_resources` (
	`id` text PRIMARY KEY,
	`guest_id` text NOT NULL,
	`kind` text NOT NULL,
	`node_id` text NOT NULL,
	`address` text NOT NULL,
	`route` text,
	`protocol` text NOT NULL,
	`ports` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `fk_guest_resources_guest_id_guests_id_fk` FOREIGN KEY (`guest_id`) REFERENCES `guests`(`id`),
	CONSTRAINT "guest_resources_kind" CHECK("kind" IN ('node','lan')),
	CONSTRAINT "guest_resources_protocol" CHECK("protocol" IN ('tcp','udp')),
	CONSTRAINT "guest_resources_route" CHECK(("kind" = 'node' AND "route" IS NULL) OR ("kind" = 'lan' AND "route" IS NOT NULL)),
	CONSTRAINT "guest_resources_ports" CHECK(length("ports") BETWEEN 1 AND 512 AND "ports" NOT GLOB '*[^0-9,-]*'),
	CONSTRAINT "guest_resources_revision" CHECK("revision" >= 1)
);
--> statement-breakpoint
CREATE INDEX `guest_resources_guest_idx` ON `guest_resources` (`guest_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `guest_resources_target_idx` ON `guest_resources` (`guest_id`,`address`,`protocol`);