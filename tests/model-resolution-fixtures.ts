import {
  MODEL_CANDIDATE_HARD_GATE_KINDS,
  MODEL_CONFIRMATION_VIEW_KINDS,
  createModelAssetRef,
  createModelCandidate,
  createModelCandidateConfirmation,
  createModelRequestSpec,
  evaluateModelHardConstraintsForProfile,
  type ModelAssetRef,
  type ModelCandidate,
  type ModelCandidateConfirmation,
  type ModelMatchAssurance,
  type ModelPromotionReceipt,
  type ModelRequestSpec,
  type ModelRightsStatus,
} from "@plasius/asset-contracts";

export const INITIAL_AT = "2026-07-13T12:00:00.000Z";
export const EVIDENCE_AT = "2026-07-13T12:05:00.000Z";
export const RENDERED_AT = "2026-07-13T12:06:00.000Z";
export const CONFIRMED_AT = "2026-07-13T12:10:00.000Z";

const hash = (character: string): string => character.repeat(64);

const catalogAssetId = (candidateId: string): string => `asset-${candidateId
  .replaceAll("_", "-underscore-")
  .replaceAll(".", "-dot-")
  .replaceAll("~", "-tilde-")}`;

export function createRequest(
  revision = 0,
  overrides: {
    readonly query?: string;
    readonly exclusions?: readonly string[];
    readonly maxTriangles?: number;
  } = {},
): ModelRequestSpec {
  return createModelRequestSpec({
    query: overrides.query ?? "weathered oak dining chair",
    revision,
    locale: "en-GB",
    rankerId: "model-ranker",
    hardConstraints: {
      ...(overrides.maxTriangles === undefined
        ? {}
        : { maxTriangles: overrides.maxTriangles }),
      collision: "optional",
      lod: "optional",
      partition: "allowed",
    },
    softPreferences: {
      category: "furniture",
      style: "rustic",
      materials: ["oak"],
      tags: ["dining"],
    },
    exclusions: overrides.exclusions ?? [],
  });
}

const technicalProfile = Object.freeze({
  boundsMetres: {
    min: [-0.5, 0, -0.5] as const,
    max: [0.5, 1, 0.5] as const,
  },
  dimensionsMetres: {
    width: 1,
    height: 1,
    depth: 1,
  },
  triangleCount: 1_000,
  byteLength: 10_000,
  textureByteLength: 1_000,
  maxTextureDimensionPx: 1_024,
  lodCount: 1,
  hasCollision: false,
  partitionCount: 1,
  partitionCellMetres: 1,
});

export function createCandidate(options: {
  readonly resolutionId?: string;
  readonly request?: ModelRequestSpec;
  readonly candidateId?: string;
  readonly assurance?: ModelMatchAssurance;
  readonly disposition?: "existing" | "proposed";
  readonly rightsStatus?: ModelRightsStatus;
  readonly blockedHardGate?: boolean;
  readonly providerId?: string;
  readonly sourceAssetId?: string;
} = {}): ModelCandidate {
  const resolutionId = options.resolutionId ?? "resolution-1";
  const request = options.request ?? createRequest();
  const candidateId = options.candidateId ?? "candidate-1";
  const disposition = options.disposition ?? "existing";
  const assurance = options.assurance ?? "high";
  const rightsStatus = options.rightsStatus ?? "allowed";
  const providerId = options.providerId ?? "polyhaven";
  const sourceAssetId = options.sourceAssetId ?? `source-${candidateId}`;
  const contentHash = hash("a");
  const sourceHash = hash("b");
  const evaluation = evaluateModelHardConstraintsForProfile(request, technicalProfile);
  const score = assurance === "high" ? 0.9 : assurance === "low" ? 0.6 : 0.2;
  const views = MODEL_CONFIRMATION_VIEW_KINDS.map((kind, index) => ({
    kind,
    imageUri: `mcp://models/resolutions/${resolutionId}/candidates/${candidateId}/${kind}.png`,
    sha256: hash(String(index + 1)),
    contentType: "image/png" as const,
    width: 1_024 as const,
    height: 1_024 as const,
  }));
  const assetId = catalogAssetId(candidateId);
  const existingAsset = createModelAssetRef({
    assetId,
    version: "1.0.0",
    kind: "leaf",
    contentHash,
    runtimeManifestUri: `mcp://models/catalog/${assetId}/versions/1.0.0/manifest`,
  });

  return createModelCandidate({
    resolutionId,
    candidateId,
    assetRef: disposition === "existing"
      ? {
          disposition,
          kind: "leaf",
          contentHash,
          asset: existingAsset,
        }
      : {
          disposition,
          kind: "leaf",
          contentHash,
          proposalId: `proposal-${candidateId}`,
        },
    match: {
      score,
      hardConstraintPass: evaluation.pass,
      exactMatch: false,
      reasonCodes: evaluation.reasonCodes,
      ranker: {
        id: "model-ranker",
        version: "1.0.0",
        calibrationId: "model-match-golden",
        calibrationVersion: "1.0.0",
        evidenceMode: "multimodal",
        assuranceCeiling: "high",
      },
      fidelityWarnings: [],
      request,
      candidateId,
      candidateContentHash: contentHash,
    },
    provenance: {
      kind: disposition === "existing" ? "catalog" : "provider",
      sourceId: disposition === "existing" ? "catalog" : providerId,
      sourceAssetId,
      ...(disposition === "existing"
        ? {}
        : { sourcePageUri: `https://models.example.com/${providerId}/${sourceAssetId}` }),
      contentHash: sourceHash,
      capturedAt: EVIDENCE_AT,
    },
    rights: {
      decisionId: `rights-${candidateId}`,
      decisionToken: `rights_decision_${candidateId}_0123456789abcdef`,
      policyId: "catalog-rights-v1",
      policyVersion: "1.0.0",
      sourceId: disposition === "existing" ? "catalog" : providerId,
      sourceAssetId,
      sourceContentHash: sourceHash,
      status: rightsStatus,
      licenseId: rightsStatus === "quarantined" ? "unknown" : "CC0-1.0",
      evidencePageUri: disposition === "existing"
        ? "https://plasius.co.uk/recognitions"
        : `https://models.example.com/${providerId}/license`,
      reviewedAt: EVIDENCE_AT,
    },
    technicalProfile,
    processingManifest: {
      manifestId: `manifest-${candidateId}`,
      resolutionId,
      candidateId,
      kind: "leaf",
      contentHash,
      closureHash: contentHash,
      technicalProfile,
      lods: [{
        level: 0,
        resource: {
          uri: `mcp://models/resolutions/${resolutionId}/candidates/${candidateId}/lod0.glb`,
          byteLength: technicalProfile.byteLength,
          sha256: contentHash,
          contentType: "model/gltf-binary",
        },
        triangleCount: technicalProfile.triangleCount,
        geometricErrorMetres: 0,
      }],
      collision: { kind: "none" },
      collisionPolicy: {
        profileId: "static-world-collision",
        profileVersion: "1.0.0",
        disposition: "none-allowed",
        category: "furniture",
        decisionToken: `collision_policy_${candidateId}_0123456789abcdef`,
      },
      children: [],
      converter: {
        id: "canonical-gltf",
        version: "1.0.0",
        sourceFormat: "glb",
        targetFormat: "glb",
        sourceContentHash: sourceHash,
        outputContentHash: contentHash,
        diagnostics: [],
        losses: [],
      },
      fidelityEvidence: ["geometry", "materials", "textures"].map((aspect) => ({
        aspect,
        outcome: "preserved",
        message: `${aspect} passed deterministic fidelity review.`,
      })),
      fidelityGate: {
        profileId: "static-world-fidelity",
        profileVersion: "1.0.0",
        outcome: "passed",
        requiredAspects: ["geometry", "materials", "textures"],
        evaluatedAt: EVIDENCE_AT,
        decisionToken: `fidelity_gate_${candidateId}_0123456789abcdef`,
      },
      processedAt: EVIDENCE_AT,
    },
    views,
    renderEvidence: {
      renderId: `render-${candidateId}`,
      rendererId: "plasius-runtime-renderer",
      rendererVersion: "1.0.0",
      settingsId: "canonical-four-view",
      settingsVersion: "1.0.0",
      processingManifestId: `manifest-${candidateId}`,
      sourceContentHash: contentHash,
      viewSha256s: views.map((view) => view.sha256),
      renderedAt: RENDERED_AT,
      attestationToken: `render_attestation_${candidateId}_0123456789abcdef`,
    },
    hardGates: MODEL_CANDIDATE_HARD_GATE_KINDS.map((kind, index) => ({
      kind,
      outcome: options.blockedHardGate && index === 0 ? "blocked" : "passed",
      validatorId: `${kind}-validator`,
      validatorVersion: "1.0.0",
      subjectContentHash: kind === "malware-scan" ? sourceHash : contentHash,
      reasonCodes: options.blockedHardGate && index === 0 ? ["malware-detected"] : [],
      evaluatedAt: EVIDENCE_AT,
      attestationToken: `hard_gate_${index}_${candidateId}_0123456789abcdef`,
    })),
    confirmationToken: `confirmation_${candidateId}_0123456789abcdef`,
  });
}

export function createPromotedProviderCatalogCandidate(reference: {
  readonly providerId: string;
  readonly sourceAssetId: string;
  readonly candidateId: string;
}): ModelCandidate {
  const staged = createCandidate({
    candidateId: reference.candidateId,
    disposition: "proposed",
    providerId: reference.providerId,
    sourceAssetId: reference.sourceAssetId,
  });
  const assetId = catalogAssetId(reference.candidateId);
  const asset = createModelAssetRef({
    assetId,
    version: "1.0.0",
    kind: staged.assetRef.kind,
    contentHash: staged.assetRef.contentHash,
    runtimeManifestUri: `mcp://models/catalog/${assetId}/versions/1.0.0/manifest`,
  });
  return createModelCandidate({
    ...staged,
    assetRef: {
      disposition: "existing",
      kind: staged.assetRef.kind,
      contentHash: staged.assetRef.contentHash,
      asset,
    },
  });
}

export function createRightsReviewedCandidate(
  candidate: ModelCandidate,
  reviewedAt = "2026-07-13T12:14:00.000Z",
): ModelCandidate {
  return createModelCandidate({
    ...candidate,
    rights: {
      ...candidate.rights,
      decisionId: `rights-reviewed-${candidate.candidateId}`,
      decisionToken: `rights_reviewed_${candidate.candidateId}_0123456789abcdef`,
      status: "allowed",
      licenseId: "CC0-1.0",
      reviewedAt,
    },
    confirmationToken: `confirmation_reviewed_${candidate.candidateId}_0123456789abcdef`,
  });
}

export function createConfirmation(
  candidate: ModelCandidate,
  semanticRiskAccepted = candidate.match.assurance === "low",
  confirmedAt = CONFIRMED_AT,
): ModelCandidateConfirmation {
  return createModelCandidateConfirmation({
    confirmationId: `confirmation-${candidate.candidateId}`,
    resolutionId: candidate.resolutionId,
    candidateId: candidate.candidateId,
    confirmationToken: candidate.confirmationToken,
    viewSha256s: candidate.views.map((view) => view.sha256),
    confirmedBy: "requester-1",
    confirmedAt,
    semanticRiskAccepted,
  }, candidate, candidate.resolutionId);
}

export function createPromotion(
  candidate: ModelCandidate,
  confirmation: ModelCandidateConfirmation,
): { readonly finalAssetRef: ModelAssetRef; readonly receipt: ModelPromotionReceipt } {
  const finalAssetRef = createModelAssetRef({
    assetId: `promoted-${candidate.candidateId}`,
    version: "1.0.0",
    kind: candidate.assetRef.kind,
    contentHash: candidate.assetRef.contentHash,
    runtimeManifestUri: `mcp://models/catalog/promoted-${candidate.candidateId}/versions/1.0.0/manifest`,
  });
  return {
    finalAssetRef,
    receipt: {
      contractVersion: candidate.contractVersion,
      promotionId: `promotion-${candidate.candidateId}`,
      resolutionId: candidate.resolutionId,
      candidateId: candidate.candidateId,
      proposalId: candidate.assetRef.disposition === "proposed"
        ? candidate.assetRef.proposalId
        : "not-proposed",
      confirmationId: confirmation.confirmationId,
      processingManifestId: candidate.processingManifest.manifestId,
      processingContentHash: candidate.processingManifest.contentHash,
      closureHash: candidate.processingManifest.closureHash,
      finalAssetRef,
      promotedAt: "2026-07-13T12:15:00.000Z",
      publicationToken: `publication_${candidate.candidateId}_0123456789abcdef`,
    },
  };
}
