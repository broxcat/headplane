# Guest VPN validation — October 30, 2026

PR #7 remains unmerged. Laptop validation was explicitly deferred by the
operator. All provisioning, policy writes, registration, expiry and revocation
in this validation use disposable harness tailnets, never the native tailnet.

## Audited native executable

| Property                    | Observed value                                                     |
| --------------------------- | ------------------------------------------------------------------ |
| Executable                  | `/usr/local/bin/headscale`                                         |
| Version                     | `v0.29.6+dirty`                                                    |
| Commit                      | `a2b1d7863926834e94479dcdd91ab344a9356bd0`                         |
| Reported build time         | `2026-10-24T09:21:24Z`                                             |
| Reported toolchain/platform | `go1.27.3`, Linux AMD64                                            |
| Go build metadata           | `vcs.modified=true`; same revision/time as `/version`              |
| Executable SHA-256          | `7477c374949eea6fb7cf3cbff14dbef49e4d118d9a33557d6764a77ece617e53` |
| Metadata fingerprint        | `161a320779fb4e60fe2166b8ce3e9cc468a669643c2675b2e6ba9e9ed6a32312` |
| Served Swagger SHA-256      | `08f9b761ef4bf8ed763c13d7962a86025d43f53aecae164b1c35377f7bd630b7` |

`headscale version`, `go version -m`, `/version`, CLI help and the actual served
`/swagger/v1/openapiv2.json` were audited read-only. The dirty source diff is not
recoverable from these metadata. The executable digest records the artifact
copied into the isolated test containers; the configuration fingerprint compares
reported metadata and is not remote binary attestation.

## API comparison

The native served Swagger is byte-identical to the published
[0.29.5 Swagger](https://raw.githubusercontent.com/juanfont/headscale/v0.29.5/gen/openapiv2/headscale/v1/headscale.swagger.json).
There are no differences in its paths, operations or definitions. That does not
establish identical runtime behavior: the native executable is tested separately.

| Operation               | Native wire contract                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| Register pending device | `POST /api/v1/auth/register`, JSON `{user, authId}`, response `{node}`                      |
| Approve/reject Auth ID  | `POST /api/v1/auth/approve` / `reject`, JSON body; not used to bypass Guest identity checks |
| Users                   | `GET/POST /api/v1/user`; immutable registered node user checked by ID                       |
| Nodes                   | `GET /api/v1/node`, `GET /api/v1/node/{nodeId}`                                             |
| Expire/schedule expiry  | `POST /api/v1/node/{nodeId}/expire`, query `expiry`; read-back required                     |
| Disable expiry          | Same endpoint, `disableExpiry`; never used for Guest access                                 |
| Read/write policy       | `GET/PUT /api/v1/policy`, database mode with `updatedAt`                                    |
| Validate policy         | `POST /api/v1/policy/check`, without applying candidate                                     |

The native CLI uses `headscale auth register --auth-id … --user …`.
`nodes register` and `/api/v1/node/register?user=…&key=…` remain deprecated
interfaces; Guest registration uses the JSON endpoint to keep Auth IDs out of
request URLs.

Comparison against the published
[0.27.1 schema](https://raw.githubusercontent.com/juanfont/headscale/v0.27.1/gen/openapiv2/headscale/v1/headscale.swagger.json)
and [0.28.0 schema](https://raw.githubusercontent.com/juanfont/headscale/v0.28.0/gen/openapiv2/headscale/v1/headscale.swagger.json):

- Both lack the three Auth endpoints and policy-check endpoint. They remain
  supported by ordinary Headplane, with Guest provisioning disabled.
- Compared with 0.28, the native API adds `disableExpiry` to node expiry.
- Compared with 0.27, it also removes node-owner reassignment and changes tagged
  node/pre-auth-key representations already covered by the client capabilities.
- Guest VPN's minimum remains stable **0.29**; there is no unsafe fallback that
  skips candidate validation or sends the registration credential in a URL.

## Explicit compatibility and preview approval

`headscale.compatibility.approved_builds` requires an exact core version, full
commit and metadata fingerprint. The guide documents the reproducible algorithm.
Unknown versions, prereleases, unsupported minors, incomplete custom metadata
and mismatching approvals remain denied. A dirty flag without a version suffix
also requires approval. No force switch is added.

The isolated fixture requires a separately supplied approval JSON file. It
never approves a build by copying the current server response. Negative tests
exercise missing approval and switching the real upstream server after startup.
The active native configuration receives no approval or activation change.

The administrator's preview binds Guest revision/duration, exact resource
intentions, selected node owners/tags/addresses/routes and canonical policy.
Preparation and device activation recompute it. A changed snapshot requires a
new administrator decision, including changes while awaiting the device. The
Guest cannot approve it. Migration 14 follows the existing Local Auth migration
and stores this decision in the additive VPN tables.

## Policy ownership

The native server uses database policy mode and a Grants document. Configuration
and policy fingerprints are unchanged by this task. The inspected deployment
maintenance scripts read policy for preservation checks; no periodic policy
writer was identified in the inspected service/cron/script locations. This is
not proof against privileged manual commands or uninspected external automation.

All Headplane editors and Guest lifecycle operations share the SQLite lease,
canonical policy baseline, write journal and read-back checks. Guest groups and
rules have deterministic reserved identities and exact persisted before-images.
Manual rules are retained; ambiguous ownership, drift or uncertain writes block
provisioning rather than being overwritten. Revocation attempts native expiry
when policy cleanup cannot safely proceed.

Headscale provides no compare-and-swap policy PUT or independent section-level
writer authorization. Enforce the single-writer operator contract before any
deployment: route manual policy edits through Headplane, stop other policy
automation and restrict access to policy-set credentials/CLI. Unsupported policy
semantics or an unmaintainable writer contract keep provisioning disabled.

## Network validation

The harness runs the audited executable in isolated Docker networks with real
Tailscale clients. It exercises both ACLs and Grants, Guest A/B, an allowed
resource, wrong TCP/UDP ports and an approved test LAN router. Tests verify actual
allowed/denied packets, immutable user association, consumed/cross-Guest Auth ID
rejection, removal of managed rules, native expiry, closed TCP streams and
continued access for the other Guest.

Recovery scenarios exercise lost replies, API outages, policy drift, orphan
devices and reconstruction over persisted lifecycle state. Chromium additionally
restarts a real Headplane process and retains the scoped Guest session.

A separate short-expiry test creates a real custom-date request 60–120 seconds
ahead. It does not edit SQLite deadlines or force node expiry. During a real
control API outage the native deadline must stop packets and an open stream.
A restarted worker then completes policy cleanup from durable expiration intent.
This exposed an old monitoring backoff delaying the expiration intent; expiry
now takes priority once, and subsequent cleanup retains its persistent backoff.

## CI investigation and remaining gate

Local checks on the final implementation:

| Check                                                                 | Result                                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Frozen dependency installation                                        | Passed                                                                         |
| Unit suite                                                            | 427 passed, one optional migration-source test skipped                         |
| Audited native build: lifecycle/security/preview/build-gate scenarios | 9 passed, one older-version case intentionally skipped                         |
| Real short expiry, native build                                       | Passed                                                                         |
| Real short expiry, official 0.29.5                                    | Passed                                                                         |
| Native-build Chromium workflow                                        | Passed, light/dark/mobile captures renewed                                     |
| Typecheck, build, Drizzle snapshot check                              | Passed                                                                         |
| Lint                                                                  | Passed with the existing unused-parameter warning in `app/utils/live-data.tsx` |
| Go tests                                                              | Passed                                                                         |
| Gitleaks and diff whitespace checks                                   | Passed                                                                         |

The complete multiversion integration result and final GitHub check conclusions
are kept in the PR, whose laptop gate remains outstanding. Captures contain only
the harness's synthetic identities and resources.

The earlier failing job was **Integration (Headscale 0.27.1)** in
[run 41108401532](https://github.com/broxcat/headplane/actions/runs/41108401532).
The failing DNS test reported `tar-stream: Size mismatch`, not an absent Guest
API. Mutable file archiving can stat one revision and stream another; the
harness now archives an immutable content snapshot. The 0.27 job remains in the
matrix. No test or supported version was removed to hide this failure.

Unbounded local integration concurrency exhausted Docker's existing default
address pools. Those attempts were stopped and only their disposable resources
were collected. Validation uses bounded workers; daemon settings and production
containers are unchanged. A browser attempt started during the build was also
discarded and rerun after the build completed.

Final command results and CI status are recorded in the PR. The real laptop
workflow remains outstanding by operator request. Use an isolated endpoint with
physical/recovery access, record the original tailnet and return to it afterward.
Do not treat LAN HTTP as a final Internet deployment; prepare stable HTTPS and a
valid certificate separately. Keep PR #7 unmerged until that validation and the
final CI gates have passed.
