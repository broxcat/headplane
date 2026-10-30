# Headplane v0.8.1 — Guest Features

First pre-release of the broxcat/headplane fork, based on Headplane 0.8.1 by
Aarnav Tale and contributors. This is a custom Guest distribution, not an upstream
Headplane release. The original MIT license and credits are retained.

## Guest Features

- Guest Management: searchable drafts, filters, sorting, details and concurrent-edit protection.
- Secure single-use invitation links, hashed tokens, rotation on resend, expiry and revocation.
- Separate email verification codes and explicit administrative acceptance.
- SMTP with implicit TLS/required STARTTLS, or private local file transport.
- Access duration: 12 hours, 48 hours, 7 days or Custom date in the browser zone,
  converted to UTC with DST gap/fold validation.
- Independent invitation validity (default 24 hours), access intentions and retained audit records.
- Invitation event history and administrative revocation.
- Settings → Guest email: safe connection metadata and a connectivity check without sending.
- HttpOnly authentication cookies, configured session lifetime limits and source-map-free artifacts.

## Compatibility and prerequisites

Linux AMD64 archive; Node.js 24 required separately, with 24.22.2 as the build
reference. No runtime node_modules installation is needed. Agent/healthcheck binaries,
Browser SSH WASM and Drizzle migrations are included. Headscale 0.27.0+ is required;
Guest integration tests cover 0.27.1, 0.28.0 and 0.29.5. Optional agent/Browser SSH
require Headscale 0.28+. Headscale remains a separately managed service.

## Installation and update

Download the Linux AMD64 archive and all SHA256SUMS-listed assets. Run
sha256sum --check SHA256SUMS before extraction. Follow INSTALL.md for dedicated-user
setup, protected configuration, a persistent data directory and optional systemd.
Existing installations must keep their configuration, secrets, database and agent
identity. Extract into a new release directory; never overwrite the active release.
Stop/restart only Headplane when switching its current symlink atomically.

## SQLite migration and rollback

Back up SQLite coherently and preserve configuration/agent state before upgrading.
Startup applies the bundled official migrations. Fresh databases reach 11 migrations.
The Guest duration upgrade transactionally rebuilds guests to broaden its CHECK for
12 hours, preserves all records/references/indexes and validates foreign keys. Test
on a copy first. Do not reset or replace the database, or use drizzle-kit push.

Rollback means returning to the previous verified binary and keeping SQLite, its
11 migrations and the broadened CHECK. Phase 2 can read the migrated database, but
its forms cannot edit new 12-hour plans. Never automatically restore an older backup
or drop migration history; doing so loses subsequent data. See INSTALL.md.

## Limitations

**No Guest ACLs or VPN access are provisioned.** Acceptance does not create a
Headscale user, device or pre-auth key. VPN revocation and automatic network expiry
are not implemented. Revoke Invitation cancels only the invitation. Actual email
requires explicit SMTP configuration; file transport sends nothing externally.
Automatic record purge is not implemented. This is a pre-release for controlled
validation. Do not replace an existing v<base>-guest tag; the next base update uses
v0.8.2-guest, then v0.8.3-guest, without feature counters.

## Credits and redistribution

Original Headplane: https://github.com/tale/headplane — Aarnav Tale and contributors.
Fork and Guest additions: https://github.com/broxcat/headplane.
LICENSE contains the unchanged original MIT terms. THIRD_PARTY/ includes dependency
notices, font/Go runtime licenses and corresponding source where required. The
Tailscale WASM patch is included. Node.js is not redistributed in this archive.
