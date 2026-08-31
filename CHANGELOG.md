# Changelog

## Unreleased

- **Added**
  - (placeholder)

- **Changed**
  - Updated npm publication to use only GitHub OIDC trusted publishing from the production environment with job-scoped permissions.
  - Replaced the weaker release CI poll with exact-`main`, push-event, exact-SHA admission and a Node 24/npm 11.5.1-or-newer runtime guard.
  - Enabled exact-head manual CI dispatch for reviewed release validation.
  - (placeholder)

- **Fixed**
  - Gave the real-Git release snapshot integration test a dedicated bounded
    execution budget and bounded every child process, avoiding false CI
    failures under self-hosted runner contention without permitting hangs.
  - Regenerated npm peer-dependency lock metadata and aligned CI with the
    release workflow clean-install command so hosted release installs remain
    reproducible.
  - Release retries now pin the workflow-dispatch commit and abort if `main`
    advances, keeping version scope, tags, package bytes, and npm provenance
    bound to one immutable source snapshot.

- **Security**
  - Added fail-closed source and npm-package admission for the administrative contributor registry and pinned the CI/CD runtime to Node.js 24.18.0 LTS.
  - Removed the repository's long-lived npm write-token fallback from `.npmrc` and the publish workflow.
  - Enabled same-repository pull-request CI while preventing external forks and `pull_request_target` from executing repository code on self-hosted runners.
  - Pinned patched transitive build-tool dependencies for the current npm audit advisories.
  - (placeholder)

## [0.3.0] - 2026-07-13

- **Added**
  - Added a Node-only WGSL shader lifecycle planning surface for direct
    same-process admission-receipt revalidation, ordered interface/evidence/
    shader publication, exact promoted style-profile references, deterministic
    requalification, and pointer-only rollback.
  - Added canonical package, promotion, promoted-shader, style-profile,
    requalification-inventory, and rollback-reason hashes; trusted host
    authority interfaces; content-digest-bound compile units and fixtures;
    current qualification-context verification; profile dependency
    reverification; qualification-context-bound promotion and rollback;
    profile-rollback shader dependency closure; and defensive access to exact
    publication bytes. Exported closure hashes now validate every immutable
    reference, digest, and non-empty dependency precondition before hashing.

- **Changed**
  - Raised `@plasius/asset-contracts` to 0.3.1 and added the released
    `@plasius/asset-processing` and `@plasius/gpu-shader` lifecycle
    dependencies. Public-package verification now installs the packed tarball
    and proves the Node-only ESM, CommonJS, and TypeScript shader subpath plus
    the browser-safe runtime and type-resolution boundary.

- **Fixed**
  - Closed nested mutable-version and profile-rollback dependency-substitution
    defects found during independent release review.
  - Added raw typed-GPU-manifest preflight before shared parsing or canonical
    hashing, preventing oversized, sparse, deeply nested, or text-heavy
    interface/profile/shader graphs from consuming unbounded planner work.
  - Bound aggregate raw-manifest child edges and pending traversal work, made
    cancellation precede shader-receipt preflight, and kept the publication
    file ceiling large enough for a manifest plus all 512 shader modules.

- **Security**
  - Added same-module execution branding, trusted-clock readiness checks,
    one-use rollback-authorization subjects, bounded authority results and
    dependency graphs, managed immutable-URI enforcement, and stale-proof
    rejection. The shared asset-contract validator now rejects mutable aliases
    in top-level and nested model, GPU-interface, profile, shader, and matrix
    references before compatibility expansion. Sparse authority arrays,
    oversized compatible-model semantic graphs, and revoked profile rollback
    dependencies fail closed. Profile rollback now recomputes the original
    immutable profile publication closure, preventing a trusted result from
    substituting an unrelated promoted shader set. Rollback history and the
    selected current/target versions are defensively copied and deeply frozen
    before authority calls, closing verifier mutation/TOCTOU paths.
    Receipt assets, promoted shader records, pipeline bind groups/entries,
    stage constants, requirements, and public package-digest inputs now fail
    closed against exported graph and declaration ceilings before downstream
    authorities are invoked. Public promotion-closure hashing now revalidates
    exact admission-contract identity, ordered required steps, typed asset
    manifests, immutable versions, qualification hashes, and coherent counts
    before returning a digest; shader/interface references and module-digest
    entries are rebuilt from canonical known fields. Compatible-model
    authority rows now satisfy aggregate semantic and raw graph/property/edge
    ceilings before shared descriptor parsing.
    Additive/XR evidence fails closed until asset-processing #24 is delivered;
    stable-universal delivery remains blocked by site #1513.

## [0.2.0] - 2026-07-13

- **Added**
  - Added canonical, immutable model-resolution state and effect planning for
    catalog search, bounded provider acquisition, review, confirmation,
    promotion handoff, retries, cancellation, and Phase 1 provider exhaustion.

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [0.1.6] - 2026-06-28

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [0.1.5] - 2026-06-28

- **Added**
  - (placeholder)

- **Changed**
  - Refreshed development dependency baselines to `@types/node@26.0.1` and `eslint@10.6.0`.

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [0.1.4] - 2026-06-22

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [0.1.3] - 2026-06-21

- Scaffolded @plasius/asset-pipeline for the unified AI asset pipeline.
- Corrected package documentation to reference ADR 0084 for unified AI asset pipeline package boundaries.


[0.1.3]: https://github.com/Plasius-LTD/asset-pipeline/releases/tag/v0.1.3
[0.1.4]: https://github.com/Plasius-LTD/asset-pipeline/releases/tag/v0.1.4
[0.1.5]: https://github.com/Plasius-LTD/asset-pipeline/releases/tag/v0.1.5
[0.1.6]: https://github.com/Plasius-LTD/asset-pipeline/releases/tag/v0.1.6
[0.2.0]: https://github.com/Plasius-LTD/asset-pipeline/releases/tag/v0.2.0
[0.3.0]: https://github.com/Plasius-LTD/asset-pipeline/releases/tag/v0.3.0
