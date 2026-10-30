---
title: Guest invitations
description: Send, verify, accept and expire administrative invitations without activating VPN access.
---

Guest invitations extend [Guest management](/features/guest-management) with email
delivery and verified administrative acceptance. Accepting an invitation verifies
access to the invited mailbox. It creates no Headplane login, Headscale user,
auth key, device, ACL rule, or VPN permission. Requested network durations remain
planning information and start no countdown. The email presents the recipient,
link deadline and access intention separately; an absolute access deadline is
shown in UTC. Guest retention is independent of both deadlines.

Invitations are disabled by default. Existing configurations and phase-one
drafts continue to work without SMTP or a public URL.

## Configure delivery

Set `server.base_url` to the public HTTPS origin without a path, query, credentials,
or fragment. Keep the route prefix in `server.base_path`. Enable secure cookies
and configure a sender and SMTP server:

```yaml
server:
  base_url: https://headplane.example.com
  base_path: /admin
  cookie_secure: true
  # Keep the other existing server settings.

guest_invitations:
  enabled: true
  transport: smtp
  service_name: Headplane
  from_address: invitations@example.com
  from_name: Network administration
  max_validity_hours: 168
  timeout_ms: 10000
  retries: 1
  smtp:
    host: smtp.example.com
    port: 587
    security: starttls
    username_path: /run/secrets/smtp-username
    password_path: /run/secrets/smtp-password
```

Use `security: tls` with an implicit TLS endpoint, commonly port 465. STARTTLS
is required when `security: starttls` is selected; delivery fails if the upgrade
is unavailable. Certificate verification is always enabled. Set `smtp.ca_path`
to a trusted PEM CA file for a private SMTP certificate. Unauthenticated SMTP
relays are supported over TLS by omitting both credentials. Providing only one
credential is rejected.

Timeouts apply to DNS, connection setup, greeting and socket inactivity. Allowed
values are 1,000–30,000 milliseconds. `retries` allows zero to two additional
attempts; the default is one. Permanent SMTP refusals are not retried. Before
delivery, Headplane verifies the SMTP connection and authentication. An SMTP
acceptance means the relay accepted the message; it is not a delivery receipt.
The SMTP transport uses [Nodemailer](https://nodemailer.com/smtp), with protocol
logging, filesystem content sources and URL content sources disabled.

Store credentials in protected secret files or supply
`HEADPLANE_GUEST_INVITATIONS__SMTP__USERNAME` and
`HEADPLANE_GUEST_INVITATIONS__SMTP__PASSWORD` through the service environment.
The corresponding `__USERNAME_PATH` and `__PASSWORD_PATH` environment variables
use the existing [secret file mechanism](/configuration/sensitive-values).
File values follow its trimming rules; environment credentials remain strings,
including numeric or boolean-like passwords. Never add real credentials to
version control. No SMTP credentials are stored in SQLite or returned to pages.

The maximum invitation validity defaults to 168 hours and can be configured from
1 to 720 hours. Each issuance chooses a whole number of hours between 1 and that
maximum. This validity belongs to the invitation link, independently of the
requested network duration and planned network deadline on the guest draft.

### Local development transport

Use a dedicated data directory and the file transport to test without contacting
any external email address:

```yaml
server:
  base_url: http://127.0.0.1:3001
  base_path: /admin
  cookie_secure: false
  data_path: /tmp/headplane-invitation-dev
  # Keep the other required server settings.

guest_invitations:
  enabled: true
  transport: file
```

Loopback HTTP is permitted only with this transport. Messages are MIME files in
`server.data_path/guest-mail/`, with HTML and plain-text alternatives. The
directory is created with mode 0700 and message files with mode 0600. These files
contain invitation links and verification codes: treat them as secrets, keep
them outside public/static directories, and remove them after testing. They are
not logs or an administrative inbox. Headplane never prints their contents.

## Check delivery without sending

Open **Settings → Guest email** (or **Guest email settings** from Guests).
Owners and admins can inspect the transport, sender, public origin and SMTP
connection metadata. SMTP passwords, usernames and secret paths are never
returned to the browser. Edit configuration and protected secret files on the
server; this screen never writes configuration or changes systemd services.

Select **Check connection** and confirm. SMTP checks negotiate mandatory TLS and
authenticate without sending `MAIL FROM`, a recipient or a message. File checks
verify directory access without creating a message. Checks have a one-minute
per-process cooldown, require `manage_guests` and use the existing same-origin
mutation guard. Errors are fixed messages without provider exception text.
Success confirms connectivity and authentication; it does not establish sender
approval, recipient acceptance or eventual inbox delivery.

Keep `transport: file` during validation. Changing production configuration or
sending real invitations requires the operator's approval. Verify the SMTP
endpoint, TLS mode, sender authorization and public URL before switching.
No connectivity check runs automatically at application startup or page load.

## Administrator guide

1. Open **Guests**, create a draft and verify its email address and requested
   access details.
2. Open the guest details and select **Send Invitation**.
3. Choose the invitation validity in hours (default 24, independent of access duration), then confirm **Send invitation**.
4. Filter the guest list by **Pending** to review outstanding invitations. The
   list and details show the invitation deadline and last successful send.
5. Review the delivery state and event history in the details.
6. Select **Resend** to issue a new link. Wait at least one minute between send
   attempts. Confirming a resend immediately invalidates the old link and all
   associated sessions and codes, even if the new delivery fails.
7. Select **Revoke invitation** and confirm to close an unused invitation.

An issued request cannot be edited in place. Create another draft for a different
recipient or revised request. A failed or interrupted delivery can be resent
after checking the configuration. Accepted and revoked invitations are terminal;
create another draft to start a new administrative request. Expired invitations
can be resent with a new deadline or administratively revoked.

Only owners and admins, through the existing `manage_guests` capability, can read
or change invitations and their event history. API key sessions retain their
existing administrative rights. Every private loader and intent checks RBAC
server-side. Guest revisions protect against stale forms across both draft and
invitation operations.

## Recipient guide

Open the complete link from the invitation email. Headplane exchanges the link
secret for a temporary browser session and removes the fragment from the address
bar. Select **Send verification code** to receive a separate email at the
administrator-recorded address. Enter the eight-digit code, confirm the statement
about administrative acceptance, then select **Accept invitation**.

The code expires after ten minutes and permits five failed guesses. A new code
invalidates every earlier code for the invitation, including codes issued in
other browser sessions. A session lasts fifteen minutes. Request another code
after sixty seconds if necessary; reopening the original link starts a new
session while the invitation remains pending and valid.

A link alone cannot accept the invitation. A fresh challenge demonstrates access
to the invited mailbox; it does not establish a legal identity or the identity
of a particular human, and forwarded or shared mailboxes retain their ordinary
limitations. OIDC account binding and stronger identity verification are future
work. Acceptance is a single administrative event and activates no network access.

Invalid, expired, revoked and already used links receive the same public failure.
The public page reveals no email address, administrative notes, account directory
or tailnet information. Refreshing a successfully accepted session preserves its
confirmation until that temporary session expires.

## Lifecycle and storage

Drafts retain the phase-one schema and restrictions, with a versioned
constraint upgrade adding 12-hour access intentions. See the
[access plan migration and revocation contract](/features/guest-management).
Issuing a draft creates a separate `guest_invitations` record; its status drives
the invitation presentation. A guest request has at most one invitation record,
while separate requests may still use the same normalized email address.

| Invitation state | Allowed next steps                                                |
| ---------------- | ----------------------------------------------------------------- |
| `draft`          | Initial preparation; first issuance creates the invitation record |
| `pending`        | Verified explicit acceptance, resend, expiration, or revocation   |
| `accepted`       | Terminal administrative acceptance, without VPN provisioning      |
| `expired`        | Resend with a fresh token/deadline, or revoke                     |
| `revoked`        | Terminal cancellation                                             |

No `active` state is used for invitations. A delivery state of `sending`, `sent`
or `failed` is separate from this lifecycle; acceptance requires a completed
successful send. The invitation's recipient email is snapshotted at issuance.

The additive `guest_invitations` migration creates:

| Table                       | Contents                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `guest_invitations`         | ULID, unique guest reference, recipient, lifecycle, token hash/version, issuance and lifecycle dates, send count, creator, revision and delivery lease |
| `guest_invitation_sessions` | Hashed random session ID, invitation/version, session expiry, keyed code hash/expiry, readiness and failed-attempt count                               |
| `guest_invitation_events`   | Event ID, invitation reference, event kind, time and optional administrator ID                                                                         |
| `guest_invitation_limits`   | Hashed limiter key, minute window and request count                                                                                                    |

Indexes cover expiry, token lookup, invitation/session relations and event order.
Constraints reject unsupported states, inconsistent terminal dates and tokens,
negative counters, missing pending dates, and codes marked ready without a hash.
Existing users, sessions, host details, drafts and revocations are preserved.

## Security and failure recovery

Link and session secrets contain 256 random bits. SQLite stores only their
SHA-256 hashes. Verification codes use a keyed HMAC bound to the browser session,
with the existing cookie secret as the key; a database copy alone is insufficient
to test a code dictionary. Code comparison uses constant-time hash comparison.
Changing the cookie secret invalidates existing sessions and code challenges.

Links use a URL fragment, so normal HTTP requests, access-log request URLs and
referrers contain no link token. The browser removes the fragment before posting
it in a same-origin form body. Do not add request-body capture or analytics to
this route. No secret appears in loader data, audit events or application logs.

Temporary cookies are signed, HttpOnly and SameSite Strict, and Secure with SMTP.
Every public mutation also requires an allowed Origin and session-bound CSRF
value. There is no arbitrary redirect target. Responses use `Cache-Control:
no-store`, `Referrer-Policy: no-referrer`, frame denial, content-type protection
and a content security policy. All page resources are same-origin; the normal
authenticated live-update connection is disabled on this page. JavaScript is
required for the fragment exchange. The CSP permits React Router's inline
hydration scripts; it is not a nonce-based strict CSP.

SQLite-backed fixed-minute limits survive service restarts and are shared across
processes: 120 public mutations globally, ten exchanges per link, three code
requests per session, and eight acceptance requests per session per minute. Each
challenge additionally allows five guesses total and each invitation permits a
mail attempt or new code only once per minute. Global limiting deliberately
avoids trusting arbitrary forwarded IP headers; it can affect other visitors
during abusive traffic. Public pages are not a general-purpose high-volume signup
service. Limiter windows and expired temporary sessions are pruned automatically.

Issuance reserves a new token and delivery lease in a transaction before email
delivery. Completion checks the lease, so revocation during SMTP delivery cannot
reactivate a link. A crash after SMTP accepted a message can leave an ambiguous
delivery; once the lease expires, the unrecoverable token is invalidated and an
administrator can resend. The lease accounts for the configured timeout/retry
budget. Limited retries can deliver duplicate messages, but only the current
token can be consumed and acceptance remains single-use.

Acceptance, revocation, session invalidation and their audit events are atomic.
Every use checks expiry immediately. A worker runs at startup and every thirty
seconds to expire pending invitations and record one expiration event, recover
abandoned sends, reconcile phase-one revocations made during a rollback, and
prune transient state. It needs no Internet connection or SMTP availability.

The audit stores created, sent, resent, accepted, expired, revoked, delivery
failure, verification sent and failed verification events. It stores no token,
code, SMTP exception, credentials, address copies or source IP. The private UI
shows the latest 100 events. Full audit history is retained with the invitation;
automatic archival and deletion are not implemented.

## Tests and migration

Run:

```sh
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm build
pnpm test:integration tests/integration/headplane/guest-invitations.test.ts tests/integration/headplane/guest-mail.test.ts tests/integration/headplane/guest-email-settings.test.ts tests/integration/headplane/guests.test.ts tests/integration/headplane/permissions.test.ts
HP_HEADSCALE_VERSIONS=all pnpm test:integration tests/integration/headplane/guest-invitations.test.ts
```

The SMTP fixture is a real TLS/STARTTLS server bound only to loopback. It captures
mail in memory and tests authentication, certificate verification, refusal of
plaintext fallback, permanent errors and bounded retries. Route scenarios use
the real Headscale harness and compare policy, users, machines and configuration
before and after guest acceptance. Unit tests cover replay, concurrency,
revocation, resend rotation, expiry, restart recovery, OTP limits, durable rate
limits, secret loading, database failures and phase-one data preservation.

Migration tests also verify that a pending mailbox challenge survives reopening
SQLite. To test a consistent read-only copy of the development database, run:

```sh
HP_GUEST_MIGRATION_SOURCE=/path/to/development/hp_persist.db pnpm test:unit tests/unit/guests/migration.test.ts
```

For the opt-in Chromium scenario, install Chromium, build the app, then run:

```sh
pnpm exec playwright install chromium
HP_GUEST_BROWSER=1 HP_GUEST_SCREENSHOTS=/tmp/headplane-invitation-review \
  pnpm test:integration tests/integration/headplane/invitation-browser.test.ts
```

This scenario starts isolated services, exercises a custom route prefix, performs
mailbox verification and acceptance in a fresh browser context, and checks for
token disclosure, third-party requests and mobile overflow. It captures light,
dark and mobile views when an output directory is supplied.

Back up Headplane's database consistently before upgrading. Migrations apply at
startup. Roll back the application by stopping the upgraded instance and running
the previous version with the additive tables retained. The invitation route is
then unavailable. Do not remove migration history or drop tables. Restore the
whole backup only when intentionally discarding all subsequent Headplane changes.
On a later upgrade, phase-one revocations are reconciled before a link is used.

## Future phases

[Resource selection and read-only ACL preview](/features/guest-resources) are available
as administrative intentions. OIDC identity binding, Headscale account provisioning,
network grants, effective access expiry and device revocation remain separate
work. Invitation acceptance is only an audited prerequisite for those workflows.
No Headscale client or agent dependency is passed to the invitation service.
