# Headplane — Guest fork

This is [broxcat/headplane](https://github.com/broxcat/headplane), a custom fork of
[tale/headplane](https://github.com/tale/headplane) with administrative Guest features.
The original project, credits and MIT license are retained.

> A feature-complete web UI for [Headscale](https://headscale.net)

<picture>
    <source
        media="(prefers-color-scheme: dark)"
        srcset="./docs/assets/preview-dark.png"
    >
    <source
        media="(prefers-color-scheme: light)"
        srcset="./docs/assets/preview-light.png"
    >
    <img
        alt="Preview"
        src="./docs/assets/preview-dark.png"
    >
</picture>

Headscale is the de-facto self-hosted version of Tailscale, a popular Wireguard
based VPN service. By default, it does not ship with a web UI, which is where
Headplane comes in. Headplane is a feature-complete web UI for Headscale, allowing
you to manage your nodes, networks, and ACLs with ease.

Headplane aims to replicate the functionality offered by the official Tailscale
product and dashboard, being one of the most feature complete Headscale UIs available.
These are some of the features that Headplane offers:

- Machine management, including expiry, network routing, name, and owner management
- Access Control List (ACL) and tagging configuration for ACL enforcement
- Support for OpenID Connect (OIDC) as a login provider
- The ability to edit DNS settings and automatically provision Headscale
- Configurability for Headscale's settings

## Guest Features

- **Guest Management**: drafts, search, status filters, details and protected edits.
- **Secure invitations**: single-use hashed tokens, separate email verification
  codes, resend rotation, expiry, revocation and event history.
- **SMTP and file**: implicit TLS/required STARTTLS, protected server-side secrets,
  or private local messages for development. Settings → Guest email checks the
  configured transport without sending a message.
- **Access duration**: 12 hours, 48 hours, 7 days or Custom date in the browser's
  time zone, stored in UTC with invalid/ambiguous clock-change times refused.
- Invitation validity, future access duration and audit retention are separate.

**Guest ACLs are not provisioned, and no VPN access is automatically granted.**
VPN revocation is not implemented: Revoke Invitation cancels the invitation only.
Real email requires SMTP configuration. Guest records remain available for audit.

Read [Guest management](docs/features/guest-management.md) and
[Guest invitations/SMTP](docs/features/guest-invitations.md).

## Deployment

Download the Linux AMD64 archive from this fork's [GitHub Releases](https://github.com/broxcat/headplane/releases).
Node.js 24 is required separately; application dependencies, Go binaries, Browser SSH
WASM and migrations are included. Verify SHA256SUMS before extraction.

Follow [installation, upgrades, SQLite migrations and rollback](release/INSTALL.md).
Keep persistent data and configuration outside immutable release directories.
Back up SQLite coherently before upgrading. Do not replace or reset an existing
database. This fork's Guest release workflow does not deploy existing services.
The upstream [website](https://headplane.net) documents the original Headplane UI.

## Versioning

This fork uses one immutable custom version per Headplane base version:

| Headplane base | Guest fork release |
| -------------- | ------------------ |
| v0.8.1         | v0.8.1-guest       |
| v0.8.2         | v0.8.2-guest       |
| v0.8.3         | v0.8.3-guest       |

No `.1`, `.2` or `.3` feature counters are added. Never move or overwrite a
published tag. If the planned tag exists, stop and choose the next deliberate
base version. v0.8.1-guest is a **pre-release** for controlled validation.
See [release notes](release/RELEASE-NOTES.md) and the [maintainer procedure](release/MAINTAINING.md).

## Contributing

Headplane is an open-source project and contributions are welcome! If you have
any suggestions, bug reports, or feature requests, please open an issue. Also
refer to the [contributor guidelines](./.github/CONTRIBUTING.md) for more info.

---

<picture>
    <source
        media="(prefers-color-scheme: dark)"
        srcset="./docs/assets/acls-dark.png"
    >
    <source
        media="(prefers-color-scheme: light)"
        srcset="./docs/assets/acls-light.png"
    >
    <img
        alt="ACLs"
        src="./docs/assets/acls-dark.png"
    >
</picture>

<picture>
    <source
        media="(prefers-color-scheme: dark)"
        srcset="./docs/assets/machine-dark.png"
    >
    <source
        media="(prefers-color-scheme: light)"
        srcset="./docs/assets/machine-light.png"
    >
    <img
        alt="Machine Management"
        src="./docs/assets/machine-dark.png"
    >
</picture>

> Copyright (c) 2025 Aarnav Tale

### Local administrator login

Optional username/password sign-in keeps the Headscale administrative key on the
server and coexists with API key and OIDC authentication. Create accounts with
`node build/server/index.js admin create --config /etc/headplane/config.yaml`
and enable `auth.local.enabled`. See the [local authentication guide](docs/configuration/local-auth.md)
for setup, password recovery, session revocation and SQLite backups.
