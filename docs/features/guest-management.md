---
title: Guest management
description: Prepare guest requests in Headplane without provisioning network access.
---

Guest management prepares administrative requests for future temporary access.
The phase-one foundation stores drafts in Headplane only. Creating a draft sends
no email, creates no Headscale users or auth keys, and changes no ACLs, machines,
or Headscale configuration. Optional [Guest invitations](/features/guest-invitations)
add email delivery and verified administrative acceptance when configured.
Saving a draft never grants VPN access or starts an access countdown.

## Manage guests

Open **Guests** in the administration navigation and select **Add Guest**.
Enter an email address, optionally a display name and administrative notes, and
choose **Access duration**: **12 hours**, **48 hours**, **7 days**, or **Custom date**.
The choice is exclusive. Presets store 43,200, 172,800 or 604,800 seconds, with no
absolute expiry. They begin only after confirmed VPN provisioning in a future
phase; draft creation, invitation sending and acceptance start no access countdown.

Select **Custom date** to reveal **Date** and **Time** under **Access expires at**.
The dialog shows the browser's IANA time zone and the resulting UTC instant.
The server independently resolves the local wall time using that zone. Invalid
calendar dates, nonexistent clock-change times and ambiguous repeated times are
rejected rather than silently normalized. Choose an unambiguous time after the
clock change. Dates must be in the future and within five years (5 × 366 days).
Only the absolute UTC instant is persisted; reopening the draft converts that
instant into the current browser's time zone without changing the deadline.

An absolute deadline remains an upper bound. If it passes before access is
activated, a future provisioning service must refuse activation. The pure
`accessExpiryAtActivation` helper defines that date calculation, without granting
or revoking any permission. Authorization and Headscale confirmation remain
separate requirements for a future provisioning implementation.

Select **Create draft**. Search by name or email, filter by status, or sort by
creation or modification date. Select **Apply** to save search options in the
address bar. Lists contain up to 25 requests per page. Select **View** or the
guest name to open details, then **Edit draft** to change information.
After issuance, use the invitation actions or create another draft; an issued
request cannot be edited in place.

Select **Revoke draft** and confirm to close a request permanently. Revoked
requests remain visible for administrative history and cannot be edited or
reactivated. Revoking a draft does not revoke an existing Headscale identity,
device, or network permission. Create another draft to start a new request.
Deletion is not available in this phase.

Multiple requests may use the same email address, including multiple drafts.
Each request has a separate ID, requested access, and lifecycle. Email addresses
are trimmed and lowercased, without provider-specific alias or dot rewriting.

## Invitation, access and retention

Invitation validity defaults to **24 hours** (bounded by the configured maximum).
It controls only the invitation link. The separate invitation table stores that
deadline; expiration does not expire network permissions or delete a guest.

Guest details show **Invitation status**, **Invitation expires at**, **Access
duration**, **Access expires at** for absolute plans, **Access status**, creation,
acceptance and revocation dates. **VPN access not provisioned** is always shown
in this phase. The overview labels invitation status and access intentions
separately; there is no active access state or access-revocation button.

Guest records and audit remain after invitation expiration or administrative
revocation. Automatic retention, purge and guest deletion are not implemented;
a future explicit deletion operation and configurable retention policy must
remain separate from access expiry.

Older 24-hour intentions remain readable and editable as **24 hours (legacy)**.
Existing records that contain both a relative duration and an absolute deadline
are preserved unchanged and flagged in details. The deadline takes precedence
until an explicit draft edit selects one intention. New writes cannot combine
them. An elapsed deadline remains in historical records, but saving an edited
custom plan requires choosing a future deadline or changing to a relative plan.

## Permissions and security

The `manage_guests` capability is granted only to the `owner` and `admin` roles.
IT administrators, network administrators, auditors, viewers, and members cannot
read or change guests. API key sessions retain full administrative access under
Headplane's existing authentication model. See [Users and roles](/features/users-roles).

Every loader and action checks permissions on the server. Forms use the existing
React Router action transport and its Origin checks against cross-site writes,
the signed authentication session, Valibot validation, `ActionError` form errors,
and success notifications. Notes are plain text and are never rendered as HTML.
No Headscale credentials are stored in guest records.

Edits and revocations compare the request's revision in one atomic SQL statement.
A stale form returns a conflict instead of overwriting newer information. Reload
the page before retrying. Database failures produce an error rather than a
successful no-op.

## Architecture and routes

`app/server/guests.ts` provides a service built once by `createAppContext` and
injected through `guestsContext`. Its only dependency is the existing Drizzle
SQLite client. It has no Headscale client, agent dependency, background task, or
network side effect. Expected failures are typed results mapped to page or form
errors by the routes. Shared form schemas validate at both the browser and
server boundaries.

| Internal route | Operation                            | Required capability |
| -------------- | ------------------------------------ | ------------------- |
| `/guests`      | List, search, filter, sort, paginate | `manage_guests`     |
| `/guests`      | POST `create`                        | `manage_guests`     |
| `/guests/:id`  | Read details                         | `manage_guests`     |
| `/guests/:id`  | POST `update`, `revoke`              | `manage_guests`     |

Routes are relative to `server.base_path`, so the default list address is
`/admin/guests`. The navigation and links support a custom base path.

## Data model

The original additive `guest_management` migration creates `guests`. The
`guest_access_duration` migration broadens its duration check to include 12 hours. Email, creation date, and status plus creation date are indexed;
email has no uniqueness constraint.

| Column                       | Representation and purpose                                                  |
| ---------------------------- | --------------------------------------------------------------------------- |
| `id`                         | ULID primary key                                                            |
| `email`                      | Required normalized address, at most 254 characters                         |
| `display_name`               | Optional plain text, at most 100 characters                                 |
| `notes`                      | Optional plain text, at most 4,000 characters                               |
| `status`                     | Explicit lifecycle state                                                    |
| `requested_duration_seconds` | 43,200, 172,800, or 604,800; legacy 86,400 retained; null for a custom date |
| `requested_expires_at`       | Exclusive absolute UTC deadline; null for relative plans                    |
| `activated_at`, `expires_at` | Future effective access dates; always null in phase 1                       |
| `revoked_at`                 | Administrative revocation time, null for a draft                            |
| `created_at`, `updated_at`   | Required UTC timestamps                                                     |
| `created_by`                 | Headplane user ID, or null for an API key session                           |
| `revision`                   | Incrementing version for concurrent edit protection                         |

Dates use the existing SQLite integer timestamp convention. `created_by` is
historical attribution, without a foreign key, so removing an account does not
remove guest history. API keys and their hashes are never copied into it.

| Status    | Meaning                                     | Phase 1               |
| --------- | ------------------------------------------- | --------------------- |
| `draft`   | Prepared request without provisioned access | Created and editable  |
| `pending` | Future invitation sent                      | Reserved, unavailable |
| `active`  | Future access successfully provisioned      | Reserved, unavailable |
| `expired` | Future effective access deadline elapsed    | Reserved, unavailable |
| `revoked` | Administratively closed request             | Terminal, read-only   |

The only transition is `draft` → `revoked`. Database checks enforce the phase 1
statuses, null effective access dates, supported duration intentions, and a
revocation timestamp consistent with status. Enabling the reserved states in a
future phase requires an explicit migration and provisioning workflow.

## Migration and rollback

SQLite requires a table rebuild to broaden the existing CHECK constraint.
The versioned `20261029220612_guest_access_duration` migration copies every column,
including legacy durations, mixed intentions and revisions, into a replacement
table inside the official Drizzle transaction, then restores the table name and
all three indexes. No application record is discarded or rewritten. No columns
are added: expiration kind is derived from the mutually exclusive intention
columns; invitation state already lives separately; effective access dates
remain null and the VPN access status is derived as not provisioned.

The startup migration adapter changes foreign-key mode **before** Drizzle begins
its transaction, as required for a [SQLite rebuild](https://www.sqlite.org/lang_altertable.html#otheralter).
The migration checks every foreign-key reference before commit and aborts on
violations. The adapter restores connection enforcement in a finally block,
including failure paths. Tests cover a referenced guest, a stored mailbox
challenge, legacy mixed records, retry after rollback and the real read-only
SQLite copy. Previous migration files are unchanged.

Headplane applies the migration automatically when the updated application
starts. Back up the Headplane SQLite database before deploying, using a
consistent SQLite backup or a copy made while Headplane is stopped. Include any
WAL data when copying an open database. No Headscale migration is required.

To roll back the application, stop the updated Headplane instance and run the
previous version against the same database. The broadened constraint and
invitation tables may remain in place; retain its migration history and guest data for a later upgrade.
Older application versions do not offer the 12-hour choice in their forms; retain
new records without editing them through an older UI. Do not restore the old
constraint while 12-hour rows exist. Do not drop tables or remove migration
history. A full database restore is only needed when restoring the entire prior state; it also discards all Headplane
changes made after the backup, including sessions and account changes.

## Verification

Run the repository checks:

```sh
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:integration tests/integration/headplane/guests.test.ts tests/integration/headplane/permissions.test.ts
```

Unit tests cover input validation, normalization, duration intentions, custom
dates, persistence across database reopening, concurrent edits, revocation,
unsupported lifecycle transitions, searches with SQL wildcard characters,
pagination, and database failure recovery. Migration tests preserve existing
users, sessions, and host information from a database built with prior migrations.
Integration tests use the real harness, authenticated sessions for every role,
and Headscale versions from `testedVersions()`. The lifecycle scenario compares
the policy, users, machines, and configuration before and after guest operations.

To verify a migration against an existing development database without modifying
it, pass its path explicitly:

```sh
HP_GUEST_MIGRATION_SOURCE=/path/to/development/hp_persist.db \
  pnpm test:unit tests/unit/guests/migration.test.ts
```

This opt-in test opens the source read-only, backs it up through SQLite into a
temporary directory, applies migrations only to the copy, compares hashes of
every preexisting application table, and verifies a persisted guest record. The
source remains read-only and is never migrated.

The optional Chromium scenario checks real form submissions, persistence after
refresh, editing, revocation, search, filtering, both themes, mobile layout, a
custom base path, and refusal of cross-site writes. Build the app and install
Chromium before running it:

```sh
pnpm build
pnpm exec playwright install chromium
HP_GUEST_BROWSER=1 pnpm test:integration tests/integration/headplane/guest-browser.test.ts
```

Set `HP_GUEST_SCREENSHOTS` to an output directory to capture light, dark, and
mobile views during that scenario. All browser data and services are isolated
from existing installations.

For manual testing, use a separate Headplane data directory and a disposable
Headscale from the [test harness](https://github.com/tale/headplane/tree/main/tests).
Create a draft, refresh the page, search and filter it, change its requested
duration, then revoke it. Open the same draft in two tabs to check stale edits.
Repeat with light and dark themes and a narrow viewport. Sign in as a viewer or
IT administrator and verify that direct guest URLs and submissions are refused.

## Resource and Headscale extensions

Phase 3 adds [resource intentions and read-only ACL preview](/features/guest-resources).
Select current Headscale machines or explicitly declare private LAN services behind
announced and approved subnet routes. Ports and protocols are explicit; no network
access is granted. Deleted machines, changed addresses and permissive policy rules
are reported without silently rewriting any Headscale state.

Network identity binding, activation, effective expiration and verified ACL
provisioning remain future work. Resource rows represent requested permissions,
not effective grants. No preview guarantees isolation without a proven identity
and complete policy evaluation.

## Future network revocation contract

**Revoke Invitation** continues to invalidate only the invitation token, sessions
and mailbox challenges. It must never report VPN revocation. **Revoke Access Now**
has no route, intent or enabled UI control in this phase.

A future access service must implement the following contract separately:

1. Require `manage_guests` or a dedicated access capability, same-origin CSRF
   protection, an expected access revision and an idempotency key.
2. Identify the exact provisioned grant, machine identities and policy ownership.
   Accepted invitations alone are insufficient evidence of a network grant.
3. Record revocation requested immediately, prevent extension or reactivation,
   and enqueue durable reconciliation with Headscale, independently of expiry.
4. Withdraw the actual permissions using the future provisioner's supported
   policy model. Do not equate deleting an invitation or stopping a node with
   withdrawing all grants. Recheck the effective Headscale state.
5. Mark access revoked and report success only after confirmed withdrawal.
   Retain request, confirmation and audit timestamps. On failure, report a
   pending/failed revocation and retry safely across restarts; never claim that
   network access stopped without confirmation.

Future access states (not provisioned, provisioning, active, revoking, revoked,
expired or failed) must belong to a separate grant model. Actual activation,
effective expiry and access revocation timestamps must not reuse invitation
lifecycle timestamps. Relative expiry is calculated only on confirmed activation;
an elapsed absolute deadline must prevent provisioning. No Headscale client is
added to the current guest or invitation services.
