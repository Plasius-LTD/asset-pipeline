# Architectural Decision Record (ADR)

## Title

Trusted WGSL Shader Lifecycle Planning

---

## Status

- Accepted
- Date: 2026-07-13
- Version: 1.0

---

## Tags

assets, webgpu, wgsl, admission, promotion, requalification, rollback

---

## Context

The unified asset lifecycle must promote GPU interfaces, validation evidence,
WGSL shader versions, and shader style profiles without allowing an incomplete,
stale, or incompatible asset to become visible through the runtime catalog.
Admission already assembles final WGSL, reflects its GPU interface, regenerates
CPU artifacts and ABI hashes, validates model fixtures, and verifies the
complete stable-WebGPU matrix. The asset pipeline must consume that result
without becoming a second shader validator or treating caller-supplied evidence
as promotion authority.

Admission receipts are deliberately process-local. Their trusted proof is not
serializable, so a receipt copied through a queue, database, or service boundary
cannot prove that the receiving process admitted the exact artifacts. Promotion
also crosses immutable Blob storage and a mutable catalog pointer. Those
operations need an explicit sequence so a partial write, stale catalog revision,
or failed audit record cannot be mistaken for a completed promotion.

Style profiles introduce another closure: each render role must reference an
exact promoted shader version compatible with the declared model interfaces and
semantics. Requalification and rollback must remain deterministic and
auditable, while the browser-safe package root must not acquire Node-only
admission or cryptographic dependencies.

---

## Decision

Expose WGSL shader lifecycle planning only from
`@plasius/asset-pipeline/shader-lifecycle`. The export is explicitly Node-only
and is not re-exported by the browser-safe package root.

The host must pass the original receipt and a fresh verifier to
`createShaderPromotionPlan` when admission and promotion occur in one module
instance. The planner directly calls `revalidateShaderAdmissionReceipt` and
requires the returned value to be that original receipt. If trust crosses a
process, queue, module reload, installed-package instance, or service boundary,
the host must rerun full `admitShaderQualification` from the retained exact
archive, matrix, evidence, attestation reference, and attestation bundle. A
deserialized or reconstructed receipt is never promotion authority.

All returned plans are branded in a module-local `WeakSet`. Executors must
reject serialized, cloned, reconstructed, or foreign-module plans, call
`assertShaderLifecyclePlanReadyForExecution` with a trusted host clock
immediately before effects, and use `copyShaderLifecyclePublicationFiles` for
exact publication bytes. Replanning from authoritative inputs is required
after a boundary crossing.

Shader promotion plans enforce this ordered closure:

1. publish and re-read/digest-verify the immutable GPU-interface version;
2. publish and re-read/digest-verify the immutable validation-evidence version;
3. publish and re-read/digest-verify the immutable shader version;
4. compare-and-swap the site-owned promoted catalog/channel pointer; and
5. persist the promotion and audit record.

Every stage is explicit and idempotency-bound. The catalog operation cannot be
planned as successful unless the interface, evidence, and shader stages identify
one coherent admitted subject, approval identity/time, runtime channel,
idempotency key, ABI closure, and complete passing matrix. A stale expected
catalog revision is a conflict, not permission to overwrite another promotion.

Before approval, the host maps the exact revalidated receipt subject to the
catalog's current `qualificationContextSha256`. The host-owned digest covers
the mandatory reflector, CPU packer, assembler, runtime validator, matrix,
evidence harness, and WebGPU toolchain policy. Verification binds the receipt's
subject, evidence, and matrix hashes at the exact expected catalog revision;
the digest is included in approval, idempotency, catalog CAS, and audit. A
mandatory-context change must also change the catalog revision.

Profile promotion accepts only exact `ShaderVersionRef` values that already
exist as freshly storage-verified promoted records at the requested channel and
catalog revision. Each role must be implemented by its shader, and the complete
profile must satisfy its compatible model-interface, `modelAbiHash`, and
required-semantic constraints against a model snapshot at that same catalog
revision and qualification context. Mutable aliases, version ranges, and
arbitrary Blob URLs are not accepted references. Profile effects are exact
publication, dependency reverification, catalog compare-and-swap, then audit.

Requalification planning derives a stable, sorted work set from declared change
causes and dependency references. Reflection, packing, canonical-interface,
shared-assembly, runtime-validation, matrix-policy, and WebGPU-toolchain changes
select the complete shader inventory. An ordinary shader change selects all
affected compile units, style profiles, and model fixtures. Inventories bind the
exact catalog revision, normalized inventory hash, qualification-context hash,
compile-unit content hashes, and model-fixture content hashes; volatile snapshot
metadata is excluded from the idempotency fingerprint.

Rollback plans may point only to an older superseded, eligible, non-revoked
immutable version with its original publication closure, the current mandatory
qualification context, and a fresh storage verification. A host authorization
binds the exact target, closure, qualification context, expected revision,
bounded reason hash, incident, actor, one-use nonce, and expiry. The host must
atomically consume the nonce with the authorized compare-and-swap, then record
audit data. Rollback does not overwrite, republish, delete, or otherwise mutate
immutable assets.

For a profile target, the immutable-target authority must also re-resolve every
exact pinned shader. Each must remain promoted, non-revoked, freshly verified,
on the expected channel/revision, and under the current qualification context.
The authority returns the verified immutable profile package digest as
`profilePackageSha256`, and the planner recomputes the original style-profile
publication closure from the exact target `ShaderStyleProfileRef`, that package
digest, the current context, and the validated shader references. It must equal
the target `publicationClosureSha256` retained in catalog history before
authorization. The sorted current dependency closure is then bound into
rollback authorization and CAS. Shader targets require a null
`profilePackageSha256` and an empty dependency set.

Host authority interfaces are explicit and request data cannot select their
implementations. They resolve current qualification context, approvals,
promoted records and compatible-model
snapshots, requalification inventory snapshots, rollback history and
authorization, managed-storage URI policy, immutable version verification, and
trusted time. Resource limits are exported and applied before hashing,
traversal, or authority-result expansion; sparse, duplicate, malformed, and
oversized authority results fail closed.
Raw typed GPU manifests are special-cased at every lifecycle ingress. The
planner applies a bounded object-graph preflight before shared contract parsing
or canonical hashing, including receipt GPU-interface/evidence/shader assets,
request-owned profiles, promoted-shader records, and the public package-digest
helper. The graph budget covers depth, nodes, per-object and aggregate
properties, dense arrays, scalar/property-key text, interface projections,
pipeline bind groups and entries, stage constants, render-role pipeline
references, and requirement arrays. This prevents a valid type annotation or
trusted-record wrapper from turning an unbounded nested value into parser work.

The host owns remote control evaluation:

- `asset.pipeline.shader-store.enabled` gates runtime discovery, loading, and
  activation of newly stored shader profiles; and
- `gpu.shader.style.select` gates user-visible style discovery and selection,
  not default-profile rendering or catalog mutation.

Neither control is evaluated inside this planning package. Private intake,
qualification, promotion preparation, and rollback remain separately
authorized operational flows while runtime exposure is disabled.

`@plasius/storage` owns injected-client immutable Blob operations.
`plasius-ltd-site` model storage owns durable catalog rows, channel
compare-and-swap, authentication, authorization, runtime delivery, and audit.
This package owns deterministic precondition and lifecycle planning only.

---

## Alternatives Considered

- Re-export shader lifecycle planning from the package root: rejected because
  it would pull Node-only admission and cryptographic trust boundaries into
  browser consumers.
- Trust serialized receipt fields after a queue or database handoff: rejected
  because process-local proof cannot survive serialization.
- Update the catalog before every immutable dependency is verified: rejected
  because runtime discovery could expose a partial asset closure.
- Permit profiles to use `latest`, ranges, or unresolved catalog aliases:
  rejected because style activation and rollback would no longer be
  reproducible.
- Roll back by overwriting failed bytes: rejected because immutable versions and
  their evidence must remain available for audit and incident analysis.
- Treat missing physical runners as a release exception: rejected because the
  stable-universal contract requires every declared representative matrix cell.
- Accept additive/XR evidence before admission can prove it: rejected because a
  caller-authored reference is not qualification evidence. Contract v1 rejects
  non-empty additive evidence until asset-processing #24 is delivered.

---

## Consequences

- Promotion, requalification, and rollback decisions can be replayed and tested
  without granting the package storage or catalog mutation authority.
- Hosts must retain the exact admission artifacts whenever work may cross a
  process boundary.
- Storage and catalog adapters must report digest-bound immutable identities,
  idempotency outcomes, expected revisions, and audit completion back to the
  coordinator.
- Style profiles remain reproducible and can be added without republishing a
  compatible model.
- Rollback is fast and preserves evidence because only a verified pointer is
  changed.
- Stable universal rollout remains blocked until the physical runner fleet in
  [plasius-ltd-site #1513](https://github.com/Plasius-LTD/plasius-ltd-site/issues/1513)
  is provisioned and every required cell passes. This decision does not claim
  that prerequisite is complete.
- Contract v1 promotes universal evidence only. Platform-limited and XR
  profiles remain blocked until
  [asset-processing #24](https://github.com/Plasius-LTD/asset-processing/issues/24)
  binds additive evidence into admission and promotion; future XR promotion
  must still pass the universal matrix plus all additive XR lanes.

---

## Related Decisions

- ADR 0001: Asset Pipeline Package Boundary
- ADR 0002: Pure Model Resolution State and Effect Planning
- TDR 0001: WGSL Shader Promotion, Requalification, and Rollback
- plasius-ltd-site ADR 0110: Final Assembled WGSL Is the GPU Interface Source
  of Truth
- plasius-ltd-site TDR 0005: WGSL Shader Compatibility and Style-Profile
  Lifecycle
- `@plasius/asset-processing` ADR 0003: WGSL Shader Admission Boundary
