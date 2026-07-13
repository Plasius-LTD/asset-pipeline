import {
  MODEL_GENERATOR_DISABLED_REASON_CODE,
  MODEL_REQUEST_MAX_REVISION,
  createModelCandidate,
  createModelCandidateConfirmation,
  createModelRequestSpec,
  createModelResolution,
  isModelCandidateConfirmable,
  isModelResolutionState,
  type ModelAssetRef,
  type ModelCandidate,
  type ModelCandidateConfirmation,
  type ModelPromotionReceipt,
  type ModelRequestSpec,
  type ModelResolution,
  type ModelResolutionState,
} from "@plasius/asset-contracts";

/** Maximum provider searches planned concurrently for one request revision. */
export const MODEL_RESOLUTION_PROVIDER_LIMIT = 5 as const;

/** Maximum ranked provider candidates downloaded for one request revision. */
export const MODEL_RESOLUTION_DOWNLOAD_LIMIT = 3 as const;

/** Phase 1 never plans an AI model-generator invocation. */
export const MODEL_RESOLUTION_PHASE_ONE_GENERATOR_ENABLED = false as const;

/** Terminal canonical resolution states; retries create a separate immutable revision. */
export const MODEL_RESOLUTION_TERMINAL_STATES = Object.freeze([
  "completed",
  "unresolved",
  "failed",
  "cancelled",
] as const);

/** States where unfinished external work may be cancelled safely. */
export const MODEL_RESOLUTION_CANCELLABLE_STATES = Object.freeze([
  "searching-catalog",
  "searching-providers",
  "awaiting-provider-auth",
  "quarantining",
  "processing",
  "rendering",
  "evaluating",
  "awaiting-rights-review",
  "awaiting-confirmation",
] as const);

/** Stable public planning error codes. */
export const MODEL_RESOLUTION_PLANNING_ERROR_CODES = Object.freeze({
  INVALID_INPUT: "model-resolution-invalid-input",
  INVALID_STATE: "model-resolution-invalid-state",
  INVALID_TRANSITION: "model-resolution-invalid-transition",
  INVALID_EVENT: "model-resolution-invalid-event",
  INVALID_TIMESTAMP: "model-resolution-invalid-timestamp",
  PROVIDER_LIMIT_EXCEEDED: "model-resolution-provider-limit-exceeded",
  DOWNLOAD_LIMIT_EXCEEDED: "model-resolution-download-limit-exceeded",
  TERMINAL_STATE: "model-resolution-terminal-state",
  PROMOTION_IN_PROGRESS: "model-resolution-promotion-in-progress",
  RETRY_NOT_ALLOWED: "model-resolution-retry-not-allowed",
  RETRY_REVISION_LIMIT: "model-resolution-retry-revision-limit",
  RETRY_REVISION_MISMATCH: "model-resolution-retry-revision-mismatch",
  RETRY_REFINEMENT_REQUIRED: "model-resolution-retry-refinement-required",
  CANDIDATE_REJECTION_REQUIRED: "model-resolution-candidate-rejection-required",
} as const);

/** A stable planner error without provider, persistence, or user-data details. */
export class ModelResolutionPlanningError extends Error {
  readonly code: ModelResolutionPlanningErrorCode;

  constructor(code: ModelResolutionPlanningErrorCode) {
    super(code);
    this.name = "ModelResolutionPlanningError";
    this.code = code;
  }
}

export type ModelResolutionPlanningErrorCode =
  typeof MODEL_RESOLUTION_PLANNING_ERROR_CODES[keyof typeof MODEL_RESOLUTION_PLANNING_ERROR_CODES];

/** One explicit canonical state transition. */
export interface ModelResolutionTransition {
  readonly from: ModelResolutionState;
  readonly to: ModelResolutionState;
}

/** Opaque provider metadata required to plan private acquisition. */
export interface ModelProviderCandidateRef {
  readonly providerId: string;
  readonly sourceAssetId: string;
  readonly candidateId: string;
}

/** Pure work descriptions interpreted by hosted orchestration outside this package. */
export type ModelResolutionEffect =
  | {
      readonly kind: "search-catalog";
      readonly request: ModelRequestSpec;
      readonly excludedCandidateIds: readonly string[];
      readonly supersedesRevision?: number;
    }
  | {
      readonly kind: "search-providers";
      readonly request: ModelRequestSpec;
      readonly providerIds: readonly string[];
      readonly maxConcurrency: typeof MODEL_RESOLUTION_PROVIDER_LIMIT;
      readonly excludedCandidateIds: readonly string[];
    }
  | {
      readonly kind: "download-provider-candidates";
      readonly candidates: readonly ModelProviderCandidateRef[];
      readonly maxDownloads: typeof MODEL_RESOLUTION_DOWNLOAD_LIMIT;
    }
  | {
      readonly kind: "request-provider-authorization";
      readonly providerId: string;
    }
  | {
      readonly kind: "quarantine-provider-candidate";
      readonly candidate: ModelProviderCandidateRef;
    }
  | {
      readonly kind: "process-model-candidate";
      readonly candidate: ModelProviderCandidateRef;
    }
  | {
      readonly kind: "render-model-candidate";
      readonly candidate: ModelProviderCandidateRef;
    }
  | {
      readonly kind: "evaluate-model-candidate";
      readonly candidate: ModelProviderCandidateRef;
    }
  | {
      readonly kind: "request-rights-review";
      readonly candidate: ModelCandidate;
    }
  | {
      readonly kind: "request-human-confirmation";
      readonly candidate: ModelCandidate;
      readonly semanticRiskAcceptanceRequired: boolean;
    }
  | {
      readonly kind: "select-existing-catalog-candidate";
      readonly candidate: ModelCandidate;
      readonly confirmation: ModelCandidateConfirmation;
      readonly finalAssetRef: ModelAssetRef;
    }
  | {
      readonly kind: "promote-model-candidate";
      readonly candidate: ModelCandidate;
      readonly confirmation: ModelCandidateConfirmation;
    }
  | {
      readonly kind: "generator-disabled";
      readonly reasonCode: typeof MODEL_GENERATOR_DISABLED_REASON_CODE;
    }
  | {
      readonly kind: "cancel-resolution-work";
      readonly fromState: ModelResolutionState;
      readonly reasonCode: string;
    };

/** Immutable canonical record plus planner-owned bounded queue state and next effects. */
export interface ModelResolutionWorkflowPlan {
  readonly resolution: ModelResolution;
  readonly excludedCandidateIds: readonly string[];
  readonly configuredProviderIds: readonly string[];
  readonly plannedProviderCandidates: readonly ModelProviderCandidateRef[];
  readonly providerAuthorizationAttemptedIds: readonly string[];
  readonly pendingProviderCandidates: readonly ModelProviderCandidateRef[];
  readonly activeProviderCandidate?: ModelProviderCandidateRef;
  readonly awaitingProviderId?: string;
  readonly providersExhausted: boolean;
  readonly effects: readonly ModelResolutionEffect[];
}

/** Start input for revision zero. */
export interface CreateModelResolutionWorkflowPlanInput {
  readonly resolutionId: string;
  readonly request: ModelRequestSpec;
  readonly createdAt: string;
}

/** Bounded immutable retry input. */
export interface PlanModelResolutionRetryInput {
  readonly request: ModelRequestSpec;
  readonly rejectedCandidateIds: readonly string[];
  readonly createdAt: string;
}

/** Cancellable-work request. */
export interface PlanModelResolutionCancellationInput {
  readonly cancelledAt: string;
  readonly reasonCode: string;
}

/** Events accepted by the pure state/effect reducer. */
export type ModelResolutionEvent =
  | {
      readonly type: "catalog-search-completed";
      readonly occurredAt: string;
      readonly candidates: readonly ModelCandidate[];
      readonly providerIds: readonly string[];
      readonly refinementQuestions?: readonly string[];
    }
  | {
      readonly type: "provider-search-completed";
      readonly occurredAt: string;
      readonly rankedCandidates: readonly ModelProviderCandidateRef[];
      readonly refinementQuestions?: readonly string[];
    }
  | {
      readonly type: "provider-auth-required";
      readonly occurredAt: string;
      readonly providerId: string;
    }
  | {
      readonly type: "provider-auth-resumed";
      readonly occurredAt: string;
      readonly providerId: string;
    }
  | {
      readonly type: "provider-download-ready";
      readonly occurredAt: string;
      readonly candidate: ModelProviderCandidateRef;
    }
  | {
      readonly type: "quarantine-completed";
      readonly occurredAt: string;
      readonly candidateId: string;
    }
  | {
      readonly type: "processing-completed";
      readonly occurredAt: string;
      readonly candidateId: string;
    }
  | {
      readonly type: "rendering-completed";
      readonly occurredAt: string;
      readonly candidateId: string;
    }
  | {
      readonly type: "candidate-evaluated";
      readonly occurredAt: string;
      readonly candidate: ModelCandidate;
      readonly providersExhausted: boolean;
      readonly refinementQuestions?: readonly string[];
    }
  | {
      readonly type: "rights-review-completed";
      readonly occurredAt: string;
      readonly candidate: ModelCandidate;
      readonly providersExhausted: boolean;
      readonly refinementQuestions?: readonly string[];
    }
  | {
      readonly type: "providers-exhausted";
      readonly occurredAt: string;
      readonly refinementQuestions?: readonly string[];
    }
  | {
      readonly type: "candidate-confirmed";
      readonly occurredAt: string;
      readonly confirmation: ModelCandidateConfirmation;
    }
  | {
      readonly type: "promotion-completed";
      readonly occurredAt: string;
      readonly finalAssetRef: ModelAssetRef;
      readonly promotionReceipt: ModelPromotionReceipt;
    }
  | {
      readonly type: "failed";
      readonly occurredAt: string;
      readonly reasonCode: string;
    };

const TRANSITIONS: Readonly<Record<ModelResolutionState, readonly ModelResolutionState[]>> =
  Object.freeze({
    "searching-catalog": Object.freeze([
      "searching-providers",
      "awaiting-confirmation",
      "unresolved",
      "failed",
      "cancelled",
    ] as const),
    "searching-providers": Object.freeze([
      "awaiting-provider-auth",
      "quarantining",
      "awaiting-confirmation",
      "unresolved",
      "failed",
      "cancelled",
    ] as const),
    "awaiting-provider-auth": Object.freeze([
      "searching-providers",
      "failed",
      "cancelled",
    ] as const),
    quarantining: Object.freeze(["processing", "failed", "cancelled"] as const),
    processing: Object.freeze(["rendering", "failed", "cancelled"] as const),
    rendering: Object.freeze(["evaluating", "failed", "cancelled"] as const),
    evaluating: Object.freeze([
      "searching-providers",
      "awaiting-rights-review",
      "awaiting-confirmation",
      "unresolved",
      "failed",
      "cancelled",
    ] as const),
    "awaiting-rights-review": Object.freeze([
      "searching-providers",
      "awaiting-confirmation",
      "unresolved",
      "failed",
      "cancelled",
    ] as const),
    "awaiting-confirmation": Object.freeze([
      "promoting",
      "completed",
      "failed",
      "cancelled",
    ] as const),
    promoting: Object.freeze(["completed", "failed"] as const),
    completed: Object.freeze([] as const),
    unresolved: Object.freeze([] as const),
    failed: Object.freeze([] as const),
    cancelled: Object.freeze([] as const),
  });

const TOKEN_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/u;
const MODEL_PATH_SEGMENT_PATTERN = /^[0-9A-Za-z._~-]{1,128}$/u;
const OPAQUE_SOURCE_ASSET_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,255}$/u;
const MAX_TRACKED_RESULTS = 50;

function planningError(code: ModelResolutionPlanningErrorCode): never {
  throw new ModelResolutionPlanningError(code);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function canonical<T>(factory: () => T): T {
  try {
    return factory();
  } catch {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
}

function requiredToken(value: unknown): string {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  return value;
}

function requiredModelPathSegment(value: unknown): string {
  if (
    typeof value !== "string"
    || !MODEL_PATH_SEGMENT_PATTERN.test(value)
    || value === "."
    || value === ".."
  ) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  return value;
}

function requiredSourceAssetId(value: unknown): string {
  if (typeof value !== "string" || !OPAQUE_SOURCE_ASSET_ID_PATTERN.test(value)) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  return value;
}

function requiredTimestamp(value: unknown, previous?: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_TIMESTAMP);
  }
  if (new Date(value).toISOString() !== value) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_TIMESTAMP);
  }
  if (previous !== undefined && Date.parse(value) < Date.parse(previous)) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_TIMESTAMP);
  }
  return value;
}

function normalizeTokenList(value: unknown, maximum = MAX_TRACKED_RESULTS): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  const tokens = value.map(requiredToken);
  if (new Set(tokens).size !== tokens.length) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  return Object.freeze([...tokens].sort());
}

function normalizeCandidateIdList(
  value: unknown,
  maximum = MAX_TRACKED_RESULTS,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  const candidateIds = value.map(requiredModelPathSegment);
  if (new Set(candidateIds).size !== candidateIds.length) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  return Object.freeze([...candidateIds].sort());
}

function normalizeQuestions(value: unknown): readonly string[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value) || value.length > 3) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  const questions = value.map((question) => {
    if (typeof question !== "string" || question.trim().length === 0 || question.trim().length > 512) {
      return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
    }
    return question.trim();
  });
  if (new Set(questions).size !== questions.length) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  return Object.freeze(questions);
}

function normalizeProviderCandidate(value: unknown): ModelProviderCandidateRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !["providerId", "sourceAssetId", "candidateId"].includes(key))
  ) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  return deepFreeze({
    providerId: requiredToken(record.providerId),
    sourceAssetId: requiredSourceAssetId(record.sourceAssetId),
    candidateId: requiredModelPathSegment(record.candidateId),
  });
}

function normalizeProviderCandidates(
  value: unknown,
  maximum = MAX_TRACKED_RESULTS,
): readonly ModelProviderCandidateRef[] {
  if (!Array.isArray(value) || value.length > maximum) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.DOWNLOAD_LIMIT_EXCEEDED);
  }
  const candidates = value.map(normalizeProviderCandidate);
  if (new Set(candidates.map((candidate) => candidate.candidateId)).size !== candidates.length) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  return Object.freeze(candidates);
}

function providerCandidateEquivalent(
  left: ModelProviderCandidateRef,
  right: ModelProviderCandidateRef,
): boolean {
  return left.providerId === right.providerId
    && left.sourceAssetId === right.sourceAssetId
    && left.candidateId === right.candidateId;
}

function canonicalRequest(value: unknown): ModelRequestSpec {
  return canonical(() => createModelRequestSpec(value));
}

function canonicalCandidate(value: unknown): ModelCandidate {
  return canonical(() => createModelCandidate(value));
}

function canonicalResolution(value: unknown): ModelResolution {
  return canonical(() => createModelResolution(value));
}

function compareTokens(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isExistingCatalogCandidate(candidate: ModelCandidate): boolean {
  return candidate.assetRef.disposition === "existing";
}

function providerCandidateMatchesRef(
  candidate: ModelCandidate,
  reference: ModelProviderCandidateRef,
): boolean {
  return candidate.assetRef.disposition === "proposed"
    && candidate.provenance.kind === "provider"
    && candidate.candidateId === reference.candidateId
    && candidate.provenance.sourceId === reference.providerId
    && candidate.provenance.sourceAssetId === reference.sourceAssetId;
}

function normalizeCatalogCandidates(value: unknown): readonly ModelCandidate[] {
  if (!Array.isArray(value) || value.length > MAX_TRACKED_RESULTS) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  const candidates = value.map(canonicalCandidate);
  if (candidates.some((candidate) => !isExistingCatalogCandidate(candidate))) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  return Object.freeze(candidates);
}

function rightsStableProjection(candidate: ModelCandidate): string {
  return JSON.stringify({
    contractVersion: candidate.contractVersion,
    resolutionId: candidate.resolutionId,
    candidateId: candidate.candidateId,
    assetRef: candidate.assetRef,
    match: candidate.match,
    provenance: candidate.provenance,
    technicalProfile: candidate.technicalProfile,
    processingManifest: candidate.processingManifest,
    views: candidate.views,
    renderEvidence: candidate.renderEvidence,
    hardGates: candidate.hardGates,
    confirmationRequired: candidate.confirmationRequired,
  });
}

function readPlan(value: ModelResolutionWorkflowPlan): ModelResolutionWorkflowPlan {
  if (value === null || typeof value !== "object") {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  const resolution = canonicalResolution(value.resolution);
  const excludedCandidateIds = normalizeCandidateIdList(value.excludedCandidateIds);
  const configuredProviderIds = normalizeTokenList(
    value.configuredProviderIds,
    MODEL_RESOLUTION_PROVIDER_LIMIT,
  );
  const plannedProviderCandidates = normalizeProviderCandidates(
    value.plannedProviderCandidates,
    MODEL_RESOLUTION_DOWNLOAD_LIMIT,
  );
  const providerAuthorizationAttemptedIds = normalizeTokenList(
    value.providerAuthorizationAttemptedIds,
    MODEL_RESOLUTION_PROVIDER_LIMIT,
  );
  const pendingProviderCandidates = normalizeProviderCandidates(
    value.pendingProviderCandidates,
    MODEL_RESOLUTION_DOWNLOAD_LIMIT,
  );
  const activeProviderCandidate = value.activeProviderCandidate === undefined
    ? undefined
    : normalizeProviderCandidate(value.activeProviderCandidate);
  const awaitingProviderId = value.awaitingProviderId === undefined
    ? undefined
    : requiredToken(value.awaitingProviderId);
  if (typeof value.providersExhausted !== "boolean") {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  const providersExhausted = value.providersExhausted;
  if (
    activeProviderCandidate !== undefined
    && pendingProviderCandidates.some((candidate) => candidate.candidateId === activeProviderCandidate.candidateId)
  ) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  if (
    (resolution.state === "awaiting-provider-auth") !== (awaitingProviderId !== undefined)
  ) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  if (
    awaitingProviderId !== undefined
    && (
      !configuredProviderIds.includes(awaitingProviderId)
      || !providerAuthorizationAttemptedIds.includes(awaitingProviderId)
    )
  ) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  if (
    providerAuthorizationAttemptedIds.some((providerId) =>
      !configuredProviderIds.includes(providerId))
  ) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  if (
    [...plannedProviderCandidates, ...pendingProviderCandidates, ...(activeProviderCandidate === undefined
      ? []
      : [activeProviderCandidate])]
      .some((candidate) => !configuredProviderIds.includes(candidate.providerId))
  ) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  const plannedByCandidateId = new Map(
    plannedProviderCandidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const catalogCandidateIds = new Set(
    resolution.candidates
      .filter((candidate) => candidate.assetRef.disposition === "existing")
      .map((candidate) => candidate.candidateId),
  );
  if (plannedProviderCandidates.some((candidate) =>
    catalogCandidateIds.has(candidate.candidateId))) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  if (
    [...pendingProviderCandidates, ...(activeProviderCandidate === undefined
      ? []
      : [activeProviderCandidate])]
      .some((candidate) => {
        const planned = plannedByCandidateId.get(candidate.candidateId);
        return planned === undefined || !providerCandidateEquivalent(planned, candidate);
      })
  ) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  for (const candidate of resolution.candidates) {
    if (isExistingCatalogCandidate(candidate)) {
      continue;
    }
    const planned = plannedByCandidateId.get(candidate.candidateId);
    if (planned === undefined || !providerCandidateMatchesRef(candidate, planned)) {
      return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
    }
  }
  return createPlan({
    resolution,
    excludedCandidateIds,
    configuredProviderIds,
    plannedProviderCandidates,
    providerAuthorizationAttemptedIds,
    pendingProviderCandidates,
    ...(activeProviderCandidate === undefined ? {} : { activeProviderCandidate }),
    ...(awaitingProviderId === undefined ? {} : { awaitingProviderId }),
    providersExhausted,
    effects: [],
  });
}

function createPlan(input: {
  readonly resolution: ModelResolution;
  readonly excludedCandidateIds?: readonly string[];
  readonly configuredProviderIds?: readonly string[];
  readonly plannedProviderCandidates?: readonly ModelProviderCandidateRef[];
  readonly providerAuthorizationAttemptedIds?: readonly string[];
  readonly pendingProviderCandidates?: readonly ModelProviderCandidateRef[];
  readonly activeProviderCandidate?: ModelProviderCandidateRef;
  readonly awaitingProviderId?: string;
  readonly providersExhausted?: boolean;
  readonly effects?: readonly ModelResolutionEffect[];
}): ModelResolutionWorkflowPlan {
  return deepFreeze({
    resolution: input.resolution,
    excludedCandidateIds: [...(input.excludedCandidateIds ?? [])],
    configuredProviderIds: [...(input.configuredProviderIds ?? [])],
    plannedProviderCandidates: [...(input.plannedProviderCandidates ?? [])],
    providerAuthorizationAttemptedIds: [...(input.providerAuthorizationAttemptedIds ?? [])],
    pendingProviderCandidates: [...(input.pendingProviderCandidates ?? [])],
    ...(input.activeProviderCandidate === undefined
      ? {}
      : { activeProviderCandidate: input.activeProviderCandidate }),
    ...(input.awaitingProviderId === undefined
      ? {}
      : { awaitingProviderId: input.awaitingProviderId }),
    providersExhausted: input.providersExhausted ?? false,
    effects: [...(input.effects ?? [])],
  });
}

function createPlanFrom(
  previous: ModelResolutionWorkflowPlan,
  input: Parameters<typeof createPlan>[0],
): ModelResolutionWorkflowPlan {
  return createPlan({
    configuredProviderIds: previous.configuredProviderIds,
    plannedProviderCandidates: previous.plannedProviderCandidates,
    providerAuthorizationAttemptedIds: previous.providerAuthorizationAttemptedIds,
    providersExhausted: previous.providersExhausted,
    ...input,
  });
}

function updateResolution(
  resolution: ModelResolution,
  state: ModelResolutionState,
  occurredAt: string,
  patch: Partial<Omit<ModelResolution, "state" | "updatedAt">> = {},
): ModelResolution {
  const updatedAt = requiredTimestamp(occurredAt, resolution.updatedAt);
  if (state !== resolution.state) {
    assertModelResolutionTransition(resolution.state, state);
  }
  return canonicalResolution({
    ...resolution,
    ...patch,
    state,
    updatedAt,
  });
}

function requireState(
  resolution: ModelResolution,
  states: readonly ModelResolutionState[],
): void {
  if (!states.includes(resolution.state)) {
    planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT);
  }
}

function assertNoOutstandingProviderWork(plan: ModelResolutionWorkflowPlan): void {
  if (plan.pendingProviderCandidates.length > 0 || plan.activeProviderCandidate !== undefined) {
    planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT);
  }
}

function mergeCandidates(
  existing: readonly ModelCandidate[],
  incoming: unknown,
  excludedCandidateIds: readonly string[],
  replaceCandidateId?: string,
): readonly ModelCandidate[] {
  if (!Array.isArray(incoming)) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  const byId = new Map(existing.map((candidate) => [candidate.candidateId, candidate]));
  for (const value of incoming) {
    const candidate = canonicalCandidate(value);
    if (excludedCandidateIds.includes(candidate.candidateId)) {
      continue;
    }
    const current = byId.get(candidate.candidateId);
    if (
      current !== undefined
      && candidate.candidateId !== replaceCandidateId
      && JSON.stringify(current) !== JSON.stringify(candidate)
    ) {
      planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
    }
    byId.set(candidate.candidateId, candidate);
  }
  return Object.freeze(
    [...byId.values()].sort((left, right) => compareTokens(left.candidateId, right.candidateId)),
  );
}

function bestConfirmableCandidate(candidates: readonly ModelCandidate[]): ModelCandidate | undefined {
  const assuranceRank = { high: 2, low: 1, none: 0 } as const;
  return [...candidates]
    .filter(isModelCandidateConfirmable)
    .sort((left, right) =>
      assuranceRank[right.match.assurance] - assuranceRank[left.match.assurance]
      || right.match.score - left.match.score
      || compareTokens(left.candidateId, right.candidateId))[0];
}

function humanConfirmationEffect(candidate: ModelCandidate): ModelResolutionEffect {
  return deepFreeze({
    kind: "request-human-confirmation",
    candidate,
    semanticRiskAcceptanceRequired: candidate.match.assurance === "low",
  });
}

function downloadEffect(candidates: readonly ModelProviderCandidateRef[]): readonly ModelResolutionEffect[] {
  return candidates.length === 0
    ? Object.freeze([])
    : Object.freeze([deepFreeze({
        kind: "download-provider-candidates" as const,
        candidates: [...candidates],
        maxDownloads: MODEL_RESOLUTION_DOWNLOAD_LIMIT,
      })]);
}

function finishProviderExhaustion(
  plan: ModelResolutionWorkflowPlan,
  occurredAt: string,
  questionsInput?: readonly string[],
  candidatesInput: readonly ModelCandidate[] = plan.resolution.candidates,
): ModelResolutionWorkflowPlan {
  assertNoOutstandingProviderWork(plan);
  const questions = questionsInput === undefined
    ? plan.resolution.refinementQuestions
    : normalizeQuestions(questionsInput);
  const bestCandidate = bestConfirmableCandidate(candidatesInput);
  if (bestCandidate !== undefined) {
    if (bestCandidate.match.assurance === "low" && questions.length === 0) {
      return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
    }
    const resolution = updateResolution(plan.resolution, "awaiting-confirmation", occurredAt, {
      candidates: candidatesInput,
      bestCandidate,
      refinementQuestions: bestCandidate.match.assurance === "low" ? questions : [],
    });
    return createPlanFrom(plan, {
      resolution,
      excludedCandidateIds: plan.excludedCandidateIds,
      providersExhausted: true,
      effects: [humanConfirmationEffect(bestCandidate)],
    });
  }
  const resolution = updateResolution(plan.resolution, "unresolved", occurredAt, {
    candidates: candidatesInput,
    bestCandidate: undefined,
    refinementQuestions: questions,
    stateReasonCode: "provider-and-generator-exhausted",
  });
  return createPlanFrom(plan, {
    resolution,
    excludedCandidateIds: plan.excludedCandidateIds,
    providersExhausted: true,
    effects: [{
      kind: "generator-disabled",
      reasonCode: MODEL_GENERATOR_DISABLED_REASON_CODE,
    }],
  });
}

function continueProviderResolution(
  plan: ModelResolutionWorkflowPlan,
  occurredAt: string,
  candidates: readonly ModelCandidate[],
  questions: readonly string[],
): ModelResolutionWorkflowPlan {
  const bestCandidate = bestConfirmableCandidate(candidates);
  const resolution = updateResolution(plan.resolution, "searching-providers", occurredAt, {
    candidates,
    ...(bestCandidate === undefined ? { bestCandidate: undefined } : { bestCandidate }),
    refinementQuestions: questions,
  });
  return createPlanFrom(plan, {
    resolution,
    excludedCandidateIds: plan.excludedCandidateIds,
    pendingProviderCandidates: plan.pendingProviderCandidates,
    providersExhausted: false,
    effects: [],
  });
}

function normalizedRequestFingerprint(request: ModelRequestSpec): string {
  const sort = (value: readonly string[] | undefined): readonly string[] | undefined =>
    value === undefined ? undefined : [...value].sort();
  return JSON.stringify({
    policyProfileId: request.policyProfileId,
    query: request.query,
    locale: request.locale,
    rankerId: request.rankerId,
    hardConstraints: request.hardConstraints,
    softPreferences: {
      ...request.softPreferences,
      materials: sort(request.softPreferences.materials),
      colors: sort(request.softPreferences.colors),
      tags: sort(request.softPreferences.tags),
    },
    exclusions: sort(request.exclusions),
  });
}

/** Return whether a canonical model-resolution state transition is legal. */
export function canTransitionModelResolution(from: unknown, to: unknown): boolean {
  return isModelResolutionState(from)
    && isModelResolutionState(to)
    && TRANSITIONS[from].includes(to);
}

/** Assert and freeze one legal model-resolution state transition. */
export function assertModelResolutionTransition(
  from: ModelResolutionState,
  to: ModelResolutionState,
): ModelResolutionTransition {
  if (!isModelResolutionState(from) || !isModelResolutionState(to)) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_STATE);
  }
  if (!canTransitionModelResolution(from, to)) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_TRANSITION);
  }
  return Object.freeze({ from, to });
}

/** Create revision zero and plan promoted-catalog search as its only first effect. */
export function createModelResolutionWorkflowPlan(
  input: CreateModelResolutionWorkflowPlanInput,
): ModelResolutionWorkflowPlan {
  if (input === null || typeof input !== "object") {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  const request = canonicalRequest(input.request);
  if (request.revision !== 0) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.RETRY_REVISION_MISMATCH);
  }
  const createdAt = requiredTimestamp(input.createdAt);
  const resolution = canonicalResolution({
    resolutionId: requiredModelPathSegment(input.resolutionId),
    request,
    attempts: 1,
    state: "searching-catalog",
    candidates: [],
    refinementQuestions: [],
    createdAt,
    updatedAt: createdAt,
  });
  return createPlan({
    resolution,
    effects: [{ kind: "search-catalog", request, excludedCandidateIds: [] }],
  });
}

/** Reduce one completed external event into a canonical state and the next pure effects. */
export function planModelResolutionEvent(
  inputPlan: ModelResolutionWorkflowPlan,
  event: ModelResolutionEvent,
): ModelResolutionWorkflowPlan {
  const plan = readPlan(inputPlan);
  if (MODEL_RESOLUTION_TERMINAL_STATES.includes(
    plan.resolution.state as typeof MODEL_RESOLUTION_TERMINAL_STATES[number],
  )) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.TERMINAL_STATE);
  }
  if (event === null || typeof event !== "object") {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT);
  }
  const occurredAt = requiredTimestamp(event.occurredAt, plan.resolution.updatedAt);

  switch (event.type) {
    case "catalog-search-completed": {
      requireState(plan.resolution, ["searching-catalog"]);
      if (!Array.isArray(event.providerIds)) {
        return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
      }
      if (event.providerIds.length > MODEL_RESOLUTION_PROVIDER_LIMIT) {
        return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.PROVIDER_LIMIT_EXCEEDED);
      }
      const providerIds = normalizeTokenList(event.providerIds, MODEL_RESOLUTION_PROVIDER_LIMIT);
      const questions = normalizeQuestions(event.refinementQuestions);
      const catalogCandidates = normalizeCatalogCandidates(event.candidates);
      const candidates = mergeCandidates(
        plan.resolution.candidates,
        catalogCandidates,
        plan.excludedCandidateIds,
      );
      const bestCandidate = bestConfirmableCandidate(candidates);
      if (bestCandidate?.match.assurance === "high") {
        const resolution = updateResolution(plan.resolution, "awaiting-confirmation", occurredAt, {
          candidates,
          bestCandidate,
          refinementQuestions: [],
        });
        return createPlan({
          resolution,
          excludedCandidateIds: plan.excludedCandidateIds,
          configuredProviderIds: providerIds,
          effects: [humanConfirmationEffect(bestCandidate)],
        });
      }
      const searchingResolution = updateResolution(plan.resolution, "searching-providers", occurredAt, {
        candidates,
        ...(bestCandidate === undefined ? {} : { bestCandidate }),
        refinementQuestions: questions,
      });
      const searchingPlan = createPlan({
        resolution: searchingResolution,
        excludedCandidateIds: plan.excludedCandidateIds,
        configuredProviderIds: providerIds,
      });
      if (providerIds.length === 0) {
        return finishProviderExhaustion(searchingPlan, occurredAt, questions, candidates);
      }
      return createPlan({
        resolution: searchingResolution,
        excludedCandidateIds: plan.excludedCandidateIds,
        configuredProviderIds: providerIds,
        effects: [{
          kind: "search-providers",
          request: searchingResolution.request,
          providerIds,
          maxConcurrency: MODEL_RESOLUTION_PROVIDER_LIMIT,
          excludedCandidateIds: plan.excludedCandidateIds,
        }],
      });
    }

    case "provider-search-completed": {
      requireState(plan.resolution, ["searching-providers"]);
      assertNoOutstandingProviderWork(plan);
      const questions = event.refinementQuestions === undefined
        ? plan.resolution.refinementQuestions
        : normalizeQuestions(event.refinementQuestions);
      const rankedInput = normalizeProviderCandidates(event.rankedCandidates);
      if (rankedInput.some((candidate) =>
        !plan.configuredProviderIds.includes(candidate.providerId))) {
        return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT);
      }
      const plannedCandidateIds = new Set(
        plan.plannedProviderCandidates.map((candidate) => candidate.candidateId),
      );
      const knownCandidateIds = new Set(
        plan.resolution.candidates.map((candidate) => candidate.candidateId),
      );
      if (rankedInput.some((candidate) =>
        plannedCandidateIds.has(candidate.candidateId)
        || knownCandidateIds.has(candidate.candidateId))) {
        return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT);
      }
      const remainingDownloads = MODEL_RESOLUTION_DOWNLOAD_LIMIT
        - plan.plannedProviderCandidates.length;
      const ranked = rankedInput.filter((candidate) =>
        !plan.excludedCandidateIds.includes(candidate.candidateId)
      );
      const pendingProviderCandidates = Object.freeze(
        ranked.slice(0, remainingDownloads),
      );
      const resolution = updateResolution(plan.resolution, "searching-providers", occurredAt, {
        refinementQuestions: questions,
      });
      if (pendingProviderCandidates.length === 0) {
        return finishProviderExhaustion(
          createPlanFrom(plan, { resolution, excludedCandidateIds: plan.excludedCandidateIds }),
          occurredAt,
          questions,
        );
      }
      return createPlanFrom(plan, {
        resolution,
        excludedCandidateIds: plan.excludedCandidateIds,
        plannedProviderCandidates: [
          ...plan.plannedProviderCandidates,
          ...pendingProviderCandidates,
        ],
        pendingProviderCandidates,
        providersExhausted: false,
        effects: downloadEffect(pendingProviderCandidates),
      });
    }

    case "provider-auth-required": {
      requireState(plan.resolution, ["searching-providers"]);
      assertNoOutstandingProviderWork(plan);
      const providerId = requiredToken(event.providerId);
      if (
        !plan.configuredProviderIds.includes(providerId)
        || plan.providerAuthorizationAttemptedIds.includes(providerId)
      ) {
        return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT);
      }
      const resolution = updateResolution(plan.resolution, "awaiting-provider-auth", occurredAt);
      return createPlanFrom(plan, {
        resolution,
        excludedCandidateIds: plan.excludedCandidateIds,
        providerAuthorizationAttemptedIds: [
          ...plan.providerAuthorizationAttemptedIds,
          providerId,
        ].sort(),
        awaitingProviderId: providerId,
        effects: [{ kind: "request-provider-authorization", providerId }],
      });
    }

    case "provider-auth-resumed": {
      requireState(plan.resolution, ["awaiting-provider-auth"]);
      const providerId = requiredToken(event.providerId);
      if (providerId !== plan.awaitingProviderId) {
        return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT);
      }
      const resolution = updateResolution(plan.resolution, "searching-providers", occurredAt);
      return createPlanFrom(plan, {
        resolution,
        excludedCandidateIds: plan.excludedCandidateIds,
        effects: [{
          kind: "search-providers",
          request: resolution.request,
          providerIds: [providerId],
          maxConcurrency: MODEL_RESOLUTION_PROVIDER_LIMIT,
          excludedCandidateIds: plan.excludedCandidateIds,
        }],
      });
    }

    case "provider-download-ready": {
      requireState(plan.resolution, ["searching-providers"]);
      if (plan.activeProviderCandidate !== undefined) {
        return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT);
      }
      const candidate = normalizeProviderCandidate(event.candidate);
      const queued = plan.pendingProviderCandidates.find((value) =>
        providerCandidateEquivalent(value, candidate));
      if (queued === undefined) {
        return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT);
      }
      const pendingProviderCandidates = plan.pendingProviderCandidates.filter(
        (value) => value.candidateId !== candidate.candidateId,
      );
      const resolution = updateResolution(plan.resolution, "quarantining", occurredAt);
      return createPlanFrom(plan, {
        resolution,
        excludedCandidateIds: plan.excludedCandidateIds,
        pendingProviderCandidates,
        activeProviderCandidate: candidate,
        effects: [{ kind: "quarantine-provider-candidate", candidate }],
      });
    }

    case "quarantine-completed":
    case "processing-completed":
    case "rendering-completed": {
      const policy = {
        "quarantine-completed": {
          from: "quarantining",
          to: "processing",
          effect: "process-model-candidate",
        },
        "processing-completed": {
          from: "processing",
          to: "rendering",
          effect: "render-model-candidate",
        },
        "rendering-completed": {
          from: "rendering",
          to: "evaluating",
          effect: "evaluate-model-candidate",
        },
      } as const;
      const selected = policy[event.type];
      requireState(plan.resolution, [selected.from]);
      const candidateId = requiredModelPathSegment(event.candidateId);
      if (plan.activeProviderCandidate?.candidateId !== candidateId) {
        return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT);
      }
      const resolution = updateResolution(plan.resolution, selected.to, occurredAt);
      return createPlanFrom(plan, {
        resolution,
        excludedCandidateIds: plan.excludedCandidateIds,
        pendingProviderCandidates: plan.pendingProviderCandidates,
        activeProviderCandidate: plan.activeProviderCandidate,
        effects: [{ kind: selected.effect, candidate: plan.activeProviderCandidate }],
      });
    }

    case "candidate-evaluated": {
      requireState(plan.resolution, ["evaluating"]);
      if (typeof event.providersExhausted !== "boolean") {
        return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
      }
      const candidate = canonicalCandidate(event.candidate);
      if (
        plan.activeProviderCandidate === undefined
        || !providerCandidateMatchesRef(candidate, plan.activeProviderCandidate)
      ) {
        return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT);
      }
      if (event.providersExhausted && plan.pendingProviderCandidates.length > 0) {
        return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT);
      }
      const questions = event.refinementQuestions === undefined
        ? plan.resolution.refinementQuestions
        : normalizeQuestions(event.refinementQuestions);
      const candidates = mergeCandidates(
        plan.resolution.candidates,
        [candidate],
        plan.excludedCandidateIds,
      );
      if (candidate.rights.status === "quarantined") {
        const resolution = updateResolution(plan.resolution, "awaiting-rights-review", occurredAt, {
          candidates,
          refinementQuestions: questions,
        });
        return createPlanFrom(plan, {
          resolution,
          excludedCandidateIds: plan.excludedCandidateIds,
          pendingProviderCandidates: plan.pendingProviderCandidates,
          activeProviderCandidate: plan.activeProviderCandidate,
          providersExhausted: event.providersExhausted,
          effects: [{ kind: "request-rights-review", candidate }],
        });
      }
      const bestCandidate = bestConfirmableCandidate(candidates);
      if (bestCandidate?.match.assurance === "high") {
        const resolution = updateResolution(plan.resolution, "awaiting-confirmation", occurredAt, {
          candidates,
          bestCandidate,
          refinementQuestions: [],
        });
        return createPlanFrom(plan, {
          resolution,
          excludedCandidateIds: plan.excludedCandidateIds,
          providersExhausted: event.providersExhausted,
          effects: [humanConfirmationEffect(bestCandidate)],
        });
      }
      const cleared = createPlanFrom(plan, {
        resolution: plan.resolution,
        excludedCandidateIds: plan.excludedCandidateIds,
        pendingProviderCandidates: plan.pendingProviderCandidates,
        providersExhausted: event.providersExhausted,
      });
      if (event.providersExhausted) {
        return finishProviderExhaustion(cleared, occurredAt, questions, candidates);
      }
      return continueProviderResolution(cleared, occurredAt, candidates, questions);
    }

    case "rights-review-completed": {
      requireState(plan.resolution, ["awaiting-rights-review"]);
      if (typeof event.providersExhausted !== "boolean") {
        return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
      }
      const candidate = canonicalCandidate(event.candidate);
      const currentCandidate = plan.resolution.candidates.find(
        (value) => value.candidateId === candidate.candidateId,
      );
      if (
        plan.activeProviderCandidate === undefined
        || !providerCandidateMatchesRef(candidate, plan.activeProviderCandidate)
        || currentCandidate === undefined
        || currentCandidate.rights.status !== "quarantined"
        || candidate.rights.status === "quarantined"
        || rightsStableProjection(currentCandidate) !== rightsStableProjection(candidate)
        || candidate.rights.policyId !== currentCandidate.rights.policyId
        || candidate.rights.policyVersion !== currentCandidate.rights.policyVersion
        || candidate.rights.decisionId === currentCandidate.rights.decisionId
        || candidate.rights.decisionToken === currentCandidate.rights.decisionToken
        || candidate.confirmationToken === currentCandidate.confirmationToken
        || event.providersExhausted !== plan.providersExhausted
      ) {
        return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT);
      }
      if (Date.parse(candidate.rights.reviewedAt) <= Date.parse(currentCandidate.rights.reviewedAt)) {
        return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_TIMESTAMP);
      }
      if (plan.providersExhausted && plan.pendingProviderCandidates.length > 0) {
        return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT);
      }
      const questions = event.refinementQuestions === undefined
        ? plan.resolution.refinementQuestions
        : normalizeQuestions(event.refinementQuestions);
      const candidates = mergeCandidates(
        plan.resolution.candidates,
        [candidate],
        plan.excludedCandidateIds,
        candidate.candidateId,
      );
      const bestCandidate = bestConfirmableCandidate(candidates);
      if (bestCandidate?.match.assurance === "high") {
        const resolution = updateResolution(plan.resolution, "awaiting-confirmation", occurredAt, {
          candidates,
          bestCandidate,
          refinementQuestions: [],
        });
        return createPlanFrom(plan, {
          resolution,
          excludedCandidateIds: plan.excludedCandidateIds,
          providersExhausted: plan.providersExhausted,
          effects: [humanConfirmationEffect(bestCandidate)],
        });
      }
      const cleared = createPlanFrom(plan, {
        resolution: plan.resolution,
        excludedCandidateIds: plan.excludedCandidateIds,
        pendingProviderCandidates: plan.pendingProviderCandidates,
        providersExhausted: plan.providersExhausted,
      });
      if (plan.providersExhausted) {
        return finishProviderExhaustion(cleared, occurredAt, questions, candidates);
      }
      return continueProviderResolution(cleared, occurredAt, candidates, questions);
    }

    case "providers-exhausted": {
      requireState(plan.resolution, ["searching-providers", "evaluating"]);
      return finishProviderExhaustion(plan, occurredAt, event.refinementQuestions);
    }

    case "candidate-confirmed": {
      requireState(plan.resolution, ["awaiting-confirmation"]);
      const candidate = plan.resolution.bestCandidate;
      if (candidate === undefined) {
        return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT);
      }
      const confirmation = canonical(() => createModelCandidateConfirmation(
        event.confirmation,
        candidate,
        plan.resolution.resolutionId,
      ));
      if (Date.parse(occurredAt) < Date.parse(confirmation.confirmedAt)) {
        return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_TIMESTAMP);
      }
      if (candidate.assetRef.disposition === "existing") {
        const finalAssetRef = candidate.assetRef.asset;
        const resolution = updateResolution(plan.resolution, "completed", occurredAt, {
          confirmation,
          finalAssetRef,
          refinementQuestions: plan.resolution.refinementQuestions,
        });
        return createPlanFrom(plan, {
          resolution,
          excludedCandidateIds: plan.excludedCandidateIds,
          effects: [{
            kind: "select-existing-catalog-candidate",
            candidate,
            confirmation,
            finalAssetRef,
          }],
        });
      }
      const resolution = updateResolution(plan.resolution, "promoting", occurredAt, {
        confirmation,
      });
      return createPlanFrom(plan, {
        resolution,
        excludedCandidateIds: plan.excludedCandidateIds,
        effects: [{ kind: "promote-model-candidate", candidate, confirmation }],
      });
    }

    case "promotion-completed": {
      requireState(plan.resolution, ["promoting"]);
      const resolution = updateResolution(plan.resolution, "completed", occurredAt, {
        finalAssetRef: event.finalAssetRef,
        promotionReceipt: event.promotionReceipt,
      });
      return createPlanFrom(plan, { resolution, excludedCandidateIds: plan.excludedCandidateIds });
    }

    case "failed": {
      const reasonCode = requiredToken(event.reasonCode);
      const resolution = updateResolution(plan.resolution, "failed", occurredAt, {
        stateReasonCode: reasonCode,
      });
      return createPlanFrom(plan, { resolution, excludedCandidateIds: plan.excludedCandidateIds });
    }

    default:
      return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_EVENT);
  }
}

/** Plan idempotent cancellation while preserving promotion atomicity. */
export function planModelResolutionCancellation(
  inputPlan: ModelResolutionWorkflowPlan,
  input: PlanModelResolutionCancellationInput,
): ModelResolutionWorkflowPlan {
  const plan = readPlan(inputPlan);
  if (input === null || typeof input !== "object") {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  if (plan.resolution.state === "cancelled") {
    return createPlanFrom(plan, {
      resolution: plan.resolution,
      excludedCandidateIds: plan.excludedCandidateIds,
    });
  }
  if (plan.resolution.state === "promoting") {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.PROMOTION_IN_PROGRESS);
  }
  if (MODEL_RESOLUTION_TERMINAL_STATES.includes(
    plan.resolution.state as typeof MODEL_RESOLUTION_TERMINAL_STATES[number],
  )) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.TERMINAL_STATE);
  }
  if (!MODEL_RESOLUTION_CANCELLABLE_STATES.includes(
    plan.resolution.state as typeof MODEL_RESOLUTION_CANCELLABLE_STATES[number],
  )) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_STATE);
  }
  const reasonCode = requiredToken(input.reasonCode);
  const fromState = plan.resolution.state;
  const resolution = updateResolution(plan.resolution, "cancelled", input.cancelledAt, {
    stateReasonCode: reasonCode,
  });
  return createPlanFrom(plan, {
    resolution,
    excludedCandidateIds: plan.excludedCandidateIds,
    effects: [{ kind: "cancel-resolution-work", fromState, reasonCode }],
  });
}

/** Create a new immutable request revision without changing the prior terminal/rejected record. */
export function planModelResolutionRetry(
  inputPlan: ModelResolutionWorkflowPlan,
  input: PlanModelResolutionRetryInput,
): ModelResolutionWorkflowPlan {
  const plan = readPlan(inputPlan);
  if (input === null || typeof input !== "object") {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  const current = plan.resolution;
  const retryableState = current.state === "awaiting-confirmation"
    || current.state === "unresolved"
    || (current.state === "failed" && current.confirmation === undefined);
  if (!retryableState) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.RETRY_NOT_ALLOWED);
  }
  if (current.request.revision >= MODEL_REQUEST_MAX_REVISION) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.RETRY_REVISION_LIMIT);
  }
  const request = canonicalRequest(input.request);
  if (request.revision !== current.request.revision + 1) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.RETRY_REVISION_MISMATCH);
  }
  const rejectedCandidateIds = normalizeCandidateIdList(input.rejectedCandidateIds);
  const knownCandidateIds = new Set([
    ...plan.excludedCandidateIds,
    ...current.candidates.map((candidate) => candidate.candidateId),
  ]);
  if (rejectedCandidateIds.some((candidateId) => !knownCandidateIds.has(candidateId))) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.INVALID_INPUT);
  }
  if (
    current.state === "awaiting-confirmation"
    && (
      current.bestCandidate === undefined
      || !rejectedCandidateIds.includes(current.bestCandidate.candidateId)
    )
  ) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.CANDIDATE_REJECTION_REQUIRED);
  }
  const combinedRejectedCandidateIds = normalizeCandidateIdList([
    ...plan.excludedCandidateIds,
    ...rejectedCandidateIds.filter((candidateId) => !plan.excludedCandidateIds.includes(candidateId)),
  ]);
  const rejectionChanged = combinedRejectedCandidateIds.length > plan.excludedCandidateIds.length;
  const requestChanged = normalizedRequestFingerprint(request)
    !== normalizedRequestFingerprint(current.request);
  if (!rejectionChanged && !requestChanged) {
    return planningError(MODEL_RESOLUTION_PLANNING_ERROR_CODES.RETRY_REFINEMENT_REQUIRED);
  }
  const createdAt = requiredTimestamp(input.createdAt, current.updatedAt);
  const resolution = canonicalResolution({
    resolutionId: current.resolutionId,
    request,
    attempts: current.attempts + 1,
    state: "searching-catalog",
    candidates: [],
    refinementQuestions: [],
    createdAt,
    updatedAt: createdAt,
  });
  return createPlan({
    resolution,
    excludedCandidateIds: combinedRejectedCandidateIds,
    effects: [{
      kind: "search-catalog",
      request,
      excludedCandidateIds: combinedRejectedCandidateIds,
      supersedesRevision: current.request.revision,
    }],
  });
}
