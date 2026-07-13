# @plasius/asset-pipeline

State-machine and orchestration helpers for Plasius AI asset intake, validation, review, and promotion flows.

## Install

```bash
npm install @plasius/asset-pipeline
```

## Scope

This package is part of the unified AI asset pipeline package family. It is scaffolded from the standard `@plasius/*` package template and owns the asset pipeline boundary described in the Plasius asset pipeline design.

## Feature Flag

- `asset.pipeline.unified-ai-assets.enabled`

The host must check this remotely controlled parent flag before it creates or
interprets a model-resolution plan. Disabling the flag stops new orchestration;
it does not mutate immutable resolution records that have already been stored.

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

## Related Documents

- plasius-ltd-site `docs/Design/unified-ai-asset-pipeline.md`
- plasius-ltd-site `docs/adrs/adr-0084-unified-ai-asset-pipeline-packages.md`
- plasius-ltd-site `docs/tdrs/tdr-0004-unified-ai-asset-pipeline.md`
- [ADR 0002: Pure Model Resolution State and Effect Planning](./docs/adrs/adr-0002-model-resolution-state-effect-planning.md)

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
- CLA and legal docs: [legal](./legal)

## License

Apache-2.0
