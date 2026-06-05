# Architectural Decision Record (ADR)

## Title

Asset Pipeline Package Boundary

---

## Status

- Proposed
- Date: 2026-05-27
- Version: 1.0

---

## Tags

assets, ai, pipeline, package-boundary

---

## Context

The unified AI asset pipeline needs stable package boundaries so local seed assets and AI-generated assets use one governed lifecycle without mixing contracts, processing, review, and MCP responsibilities.

---

## Decision

Keep state transition policy and pipeline orchestration contracts separate from processing and review implementations.

---

## Alternatives Considered

- Keep this responsibility inside plasius-ltd-site only: rejected because the contracts need to be reusable across backend, CI, MCP, and runtime consumers.
- Merge all asset pipeline responsibilities into one package: rejected because it would couple contracts, orchestration, processing, review, and MCP service surfaces.

---

## Consequences

- The package has a narrow public API and can evolve independently.
- Additional integration packages will compose these contracts rather than reimplement them.
- Follow-up tasks must wire package publishing and repository creation through approved workflows.

---

## Related Decisions

- plasius-ltd-site ADR 0069: Use a Unified AI Asset Pipeline with Dedicated Asset Packages
