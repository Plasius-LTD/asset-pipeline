import { describe, expect, it } from "vitest";
import {
  MODEL_GENERATOR_DISABLED_REASON_CODE,
  MODEL_REQUEST_MAX_REVISION,
} from "@plasius/asset-contracts";
import {
  MODEL_RESOLUTION_DOWNLOAD_LIMIT,
  MODEL_RESOLUTION_PHASE_ONE_GENERATOR_ENABLED,
  MODEL_RESOLUTION_PLANNING_ERROR_CODES,
  MODEL_RESOLUTION_PROVIDER_LIMIT,
  ModelResolutionPlanningError,
  assertModelResolutionTransition,
  canTransitionModelResolution,
  createModelResolutionWorkflowPlan,
  planModelResolutionCancellation,
  planModelResolutionEvent,
  planModelResolutionRetry,
  type ModelResolutionWorkflowPlan,
} from "../src/index.js";
import {
  CONFIRMED_AT,
  INITIAL_AT,
  createCandidate,
  createConfirmation,
  createPromotedProviderCatalogCandidate,
  createPromotion,
  createRequest,
  createRightsReviewedCandidate,
} from "./model-resolution-fixtures.js";

const PROVIDERS = [
  "sketchfab",
  "polyhaven",
  "kenney",
  "smithsonian-open-access",
  "nasa",
] as const;

const at = (minute: number): string => `2026-07-13T12:${String(minute).padStart(2, "0")}:00.000Z`;

function expectPlanningCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected a ModelResolutionPlanningError.");
  } catch (error) {
    expect(error).toBeInstanceOf(ModelResolutionPlanningError);
    expect((error as ModelResolutionPlanningError).code).toBe(code);
  }
}

function createInitialPlan(): ModelResolutionWorkflowPlan {
  return createModelResolutionWorkflowPlan({
    resolutionId: "resolution-1",
    request: createRequest(),
    createdAt: INITIAL_AT,
  });
}

function planCatalog(
  candidates: readonly ReturnType<typeof createCandidate>[],
  providerIds: readonly string[] = PROVIDERS,
  questions: readonly string[] = ["Which chair-back shape matters most?"],
): ModelResolutionWorkflowPlan {
  return planModelResolutionEvent(createInitialPlan(), {
    type: "catalog-search-completed",
    occurredAt: at(7),
    candidates,
    providerIds,
    refinementQuestions: questions,
  });
}

function planProviderToEvaluation(
  references: readonly {
    readonly providerId: string;
    readonly sourceAssetId: string;
    readonly candidateId: string;
  }[],
): ModelResolutionWorkflowPlan {
  const plan = planModelResolutionEvent(planCatalog([]), {
    type: "provider-search-completed",
    occurredAt: at(8),
    rankedCandidates: references,
  });
  return advanceProviderToEvaluation(plan, references[0]!, 9);
}

function advanceProviderToEvaluation(
  inputPlan: ModelResolutionWorkflowPlan,
  reference: {
    readonly providerId: string;
    readonly sourceAssetId: string;
    readonly candidateId: string;
  },
  startMinute: number,
): ModelResolutionWorkflowPlan {
  let plan = inputPlan;
  plan = planModelResolutionEvent(plan, {
    type: "provider-download-ready",
    occurredAt: at(startMinute),
    candidate: reference,
  });
  for (const event of [
    { type: "quarantine-completed", occurredAt: at(startMinute + 1), candidateId: reference.candidateId },
    { type: "processing-completed", occurredAt: at(startMinute + 2), candidateId: reference.candidateId },
    { type: "rendering-completed", occurredAt: at(startMinute + 3), candidateId: reference.candidateId },
  ] as const) {
    plan = planModelResolutionEvent(plan, event);
  }
  return plan;
}

function createProviderCandidate(
  reference: {
    readonly providerId: string;
    readonly sourceAssetId: string;
    readonly candidateId: string;
  },
  options: {
    readonly assurance?: "high" | "low" | "none";
    readonly rightsStatus?: "allowed" | "attribution-required" | "quarantined" | "blocked";
    readonly blockedHardGate?: boolean;
  } = {},
): ReturnType<typeof createCandidate> {
  return createCandidate({
    ...options,
    candidateId: reference.candidateId,
    disposition: "proposed",
    providerId: reference.providerId,
    sourceAssetId: reference.sourceAssetId,
  });
}

describe("model resolution workflow planning", () => {
  it("exposes explicit legal transitions and stable invalid-transition errors", () => {
    expect(canTransitionModelResolution("searching-catalog", "searching-providers")).toBe(true);
    expect(canTransitionModelResolution("promoting", "cancelled")).toBe(false);
    expect(canTransitionModelResolution("completed", "searching-catalog")).toBe(false);
    expect(assertModelResolutionTransition("rendering", "evaluating")).toEqual({
      from: "rendering",
      to: "evaluating",
    });

    expectPlanningCode(
      () => assertModelResolutionTransition("completed", "searching-catalog"),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_TRANSITION,
    );
  });

  it("creates a canonical immutable local-search plan without mutating its request", () => {
    const request = createRequest();
    const plan = createModelResolutionWorkflowPlan({
      resolutionId: "resolution-1",
      request,
      createdAt: INITIAL_AT,
    });

    expect(plan.resolution).toMatchObject({
      state: "searching-catalog",
      attempts: 1,
      request,
    });
    expect(plan.effects).toEqual([{
      kind: "search-catalog",
      request,
      excludedCandidateIds: [],
    }]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.effects)).toBe(true);
    expect(Object.isFrozen(plan.resolution)).toBe(true);
    expect(request.revision).toBe(0);
  });

  it("requires confirmation for a valid high local candidate", () => {
    const candidate = createCandidate();
    const plan = planCatalog([candidate]);

    expect(plan.resolution.state).toBe("awaiting-confirmation");
    expect(plan.resolution.bestCandidate?.candidateId).toBe(candidate.candidateId);
    expect(plan.effects).toEqual([{
      kind: "request-human-confirmation",
      candidate,
      semanticRiskAcceptanceRequired: false,
    }]);

    const punctuationTie = planCatalog([
      createCandidate({ candidateId: "candidate_a" }),
      createCandidate({ candidateId: "candidate-a" }),
    ]);
    expect(punctuationTie.resolution.bestCandidate?.candidateId).toBe("candidate-a");

    const promotedProvider = createPromotedProviderCatalogCandidate({
      providerId: "polyhaven",
      sourceAssetId: "source-promoted-catalog",
      candidateId: "candidate-promoted-catalog",
    });
    const retainedProvenance = planCatalog([promotedProvider]);
    expect(retainedProvenance.resolution.state).toBe("awaiting-confirmation");
    expect(retainedProvenance.resolution.bestCandidate?.provenance.kind).toBe("provider");
  });

  it("fails closed on none assurance, hard constraints, and hard review gates", () => {
    const none = createCandidate({ candidateId: "candidate-none", assurance: "none" });
    const hardConstraintFailure = createCandidate({
      candidateId: "candidate-hard-failure",
      request: createRequest(0, { maxTriangles: 500 }),
      assurance: "high",
    });
    const blocked = createCandidate({ candidateId: "candidate-blocked", blockedHardGate: true });

    expect(none.match.assurance).toBe("none");
    expect(hardConstraintFailure.match.hardConstraintPass).toBe(false);
    expect(hardConstraintFailure.match.assurance).toBe("none");
    expect(planCatalog([none, blocked]).resolution.state).toBe("searching-providers");

    const providerReference = {
      providerId: "polyhaven",
      sourceAssetId: "source-not-catalog",
      candidateId: "candidate-not-catalog",
    } as const;
    expectPlanningCode(
      () => planCatalog([createProviderCandidate(providerReference)]),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
  });

  it("queues all enabled providers concurrently after a low local match", () => {
    const low = createCandidate({ assurance: "low" });
    const plan = planCatalog([low]);

    expect(MODEL_RESOLUTION_PROVIDER_LIMIT).toBe(5);
    expect(plan.resolution.state).toBe("searching-providers");
    expect(plan.resolution.bestCandidate?.match.assurance).toBe("low");
    expect(plan.effects).toEqual([{
      kind: "search-providers",
      request: plan.resolution.request,
      providerIds: [...PROVIDERS].sort(),
      maxConcurrency: MODEL_RESOLUTION_PROVIDER_LIMIT,
      excludedCandidateIds: [],
    }]);

    expectPlanningCode(
      () => planCatalog([low], [...PROVIDERS, "sixth-provider"]),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.PROVIDER_LIMIT_EXCEEDED,
    );
  });

  it("queues at most three ranked provider downloads and preserves ranking order", () => {
    const searching = planCatalog([]);
    const rankedCandidates = [1, 2, 3, 4].map((index) => ({
      providerId: PROVIDERS[index % PROVIDERS.length]!,
      sourceAssetId: `source-${index}`,
      candidateId: `provider-candidate-${index}`,
    }));
    const plan = planModelResolutionEvent(searching, {
      type: "provider-search-completed",
      occurredAt: at(8),
      rankedCandidates,
    });

    expect(MODEL_RESOLUTION_DOWNLOAD_LIMIT).toBe(3);
    expect(plan.pendingProviderCandidates).toEqual(rankedCandidates.slice(0, 3));
    expect(plan.effects).toEqual([{
      kind: "download-provider-candidates",
      candidates: rankedCandidates.slice(0, 3),
      maxDownloads: MODEL_RESOLUTION_DOWNLOAD_LIMIT,
    }]);
  });

  it("enforces the three-download budget across repeated provider result batches", () => {
    const [first, second, third, fourth] = [1, 2, 3, 4].map((index) => ({
      providerId: index % 2 === 0 ? "kenney" : "polyhaven",
      sourceAssetId: `source-budget-${index}`,
      candidateId: `candidate-budget-${index}`,
    })) as [
      { providerId: string; sourceAssetId: string; candidateId: string },
      { providerId: string; sourceAssetId: string; candidateId: string },
      { providerId: string; sourceAssetId: string; candidateId: string },
      { providerId: string; sourceAssetId: string; candidateId: string },
    ];
    let plan = planModelResolutionEvent(planCatalog([]), {
      type: "provider-search-completed",
      occurredAt: at(8),
      rankedCandidates: [first],
      refinementQuestions: ["Which proportions are essential?"],
    });
    plan = advanceProviderToEvaluation(plan, first, 9);
    plan = planModelResolutionEvent(plan, {
      type: "candidate-evaluated",
      occurredAt: at(13),
      candidate: createProviderCandidate(first, { assurance: "low" }),
      providersExhausted: false,
      refinementQuestions: ["Which proportions are essential?"],
    });
    expectPlanningCode(
      () => planModelResolutionEvent(plan, {
        type: "provider-search-completed",
        occurredAt: at(14),
        rankedCandidates: [first],
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );
    plan = planModelResolutionEvent(plan, {
      type: "provider-search-completed",
      occurredAt: at(14),
      rankedCandidates: [second, third, fourth],
    });
    expect(plan.plannedProviderCandidates).toEqual([first, second, third]);
    expect(plan.pendingProviderCandidates).toEqual([second, third]);

    plan = advanceProviderToEvaluation(plan, second, 15);
    plan = planModelResolutionEvent(plan, {
      type: "candidate-evaluated",
      occurredAt: at(19),
      candidate: createProviderCandidate(second, { assurance: "low" }),
      providersExhausted: false,
    });
    plan = advanceProviderToEvaluation(plan, third, 20);
    plan = planModelResolutionEvent(plan, {
      type: "candidate-evaluated",
      occurredAt: at(24),
      candidate: createProviderCandidate(third, { assurance: "low" }),
      providersExhausted: false,
    });
    plan = planModelResolutionEvent(plan, {
      type: "provider-search-completed",
      occurredAt: at(25),
      rankedCandidates: [fourth],
    });
    expect(plan.resolution.state).toBe("awaiting-confirmation");
    expect(plan.plannedProviderCandidates).toHaveLength(MODEL_RESOLUTION_DOWNLOAD_LIMIT);
    expect(plan.plannedProviderCandidates).not.toContainEqual(fourth);
  });

  it("plans private provider intake through quarantine, processing, rendering, and evaluation", () => {
    const reference = {
      providerId: "polyhaven",
      sourceAssetId: "source-provider-1",
      candidateId: "provider-candidate-1",
    } as const;
    let plan = planModelResolutionEvent(planCatalog([]), {
      type: "provider-search-completed",
      occurredAt: at(8),
      rankedCandidates: [reference],
    });
    plan = planModelResolutionEvent(plan, {
      type: "provider-download-ready",
      occurredAt: at(9),
      candidate: reference,
    });
    expect(plan.resolution.state).toBe("quarantining");
    expect(plan.effects[0]?.kind).toBe("quarantine-provider-candidate");

    plan = planModelResolutionEvent(plan, {
      type: "quarantine-completed",
      occurredAt: at(10),
      candidateId: reference.candidateId,
    });
    expect(plan.resolution.state).toBe("processing");

    plan = planModelResolutionEvent(plan, {
      type: "processing-completed",
      occurredAt: at(11),
      candidateId: reference.candidateId,
    });
    expect(plan.resolution.state).toBe("rendering");

    plan = planModelResolutionEvent(plan, {
      type: "rendering-completed",
      occurredAt: at(12),
      candidateId: reference.candidateId,
    });
    expect(plan.resolution.state).toBe("evaluating");
    expect(plan.effects).toEqual([{
      kind: "evaluate-model-candidate",
      candidate: reference,
    }]);
  });

  it("routes quarantined rights to review and resumes with updated candidate evidence", () => {
    const reference = {
      providerId: "polyhaven",
      sourceAssetId: "source-provider-1",
      candidateId: "provider-candidate-1",
    } as const;
    let plan = planModelResolutionEvent(planCatalog([]), {
      type: "provider-search-completed",
      occurredAt: at(8),
      rankedCandidates: [reference],
    });
    for (const event of [
      { type: "provider-download-ready", occurredAt: at(9), candidate: reference },
      { type: "quarantine-completed", occurredAt: at(10), candidateId: reference.candidateId },
      { type: "processing-completed", occurredAt: at(11), candidateId: reference.candidateId },
      { type: "rendering-completed", occurredAt: at(12), candidateId: reference.candidateId },
    ] as const) {
      plan = planModelResolutionEvent(plan, event);
    }
    const quarantined = createProviderCandidate(reference, {
      assurance: "low",
      rightsStatus: "quarantined",
    });
    plan = planModelResolutionEvent(plan, {
      type: "candidate-evaluated",
      occurredAt: at(13),
      candidate: quarantined,
      providersExhausted: true,
      refinementQuestions: ["Which surface finish is essential?"],
    });

    expect(plan.resolution.state).toBe("awaiting-rights-review");
    expect(plan.effects[0]?.kind).toBe("request-rights-review");

    const allowed = createRightsReviewedCandidate(quarantined);
    plan = planModelResolutionEvent(plan, {
      type: "rights-review-completed",
      occurredAt: at(14),
      candidate: allowed,
      providersExhausted: true,
      refinementQuestions: ["Which surface finish is essential?"],
    });
    expect(plan.resolution.state).toBe("awaiting-confirmation");
    expect(plan.resolution.bestCandidate?.candidateId).toBe(reference.candidateId);
  });

  it("returns the best valid low candidate after provider exhaustion", () => {
    const lower = createCandidate({ candidateId: "candidate-lower", assurance: "low" });
    const higher = createCandidate({ candidateId: "candidate-higher", assurance: "low" });
    const lowPlan = planCatalog([lower, higher], PROVIDERS, ["Should the chair have arms?"]);
    const exhausted = planModelResolutionEvent(lowPlan, {
      type: "providers-exhausted",
      occurredAt: at(9),
      refinementQuestions: ["Should the chair have arms?"],
    });

    expect(exhausted.resolution.state).toBe("awaiting-confirmation");
    expect(exhausted.resolution.bestCandidate?.match.assurance).toBe("low");
    expect(exhausted.effects[0]).toMatchObject({
      kind: "request-human-confirmation",
      semanticRiskAcceptanceRequired: true,
    });
  });

  it("ends unresolved with explicit disabled-generator evidence when providers are exhausted", () => {
    const exhausted = planModelResolutionEvent(planCatalog([]), {
      type: "providers-exhausted",
      occurredAt: at(9),
    });

    expect(MODEL_RESOLUTION_PHASE_ONE_GENERATOR_ENABLED).toBe(false);
    expect(exhausted.resolution).toMatchObject({
      state: "unresolved",
      stateReasonCode: "provider-and-generator-exhausted",
    });
    expect(exhausted.effects).toEqual([{
      kind: "generator-disabled",
      reasonCode: MODEL_GENERATOR_DISABLED_REASON_CODE,
    }]);
  });

  it("requires low semantic-risk acceptance and completes an existing catalog selection", () => {
    const low = createCandidate({ assurance: "low" });
    const awaiting = planCatalog([low], []);

    expect(() => createConfirmation(low, false)).toThrow(/semantic risk/i);
    const confirmation = createConfirmation(low, true);
    const completed = planModelResolutionEvent(awaiting, {
      type: "candidate-confirmed",
      occurredAt: CONFIRMED_AT,
      confirmation,
    });

    expect(completed.resolution.state).toBe("completed");
    expect(completed.resolution.finalAssetRef).toEqual(
      low.assetRef.disposition === "existing" ? low.assetRef.asset : undefined,
    );
    expect(completed.effects[0]?.kind).toBe("select-existing-catalog-candidate");
  });

  it("hands a confirmed staged candidate to atomic promotion and records completion", () => {
    const reference = {
      providerId: "polyhaven",
      sourceAssetId: "source-promote",
      candidateId: "provider-promote",
    } as const;
    const proposed = createProviderCandidate(reference);
    const awaiting = planModelResolutionEvent(planProviderToEvaluation([reference]), {
      type: "candidate-evaluated",
      occurredAt: at(13),
      candidate: proposed,
      providersExhausted: true,
    });
    const confirmation = createConfirmation(proposed, false, at(14));
    let plan = planModelResolutionEvent(awaiting, {
      type: "candidate-confirmed",
      occurredAt: at(14),
      confirmation,
    });
    expect(plan.resolution.state).toBe("promoting");
    expect(plan.effects[0]?.kind).toBe("promote-model-candidate");

    const promotion = createPromotion(proposed, confirmation);
    plan = planModelResolutionEvent(plan, {
      type: "promotion-completed",
      occurredAt: at(15),
      finalAssetRef: promotion.finalAssetRef,
      promotionReceipt: promotion.receipt,
    });
    expect(plan.resolution.state).toBe("completed");
    expect(plan.resolution.finalAssetRef).toEqual(promotion.finalAssetRef);
  });

  it("supports provider authorization without fabricating a provider fallback", () => {
    expectPlanningCode(
      () => planModelResolutionEvent(planCatalog([]), {
        type: "provider-auth-required",
        occurredAt: at(8),
        providerId: "unconfigured-provider",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );

    let plan = planModelResolutionEvent(planCatalog([]), {
      type: "provider-auth-required",
      occurredAt: at(8),
      providerId: "sketchfab",
    });
    expect(plan.resolution.state).toBe("awaiting-provider-auth");
    expect(plan.awaitingProviderId).toBe("sketchfab");
    expect(plan.effects).toEqual([{
      kind: "request-provider-authorization",
      providerId: "sketchfab",
    }]);
    expectPlanningCode(
      () => planModelResolutionEvent({
        ...plan,
        providerAuthorizationAttemptedIds: [],
      }, {
        type: "provider-auth-resumed",
        occurredAt: at(9),
        providerId: "sketchfab",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );

    expectPlanningCode(
      () => planModelResolutionEvent(plan, {
        type: "provider-auth-resumed",
        occurredAt: at(9),
        providerId: "polyhaven",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );

    plan = planModelResolutionEvent(plan, {
      type: "provider-auth-resumed",
      occurredAt: at(9),
      providerId: "sketchfab",
    });
    expect(plan.resolution.state).toBe("searching-providers");
    expect(plan.awaitingProviderId).toBeUndefined();
    expect(plan.effects[0]?.kind).toBe("search-providers");
    expectPlanningCode(
      () => planModelResolutionEvent(plan, {
        type: "provider-auth-required",
        occurredAt: at(10),
        providerId: "sketchfab",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );
  });

  it("cancels cancellable work idempotently but refuses cancellation during promotion", () => {
    const plan = createInitialPlan();
    const cancelled = planModelResolutionCancellation(plan, {
      cancelledAt: at(7),
      reasonCode: "requester-cancelled",
    });
    expect(cancelled.resolution.state).toBe("cancelled");
    expect(cancelled.effects[0]?.kind).toBe("cancel-resolution-work");

    const repeated = planModelResolutionCancellation(cancelled, {
      cancelledAt: at(8),
      reasonCode: "requester-cancelled",
    });
    expect(repeated.resolution).toEqual(cancelled.resolution);
    expect(repeated.effects).toEqual([]);

    const reference = {
      providerId: "polyhaven",
      sourceAssetId: "source-cancel-promote",
      candidateId: "provider-cancel-promote",
    } as const;
    const proposed = createProviderCandidate(reference);
    const awaiting = planModelResolutionEvent(planProviderToEvaluation([reference]), {
      type: "candidate-evaluated",
      occurredAt: at(13),
      candidate: proposed,
      providersExhausted: true,
    });
    const confirmation = createConfirmation(proposed, false, at(14));
    const promoting = planModelResolutionEvent(awaiting, {
      type: "candidate-confirmed",
      occurredAt: at(14),
      confirmation,
    });
    expectPlanningCode(
      () => planModelResolutionCancellation(promoting, {
        cancelledAt: at(11),
        reasonCode: "requester-cancelled",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.PROMOTION_IN_PROGRESS,
    );
  });

  it("creates bounded immutable retry revisions only after rejection or retryable terminals", () => {
    const rejected = createCandidate({ assurance: "low" });
    const awaiting = planCatalog([rejected], [], ["Should the chair have arms?"]);
    const nextRequest = createRequest(1, { query: "weathered oak dining chair with arms" });
    const retry = planModelResolutionRetry(awaiting, {
      request: nextRequest,
      rejectedCandidateIds: [rejected.candidateId],
      createdAt: at(10),
    });

    expect(awaiting.resolution.request.revision).toBe(0);
    expect(awaiting.resolution.state).toBe("awaiting-confirmation");
    expect(retry.resolution).toMatchObject({
      state: "searching-catalog",
      attempts: 2,
      request: { revision: 1 },
    });
    expect(retry.excludedCandidateIds).toEqual([rejected.candidateId]);
    expect(retry.effects[0]).toMatchObject({
      kind: "search-catalog",
      supersedesRevision: 0,
    });

    expectPlanningCode(
      () => planModelResolutionRetry(awaiting, {
        request: createRequest(1),
        rejectedCandidateIds: [],
        createdAt: at(10),
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.CANDIDATE_REJECTION_REQUIRED,
    );
  });

  it("prevents retry cycles, skipped revisions, and revisions beyond the contract limit", () => {
    const unresolved = planModelResolutionEvent(planCatalog([]), {
      type: "providers-exhausted",
      occurredAt: at(9),
    });
    expectPlanningCode(
      () => planModelResolutionRetry(unresolved, {
        request: createRequest(1),
        rejectedCandidateIds: [],
        createdAt: at(10),
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.RETRY_REFINEMENT_REQUIRED,
    );
    expectPlanningCode(
      () => planModelResolutionRetry(unresolved, {
        request: createRequest(2, { query: "chair with arms" }),
        rejectedCandidateIds: [],
        createdAt: at(10),
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.RETRY_REVISION_MISMATCH,
    );

    let plan = unresolved;
    for (let revision = 1; revision <= MODEL_REQUEST_MAX_REVISION; revision += 1) {
      const minute = revision * 10;
      plan = planModelResolutionRetry(plan, {
        request: createRequest(revision, { query: `chair revision ${revision}` }),
        rejectedCandidateIds: [],
        createdAt: `2026-07-13T13:${String(minute).padStart(2, "0")}:00.000Z`,
      });
      plan = planModelResolutionEvent(plan, {
        type: "catalog-search-completed",
        occurredAt: `2026-07-13T13:${String(minute + 1).padStart(2, "0")}:00.000Z`,
        candidates: [],
        providerIds: [],
      });
    }
    expect(plan.resolution.request.revision).toBe(MODEL_REQUEST_MAX_REVISION);
    expectPlanningCode(
      () => planModelResolutionRetry(plan, {
        request: createRequest(MODEL_REQUEST_MAX_REVISION, { query: "one more" }),
        rejectedCandidateIds: [],
        createdAt: "2026-07-13T14:00:00.000Z",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.RETRY_REVISION_LIMIT,
    );
  });

  it("records controlled failures as terminal and rejects further events", () => {
    const failed = planModelResolutionEvent(createInitialPlan(), {
      type: "failed",
      occurredAt: at(7),
      reasonCode: "catalog-index-unavailable",
    });
    expect(failed.resolution).toMatchObject({
      state: "failed",
      stateReasonCode: "catalog-index-unavailable",
    });
    expectPlanningCode(
      () => planModelResolutionEvent(failed, {
        type: "providers-exhausted",
        occurredAt: at(8),
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.TERMINAL_STATE,
    );
  });

  it("validates revision, timestamps, identifiers, questions, and transition states", () => {
    expect(canTransitionModelResolution("not-a-state", "failed")).toBe(false);
    expectPlanningCode(
      () => assertModelResolutionTransition("not-a-state" as never, "failed"),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_STATE,
    );
    expectPlanningCode(
      () => createModelResolutionWorkflowPlan({
        resolutionId: "resolution-1",
        request: createRequest(1),
        createdAt: INITIAL_AT,
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.RETRY_REVISION_MISMATCH,
    );
    expectPlanningCode(
      () => createModelResolutionWorkflowPlan({
        resolutionId: "resolution-1",
        request: createRequest(),
        createdAt: "13 July 2026",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_TIMESTAMP,
    );
    expectPlanningCode(
      () => planModelResolutionEvent(createInitialPlan(), {
        type: "catalog-search-completed",
        occurredAt: "2026-07-13T11:59:00.000Z",
        candidates: [],
        providerIds: PROVIDERS,
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_TIMESTAMP,
    );
    expectPlanningCode(
      () => planCatalog([], ["polyhaven", "polyhaven"]),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => planCatalog([], PROVIDERS, ["Duplicate?", "Duplicate?"]),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => planModelResolutionEvent(createInitialPlan(), {
        type: "catalog-search-completed",
        occurredAt: at(7),
        candidates: undefined,
        providerIds: PROVIDERS,
      } as never),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => planModelResolutionEvent(createInitialPlan(), {
        type: "catalog-search-completed",
        occurredAt: at(7),
        candidates: Array.from({ length: 51 }, () => ({})),
        providerIds: PROVIDERS,
      } as never),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
  });

  it("rejects oversized, duplicate, unqueued, and outstanding provider work", () => {
    const searching = planCatalog([]);
    const oversized = Array.from({ length: 51 }, (_, index) => ({
      providerId: "polyhaven",
      sourceAssetId: `source-${index}`,
      candidateId: `candidate-${index}`,
    }));
    expectPlanningCode(
      () => planModelResolutionEvent(searching, {
        type: "provider-search-completed",
        occurredAt: at(8),
        rankedCandidates: oversized,
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.DOWNLOAD_LIMIT_EXCEEDED,
    );
    expectPlanningCode(
      () => planModelResolutionEvent(searching, {
        type: "provider-search-completed",
        occurredAt: at(8),
        rankedCandidates: [
          { providerId: "polyhaven", sourceAssetId: "one", candidateId: "duplicate" },
          { providerId: "kenney", sourceAssetId: "two", candidateId: "duplicate" },
        ],
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => planModelResolutionEvent(searching, {
        type: "provider-search-completed",
        occurredAt: at(8),
        rankedCandidates: [{
          providerId: "unconfigured-provider",
          sourceAssetId: "source-unconfigured",
          candidateId: "candidate-unconfigured",
        }],
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );

    const reference = {
      providerId: "polyhaven",
      sourceAssetId: "source-1",
      candidateId: "candidate-1",
    } as const;
    const queued = planModelResolutionEvent(searching, {
      type: "provider-search-completed",
      occurredAt: at(8),
      rankedCandidates: [reference],
    });
    expectPlanningCode(
      () => planModelResolutionEvent(queued, {
        type: "provider-download-ready",
        occurredAt: at(9),
        candidate: { ...reference, candidateId: "not-queued" },
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );
    expectPlanningCode(
      () => planModelResolutionEvent(queued, {
        type: "provider-auth-required",
        occurredAt: at(9),
        providerId: "sketchfab",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );
    expectPlanningCode(
      () => planModelResolutionEvent({
        ...searching,
        pendingProviderCandidates: oversized.slice(0, 4),
      }, {
        type: "providers-exhausted",
        occurredAt: at(9),
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.DOWNLOAD_LIMIT_EXCEEDED,
    );
  });

  it("ignores rejected candidates on later immutable revisions", () => {
    const rejected = createCandidate({ assurance: "low" });
    const awaiting = planCatalog([rejected], [], ["Should the chair have arms?"]);
    const retry = planModelResolutionRetry(awaiting, {
      request: createRequest(1, { query: "chair with arms" }),
      rejectedCandidateIds: [rejected.candidateId],
      createdAt: at(10),
    });
    const exhausted = planModelResolutionEvent(retry, {
      type: "catalog-search-completed",
      occurredAt: at(11),
      candidates: [rejected],
      providerIds: [],
    });
    expect(exhausted.resolution.state).toBe("unresolved");
    expect(exhausted.resolution.candidates).toEqual([]);
  });

  it("continues pending provider downloads after a low evaluation and accepts a later high", () => {
    const first = {
      providerId: "polyhaven",
      sourceAssetId: "source-low",
      candidateId: "provider-low",
    } as const;
    const second = {
      providerId: "kenney",
      sourceAssetId: "source-high",
      candidateId: "provider-high",
    } as const;
    let plan = planProviderToEvaluation([first, second]);
    plan = planModelResolutionEvent(plan, {
      type: "candidate-evaluated",
      occurredAt: at(13),
      candidate: createProviderCandidate(first, {
        assurance: "low",
      }),
      providersExhausted: false,
      refinementQuestions: ["Which proportions are essential?"],
    });
    expect(plan.resolution.state).toBe("searching-providers");
    expect(plan.pendingProviderCandidates).toEqual([second]);
    expect(plan.effects).toEqual([]);

    for (const event of [
      { type: "provider-download-ready", occurredAt: at(14), candidate: second },
      { type: "quarantine-completed", occurredAt: at(15), candidateId: second.candidateId },
      { type: "processing-completed", occurredAt: at(16), candidateId: second.candidateId },
      { type: "rendering-completed", occurredAt: at(17), candidateId: second.candidateId },
    ] as const) {
      plan = planModelResolutionEvent(plan, event);
    }
    plan = planModelResolutionEvent(plan, {
      type: "candidate-evaluated",
      occurredAt: at(18),
      candidate: createProviderCandidate(second),
      providersExhausted: true,
    });
    expect(plan.resolution.state).toBe("awaiting-confirmation");
    expect(plan.resolution.bestCandidate?.candidateId).toBe(second.candidateId);
  });

  it("fails closed after blocked provider evaluation and on repeated rights quarantine", () => {
    const reference = {
      providerId: "polyhaven",
      sourceAssetId: "source-blocked",
      candidateId: "provider-blocked",
    } as const;
    expectPlanningCode(
      () => planModelResolutionEvent(planProviderToEvaluation([reference]), {
        type: "candidate-evaluated",
        occurredAt: at(13),
        candidate: createProviderCandidate({
          ...reference,
          providerId: "kenney",
        }),
        providersExhausted: true,
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );
    const blocked = planModelResolutionEvent(planProviderToEvaluation([reference]), {
      type: "candidate-evaluated",
      occurredAt: at(13),
      candidate: createProviderCandidate(reference, {
        rightsStatus: "blocked",
      }),
      providersExhausted: true,
    });
    expect(blocked.resolution.state).toBe("unresolved");

    expectPlanningCode(
      () => planModelResolutionEvent(planProviderToEvaluation([reference]), {
        type: "candidate-evaluated",
        occurredAt: at(13),
        candidate: createProviderCandidate(reference),
        providersExhausted: undefined,
      } as never),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );

    const quarantined = createProviderCandidate(reference, {
      rightsStatus: "quarantined",
    });
    const reviewed = createRightsReviewedCandidate(quarantined);
    let rightsPlan = planModelResolutionEvent(planProviderToEvaluation([reference]), {
      type: "candidate-evaluated",
      occurredAt: at(13),
      candidate: quarantined,
      providersExhausted: true,
    });
    expectPlanningCode(
      () => planModelResolutionEvent(rightsPlan, {
        type: "rights-review-completed",
        occurredAt: at(14),
        candidate: createProviderCandidate(reference, {
          rightsStatus: "quarantined",
        }),
        providersExhausted: true,
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );

    expectPlanningCode(
      () => planModelResolutionEvent(rightsPlan, {
        type: "rights-review-completed",
        occurredAt: at(14),
        candidate: createProviderCandidate(reference),
        providersExhausted: true,
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );
    expectPlanningCode(
      () => planModelResolutionEvent(rightsPlan, {
        type: "rights-review-completed",
        occurredAt: at(14),
        candidate: reviewed,
        providersExhausted: false,
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );
    expectPlanningCode(
      () => planModelResolutionEvent(rightsPlan, {
        type: "rights-review-completed",
        occurredAt: at(14),
        candidate: createRightsReviewedCandidate(
          createProviderCandidate(reference, { assurance: "low" }),
        ),
        providersExhausted: true,
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );
    rightsPlan = planModelResolutionEvent(rightsPlan, {
      type: "rights-review-completed",
      occurredAt: at(14),
      candidate: reviewed,
      providersExhausted: true,
    });
    expect(rightsPlan.resolution.state).toBe("awaiting-confirmation");
  });

  it("rejects premature confirmation, terminal cancellation, active retries, and unknown events", () => {
    const high = createCandidate();
    const awaiting = planCatalog([high]);
    const confirmation = createConfirmation(high, false);
    expectPlanningCode(
      () => planModelResolutionEvent(awaiting, {
        type: "candidate-confirmed",
        occurredAt: at(9),
        confirmation,
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_TIMESTAMP,
    );

    const unresolved = planModelResolutionEvent(planCatalog([]), {
      type: "providers-exhausted",
      occurredAt: at(9),
    });
    expectPlanningCode(
      () => planModelResolutionCancellation(unresolved, {
        cancelledAt: at(10),
        reasonCode: "requester-cancelled",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.TERMINAL_STATE,
    );
    expectPlanningCode(
      () => planModelResolutionRetry(createInitialPlan(), {
        request: createRequest(1, { query: "refined chair" }),
        rejectedCandidateIds: [],
        createdAt: at(10),
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.RETRY_NOT_ALLOWED,
    );
    expectPlanningCode(
      () => planModelResolutionRetry(unresolved, {
        request: createRequest(1, { query: "refined chair" }),
        rejectedCandidateIds: ["candidate-never-returned"],
        createdAt: at(10),
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => planModelResolutionEvent(createInitialPlan(), {
        type: "unknown-event",
        occurredAt: at(7),
      } as never),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );
  });

  it("rejects malformed public inputs and corrupted persisted planner metadata", () => {
    expectPlanningCode(
      () => createModelResolutionWorkflowPlan(null as never),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => createModelResolutionWorkflowPlan({
        resolutionId: "resolution-1",
        request: {} as never,
        createdAt: INITIAL_AT,
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => createModelResolutionWorkflowPlan({
        resolutionId: "..",
        request: createRequest(),
        createdAt: INITIAL_AT,
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => createModelResolutionWorkflowPlan({
        resolutionId: "resolution-1",
        request: createRequest(),
        createdAt: null as never,
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_TIMESTAMP,
    );
    expectPlanningCode(
      () => planCatalog([], ["provider with spaces"]),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => planCatalog([], PROVIDERS, ["one", "two", "three", "four"]),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => planCatalog([], PROVIDERS, [" "]),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );

    const searching = planCatalog([]);
    for (const rankedCandidates of [
      [null],
      [{ providerId: "polyhaven", sourceAssetId: "source-1", candidateId: "candidate-1", extra: true }],
      [{ providerId: "polyhaven", sourceAssetId: "source:invalid", candidateId: "candidate-1" }],
      [{ providerId: "polyhaven", sourceAssetId: "source-1", candidateId: ".." }],
    ]) {
      expectPlanningCode(
        () => planModelResolutionEvent(searching, {
          type: "provider-search-completed",
          occurredAt: at(8),
          rankedCandidates,
        } as never),
        MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
      );
    }

    expectPlanningCode(
      () => planModelResolutionCancellation(null as never, {
        cancelledAt: at(8),
        reasonCode: "requester-cancelled",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => planModelResolutionCancellation({
        ...createInitialPlan(),
        configuredProviderIds: null as never,
      }, {
        cancelledAt: at(8),
        reasonCode: "requester-cancelled",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => planModelResolutionCancellation({
        ...createInitialPlan(),
        providersExhausted: "no" as never,
      }, {
        cancelledAt: at(8),
        reasonCode: "requester-cancelled",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => planModelResolutionCancellation({
        ...createInitialPlan(),
        configuredProviderIds: ["sketchfab"],
        providerAuthorizationAttemptedIds: ["sketchfab"],
        awaitingProviderId: "sketchfab",
      }, {
        cancelledAt: at(8),
        reasonCode: "requester-cancelled",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => planModelResolutionCancellation({
        ...createInitialPlan(),
        providerAuthorizationAttemptedIds: ["sketchfab"],
      }, {
        cancelledAt: at(8),
        reasonCode: "requester-cancelled",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );

    const reference = {
      providerId: "polyhaven",
      sourceAssetId: "source-corrupt",
      candidateId: "candidate-corrupt",
    } as const;
    const queued = planModelResolutionEvent(searching, {
      type: "provider-search-completed",
      occurredAt: at(8),
      rankedCandidates: [reference],
    });
    expectPlanningCode(
      () => planModelResolutionCancellation({
        ...queued,
        activeProviderCandidate: reference,
      }, {
        cancelledAt: at(9),
        reasonCode: "requester-cancelled",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => planModelResolutionCancellation({
        ...searching,
        plannedProviderCandidates: [{ ...reference, providerId: "unconfigured" }],
      }, {
        cancelledAt: at(9),
        reasonCode: "requester-cancelled",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => planModelResolutionCancellation({
        ...queued,
        pendingProviderCandidates: [{ ...reference, sourceAssetId: "different-source" }],
      }, {
        cancelledAt: at(9),
        reasonCode: "requester-cancelled",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );

    const catalogCandidate = createCandidate({ candidateId: "candidate-catalog-collision" });
    const catalogAwaiting = planCatalog([catalogCandidate]);
    expectPlanningCode(
      () => planModelResolutionCancellation({
        ...catalogAwaiting,
        plannedProviderCandidates: [{
          providerId: "polyhaven",
          sourceAssetId: "source-catalog-collision",
          candidateId: catalogCandidate.candidateId,
        }],
      }, {
        cancelledAt: at(9),
        reasonCode: "requester-cancelled",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );

    const proposedReference = {
      providerId: "polyhaven",
      sourceAssetId: "source-proposed",
      candidateId: "candidate-proposed",
    } as const;
    const proposedAwaiting = planModelResolutionEvent(
      planProviderToEvaluation([proposedReference]),
      {
        type: "candidate-evaluated",
        occurredAt: at(13),
        candidate: createProviderCandidate(proposedReference),
        providersExhausted: true,
      },
    );
    expectPlanningCode(
      () => planModelResolutionCancellation({
        ...proposedAwaiting,
        plannedProviderCandidates: [],
      }, {
        cancelledAt: at(14),
        reasonCode: "requester-cancelled",
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
  });

  it("covers fail-closed event correlation and rights-review boundaries", () => {
    expectPlanningCode(
      () => planModelResolutionEvent(createInitialPlan(), null as never),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );
    expectPlanningCode(
      () => planModelResolutionEvent(createInitialPlan(), {
        type: "catalog-search-completed",
        occurredAt: at(7),
        candidates: [],
        providerIds: null,
      } as never),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => planModelResolutionEvent(createInitialPlan(), {
        type: "provider-search-completed",
        occurredAt: at(7),
        rankedCandidates: [],
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );

    const duplicateHigh = createCandidate({ candidateId: "candidate-duplicate", assurance: "high" });
    const duplicateLow = createCandidate({ candidateId: "candidate-duplicate", assurance: "low" });
    expectPlanningCode(
      () => planCatalog([duplicateHigh, duplicateLow]),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => planCatalog([createCandidate({ assurance: "low" })], [], []),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );

    const first = {
      providerId: "polyhaven",
      sourceAssetId: "source-first-boundary",
      candidateId: "candidate-first-boundary",
    } as const;
    const second = {
      providerId: "kenney",
      sourceAssetId: "source-second-boundary",
      candidateId: "candidate-second-boundary",
    } as const;
    const queued = planModelResolutionEvent(planCatalog([]), {
      type: "provider-search-completed",
      occurredAt: at(8),
      rankedCandidates: [first, second],
    });
    expectPlanningCode(
      () => planModelResolutionEvent({
        ...queued,
        activeProviderCandidate: first,
        pendingProviderCandidates: [second],
      }, {
        type: "provider-download-ready",
        occurredAt: at(9),
        candidate: second,
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );

    const quarantining = planModelResolutionEvent(queued, {
      type: "provider-download-ready",
      occurredAt: at(9),
      candidate: first,
    });
    expectPlanningCode(
      () => planModelResolutionEvent(quarantining, {
        type: "quarantine-completed",
        occurredAt: at(10),
        candidateId: second.candidateId,
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );

    const evaluating = advanceProviderToEvaluation(queued, first, 9);
    expectPlanningCode(
      () => planModelResolutionEvent(evaluating, {
        type: "candidate-evaluated",
        occurredAt: at(13),
        candidate: createProviderCandidate(first, { assurance: "low" }),
        providersExhausted: true,
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );

    const quarantined = createProviderCandidate(first, {
      assurance: "low",
      rightsStatus: "quarantined",
    });
    const rightsPlan = planModelResolutionEvent(evaluating, {
      type: "candidate-evaluated",
      occurredAt: at(13),
      candidate: quarantined,
      providersExhausted: false,
    });
    expectPlanningCode(
      () => planModelResolutionEvent(rightsPlan, {
        type: "rights-review-completed",
        occurredAt: at(14),
        candidate: createRightsReviewedCandidate(quarantined),
        providersExhausted: undefined,
      } as never),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => planModelResolutionEvent(rightsPlan, {
        type: "rights-review-completed",
        occurredAt: at(14),
        candidate: createRightsReviewedCandidate(
          quarantined,
          "2026-07-13T12:05:00.000Z",
        ),
        providersExhausted: false,
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_TIMESTAMP,
    );
    expectPlanningCode(
      () => planModelResolutionEvent({
        ...rightsPlan,
        providersExhausted: true,
      }, {
        type: "rights-review-completed",
        occurredAt: at(14),
        candidate: createRightsReviewedCandidate(quarantined),
        providersExhausted: true,
      }),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT,
    );

    const reviewedLow = planModelResolutionEvent(rightsPlan, {
      type: "rights-review-completed",
      occurredAt: at(14),
      candidate: createRightsReviewedCandidate(quarantined),
      providersExhausted: false,
      refinementQuestions: ["Which proportions are essential?"],
    });
    expect(reviewedLow.resolution.state).toBe("searching-providers");

    expectPlanningCode(
      () => planModelResolutionCancellation(createInitialPlan(), null as never),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
    expectPlanningCode(
      () => planModelResolutionRetry(
        planModelResolutionEvent(planCatalog([]), {
          type: "providers-exhausted",
          occurredAt: at(9),
        }),
        null as never,
      ),
      MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT,
    );
  });
});
