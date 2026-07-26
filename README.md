# @plasius/asset-pipeline

State-machine and orchestration helpers for Plasius AI asset intake, validation, review, and promotion flows.

## Install

```bash
npm install @plasius/asset-pipeline
```

## Scope

This package is part of the unified AI asset pipeline package family. It is scaffolded from the standard `@plasius/*` package template and owns the asset pipeline boundary described in the Plasius asset pipeline design.

## Feature Flags and Style Capability

- `asset.pipeline.unified-ai-assets.enabled`
- `asset.pipeline.shader-store.enabled`

The host must check the remotely controlled unified-assets flag before it
creates or interprets a model-resolution plan. The shader-store flag controls
runtime catalog discovery, loading, and activation of newly stored shader style
profiles. Disabling either flag stops its gated work without mutating immutable
records or asset bytes that have already been stored.

User-visible shader-style discovery and selection additionally requires the
`gpu.shader.style.select` capability. The capability does not authorize
admission, immutable publication, catalog promotion, or rollback, and default
profile rendering remains available without style-selection access. Private
intake, qualification, promotion preparation, and rollback remain subject to
their existing operator/service authorization while runtime shader-store
exposure is disabled.

## Model resolution planning

The package exposes a pure state/effect planner for the canonical model types
published by `@plasius/asset-contracts`:

```ts
import { createModelRequestSpec } from "@plasius/asset-contracts";
import {
  createModelResolutionWorkflowPlan,
  planModelResolutionEvent,
} from "@plasius/asset-pipeline";

const request = createModelRequestSpec({
  revision: 0,
  query: "weathered oak dining table",
  locale: "en-GB",
  policyProfileId: "static-world-v1",
  hardConstraints: {},
  softPreferences: {},
  exclusions: [],
});

const initial = createModelResolutionWorkflowPlan({
  resolutionId: "resolution-table-001",
  request,
  createdAt: "2026-07-13T10:00:00.000Z",
});

const next = planModelResolutionEvent(initial, {
  type: "catalog-search-completed",
  occurredAt: "2026-07-13T10:00:01.000Z",
  candidates: [],
  providerIds: ["provider-a", "provider-b"],
});
```

The returned plan is deeply frozen. It contains the canonical immutable
`ModelResolution`, bounded provider queue state, rejected-candidate exclusions,
configured/authorization-attempted provider IDs, cumulative planned-download
references, and declarative effects for the hosted coordinator to execute. This
correlation metadata prevents provider, candidate, source, rights-review, and
retry events from being replayed against the wrong attempt. The planner does not
perform persistence, provider I/O, conversion, rendering, rights review, or
promotion itself.

The Phase 1 policy is deliberately bounded:

- At most five provider searches are planned concurrently.
- At most three ranked provider candidates are selected for download across the
  entire request revision, including repeated or authorization-resumed result
  batches. Each selected batch emits its download effect once; pending download
  completions are retained without re-enqueuing the same network work.
- Every technically and legally usable candidate enters
  `awaiting-confirmation`; low assurance also requires semantic-risk acceptance
  in the canonical confirmation contract.
- Provider exhaustion returns the best valid low candidate with one to three
  refinement questions, or a terminal `unresolved` result. AI generation is
  represented by a fail-closed `generator-disabled` effect in Phase 1.
- Retry creates revision `n + 1` under the same resolution identifier, preserves
  prior records, excludes rejected candidates, requires a meaningful request or
  rejection change, and observes the contracts package's maximum revision 3.
- Cancellation is idempotent for already-cancelled work. It is rejected after a
  terminal outcome and while atomic promotion is in progress.

All planner timestamps must be canonical ISO 8601 UTC strings. Invalid input,
events, transitions, retry attempts, and cancellation attempts fail with
`ModelResolutionPlanningError` and a stable code from
`MODEL_RESOLUTION_PLANNING_ERROR_CODES`.

## WGSL shader lifecycle planning

Shader admission, promotion, requalification, and rollback planning are
available only from the Node-specific subpath:

```ts
import {
  SHADER_LIFECYCLE_ERROR_CODES,
  SHADER_LIFECYCLE_LIMITS,
  assertShaderLifecyclePlanReadyForExecution,
  copyShaderLifecyclePublicationFiles,
  createShaderRequalificationPlan,
  createShaderRollbackPlan,
  createShaderPromotionPlan,
  createShaderStyleProfilePromotionPlan,
} from "@plasius/asset-pipeline/shader-lifecycle";
```

The package root remains browser-safe and does not re-export this surface. The
Node-only boundary is required because promotion consumes the trusted
server-side admission contract from
`@plasius/asset-processing/shader-admission`; browser code cannot create,
deserialize, or promote a trusted shader-admission receipt.
The conditional export nests its ESM, CommonJS, and declaration targets under
`node`, so browser bundlers and browser-oriented TypeScript resolution both
reject the subpath.

Pass the original same-module admission receipt and a fresh cryptographic
verifier to `createShaderPromotionPlan`; the planner directly calls
`revalidateShaderAdmissionReceipt` and requires the returned value to be that
same receipt object. Receipt trust is process-local. If a queue, database,
process restart, module reload, second installed package instance, or service
boundary intervenes, retain the exact source archive, matrix, evidence, and
attestation artifacts and rerun full `admitShaderQualification` before
replanning. Reconstructing a receipt from serialized fields is not an accepted
shortcut.

A valid shader promotion plan preserves this order:

1. publish and re-read the exact GPU-interface version;
2. publish and re-read its complete validation-evidence version;
3. publish and re-read the exact shader version;
4. compare-and-swap the site-owned promoted catalog/channel pointer; and
5. persist promotion and audit provenance.

Every immutable write is digest-bound and idempotent. A stale receipt, failed
matrix cell, missing approval, ABI mismatch, storage conflict, or stale catalog
revision fails closed before catalog visibility changes. Audit persistence is
ordered after catalog compare-and-swap; failure after that mutable operation is
a reconciliation incident and must never be reported as an ordinary
pre-promotion failure. The planner describes the ordered operation; it does not
write Blob storage, Cosmos rows, or feature-flag state itself.

The promotion authority must also resolve the revalidated receipt against the
catalog's current `qualificationContextSha256`. That digest represents the
mandatory reflector, packer, assembler, runtime validator, stable matrix,
evidence harness, and WebGPU toolchain policy. The verification binds the
receipt subject, evidence, and matrix hashes to the exact expected catalog
revision; the digest then flows through approval, idempotency, CAS, and audit.
A mandatory-context change must change the catalog revision, preventing an
older otherwise valid receipt from being promoted after a serious update.

### Safe executor boundary

Every promotion, profile, requalification, and rollback plan carries a
module-local execution brand. JSON, structured clone, object reconstruction,
module reload, and another installed package instance remove that authority.
Executors must call `assertShaderLifecyclePlanReadyForExecution` with a
host-injected trusted clock immediately before performing effects. Publication
executors must obtain exact defensive byte copies with
`copyShaderLifecyclePublicationFiles`; caller-owned or reconstructed maps are
not authoritative.

```ts
assertShaderLifecyclePlanReadyForExecution(plan, trustedExecutionClock);
const files = copyShaderLifecyclePublicationFiles(
  plan,
  "shader",
  plan.shader.shaderId,
  plan.shader.version,
);
```

Crossing a process or module boundary requires a new plan from trusted host
authorities. Shader promotion additionally requires full re-admission. Public
hash helpers let host adapters bind the same immutable subjects:
`computeShaderLifecyclePackageSha256`,
`computeShaderPromotionClosureSha256`,
`computePromotedShaderClosureSha256`,
`computeShaderStyleProfileClosureSha256`,
`computeShaderRequalificationInventorySha256`,
`computeShaderRollbackDependencyClosureSha256`, and
`computeShaderRollbackReasonSha256`. Approval subjects fix the purpose, asset
kind/identity/version, manifest, closure, and qualification-context hashes,
runtime channel, and expected catalog revision. Stable errors and resource
ceilings are exported as
`SHADER_LIFECYCLE_ERROR_CODES` and `SHADER_LIFECYCLE_LIMITS`.
Request-owned profile manifests, shader manifests embedded in admission
receipts, and shader manifests returned in promoted records receive a bounded
raw-graph preflight before a shared contract parser or digest helper can
traverse them. Receipt GPU-interface/evidence manifests and every typed GPU
asset package passed to the public digest helper use the same preflight.
Oversized, sparse, excessively deep, high-fan-out, or text-heavy declarations therefore fail
with the boundary's stable error code before parsing or hashing. Request and
receipt inputs fail before cryptographic revalidation or downstream
authorities; a promoted record is checked immediately after catalog resolution
and before compatible-model resolution or approval. Compatible-model authority
rows receive aggregate semantic and raw-graph preflight before the shared model
descriptor parser runs.
The hash helpers fail closed on mutable or malformed references, bad digests,
duplicate logical identities, invalid typed receipt assets, incoherent receipt
proof fields, and empty profile closures before producing a canonical value.

Style-profile promotion accepts only exact, already-promoted shader version
references for every declared render role. Semver ranges, `latest`, mutable
aliases, arbitrary Blob URLs, or a shader that does not implement the role or
model ABI/semantics are rejected. Adding a compatible style does not require a
model version to be republished. The ordered plan publishes the exact profile,
reverifies every shader dependency against its prior storage closure, changes
the profile catalog pointer with compare-and-swap, and then records audit data.
Promoted records, storage proofs, and the compatible-model snapshot must match
the requested channel, current qualification context, and exact expected
catalog revision. Storage proofs are at most five minutes old and must retain
at least a 30-second execution window. Model snapshots have per-model and
aggregate semantic budgets before any semantic sets are expanded. The shared
asset-contract validator checks every version-bearing nested model/interface,
default-profile, role-shader, compatible-interface, and validation-matrix
reference before those compatibility indexes or semantic sets are built.

Requalification planning is deterministic. Changes to reflection, CPU packing,
canonical interfaces, shared assembly, runtime compatibility validation,
stable-WebGPU matrix policy, or the WebGPU toolchain require the complete shader
inventory. An ordinary shader change selects every affected compile unit,
profile, and model fixture. The authoritative snapshot binds the exact catalog
revision, normalized inventory digest, qualification-context digest, compile
unit content digests, and fixture content digests; volatile snapshot identity
and capture time do not change the work fingerprint.

Rollback can target only an older, superseded, eligible, non-revoked immutable
version qualified under the current mandatory qualification context. A fresh
verification and one-use host authorization bind the target manifest,
publication closure, qualification context, expected catalog revision, bounded
reason hash, incident, actor, nonce, and expiry. The executor must atomically
consume that nonce with the authorized catalog compare-and-swap. Rollback never
rewrites or deletes asset bytes.

Profile rollback additionally re-resolves every exact shader version pinned by
the target profile. Each dependency must remain promoted, non-revoked, freshly
storage-verified, on the requested channel/revision, and qualified under the
current context. Immutable-target verification supplies the exact
`profilePackageSha256`, and the planner recomputes the original style-profile
publication closure from that package digest, the exact target
`ShaderStyleProfileRef`, current qualification context, and validated shader
references before authorization. The result must equal the target's original
`publicationClosureSha256` retained in catalog history. Their sorted current
dependency closure is also bound into authorization and CAS; empty, stale,
substituted, or revoked dependency sets fail closed. Shader targets require a
null `profilePackageSha256` and no shader dependencies.

`@plasius/storage` owns injected-client immutable Blob primitives.
`plasius-ltd-site` model storage owns durable catalog rows, channel
compare-and-swap, authorization, runtime delivery, and audit. This package owns
only deterministic lifecycle preconditions and plans.

Stable universal delivery remains blocked on
[plasius-ltd-site #1513](https://github.com/Plasius-LTD/plasius-ltd-site/issues/1513).
Every declared physical stable-WebGPU matrix cell must be provisioned and pass;
an unavailable runner, skip, timeout, or device loss is a failed gate, not a
waiver or hosted-runner substitute.

Contract v1 admits universal evidence only. Shader promotion rejects non-empty
`additionalValidationEvidence` until the additive-evidence admission work in
[asset-processing #24](https://github.com/Plasius-LTD/asset-processing/issues/24)
is released. Platform-limited and XR profiles therefore remain blocked; future
support must require the universal matrix plus every declared additive lane.

## Related Documents

- plasius-ltd-site `docs/Design/unified-ai-asset-pipeline.md`
- plasius-ltd-site `docs/adrs/adr-0084-unified-ai-asset-pipeline-packages.md`
- plasius-ltd-site `docs/tdrs/tdr-0004-unified-ai-asset-pipeline.md`
- [ADR 0002: Pure Model Resolution State and Effect Planning](./docs/adrs/adr-0002-model-resolution-state-effect-planning.md)
- [ADR 0003: Trusted WGSL Shader Lifecycle Planning](./docs/adrs/adr-0003-shader-lifecycle-planning.md)
- [TDR 0001: WGSL Shader Promotion, Requalification, and Rollback](./docs/tdrs/tdr-0001-shader-promotion-requalification-and-rollback.md)

## Development

```bash
npm install
npm run build
npm test
npm run test:coverage
npm run pack:check
```

## Governance

- Security policy: [SECURITY.md](./SECURITY.md)
- Code of conduct: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- ADRs: [docs/adrs](./docs/adrs)
- TDRs: [docs/tdrs](./docs/tdrs)
- CLA and legal docs: [legal](./legal)

## License

Apache-2.0

<!-- BEGIN PLASIUS RELEASE INTEGRITY -->
## Release integrity

CI keeps the administrative contributor registry outside Git and npm package
artifacts using exact, case-normalised path checks. CI runs on approved
self-hosted runners. Release preparation and npm publication use GitHub-hosted
runners with Node.js 24.18.0 LTS. CD remains disabled until the npm trusted
publisher binding is verified and the legacy token fallback is removed.
<!-- END PLASIUS RELEASE INTEGRITY -->
