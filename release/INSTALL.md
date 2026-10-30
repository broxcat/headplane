# Headplane Guest release — Linux AMD64

This is the broxcat/headplane fork of tale/headplane, distributed under the original
MIT license. Keep LICENSE and THIRD_PARTY/ with redistributed copies. THIRD_PARTY/
contains notices for bundled JavaScript, fonts, Go modules and the Go runtime.

## Requirements

- Linux AMD64 and Node.js 24 (24.22.2 is the pinned build/runtime reference).
- A separately installed Headscale, version 0.27.0 or later. Automated Guest tests
  cover 0.27.1, 0.28.0 and 0.29.5. The optional agent and Browser SSH require 0.28+.
- A writable persistent Headplane data directory and protected configuration.
- HTTPS and a public origin for actual SMTP invitation delivery.

Node.js is a prerequisite, not included in the archive. No npm install or runtime
node_modules is needed: the server dependencies are bundled. hp_agent and
hp_healthcheck are statically built Go binaries; Browser SSH WASM is in build/client.

## Download and install

Download the archive, SHA256SUMS, INSTALL.md, RELEASE-NOTES.md, release.json and
THIRD_PARTY_NOTICES.md from the same GitHub Release, then check all files:

```sh
guest_tag=v0.8.1-guest
mkdir "$guest_tag"
cd "$guest_tag"
gh release download "$guest_tag" --repo broxcat/headplane
sha256sum --check SHA256SUMS
sudo mkdir -p /opt/headplane/releases
sudo tar -xzf headplane-0.8.1-guest-linux-amd64.tar.gz -C /opt/headplane/releases
```

Checksums detect corruption; verify the release/tag provenance through the fork's
GitHub account as well. Never mix checksums and assets from different releases.

Create a dedicated system account and persistent directories if absent. Keep the
release immutable to that account, and give it read/execute access. Start from
config.example.yaml only for a new installation; retain existing configuration and
secret files during an upgrade. Generate a strong cookie secret and configure the
Headscale URL and existing authentication. Set server.data_path to the persistent
directory, never a release directory. Keep file SMTP credentials in protected files
through username_path/password_path; do not put secrets in the release directory.

Set integration.agent.executable_path to the release's hp_agent path when opting
into the agent. Keep its work_dir outside releases so the agent identity survives
upgrades. Integration, OIDC and SMTP remain optional.

For a first installation, point /opt/headplane/current to the extracted directory.
Run from that directory (Drizzle migrations are resolved relative to it):

```sh
cd /opt/headplane/current
HEADPLANE_CONFIG_PATH=/etc/headplane/config.yaml node build/server/index.js
```

Run as the dedicated service account. A systemd example is included. Adapt the Node
binary path, user/group and file permissions to the installation. The unit controls
only Headplane, independently of Headscale. Do not enable Docker/proc integrations
unless their operational permissions and restart behavior are explicitly intended.

Check the configured origin plus /admin/healthz (or the custom server.base_path).
Use a trusted CA for native HTTPS. hp_healthcheck reads HEADPLANE_LISTEN_FILE when
that optional discovery file is enabled; it is not a replacement for CA-validated
native HTTPS checks.

## Guest setup

Invitations are disabled until configured. Use guest_invitations.transport: file for
local validation; MIME files in data_path/guest-mail contain sensitive links/codes.
Keep them private and never serve that directory. Set enabled: true, sender details,
server.base_url to the HTTPS origin, cookie_secure: true, and SMTP settings to enable
actual sending. Use implicit TLS or required STARTTLS. Settings → Guest email checks
connectivity/authentication without sending a message or exposing credentials.

Relative access plans are 12 hours, 48 hours or 7 days, starting only at a future
confirmed VPN activation. Custom date uses the browser zone, stores UTC, and rejects
ambiguous/nonexistent or elapsed dates. Invitation validity defaults to 24 hours
and is separate. Guest records/audits remain after invitation expiry/revocation.

## Upgrade and SQLite migration

1. Verify/download a new immutable release directory; do not overwrite current.
2. Record the current symlink target and configuration permissions.
3. Stop only Headplane. Take a coherent SQLite backup using SQLite's backup API
   or .backup command, and back up configuration and the stopped agent state.
4. Test migrations on a backup copy. Never start a test with production data_path
   or Headscale credentials; use an isolated config and test Headscale.
5. Preserve configuration/secrets and the persistent data directory. Atomically
   replace current using a temporary symlink and rename on the same filesystem.
6. Start only Headplane. Its startup invokes the project's official Drizzle
   migrator and its SQLite foreign-key adapter. Do not use drizzle-kit push,
   hand-applied SQL, schema resets or an empty replacement database.
7. Verify HTTPS, authentication, agent, Guest pages and unchanged Headscale policy.

Fresh databases apply all 11 migrations. Phase 1 creates guests; Phase 2 adds
invitation/session/audit/rate-limit tables. The final guest_access_duration migration
broadens the duration CHECK to accept 43,200 seconds. It rebuilds guests in one
transaction, preserving every column, record, index and reference, checks foreign
keys before commit, and restores enforcement even on failure. Legacy 24-hour and
mixed duration/deadline records remain intact. Only new edits choose one intention.
Always back up before upgrading; this release does not migrate any remote Headscale.

## Rollback

Stop only Headplane and repoint current atomically to the previous verified release.
Keep configuration and persistent SQLite in place, then restart Headplane. Keep all
11 migration records and the broadened duration constraint. The Phase 2 binary has
been tested against a migrated database; older forms cannot edit new 12-hour plans.
Do not narrow the CHECK constraint while such rows exist. Do not remove invitation
records, audit, tables or migration history.

Do not automatically restore the backup: it discards changes made after it was
created. Data restoration is a separate, explicitly planned recovery operation.
Keep old releases and backups until the new release is verified.

## Scope and limitations

Guest invitations verify mailbox access and administrative acceptance only. No
Guest ACL, Headscale user, pre-auth key, machine, route or VPN permission is
provisioned. Revoke Invitation does not revoke network access. Revoke Access Now and
automatic network expiry are future work. Automatic guest purge/retention is not
implemented. SMTP acceptance is not proof of inbox delivery. See the included Guest
documents for rate limits, lifecycle, privacy and the future revocation contract.

## Build and provenance

Source: https://github.com/broxcat/headplane. Original: https://github.com/tale/headplane.
Version policy: one immutable v<base-version>-guest per Headplane base version;
there are no feature counters. Never replace a published tag or its assets.

Install the exact toolchains in release/toolchains.json. Run pnpm install
--frozen-lockfile, typecheck, lint, unit/integration tests, Go tests, then
./scripts/build-guest.sh dist. The build uses lockfiles, CGO_ENABLED=0, trimpath,
no source maps, sorted archives, normalized owners/modes/timestamps and gzip without
a wall-clock timestamp. release.json records the exact source commit/tree and tools.
Candidate archives from an uncommitted tree are marked sourceDirty and must never
be published. Final archives must be built from the annotated main-branch tag.
