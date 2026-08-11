# ADR 0004: Hosted OIDC Package Publication

- Status: Accepted
- Date: 2026-08-11

## Context

`@plasius/asset-pipeline` already selected an immutable dispatch snapshot and
waited for CI, but publication also needs to prove that snapshot is still the
current public `main` head and that its evidence came from push-triggered CI.

## Decision

Publication is phase-isolated: dependency installation, package validation, SBOM generation, and immutable tarball packing run in `validate_and_pack` without the `production` environment or OIDC permission. The final hosted `publish` job downloads only that sealed artifact, explicitly installs npm 11.6.2, runs no repository dependency code, and publishes the tarball with lifecycle scripts disabled. It re-fetches current `main` immediately before the first release mutation and again immediately before npm publication. `.npmrc` contains no registry-auth placeholder, and release preparation returns the reviewed current `main` HEAD rather than package-file history.

Publish from the GitHub-hosted `production` job using npm trusted publishing.
Before package work, compare the prepared SHA to the fetched remote `main` and
query `ci.yml` runs by branch, push event, and exact SHA. Enforce Node 24 and npm
11.5.1 or newer, publish with provenance, and prohibit npm write-token fallbacks.

## Consequences

Publication stops if `main` moves, matching push CI is absent, the runtime is
unsupported, the trusted-publisher binding is missing, or OIDC is unavailable.
The earlier weaker CI poll is removed so one fail-closed admission gate owns the
decision.

## Test implications

Workflow tests enforce exact-main and exact push-CI admission, the supported
runtime, hosted production OIDC publication, provenance, and token absence.
