# TDR 0001: WGSL Shader Promotion, Requalification, and Rollback

- Date: 2026-07-13
- Status: Accepted
- Related task: [Plasius-LTD/asset-pipeline #18](https://github.com/Plasius-LTD/asset-pipeline/issues/18)
- Parent feature: [Plasius-LTD/plasius-ltd-site #1026](https://github.com/Plasius-LTD/plasius-ltd-site/issues/1026)
- Feature flag: `asset.pipeline.shader-store.enabled`
- Style-selection capability: `gpu.shader.style.select`

## Purpose

Define the technical contract by which `@plasius/asset-pipeline` turns a trusted
WGSL admission result into deterministic promotion, requalification, profile,
and rollback plans. The package coordinates preconditions and ordering; it does
not perform shader reflection, Blob writes, catalog mutation, authorization, or
remote-control evaluation.

## Export and Runtime Boundary

The lifecycle API is exported only from
`@plasius/asset-pipeline/shader-lifecycle` with a Node export condition and a
`null` default condition. It is absent from the package root. Installed-package
validation must prove that ESM and CommonJS Node consumers can load the subpath,
and typecheck against their matching declarations, the browser-safe root still
bundles and typechecks, and browser runtime and TypeScript resolution cannot
resolve the Node-only subpath.

This boundary exists because the planner composes the server-only
`@plasius/asset-processing/shader-admission` contract. It must not make
filesystem, cryptographic-verifier, source-archive, or admission-receipt
capabilities available to browser code.

## Trust Handoff

`ShaderAdmissionReceipt` trust is retained by the module instance that created
it. Visible receipt fields are useful diagnostics and identities but are not a
portable proof.

Two handoff modes are permitted:

1. **Same module instance:** pass the original receipt and a fresh trusted
   cryptographic verifier to `createShaderPromotionPlan`; the planner directly
   calls `revalidateShaderAdmissionReceipt` and requires the returned value to
   be that same receipt object.
2. **Cross process:** retain the exact source archive, matrix, validation
   evidence, attestation reference, and attestation bundle; rerun
   `admitShaderQualification` in the receiving process, then revalidate the new
   original receipt there.

A queue message, database row, JSON document, structured clone, module reload,
or second installed package instance requires the cross-process path. A host
must never rebuild a receipt object from its public fields or downgrade failed
revalidation to a warning.

## Safe Execution Contract

Every promotion, profile, requalification, and rollback plan is branded in a
module-local `WeakSet`. JSON serialization, structured clone, object spread,
reconstruction, module reload, and another installed package instance remove
execution authority. Executors must call
`assertShaderLifecyclePlanReadyForExecution(plan, executionAuthority)` with a
host-injected trusted clock immediately before effects. Shader and profile
publication executors must additionally use
`assertShaderLifecyclePublicationPlanExecutable` and obtain exact defensive
bytes through `copyShaderLifecyclePublicationFiles`; request-owned or
reconstructed maps cannot replace retained plan bytes.

Crossing a module/process boundary requires a new plan from trusted
authorities. Shader promotion also requires full admission in the receiving
module instance. The executor performs the readiness check immediately before
dependency reverification and the mutable catalog compare-and-swap, not when a
plan is merely queued.

## Trusted Host Authorities

Request data never selects an authority implementation:

- `ShaderLifecyclePlanningAuthority` verifies that an exact admitted subject is
  current for the expected qualification context/catalog revision, resolves an
  exact promotion approval, applies managed-immutable-URI policy, and supplies
  trusted time.
- `ShaderStyleProfileAuthority` additionally resolves exact promoted shader
  records at the requested channel/catalog revision and a compatible-model
  snapshot at that same revision.
- `ShaderRequalificationInventoryLoader` returns an authoritative promoted
  inventory snapshot at the expected catalog revision.
- `ShaderRollbackAuthority` returns catalog history, verifies the immutable
  target, resolves exact rollback authorization, applies URI policy, and
  supplies trusted time.
- `ShaderLifecycleExecutionAuthority` supplies only the trusted clock used for
  the final same-module readiness check.

Dependency calls inherit one absolute bounded deadline and cancellation signal.
Unavailable or malformed authority results map to bounded stable errors without
including source, credentials, SAS parameters, or untrusted dependency text.

## Canonical Hash and Approval Bindings

The package exports the canonical formulas host adapters must reproduce:

- `computeShaderLifecyclePackageSha256` binds a normalized asset manifest and,
  transitively, every declared file digest.
- `computeShaderPromotionClosureSha256` binds the admitted interface, evidence,
  shader, ABI identities, module digests, and qualification subject after
  validating typed asset manifests and rebuilding references/digests from
  their canonical known fields.
- `computePromotedShaderClosureSha256` binds an exact shader package to its
  qualification context, interface, and sorted evidence dependencies.
- `computeShaderStyleProfileClosureSha256` binds an exact profile package to
  its qualification context and exact shader version references.
- `computeShaderRequalificationInventorySha256` binds the normalized content
  inventory.
- `computeShaderRollbackDependencyClosureSha256` binds the exact current,
  promoted, non-revoked shader dependencies required by a profile rollback.
- `computeShaderRollbackReasonSha256` binds the bounded normalized operator
  reason into authorization.

Each exported closure helper validates exact immutable references, bounded
dependency sets, managed-asset identity grammar, and every supplied digest
before hashing. It never turns `latest`, a range, an empty profile closure, or
malformed storage evidence into an apparently canonical digest.

Promotion approvals bind purpose `promote-to-runtime-catalog`, asset kind,
asset identity/version, manifest hash, closure hash, qualification-context
hash, runtime channel, and exact expected catalog revision. A substituted field
requires a new approval.

## Promotion Preconditions

Promotion planning requires one coherent closure:

- a currently trusted, revalidated admission receipt;
- matching shader ID/version, `modelAbiHash`, `shaderAbiHash`, interface
  reference, module digests, and evidence subject digests;
- complete passing results for every required compile unit and stable-WebGPU
  matrix cell, with no missing, skipped, unavailable, timed-out, or device-loss
  result;
- a trusted current `qualificationContextSha256` verification bound to the
  receipt subject, evidence, matrix, and exact expected catalog revision;
- a bounded approval identity and canonical approval timestamp;
- an exact runtime channel and idempotency key;
- the expected current catalog revision; and
- storage identities for immutable versions that can be re-read and
  digest-verified.

Caller-authored layouts, caller assertions that evidence passed, mutable
version aliases, arbitrary Blob URLs, and stale evidence cannot satisfy a
precondition.

The qualification-context digest represents the mandatory reflector, CPU
packer, assembler, runtime validator, stable matrix, evidence harness, and
WebGPU toolchain policy. The host maps the exact revalidated receipt subject to
that context. Every mandatory-context change must also advance the catalog
revision; catalog CAS validates both values atomically.

## Ordered Promotion Plan

The plan has one required sequence:

| Order | Stage | Owning boundary | Completion condition |
| --- | --- | --- | --- |
| 1 | GPU interface | Storage host | Exact immutable interface version is written manifest-last and completely re-read/digest-verified. |
| 2 | Validation evidence | Storage host | Exact evidence, matrix, inventory, and attestation version is written manifest-last and completely re-read/digest-verified. |
| 3 | Shader | Storage host | Exact WGSL modules and shader manifest are written manifest-last and completely re-read/digest-verified. |
| 4 | Catalog compare-and-swap | Site model storage | Expected channel revision still matches and the pointer changes to the exact verified shader closure. |
| 5 | Promotion/audit record | Site model storage | Actor/workflow identity, approval, idempotency key, previous/new revision, evidence, and timestamp are durably recorded. |

The host must not execute a later stage before every prior stage reports its
exact successful or idempotent result. A conflict does not become an idempotent
success unless the already-stored bytes and immutable metadata are identical.
Failure or cancellation before compare-and-swap leaves the candidate
undiscoverable. Failure after compare-and-swap requires reconciliation and
audit; it must not be represented as an ordinary pre-promotion failure.

## Exact Style-Profile Planning

A style profile maps each render role to one exact `ShaderVersionRef`. Planning
validates that:

- every shader reference resolves to one exact promoted record at the requested
  runtime channel and expected catalog revision;
- the reference fixes shader ID, version, manifest URI, and manifest digest;
- the shader declares the referenced render role and pipeline IDs;
- all profile shaders support a compatible model interface and `modelAbiHash`;
- required model semantics are provided; and
- duplicate roles, mutable aliases, version ranges, and unmanaged URLs are
  rejected.

Promoted records carry a full package digest plus interface/evidence dependency
closure. Their storage proofs must be no more than five minutes old and retain
at least a 30-second window when execution starts. Compatible-model authority
results must use the exact expected catalog revision and qualification context,
contain unique exact model identities, and provide every required interface
projection and semantic. Each model is capped at 512 semantics and the complete
snapshot at 65,536 semantic tokens before sets are allocated.

Profile bytes are independently immutable. The required effect order is:

1. publish and digest-verify the exact profile package;
2. reverify every shader dependency against its prior closure and expiry;
3. compare-and-swap the profile catalog pointer; and
4. record promotion/audit data.

Compatible new profiles remain discoverable without changing or repacking the
model.

## Deterministic Requalification

Requalification plans are derived from normalized change causes and immutable
inventory references. Results are deduplicated and sorted so identical content
produces identical work sets and idempotency fingerprints.

The complete shader inventory is selected when any of these change:

- reflection or layout calculation;
- generated CPU packing/codecs;
- canonical model-facing interfaces;
- shared WGSL assembly;
- runtime compatibility validation;
- stable-WebGPU support-matrix policy; or
- the WebGPU qualification toolchain or trusted harness.

An ordinary shader change selects the changed shader's compile units plus every
style profile and model fixture that references the affected shader/interface.
Profile-only changes select the profile closure and referenced model fixtures
without claiming unrelated shaders passed new qualification.

The authoritative snapshot binds its exact catalog revision,
`inventorySha256`, and `qualificationContextSha256`. Every selected compile unit
is `{ compileUnitId, compileUnitSha256 }`; every selected model fixture is
`{ fixtureId, fixtureSha256 }`. The fingerprint includes those content digests
and the normalized dependency closure while excluding volatile `snapshotId`
and `capturedAt` metadata.

No plan may remove a declared physical matrix cell. Contract v1 admits universal
evidence only: shader promotion rejects every non-empty
`additionalValidationEvidence` value. The profile planner can validate additive
scopes already present in a trusted promoted record, but this release cannot
create such a record through admission/promotion. Platform-specific and XR
profiles remain blocked on
[asset-processing #24](https://github.com/Plasius-LTD/asset-processing/issues/24);
when delivered, they must pass the universal matrix plus every additive lane.

## Pointer-Only Rollback

Rollback targets one exact version from bounded, dense durable promoted catalog
history. Sequence, catalog revision, and immutable-version identities must be
unique. There is exactly one current entry and it has the maximum sequence. The
target must be older, `superseded`, `eligible`, not revoked, and qualified under
the catalog's current mandatory `qualificationContextSha256`.

The host re-reads and digest-verifies the target manifest, publication closure,
and qualification context. It then returns an authorization binding the
asset/channel/target, manifest hash, publication closure, qualification
context, expected revision, and bounded reason hash. Authorization includes an
ID, incident, one-use nonce, requesting actor, authorization time, and expiry.
The executor must atomically consume the nonce with
`compare-and-swap-catalog-with-authorization`; a replay is a conflict.

For a profile target, the authority also re-reads the profile and resolves
every exact pinned shader against the current catalog. Every dependency must be
promoted, non-revoked, freshly storage-verified, on the expected channel and
revision, and qualified under the current context. The planner canonicalizes
the exact target profile reference, verified profile-package digest, current
qualification context, and validated shader references with
`computeShaderStyleProfileClosureSha256`; that result must equal the original
`publicationClosureSha256` in catalog history. The planner separately hashes
the current dependency records; authorization and CAS bind the resulting
`targetDependencyClosureSha256`. Shader targets require a null
`profilePackageSha256` and an empty dependency set, while profile targets
require a valid package digest and a non-empty dependency set.

Immutable verification and authorization must each retain at least 30 seconds
when execution starts. Effects are reverify immutable version, authorized
catalog compare-and-swap, then rollback audit.

Rollback never edits, replaces, republishes, or deletes immutable bytes. A
missing target, stale expected revision, failed digest, incomplete evidence, or
version absent from promoted history fails closed.

## Resource Limits

`SHADER_LIFECYCLE_LIMITS` is applied before hashing, iteration, graph traversal,
or authority-result expansion:

| Boundary | Limit |
| --- | --- |
| Profile package | 64 files, 8 MiB |
| Profile declaration | 64 roles, 64 interfaces, 64 validation scopes, 512 semantics |
| Raw typed GPU manifest graph | 131,072 nodes, depth 64, 8,192 properties per object, 262,144 properties aggregate, 65,536 entries per raw array, 262,144 child edges/pending entries aggregate, 16,384 characters per key/string, 4,194,304 characters aggregate |
| GPU interface declaration | 512 modules; 4,096 each of records, bindings, entry points, vertex inputs, overrides, and each model-ABI projection array |
| One promoted shader | 513 files (one manifest plus 512 modules), 64 MiB, 512 modules, 512 pipelines, 64 render roles/interfaces/evidence scopes |
| Shader pipeline graph | 4,096 render-role pipeline references, 4,096 bind groups, 4,096 entries per bind group, 65,536 bind-group entries aggregate, 4,096 constants per stage, 65,536 constants aggregate |
| Shader requirements | 512 semantics, 512 features, 512 limits, 512 formats |
| Profile shader closure | 2,048 files, 256 MiB, 2,048 managed URIs |
| One publication package | 513 files, 256 MiB |
| Compatible models | 4,096 models, 512 semantics per model, 65,536 semantic tokens aggregate |
| Requalification inventory | 4,096 shaders, 4,096 profiles, 8,192 fixtures |
| Requalification graph | 65,536 compile units, 65,536 edges |
| Rollback history | 4,096 rows |

Sparse arrays, duplicate logical identities, malformed values, unsafe paths,
and oversized authority results fail closed before a mutable effect is planned.
Length and text budgets are checked before density or content traversal and
before shared asset-contract or GPU-shader parsers run. The raw graph preflight
applies to request-owned profiles, all typed assets accepted by the package
digest helper, receipt-owned GPU-interface/evidence/shader manifests, and
shader manifests returned by the promoted-catalog authority. Receipt
qualification module digests, model ABI hashes, compile-unit IDs, and
matrix-cell IDs reuse the corresponding exported shader, model, inventory, and
semantic ceilings. Compatible-model authority rows first satisfy the per-model
and aggregate semantic ceilings, then the complete returned model graph must
satisfy the same node/property/edge/text preflight before the shared model
descriptor parser runs.

## Feature Flag and Capability

`asset.pipeline.shader-store.enabled` is the remotely controlled rollout and
kill-switch key for runtime catalog discovery/loading, new stored-profile
activation, and any public candidate-submission surface. The site-owned
feature-flag evaluator is authoritative; this package only records the expected
key in its contract. A local environment variable is not the normal control
plane.

When the flag is disabled, fresh runtime loads and activations fail closed.
Separately authorized private intake, qualification, immutable promotion
preparation, and rollback remain possible but cannot make a candidate publicly
discoverable through the disabled runtime path.

`gpu.shader.style.select` controls user-visible style discovery and selection.
It does not authorize promotion or rollback and is not required for default
profile rendering. The site capabilities service is authoritative for that
decision.

## Ownership Boundaries

| Component | Owns | Does not own |
| --- | --- | --- |
| `@plasius/gpu-shader` | Reflection, compatibility, ABI hashes, compile units, matrix/evidence validation | Storage, approval, catalog mutation |
| `@plasius/asset-processing` | Exact archive admission, generated artifacts, matrix/attestation verification, process-local receipt | Storage and promotion |
| `@plasius/asset-pipeline` | Promotion/profile/requalification/rollback preconditions and deterministic plans | Blob, Cosmos, auth, remote controls |
| `@plasius/storage` | Injected-client conditional immutable Blob writes, manifest-last publication, exact reads and digest verification | Shader policy and catalog pointers |
| `plasius-ltd-site` model storage | Intake orchestration, durable catalog rows, channel CAS, auth, capabilities, feature flags, runtime delivery, audit | GPU layout/reflection authority |

Only promoted catalog assets may reach runtime. No planner or host adapter may
turn an arbitrary Blob URL, undeclared relative path, or checked-in demo alias
into a promoted reference.

## Failure and Idempotency Rules

- Invalid, missing, stale, or incoherent input fails before a mutable pointer
  operation is planned.
- Idempotent replay requires the same idempotency key and exact subject,
  approval, channel, expected/base revision, and immutable digests.
- A reused key with changed input is a conflict.
- Diagnostics use bounded stable reason codes and must not include WGSL source,
  credentials, SAS query strings, or sensitive model metadata.
- Timeouts, cancellation, unavailable storage, missing runners, and catalog
  conflicts are explicit failures. The coordinator owns bounded retry policy.

## Physical Qualification Blocker

Stable-universal promotion is not deliverable until
[plasius-ltd-site #1513](https://github.com/Plasius-LTD/plasius-ltd-site/issues/1513)
has provisioned, isolated, monitored, and exposed every required physical
stable-WebGPU runner cell to the trusted qualification workflow. No unavailable
runner exception, skip, hosted fallback, browser substitution, or reduced
matrix is permitted. This TDR records that prerequisite; it does not claim the
fleet or qualification gate is complete.

## Validation Expectations

Tests for the lifecycle implementation cover:

- valid promotion, exact idempotent replay, and every missing/stale/incoherent
  promotion precondition;
- same-process receipt revalidation and rejection of reconstructed receipts;
- profile role, exact-reference, model-ABI, and semantic mismatches;
- deterministic affected-only and full-inventory requalification;
- valid rollback plus unknown, unpromoted, stale, and corrupt targets;
- installed-package ESM/CJS imports and browser rejection of the Node-only
  subpath.

The package's existing typecheck, unit, coverage, lint, build, audit, and
installed-tarball pack gates remain required. Enabled/disabled feature-flag,
rollback/fallback, and denied/allowed style-selection behavior are host-owned
site integration tests, not behavior executed by this package. Passing package
tests does not substitute for those downstream tests or the physical fleet
gate.

## Related Documents

- [ADR 0003: Trusted WGSL Shader Lifecycle Planning](../adrs/adr-0003-shader-lifecycle-planning.md)
- `@plasius/asset-processing` TDR 0001: WGSL Shader Admission Flow
- plasius-ltd-site `docs/Design/wgsl-shader-compatibility-and-style-framework.md`
- plasius-ltd-site `docs/how-to-guides/wgsl-shader-store-rollout-controls.md`
- plasius-ltd-site `docs/tdrs/tdr-0005-wgsl-shader-compatibility-and-style-profile-lifecycle.md`
