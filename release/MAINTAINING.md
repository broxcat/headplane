# Maintaining Guest releases

The only version shape is v<Headplane-base>-guest. Never move, force-push, delete or
replace a published tag or overwrite release assets. Stop if the intended tag or
release exists. Choose a later deliberate base version instead of feature counters.
The generic upstream `pnpm release cut` must not be used for a Guest release: it
creates a tag before the integration and approval checks below.

## Prepare

1. Audit origin/main, tags/releases, PR state and tracked files. Keep private
   infrastructure notes, credentials, databases and live configuration out of Git
   trees and artifacts. Do not use git add . or publish the working directory.
2. Review Guest Management #2, Invitations #1, Email Delivery #3 in dependency order.
   The initial Phase 1 history contains local infrastructure notes that were later
   removed. Squash the final PR state into main rather than importing that history.
3. After an approved squash merge, retarget the next PR to main and reconcile its
   base by a normal merge commit (never force push), resolving to the reviewed Guest
   tree. Review the diff again. Do the same for the next dependent PR.
4. Integrate this release-preparation PR, including the existing session-security
   fix, source-map exclusion, documentation and workflow. main must contain the
   final reviewed source tree before any tag is created.
5. Use exact Node/pnpm/Go versions from toolchains.json. Install with the frozen
   lockfile, run typecheck, lint, unit tests, Guest/SMTP/RBAC integration tests on
   all harness versions, relevant Go tests, and ./scripts/build-guest.sh dist.
6. Test the extracted archive without node_modules against an isolated Headscale:

   ```sh
   pnpm exec playwright install chromium
   HP_GUEST_ARCHIVE="$PWD/dist/headplane-0.8.1-guest-linux-amd64.tar.gz" \
     pnpm test:integration tests/integration/headplane/guest-archive.test.ts
   ```

7. Review licenses/inventory, source metadata, all artifact names and SHA256SUMS.
   SourceDirty must be false for a public artifact. Build twice from the same clean
   commit and compare checksums. License fallback text is pinned to upstream blobs
   and exact package versions; new unlicensed/missing notices fail packaging. Retain
   original notices, OFL font terms, Go runtime terms and corresponding source when
   required. Consult the original dependency terms when updating them.
8. Obtain explicit operator permission for PR merges and for publishing the tag
   and pre-release. Building a candidate or opening a PR is not permission to publish.

## Publish after approval

Fetch main and tags again. Verify that v0.8.1-guest does not exist locally/remotely
and has no GitHub Release. Check that package.json is 0.8.1-guest and the final main
commit matches the reviewed release tree. Record the commit, checks and consent.

```sh
git tag -a v0.8.1-guest <verified-main-commit> -m 'Headplane v0.8.1 — Guest Features'
git push origin refs/tags/v0.8.1-guest
```

Do not push to upstream. Do not use force or `--follow-tags`, which can publish
unrelated local tags. The Guest workflow runs only for v*-guest on broxcat/headplane.
It verifies exact version, annotated tag, checkout commit and main ancestry before
building. A tag on an unmerged PR fails; a PR does not trigger the publication job.
Legacy Docker release/issue lifecycle workflows exclude Guest tags and are scoped
to the upstream repository, so they do not publish or comment on this fork.

The build job has read-only repository permissions and no publishing token in its
build commands. Only the publish job gets contents:write. It creates a new draft
pre-release with title Headplane v0.8.1 — Guest Features, uploads archives/docs/sums,
downloads and verifies them, then publishes. No clobber/update-existing option is
used. If a draft/upload fails, stop for inspection; do not blindly rerun or replace
its tag/assets. There is no deployment, SMTP configuration, GHCR push or production
service control in this workflow.

Monitor the run and confirm the published release is non-draft and pre-release.
Download assets from the public URL and verify SHA256SUMS. Record the final tag
commit, run URL, release URL and downloaded checksum. Local candidate hashes can
differ from the final build if integration changes the commit metadata; only compare
rebuilds of the exact same source commit with the same pinned tools.

## Documentation workflows on forks

Docs (beta) still installs dependencies and compiles the documentation on every
push to main. Build failures fail the workflow. Only its Cloudflare Pages step is
restricted to tale/headplane; forks need no Cloudflare credentials.

Docs (release build) builds stable release-line documentation, attaches it to the
release and dispatches Docs (publish). Guest tags do not dispatch this chain.
Docs (publish) still assembles the site and supports the dry-run artifact; its
Cloudflare step requires tale/headplane and a non-dry-run invocation. Forks never
deploy to the official Pages projects through either workflow. Repository read
permissions, upstream secret references and build/deployment ordering are unchanged.

Before publishing a Guest tag, verify the main Build and Docs (beta) runs succeed
and the beta Cloudflare step is skipped on the fork. Do not suppress build failures
or supply official-site credentials to make a fork's checks pass.
