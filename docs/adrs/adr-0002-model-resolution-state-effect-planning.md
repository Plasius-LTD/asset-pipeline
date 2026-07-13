# Architectural Decision Record (ADR)

## Title

Pure Model Resolution State and Effect Planning

---

## Status

- Accepted
- Date: 2026-07-13
- Version: 1.0

---

## Tags

assets, orchestration, model-resolution, state-machine, human-review

---

## Context

The unified model pipeline must resolve a natural-language request against the
promoted catalog, acquire candidates from approved providers when necessary,
and pass staged candidates through processing and human confirmation. Hosted
execution spans Cosmos DB, provider connectors, conversion and rendering jobs,
rights review, and atomic promotion. Embedding those concerns in one state
machine would couple deterministic policy to network and infrastructure
failures, make retries harder to reason about, and duplicate the boundaries
owned by the generic validation and promotion packages.

The workflow also needs bounded acquisition, immutable request revisions,
stable errors, explicit terminal behavior, and a fail-closed Phase 1 generator
policy. Persisted events may be replayed, so the same input plan and event must
always produce the same next plan.

---

## Decision

Implement model resolution in `@plasius/asset-pipeline` as a pure reducer over
canonical `@plasius/asset-contracts` values. Each call returns a deeply frozen
workflow plan containing the next canonical resolution record, planner-owned
queue metadata, rejected-candidate exclusions, and declarative effects. A
hosted coordinator owns persistence, leases, provider I/O, processing,
rendering, review, and promotion execution.

The transition graph is explicit. Invalid input, events, transitions, retries,
and cancellations throw `ModelResolutionPlanningError` with stable public error
codes. Canonical ISO 8601 UTC timestamps are supplied by the caller; the planner
rejects time regression and has no clock, network, storage, or randomness.

Provider identifiers remain injected configuration rather than provider logic
inside this package. Planner metadata retains the configured providers,
authorization attempts, and exact provider/source/candidate references selected
for acquisition so later events cannot change origin or repeat a consumed
attempt. One revision may search at most five configured providers and select at
most three ranked downloads cumulatively. Catalog events accept only existing
immutable asset references while retaining their original catalog, provider, or
generated provenance for attribution; provider evaluation must match the
planned provider, source asset, and candidate exactly. Rights-review completion may
replace rights evidence and its reissued confirmation token only when it carries
a new decision identifier/token and a strictly later review time; it cannot
replace the candidate's model, match, processing, render, or hard-gate evidence. Hard
constraints, technical gates, and rights gates are represented by canonical
candidate contracts and remain independent
of semantic assurance. Every usable high or low candidate requires human
confirmation; accepting low assurance changes only semantic risk acceptance.

Completed, unresolved, failed, and cancelled revisions are terminal immutable
records. Retry starts an exact `n + 1` revision, within the contracts package's
maximum revision 3, only after rejection while awaiting confirmation or from
an unresolved or eligible failed revision. It preserves the resolution
identifier, accumulates rejected-candidate exclusions, and requires a changed
normalized request or rejection set. Cancellation is idempotent after an
already-cancelled result, but completed and other terminal outcomes reject it.
Promotion is an atomic handoff: once `promoting`, cancellation returns the
stable promotion-in-progress error so the publication closure can finish or be
reconciled by its owning service.

Phase 1 never emits a generator invocation. Provider exhaustion instead emits
the canonical disabled-generator reason and returns either the best valid low
candidate with bounded refinement questions or `unresolved`.

The host gates creation and execution with
`asset.pipeline.unified-ai-assets.enabled`. Disabling it stops new planning and
effect interpretation without rewriting existing resolution history.

---

## Alternatives Considered

- Execute provider clients and hosted jobs directly in this package: rejected
  because it would make planning nondeterministic and mix infrastructure with
  workflow policy.
- Store provider-specific registries in the planner: rejected because provider
  enablement, credentials, and kill switches belong to hosted configuration.
- Retry by mutating the active request: rejected because it loses audit history
  and makes event replay ambiguous.
- Invoke a placeholder generator after providers are exhausted: rejected
  because Phase 1 has no approved implementation and must fail closed.
- Allow cancellation during promotion: rejected because it could expose a
  partially published parent/child asset closure.

---

## Consequences

- State and effect policy can be exhaustively unit tested without hosted
  infrastructure and safely replayed by an idempotent coordinator.
- Integrators must persist the previous immutable revision before executing its
  returned effects and must supply canonical timestamps and provider config.
- Provider, processing, rights, and promotion services must translate their
  outcomes into the planner's typed events.
- The planner deliberately does not duplicate the generic asset-job validation
  or atomic publication preconditions separately tracked by asset-pipeline
  Tasks 2 and 13.
- Phase 2 can add generator effects only through a new reviewed decision and the
  same canonical ingestion and confirmation path.

---

## Related Decisions

- ADR 0001: Asset Pipeline Package Boundary
- plasius-ltd-site ADR 0084: Unified AI Asset Pipeline Packages
- plasius-ltd-site ADR 0094: Model Conversion Hub-and-Spoke Boundary
- plasius-ltd-site TDR 0004: Unified AI Asset Pipeline
