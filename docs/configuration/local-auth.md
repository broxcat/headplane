---
title: Local administrator authentication
description: Sign in with a server-managed username and password while keeping Headscale credentials on the server.
---

Local authentication is optional. Existing API key, single sign-on and trusted
proxy authentication remain available. Local administrators use Headplane's
existing `admin` role and capability checks; they are not Headscale users and
their passwords cannot register Tailscale devices.

## Enable local authentication

Back up the Headplane SQLite database before upgrading. The additive migration
creates `local_admin_users`, `local_auth_limits` and `local_auth_events`. It
preserves existing users, sessions, Guests, resources and invitations. Startup
applies migrations to the configured data directory. Keep configuration, the
cookie secret and persistent storage protected by filesystem permissions.

Configure a server-side Headscale API key and explicitly enable local login:

```yaml
headscale:
  api_key_path: /etc/headplane/secrets/headscale-api-key

auth:
  local:
    enabled: true

server:
  cookie_secure: true
  cookie_max_age: 86400
```

Retain the other required configuration fields. `HEADPLANE_AUTH__LOCAL__ENABLED=true`
is the equivalent environment override. The existing deprecated OIDC API-key
fallback continues to work, but prefer `headscale.api_key_path`. Never configure
both `headscale.api_key` and `headscale.api_key_path`.

The key remains a backend credential: maintain its expiry on the server without
copying it into the local login form. A missing server key makes an explicitly
enabled local configuration invalid. Use HTTPS and secure cookies; TLS served
directly by Headplane forces secure cookies on. See [Sensitive values](/configuration/sensitive-values)
and [TLS](/configuration/tls).

## Create the first administrator

Run maintenance commands from the Headplane installation directory, with the
same OS account and configuration as the server. Source checkouts require
`pnpm build` first. These commands open only SQLite: they do not start an HTTP
listener, contact Headscale or start the agent.

```sh
node build/server/index.js admin create --config /etc/headplane/config.yaml
```

```text
Username: operations
Display name: Operations
Password:
Confirm password:
Administrator created.
```

Password input is hidden and requires an interactive terminal. Passwords are
never accepted as command-line arguments or environment variables. An optional
username can follow `create`. New files created by maintenance use an owner-only
umask. Existing database and configuration permissions remain the operator's
responsibility.

Usernames contain 3–64 ASCII letters, digits, dots, underscores or hyphens and
start with a letter or digit. Names are unique without regard to ASCII case.
Unicode usernames and surrounding whitespace are rejected. Passwords accept
12–256 Unicode characters, including spaces and long passphrases, without
trimming, normalization or silent truncation. NUL characters are rejected.

There is no anonymous web bootstrap. Without an enabled local account, the login
page keeps presenting the existing authentication methods and the server logs a
bootstrap notice. Create an account before expecting the local form to appear.

## Sign in and change a password

Open the configured Headplane login page (normally `/admin/login`). Enter the
username and password in the primary form. Single sign-on remains alongside it;
Headscale API key authentication is under **Advanced** when local login is
available. Existing OIDC-only automatic redirects are preserved when local login
is unavailable. With local login available, the method chooser is shown even
when `oidc.disable_api_key_login` previously selected an automatic SSO redirect.

Open **Settings → Account** to view the username, display name and authentication
method. Changing a local password requires the current password, a new password
and confirmation. A successful change revokes **all** local sessions, including
the current session, clears its cookie and requires signing in again. OIDC and
API key accounts show their authentication method without a local password form.

## Recover and maintain accounts

Recovery requires server access; there is no email-based password reset.

```sh
node build/server/index.js admin list --config /etc/headplane/config.yaml
node build/server/index.js admin reset-password operations --config /etc/headplane/config.yaml
node build/server/index.js admin disable operations --config /etc/headplane/config.yaml
node build/server/index.js admin enable operations --config /etc/headplane/config.yaml
node build/server/index.js admin revoke-sessions operations --config /etc/headplane/config.yaml
```

`reset-password` prompts twice without echoing input. Resetting a password,
disabling or enabling an account, and explicit session revocation revoke every
local session for that account. A reset also clears its account throttle; it
does not enable a disabled account. Account listing includes only public
metadata, never password hashes. To change a display name, maintain the account
record through a future account-management interface; this phase exposes its
display name as read-only after creation.

Existing RBAC user management can assign another supported role to the identity.
Local bootstrap always creates `admin`, not `owner`. Preserve an existing owner
or API-key recovery method for owner-only operations.

## Sessions and brute-force protection

Local sessions use the existing `auth_sessions` table and `_hp_auth` cookie.
The signed cookie contains only the session ID. It is HttpOnly, SameSite=Lax,
scoped to the configured base path, Secure when configured, and bounded by
`server.cookie_max_age`. Logout deletes the server-side session. Every new
request resolves the current role and checks that local authentication and the
account remain enabled. Revocation cannot undo a response or operation already
in progress; existing streams follow the application's connection lifetime.

Persistent SQLite limits reserve attempts before Argon2 work:

- Account: five attempts in a 15-minute window before a temporary delay starts
  at one second and doubles to a maximum of 60 seconds. An expired delay permits
  another attempt. Rejected attempts do not extend the current delay. Successful
  password verification clears that account's penalty.
- Direct network peer: 20 attempts per minute across usernames.
- Server: 60 attempts per minute across usernames and peers, with at most two
  password verifications in flight per process.

Throttled refusals are coalesced to at most one audit event per minute, preventing
audit amplification during a flood.

Unknown accounts receive the same generic credential error and Argon2 cost as
known accounts. Throttled requests return HTTP 429. Address limits use only the
socket address provided by the HTTP adapter, ignoring `X-Forwarded-For` and
similar request headers. Behind a proxy the address budget is shared by its
clients; add an appropriately configured edge limiter for larger deployments.
When no peer address is available, account and global limits still apply.
Global or proxy-shared budgets can temporarily affect legitimate sign-ins under
attack; server-side reset remains available.

Sensitive web forms retain React Router's Origin protection. Local login,
password change and logout additionally reject explicit foreign or opaque
origins and cross-site fetch metadata when called directly.

## Password storage and audit

Argon2id version 19 uses 64 MiB, three passes, one lane, a random 16-byte salt
and a 32-byte output. Parameters are centralized in
`app/server/web/passwords.ts`. The PHC string stores the algorithm, version,
parameters, salt and hash. A successful login upgrades older, weaker parameters.
Verification compares derived bytes with Node's constant-time comparison. Modern
Node uses native asynchronous Argon2; earlier supported Node versions use the
bundled WASM implementation, whose work runs on the main thread. Rate and
concurrency limits bound authentication work.

Local session creation, successful and refused logins, account creation,
enable/disable, password changes/resets and session revocation are recorded in
`local_auth_events`; authentication events also appear in server logs. Rejected
usernames are not logged. Events contain timestamps, event names and internal
account IDs only. Passwords, hashes, session tokens, cookies and Headscale,
OIDC or SMTP credentials are never audit fields. Protect the database and logs;
plan audit retention according to the deployment's needs.

The backend Headscale key is not returned in local cookies, loader data or client
bundles. Existing API-key login still uses its existing credential cookie model;
it is a separate login method and is not used by local accounts.

## Back up and restore SQLite

Back up `hp_persist.db` in `server.data_path` with SQLite's online backup API or
`sqlite3 /path/to/hp_persist.db '.backup /secure/path/headplane-backup.db'`.
Alternatively stop Headplane cleanly before copying persistent files. Avoid a
plain copy of a live database with uncheckpointed WAL data.

Keep the backup, configuration, cookie secret and any secret files separately
protected and encrypted at rest. Backups contain credential hashes, session
records, personal information and existing OIDC logout tokens. Restore into a
stopped installation, then revoke restored local sessions or rotate the cookie
secret before exposing it. Cookie-secret rotation invalidates all signed
Headplane sessions. Retain the additive tables and migration history when
rolling back application code.

## Future MFA

The local credential service proves the first authentication factor; session
creation is a distinct step that rechecks the enabled state and credential
revision. A future MFA flow must defer `createLocalSession` until TOTP or WebAuthn
verification succeeds, bind a short-lived challenge to that revision and revoke
challenges on credential changes. Store MFA credentials in separate related
tables. No MFA or email recovery is implemented in this phase.
