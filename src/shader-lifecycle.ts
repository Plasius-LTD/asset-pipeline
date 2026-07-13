import { createHash } from "node:crypto";

import {
  GPU_SHADER_STORE_FEATURE_FLAG,
  GPU_SHADER_STYLE_SELECTION_CAPABILITY,
  assertAssetId,
  assertImmutableAssetVersion,
  createGpuAssetManifest,
  validateGpuAssetFiles,
} from "@plasius/asset-contracts";
import type {
  GpuAssetManifest,
  ModelGpuCompatibilityDescriptor,
  ShaderAssetManifest,
  ShaderStyleProfileAssetManifest,
  ShaderStyleProfileRef,
  ShaderVersionManifest,
  ShaderVersionRef,
  Sha256Hex,
} from "@plasius/asset-contracts";
import {
  SHADER_ADMISSION_CONTRACT_VERSION,
  SHADER_ADMISSION_OPERATIONS,
  revalidateShaderAdmissionReceipt,
} from "@plasius/asset-processing/shader-admission";
import type {
  ShaderAdmissionReceipt,
  ShaderEvidenceCryptographicVerifier,
} from "@plasius/asset-processing/shader-admission";
import {
  canonicalizeGpuContract,
  parseModelGpuCompatibilityDescriptor,
  parseShaderVersionManifest,
} from "@plasius/gpu-shader";

/** Version of the storage-neutral shader lifecycle planning contract. */
export const SHADER_LIFECYCLE_CONTRACT_VERSION = "2026-07-13.v1" as const;

/** Remotely controlled rollout key evaluated by the host, never by this package. */
export const SHADER_LIFECYCLE_FEATURE_FLAG = GPU_SHADER_STORE_FEATURE_FLAG;

/** Capability used only for user-visible style discovery and selection. */
export const SHADER_STYLE_SELECTION_CAPABILITY = GPU_SHADER_STYLE_SELECTION_CAPABILITY;

/** Closed runtime channels accepted by lifecycle planners. */
export const SHADER_RUNTIME_CHANNELS = Object.freeze(["stable", "preview"] as const);
/** Runtime channel accepted by promoted shader and profile catalogs. */
export type ShaderRuntimeChannel = typeof SHADER_RUNTIME_CHANNELS[number];

/** Hard resource limits applied before hashing, iteration, or authority-result expansion. */
export const SHADER_LIFECYCLE_LIMITS = Object.freeze({
  profileFiles: 64,
  profileBytes: 8 * 1_024 * 1_024,
  promotedShaderFiles: 513,
  promotedShaderBytes: 64 * 1_024 * 1_024,
  profileAggregateShaderFiles: 2_048,
  profileAggregateShaderBytes: 256 * 1_024 * 1_024,
  profileAggregateManagedUris: 2_048,
  publicationFiles: 513,
  publicationBytes: 256 * 1_024 * 1_024,
  profileRoles: 64,
  profileInterfaces: 64,
  profileValidationScopes: 64,
  profileSemantics: 512,
  compatibleModels: 4_096,
  compatibleModelSemanticTokens: 65_536,
  rawManifestGraphNodes: 131_072,
  rawManifestGraphDepth: 64,
  rawManifestObjectProperties: 8_192,
  rawManifestGraphProperties: 262_144,
  rawManifestArrayEntries: 65_536,
  rawManifestGraphEdges: 262_144,
  rawManifestTextCharacters: 16_384,
  rawManifestGraphTextCharacters: 4 * 1_024 * 1_024,
  gpuInterfaceModules: 512,
  gpuInterfaceRecords: 4_096,
  gpuInterfaceBindings: 4_096,
  gpuInterfaceEntryPoints: 4_096,
  gpuInterfaceVertexInputs: 4_096,
  gpuInterfaceOverrides: 4_096,
  gpuInterfaceModelAbiEntries: 4_096,
  shaderModules: 512,
  shaderPipelines: 512,
  shaderRenderRolePipelineIds: 4_096,
  shaderPipelineBindGroups: 4_096,
  shaderPipelineBindGroupEntries: 65_536,
  shaderPipelineEntriesPerBindGroup: 4_096,
  shaderPipelineStageConstants: 4_096,
  shaderPipelineStageConstantsAggregate: 65_536,
  shaderEvidenceScopes: 64,
  shaderRequirementFeatures: 512,
  shaderRequirementLimits: 512,
  shaderRequirementFormats: 512,
  inventoryShaders: 4_096,
  inventoryProfiles: 4_096,
  inventoryModelFixtures: 8_192,
  inventoryCompileUnits: 65_536,
  inventoryEdges: 65_536,
  rollbackHistoryEntries: 4_096,
} as const);

/** Stable public failure codes; diagnostics intentionally exclude untrusted details. */
export const SHADER_LIFECYCLE_ERROR_CODES = Object.freeze([
  "invalid-input",
  "admission-revalidation-failed",
  "receipt-incoherent",
  "evidence-incomplete",
  "qualification-context-invalid",
  "approval-invalid",
  "runtime-channel-invalid",
  "catalog-revision-invalid",
  "idempotency-key-invalid",
  "managed-uri-invalid",
  "authority-unavailable",
  "aborted",
  "timeout",
  "profile-invalid",
  "profile-shader-not-promoted",
  "profile-incompatible",
  "requalification-inventory-invalid",
  "rollback-target-invalid",
] as const);
/** Stable bounded error-code union exposed at host boundaries. */
export type ShaderLifecycleErrorCode = typeof SHADER_LIFECYCLE_ERROR_CODES[number];

/** Bounded planning error suitable for API and audit boundaries. */
export class ShaderLifecyclePlanningError extends Error {
  readonly code: ShaderLifecycleErrorCode;

  constructor(code: ShaderLifecycleErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ShaderLifecyclePlanningError";
    this.code = code;
  }
}

const ERROR_MESSAGES: Readonly<Record<ShaderLifecycleErrorCode, string>> = Object.freeze({
  "invalid-input": "Shader lifecycle input is invalid.",
  "admission-revalidation-failed": "Shader admission receipt revalidation failed.",
  "receipt-incoherent": "Shader admission receipt fields are incoherent.",
  "evidence-incomplete": "Shader qualification evidence is incomplete.",
  "qualification-context-invalid": "Shader qualification context is not current.",
  "approval-invalid": "Shader lifecycle approval is invalid.",
  "runtime-channel-invalid": "Shader runtime channel is invalid.",
  "catalog-revision-invalid": "Shader catalog revision is invalid.",
  "idempotency-key-invalid": "Shader lifecycle idempotency key is invalid.",
  "managed-uri-invalid": "Shader lifecycle asset URI is outside managed immutable storage.",
  "authority-unavailable": "Shader lifecycle authority could not provide a trusted result.",
  "aborted": "Shader lifecycle planning was cancelled.",
  "timeout": "Shader lifecycle planning exceeded its bounded timeout.",
  "profile-invalid": "Shader style profile package is invalid.",
  "profile-shader-not-promoted": "Shader style profile references an unpromoted shader.",
  "profile-incompatible": "Shader style profile compatibility requirements are not satisfied.",
  "requalification-inventory-invalid": "Shader requalification inventory is invalid.",
  "rollback-target-invalid": "Shader rollback target is not an eligible prior promotion.",
});

/** Host-owned approval bound to one exact immutable promotion closure. */
export interface ShaderLifecycleApproval {
  readonly approvalId: string;
  readonly subject: {
    readonly purpose: "promote-to-runtime-catalog";
    readonly assetKind: "shader" | "shader-style-profile";
    readonly assetId: string;
    readonly version: string;
    readonly manifestSha256: Sha256Hex;
    readonly closureSha256: Sha256Hex;
    readonly qualificationContextSha256: Sha256Hex;
    readonly runtimeChannel: ShaderRuntimeChannel;
    readonly expectedCatalogRevision: string;
  };
  readonly approvedBy: string;
  readonly approvedAt: string;
}

/** Exact URI claim checked by the host-owned model-storage policy evaluator. */
export interface ShaderManagedUriVerificationInput {
  readonly assetKind: "gpu-interface" | "shader-validation-evidence" | "shader" | "shader-style-profile";
  readonly assetId: string;
  readonly version: string;
  readonly uri: string;
  readonly purpose: "manifest" | "module" | "evidence" | "attestation";
  readonly signal?: AbortSignal;
}

/** Trusted host capability; request data must never select its implementation. */
export type ShaderManagedUriVerifier = (
  input: ShaderManagedUriVerificationInput,
) => Promise<boolean>;

/** Exact admitted subject that the host maps to its current qualification policy. */
export interface ShaderQualificationContextSubject {
  readonly admissionContractVersion: ShaderAdmissionReceipt["contractVersion"];
  readonly shader: ShaderVersionRef;
  readonly evidenceId: string;
  readonly evidenceSha256: Sha256Hex;
  readonly subjectBindingSha256: Sha256Hex;
  readonly matrixId: string;
  readonly matrixVersion: string;
  readonly matrixSha256: Sha256Hex;
  readonly gpuInterfaceGeneratedBy: {
    readonly packageVersion: string;
    readonly reflector: "wgsl_reflect";
    readonly reflectorVersion: "1.5.0";
  };
}

/** Trusted proof that one admitted subject uses the catalog's mandatory toolchain context. */
export interface ShaderQualificationContextVerification {
  readonly status: "current";
  readonly catalogRevision: string;
  readonly qualificationContextSha256: Sha256Hex;
  readonly subjectBindingSha256: Sha256Hex;
  readonly evidenceSha256: Sha256Hex;
  readonly matrixSha256: Sha256Hex;
}

/** Host-owned approval, clock, and managed-storage policy capabilities. */
export interface ShaderLifecyclePlanningAuthority {
  resolveApproval(input: {
    readonly approvalId: string;
    readonly subject: ShaderLifecycleApproval["subject"];
    readonly signal?: AbortSignal;
  }): Promise<ShaderLifecycleApproval | null>;
  resolveQualificationContext(input: {
    readonly expectedCatalogRevision: string;
    readonly subject: ShaderQualificationContextSubject;
    readonly signal?: AbortSignal;
  }): Promise<ShaderQualificationContextVerification | null>;
  verifyManagedUri: ShaderManagedUriVerifier;
  now(): string;
}

/** Same-process, defensively copied publication package retained by a branded plan. */
export interface ShaderLifecyclePublicationPackage {
  readonly assetKind: GpuAssetManifest["assetKind"];
  readonly assetId: string;
  readonly version: string;
  readonly manifest: GpuAssetManifest;
  readonly packageSha256: Sha256Hex;
  copyFiles(): Map<string, Uint8Array>;
}

/** Canonical full-package digest reproduced by storage verification adapters. */
export function computeShaderLifecyclePackageSha256(manifest: GpuAssetManifest): Sha256Hex {
  try {
    assertRawGpuAssetManifestPreflight(manifest, "invalid-input");
    const normalized = createGpuAssetManifest(
      JSON.parse(canonicalizeGpuContract(manifest)) as GpuAssetManifest,
    );
    return fingerprintValue({ manifest: normalized });
  } catch (cause) {
    if (cause instanceof ShaderLifecyclePlanningError) throw cause;
    fail("invalid-input");
  }
}

const executableLifecyclePlans = new WeakSet<object>();

/** Union of same-module branded plans accepted by lifecycle executors. */
export type ShaderLifecycleExecutablePlan = ShaderPromotionPlan
  | ShaderStyleProfilePromotionPlan
  | ShaderRequalificationPlan
  | ShaderRollbackPlan;

/** Rejects serialized or structurally forged lifecycle plans at an executor boundary. */
export function assertShaderLifecyclePlanExecutable(
  plan: unknown,
): asserts plan is ShaderLifecycleExecutablePlan {
  if (!plan || typeof plan !== "object" || !executableLifecyclePlans.has(plan)) fail("invalid-input");
}

/** Rejects serialized or structurally forged publication plans at the executor boundary. */
export function assertShaderLifecyclePublicationPlanExecutable(
  plan: unknown,
): asserts plan is ShaderPromotionPlan | ShaderStyleProfilePromotionPlan {
  assertShaderLifecyclePlanExecutable(plan);
  if (plan.kind !== "shader-promotion" && plan.kind !== "shader-style-profile-promotion") {
    fail("invalid-input");
  }
}

/** Mandatory executor check for same-module provenance and unexpired storage/authorization proofs. */
export interface ShaderLifecycleExecutionAuthority {
  /** Host-injected trusted clock; request data must never choose this implementation. */
  now(): string;
}

/** Verifies same-module provenance and proof freshness immediately before effects. */
export function assertShaderLifecyclePlanReadyForExecution(
  plan: unknown,
  authority: ShaderLifecycleExecutionAuthority,
): asserts plan is ShaderLifecycleExecutablePlan {
  assertShaderLifecyclePlanExecutable(plan);
  if (!authority || typeof authority.now !== "function") fail("invalid-input");
  const now = Date.parse(readAuthorityTime(() => authority.now(), "invalid-input"));
  if (plan.kind === "shader-style-profile-promotion") {
    const reverify = plan.effects.find((effect) =>
      effect.kind === "reverify-profile-promotion-closure");
    if (!reverify || reverify.kind !== "reverify-profile-promotion-closure"
      || reverify.shaderDependencies.some((dependency) =>
        Date.parse(requireTimestamp(
          dependency.verificationExpiresAt,
          "profile-shader-not-promoted",
        )) - now < MIN_VERIFICATION_EXECUTION_WINDOW_MS)) {
      fail("profile-shader-not-promoted");
    }
  } else if (plan.kind === "shader-catalog-rollback") {
    if (Date.parse(requireTimestamp(
      plan.verificationExpiresAt,
      "rollback-target-invalid",
    )) - now < MIN_VERIFICATION_EXECUTION_WINDOW_MS || Date.parse(requireTimestamp(
      plan.authorizationExpiresAt,
      "rollback-target-invalid",
    )) - now < MIN_VERIFICATION_EXECUTION_WINDOW_MS
      || plan.targetShaderDependencies.some((dependency) =>
        Date.parse(requireTimestamp(
          dependency.verificationExpiresAt,
          "rollback-target-invalid",
        )) - now < MIN_VERIFICATION_EXECUTION_WINDOW_MS)) {
      fail("rollback-target-invalid");
    }
  }
}

/** Returns defensive exact bytes only from a plan produced by this module instance. */
export function copyShaderLifecyclePublicationFiles(
  plan: ShaderPromotionPlan | ShaderStyleProfilePromotionPlan,
  assetKind: GpuAssetManifest["assetKind"],
  assetId: string,
  version: string,
): Map<string, Uint8Array> {
  assertShaderLifecyclePublicationPlanExecutable(plan);
  const matches = plan.publications.filter((publication) => publication.assetKind === assetKind
    && publication.assetId === assetId && publication.version === version);
  if (matches.length !== 1) fail("invalid-input");
  return matches[0]!.copyFiles();
}

/** Ordered, storage-neutral effects for exact shader catalog promotion. */
export type ShaderPromotionEffect =
  | {
      readonly order: 1 | 2 | 3;
      readonly kind: "publish-immutable-version";
      readonly assetKind: "gpu-interface" | "shader-validation-evidence" | "shader";
      readonly assetId: string;
      readonly version: string;
      readonly entrypoint: string;
      readonly entrypointSha256: Sha256Hex;
      readonly packageSha256: Sha256Hex;
    }
  | {
      readonly order: 4;
      readonly kind: "compare-and-swap-catalog";
      readonly assetKind: "shader";
      readonly assetId: string;
      readonly version: string;
      readonly manifestUri: string;
      readonly manifestSha256: Sha256Hex;
      readonly qualificationContextSha256: Sha256Hex;
      readonly runtimeChannel: ShaderRuntimeChannel;
      readonly expectedCatalogRevision: string;
    }
  | {
      readonly order: 5;
      readonly kind: "record-promotion-audit";
      readonly assetKind: "shader";
      readonly assetId: string;
      readonly version: string;
      readonly approvalId: string;
      readonly approvedBy: string;
      readonly approvedAt: string;
      readonly qualificationContextSha256: Sha256Hex;
      readonly plannedAt: string;
      readonly idempotencyKey: string;
    };

/** Branded fail-closed plan for interface, evidence, and shader promotion. */
export interface ShaderPromotionPlan {
  readonly contractVersion: typeof SHADER_LIFECYCLE_CONTRACT_VERSION;
  readonly kind: "shader-promotion";
  readonly featureFlag: typeof GPU_SHADER_STORE_FEATURE_FLAG;
  readonly shader: ShaderVersionRef;
  readonly modelAbiHash: Sha256Hex;
  readonly shaderAbiHash: Sha256Hex;
  readonly qualificationContextSha256: Sha256Hex;
  readonly evidenceId: string;
  readonly runtimeChannel: ShaderRuntimeChannel;
  readonly expectedCatalogRevision: string;
  readonly idempotencyKey: string;
  readonly idempotencyFingerprint: Sha256Hex;
  readonly publications: readonly ShaderLifecyclePublicationPackage[];
  readonly effects: readonly ShaderPromotionEffect[];
}

/** Trusted same-module receipt and host authorities used to plan shader promotion. */
export interface CreateShaderPromotionPlanInput {
  readonly receipt: ShaderAdmissionReceipt;
  readonly verifyCryptographicBundle: ShaderEvidenceCryptographicVerifier;
  readonly authority: ShaderLifecyclePlanningAuthority;
  readonly approvalId: string;
  readonly runtimeChannel: ShaderRuntimeChannel;
  readonly expectedCatalogRevision: string;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Canonical content closure an approval must bind for an admitted shader. */
export function computeShaderPromotionClosureSha256(input: {
  readonly receipt: ShaderAdmissionReceipt;
  readonly qualificationContextSha256: Sha256Hex;
}): Sha256Hex {
  assertRecord(input, "receipt-incoherent");
  assertRawAdmissionReceiptPreflight(input.receipt, "receipt-incoherent");
  const { receipt } = input;
  const gpuInterfaceAsset = normalizeGpuAssetManifestForClosure(
    receipt.assets.gpuInterface.manifest,
    "gpu-interface",
  );
  const evidenceAsset = normalizeGpuAssetManifestForClosure(
    receipt.assets.evidence.manifest,
    "shader-validation-evidence",
  );
  const shaderAsset = normalizeGpuAssetManifestForClosure(
    receipt.assets.shader.manifest,
    "shader",
  );
  assertCoherentAdmissionReceipt(receipt);
  const shader = requireShaderRef(receipt.shader, "receipt-incoherent");
  const gpuInterface = requireGpuInterfaceRef(receipt.gpuInterface, "receipt-incoherent");
  const moduleDigests = receipt.qualification.moduleDigests.map((module) => ({
    moduleId: module.moduleId,
    sha256: requireSha256(module.sha256, "evidence-incomplete"),
  }));
  return fingerprintValue({
    shader,
    gpuInterface,
    modelAbiHash: receipt.modelAbiHash,
    shaderAbiHash: receipt.shaderAbiHash,
    qualificationContextSha256: requireSha256(
      input.qualificationContextSha256,
      "qualification-context-invalid",
    ),
    assetManifests: {
      gpuInterface: gpuInterfaceAsset,
      validationEvidence: evidenceAsset,
      shader: shaderAsset,
    },
    qualification: {
      evidenceId: receipt.qualification.evidenceId,
      dataBundleSha256: receipt.qualification.dataBundleSha256,
      shaderManifestCoreSha256: receipt.qualification.shaderManifestCoreSha256,
      interfaceManifestSha256: receipt.qualification.interfaceManifestSha256,
      subjectBindingSha256: receipt.qualification.subjectBindingSha256,
      matrixSha256: receipt.qualification.matrixSha256,
      moduleDigests: moduleDigests
        .sort((left, right) => compareText(left.moduleId, right.moduleId)),
    },
  });
}

/**
 * Revalidates the original process-local admission receipt and creates the only
 * permitted interface -> evidence -> shader -> catalog CAS -> audit ordering.
 */
export async function createShaderPromotionPlan(
  input: CreateShaderPromotionPlanInput,
): Promise<ShaderPromotionPlan> {
  assertRecord(input, "invalid-input");
  if (input.signal?.aborted) fail("aborted");
  assertRawAdmissionReceiptPreflight(input.receipt, "receipt-incoherent");
  const deadline = createPlanningDeadline(input.signal, input.timeoutMs);
  const runtimeChannel = requireRuntimeChannel(input.runtimeChannel);
  const expectedCatalogRevision = requireCatalogRevision(input.expectedCatalogRevision);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  if (typeof input.verifyCryptographicBundle !== "function") {
    fail("invalid-input");
  }
  if (!input.authority
    || typeof input.authority.resolveApproval !== "function"
    || typeof input.authority.resolveQualificationContext !== "function"
    || typeof input.authority.verifyManagedUri !== "function"
    || typeof input.authority.now !== "function") fail("invalid-input");
  let revalidated: Awaited<ReturnType<typeof revalidateShaderAdmissionReceipt>>;
  try {
    revalidated = await revalidateShaderAdmissionReceipt({
      receipt: input.receipt,
      verifyCryptographicBundle: input.verifyCryptographicBundle,
      signal: deadline.signal,
      timeoutMs: deadline.remainingMs(),
    });
  } catch (cause) {
    if (cause instanceof ShaderLifecyclePlanningError) throw cause;
    fail("admission-revalidation-failed");
  }
  if (!revalidated.ok) {
    if (revalidated.diagnostics.some((diagnostic) => diagnostic.code === "aborted")) {
      fail("aborted");
    }
    if (revalidated.diagnostics.some((diagnostic) => diagnostic.code === "timeout")) {
      fail("timeout");
    }
    fail("admission-revalidation-failed");
  }
  if (revalidated.value !== input.receipt) {
    fail("admission-revalidation-failed");
  }

  const receipt = revalidated.value;
  assertCoherentAdmissionReceipt(receipt);
  const plannedAt = readAuthorityTime(() => input.authority.now(), "invalid-input");
  const qualificationContext = await resolveQualificationContext(
    input.authority,
    receipt,
    expectedCatalogRevision,
    deadline.signal,
    deadline.remainingMs(),
  );
  const approvalClosureSha256 = computeShaderPromotionClosureSha256({
    receipt,
    qualificationContextSha256: qualificationContext.qualificationContextSha256,
  });
  const approval = await resolveApproval(
    input.authority,
    input.approvalId,
    {
      purpose: "promote-to-runtime-catalog",
      assetKind: "shader",
      assetId: receipt.shaderId,
      version: receipt.version,
      manifestSha256: receipt.shader.manifestSha256,
      closureSha256: approvalClosureSha256,
      qualificationContextSha256: qualificationContext.qualificationContextSha256,
      runtimeChannel,
      expectedCatalogRevision,
    },
    plannedAt,
    deadline.signal,
    deadline.remainingMs(),
  );
  if (Date.parse(approval.approvedAt) < Date.parse(receipt.qualification.generatedAt)) {
    fail("approval-invalid");
  }

  const interfaceAsset = receipt.assets.gpuInterface.manifest;
  const evidenceAsset = receipt.assets.evidence.manifest;
  const shaderAsset = receipt.assets.shader.manifest;
  const interfaceEntrypoint = requireEntrypointDigest(interfaceAsset, "receipt-incoherent");
  const evidenceEntrypoint = requireEntrypointDigest(evidenceAsset, "receipt-incoherent");
  const shaderEntrypoint = requireEntrypointDigest(shaderAsset, "receipt-incoherent");
  await verifyAdmissionManagedUris(
    receipt,
    (uriInput) => input.authority.verifyManagedUri(uriInput),
    deadline,
  );
  let publications: readonly ShaderLifecyclePublicationPackage[];
  try {
    publications = [
      createLifecyclePublicationPackage(
        interfaceAsset,
        receipt.assets.gpuInterface.copyFiles(),
        "receipt-incoherent",
      ),
      createLifecyclePublicationPackage(
        evidenceAsset,
        receipt.assets.evidence.copyFiles(),
        "receipt-incoherent",
      ),
      createLifecyclePublicationPackage(
        shaderAsset,
        receipt.assets.shader.copyFiles(),
        "receipt-incoherent",
      ),
    ];
  } catch (cause) {
    if (cause instanceof ShaderLifecyclePlanningError) throw cause;
    fail("receipt-incoherent");
  }

  const effects: readonly ShaderPromotionEffect[] = [
    {
      order: 1,
      kind: "publish-immutable-version",
      assetKind: "gpu-interface",
      assetId: interfaceAsset.assetId,
      version: interfaceAsset.version,
      entrypoint: interfaceAsset.entrypoint,
      entrypointSha256: interfaceEntrypoint,
      packageSha256: publications[0]!.packageSha256,
    },
    {
      order: 2,
      kind: "publish-immutable-version",
      assetKind: "shader-validation-evidence",
      assetId: evidenceAsset.assetId,
      version: evidenceAsset.version,
      entrypoint: evidenceAsset.entrypoint,
      entrypointSha256: evidenceEntrypoint,
      packageSha256: publications[1]!.packageSha256,
    },
    {
      order: 3,
      kind: "publish-immutable-version",
      assetKind: "shader",
      assetId: shaderAsset.assetId,
      version: shaderAsset.version,
      entrypoint: shaderAsset.entrypoint,
      entrypointSha256: shaderEntrypoint,
      packageSha256: publications[2]!.packageSha256,
    },
    {
      order: 4,
      kind: "compare-and-swap-catalog",
      assetKind: "shader",
      assetId: receipt.shader.shaderId,
      version: receipt.shader.version,
      manifestUri: receipt.shader.manifestUri,
      manifestSha256: receipt.shader.manifestSha256,
      qualificationContextSha256: qualificationContext.qualificationContextSha256,
      runtimeChannel,
      expectedCatalogRevision,
    },
    {
      order: 5,
      kind: "record-promotion-audit",
      assetKind: "shader",
      assetId: receipt.shader.shaderId,
      version: receipt.shader.version,
      approvalId: approval.approvalId,
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
      qualificationContextSha256: qualificationContext.qualificationContextSha256,
      plannedAt,
      idempotencyKey,
    },
  ];

  const fingerprint = fingerprintValue({
    kind: "shader-promotion",
    shader: receipt.shader,
    modelAbiHash: receipt.modelAbiHash,
    shaderAbiHash: receipt.shaderAbiHash,
    qualificationContextSha256: qualificationContext.qualificationContextSha256,
    evidenceId: receipt.qualification.evidenceId,
    runtimeChannel,
    expectedCatalogRevision,
    approval,
    idempotencyKey,
  });

  const plan: ShaderPromotionPlan = deepFreeze({
    contractVersion: SHADER_LIFECYCLE_CONTRACT_VERSION,
    kind: "shader-promotion",
    featureFlag: GPU_SHADER_STORE_FEATURE_FLAG,
    shader: { ...receipt.shader },
    modelAbiHash: receipt.modelAbiHash,
    shaderAbiHash: receipt.shaderAbiHash,
    qualificationContextSha256: qualificationContext.qualificationContextSha256,
    evidenceId: receipt.qualification.evidenceId,
    runtimeChannel,
    expectedCatalogRevision,
    idempotencyKey,
    idempotencyFingerprint: fingerprint,
    publications,
    effects,
  });
  executableLifecyclePlans.add(plan);
  deadline.remainingMs();
  return plan;
}

/** Immutable interface and evidence identities retained by a promoted shader record. */
export interface PromotedShaderClosureDependencies {
  readonly gpuInterface: {
    readonly assetId: string;
    readonly version: string;
    readonly manifestUri: string;
    readonly manifestSha256: Sha256Hex;
  };
  readonly validationEvidence: readonly {
    readonly scope: "universal" | string;
    readonly assetId: string;
    readonly version: string;
    readonly evidenceUri: string;
    readonly evidenceSha256: Sha256Hex;
    readonly attestationUri: string;
    readonly attestationSha256: Sha256Hex;
  }[];
}

/** Exact promoted shader record returned by the trusted catalog/storage authority. */
export interface PromotedShaderVersionRecord {
  readonly state: "promoted";
  readonly runtimeChannel: ShaderRuntimeChannel;
  readonly catalogRevision: string;
  readonly qualificationContextSha256: Sha256Hex;
  readonly promotedAt: string;
  readonly shader: ShaderVersionRef;
  /** Digest-bound receipt returned by the trusted immutable-storage adapter. */
  readonly storageVerification: {
    readonly status: "version-ready";
    readonly assetKind: "shader";
    readonly assetId: string;
    readonly version: string;
    readonly manifestUri: string;
    readonly manifestSha256: Sha256Hex;
    readonly packageSha256: Sha256Hex;
    readonly verifiedAt: string;
    readonly closureSha256: Sha256Hex;
    readonly dependencies: PromotedShaderClosureDependencies;
  };
  readonly asset: {
    readonly manifest: ShaderAssetManifest;
    readonly files: Map<string, Uint8Array>;
  };
}

/** Canonical formula used by storage/catalog adapters for a promoted shader closure receipt. */
export function computePromotedShaderClosureSha256(input: {
  readonly shader: ShaderVersionRef;
  readonly packageSha256: Sha256Hex;
  readonly qualificationContextSha256: Sha256Hex;
  readonly dependencies: PromotedShaderClosureDependencies;
}): Sha256Hex {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("profile-shader-not-promoted");
  }
  const shader = requireShaderRef(input.shader, "profile-shader-not-promoted");
  const packageSha256 = requireSha256(input.packageSha256, "profile-shader-not-promoted");
  const dependencies = normalizePromotedShaderClosureDependencies(input.dependencies);
  return fingerprintValue({
    shader,
    packageSha256,
    qualificationContextSha256: requireSha256(
      input.qualificationContextSha256,
      "profile-shader-not-promoted",
    ),
    dependencies: {
      gpuInterface: dependencies.gpuInterface,
      validationEvidence: [...dependencies.validationEvidence]
        .sort((left, right) => compareText(
          canonicalizeGpuContract(left),
          canonicalizeGpuContract(right),
        )),
    },
  });
}

/** Exact profile + shader-reference closure bound into a profile approval. */
export function computeShaderStyleProfileClosureSha256(input: {
  readonly profile: ShaderStyleProfileRef;
  readonly profilePackageSha256: Sha256Hex;
  readonly qualificationContextSha256: Sha256Hex;
  readonly shaders: readonly ShaderVersionRef[];
}): Sha256Hex {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !Array.isArray(input.shaders) || !isDenseArray(input.shaders)
    || input.shaders.length === 0
    || input.shaders.length > SHADER_LIFECYCLE_LIMITS.profileRoles) {
    fail("profile-invalid");
  }
  const profile = requireProfileRef(input.profile, "profile-invalid");
  const profilePackageSha256 = requireSha256(input.profilePackageSha256, "profile-invalid");
  const shaders = input.shaders.map((shader) => requireShaderRef(shader, "profile-invalid"));
  const identities = shaders.map((shader) => shaderIdentityKey(shader, "profile-invalid"));
  if (new Set(identities).size !== identities.length) fail("profile-invalid");
  return fingerprintValue({
    profile,
    profilePackageSha256,
    qualificationContextSha256: requireSha256(
      input.qualificationContextSha256,
      "qualification-context-invalid",
    ),
    shaders: uniqueSorted(shaders, shaderRefKey),
  });
}

/** Trusted site/model-storage capabilities used to close a style profile. */
export interface ShaderStyleProfileAuthority {
  resolveApproval: ShaderLifecyclePlanningAuthority["resolveApproval"];
  now: ShaderLifecyclePlanningAuthority["now"];
  resolvePromotedShader(input: {
    readonly shader: ShaderVersionRef;
    readonly runtimeChannel: ShaderRuntimeChannel;
    readonly expectedCatalogRevision: string;
    readonly signal?: AbortSignal;
  }): Promise<PromotedShaderVersionRecord | null>;
  resolveCompatibleModels(input: {
    readonly profileId: string;
    readonly version: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly catalogRevision: string;
    readonly qualificationContextSha256: Sha256Hex;
    readonly models: readonly ModelGpuCompatibilityDescriptor[];
  }>;
  verifyManagedUri: ShaderManagedUriVerifier;
}

/** Ordered publication, dependency-reverification, CAS, and audit profile effects. */
export type ShaderStyleProfilePromotionEffect =
  | {
      readonly order: 1;
      readonly kind: "publish-immutable-version";
      readonly assetKind: "shader-style-profile";
      readonly assetId: string;
      readonly version: string;
      readonly entrypoint: string;
      readonly entrypointSha256: Sha256Hex;
      readonly packageSha256: Sha256Hex;
    }
  | {
      readonly order: 2;
      readonly kind: "reverify-profile-promotion-closure";
      readonly profile: ShaderStyleProfileRef;
      readonly shaderDependencies: readonly {
        readonly shader: ShaderVersionRef;
        readonly priorClosureSha256: Sha256Hex;
        readonly verificationExpiresAt: string;
      }[];
    }
  | {
      readonly order: 3;
      readonly kind: "compare-and-swap-catalog";
      readonly assetKind: "shader-style-profile";
      readonly assetId: string;
      readonly version: string;
      readonly manifestUri: string;
      readonly manifestSha256: Sha256Hex;
      readonly qualificationContextSha256: Sha256Hex;
      readonly runtimeChannel: ShaderRuntimeChannel;
      readonly expectedCatalogRevision: string;
    }
  | {
      readonly order: 4;
      readonly kind: "record-promotion-audit";
      readonly assetKind: "shader-style-profile";
      readonly assetId: string;
      readonly version: string;
      readonly approvalId: string;
      readonly approvedBy: string;
      readonly approvedAt: string;
      readonly qualificationContextSha256: Sha256Hex;
      readonly plannedAt: string;
      readonly idempotencyKey: string;
    };

/** Branded plan that closes one style profile over exact promoted shaders and models. */
export interface ShaderStyleProfilePromotionPlan {
  readonly contractVersion: typeof SHADER_LIFECYCLE_CONTRACT_VERSION;
  readonly kind: "shader-style-profile-promotion";
  readonly featureFlag: typeof GPU_SHADER_STORE_FEATURE_FLAG;
  readonly styleSelectionCapability: typeof GPU_SHADER_STYLE_SELECTION_CAPABILITY;
  readonly profile: ShaderStyleProfileRef;
  readonly shaders: readonly ShaderVersionRef[];
  readonly compatibleModelIds: readonly string[];
  readonly qualificationContextSha256: Sha256Hex;
  readonly runtimeChannel: ShaderRuntimeChannel;
  readonly expectedCatalogRevision: string;
  readonly idempotencyKey: string;
  readonly idempotencyFingerprint: Sha256Hex;
  readonly publications: readonly ShaderLifecyclePublicationPackage[];
  readonly effects: readonly ShaderStyleProfilePromotionEffect[];
}

/** Exact profile bytes and trusted authorities used to plan profile promotion. */
export interface CreateShaderStyleProfilePromotionPlanInput {
  readonly profile: {
    readonly manifest: ShaderStyleProfileAssetManifest;
    readonly files: Map<string, Uint8Array>;
    readonly ref: ShaderStyleProfileRef;
  };
  readonly authority: ShaderStyleProfileAuthority;
  readonly approvalId: string;
  readonly runtimeChannel: ShaderRuntimeChannel;
  readonly expectedCatalogRevision: string;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Creates a profile promotion plan from exact bytes and exact promoted shader records. */
export async function createShaderStyleProfilePromotionPlan(
  input: CreateShaderStyleProfilePromotionPlanInput,
): Promise<ShaderStyleProfilePromotionPlan> {
  assertRecord(input, "profile-invalid");
  const deadline = createPlanningDeadline(input.signal, input.timeoutMs);
  const runtimeChannel = requireRuntimeChannel(input.runtimeChannel);
  const expectedCatalogRevision = requireCatalogRevision(input.expectedCatalogRevision);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  if (!input.profile || !(input.profile.files instanceof Map)) fail("profile-invalid");
  assertRawGpuAssetManifestPreflight(input.profile.manifest, "profile-invalid");
  const profileRef = requireProfileRef(input.profile.ref, "profile-invalid");
  assertBoundedManifestFiles(
    input.profile.manifest,
    SHADER_LIFECYCLE_LIMITS.profileFiles,
    "profile-invalid",
  );
  const profileFiles = copyBoundedFileMap(
    input.profile.files,
    SHADER_LIFECYCLE_LIMITS.profileFiles,
    SHADER_LIFECYCLE_LIMITS.profileBytes,
    "profile-invalid",
  );

  let profileAsset: ShaderStyleProfileAssetManifest;
  try {
    const validated = await validateGpuAssetFiles({
      manifest: input.profile.manifest,
      files: profileFiles,
    });
    if (validated.assetKind !== "shader-style-profile") fail("profile-invalid");
    profileAsset = validated;
  } catch (cause) {
    if (cause instanceof ShaderLifecyclePlanningError) throw cause;
    fail("profile-invalid");
  }

  const profileManifest = profileAsset.styleProfileManifest;
  const profilePackageSha256 = computeShaderLifecyclePackageSha256(profileAsset);
  assertBoundedProfileManifest(profileManifest);
  if (!input.authority
    || typeof input.authority.resolveApproval !== "function"
    || typeof input.authority.now !== "function"
    || typeof input.authority.resolvePromotedShader !== "function"
    || typeof input.authority.resolveCompatibleModels !== "function"
    || typeof input.authority.verifyManagedUri !== "function") fail("profile-invalid");
  const initiallyObservedAt = readAuthorityTime(() => input.authority.now(), "profile-invalid");
  const profileEntrypointSha256 = requireEntrypointDigest(profileAsset, "profile-invalid");
  if (!sameProfileRef(profileRef, {
    profileId: profileManifest.profileId,
    version: profileManifest.version,
    manifestUri: profileRef.manifestUri,
    manifestSha256: profileEntrypointSha256,
  })) {
    fail("profile-invalid");
  }

  await requireManagedUri((uriInput) => input.authority.verifyManagedUri(uriInput), {
    assetKind: "shader-style-profile",
    assetId: profileManifest.profileId,
    version: profileManifest.version,
    uri: profileRef.manifestUri,
    purpose: "manifest",
  }, deadline.signal, deadline.remainingMs());

  const requestedShaders = new Map<string, ShaderVersionRef>();
  for (const roleBinding of profileManifest.roles) {
    const shader = requireShaderRef(roleBinding.shader, "profile-invalid");
    const identity = shaderIdentityKey(shader);
    const existing = requestedShaders.get(identity);
    if (existing && !sameShaderRef(existing, shader)) fail("profile-invalid");
    requestedShaders.set(identity, shader);
  }
  const promotedByRef = new Map<string, {
    record: PromotedShaderVersionRecord;
    manifest: ShaderVersionManifest;
  }>();
  let aggregateShaderFiles = 0;
  let aggregateShaderBytes = 0;
  let aggregateManagedUris = 1;
  for (const requestedShader of requestedShaders.values()) {
    let record: PromotedShaderVersionRecord | null;
    try {
      record = await boundedAuthorityCall(
        (boundedSignal) => input.authority.resolvePromotedShader({
          shader: requestedShader,
          runtimeChannel,
          expectedCatalogRevision,
          signal: boundedSignal,
        }),
        deadline.signal,
        deadline.remainingMs(),
      );
    } catch (cause) {
      if (cause instanceof ShaderLifecyclePlanningError) throw cause;
      fail("authority-unavailable");
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      fail("profile-shader-not-promoted");
    }
    const recordShader = requireShaderRef(record.shader, "profile-shader-not-promoted");
    const recordShaderKey = shaderIdentityKey(recordShader);
    if (record.state !== "promoted" || record.runtimeChannel !== runtimeChannel
      || record.catalogRevision !== expectedCatalogRevision) {
      fail("profile-shader-not-promoted");
    }
    requireCatalogRevision(record.catalogRevision);
    requireTimestamp(record.promotedAt, "profile-shader-not-promoted");
    if (!record.asset || !(record.asset.files instanceof Map)) fail("profile-shader-not-promoted");
    assertRawGpuAssetManifestPreflight(
      record.asset.manifest,
      "profile-shader-not-promoted",
    );
    const fileMetrics = measureBoundedFileMap(
      record.asset.files,
      SHADER_LIFECYCLE_LIMITS.promotedShaderFiles,
      SHADER_LIFECYCLE_LIMITS.promotedShaderBytes,
      "profile-shader-not-promoted",
    );
    aggregateShaderFiles += fileMetrics.files;
    aggregateShaderBytes += fileMetrics.bytes;
    if (aggregateShaderFiles > SHADER_LIFECYCLE_LIMITS.profileAggregateShaderFiles
      || aggregateShaderBytes > SHADER_LIFECYCLE_LIMITS.profileAggregateShaderBytes) {
      fail("profile-shader-not-promoted");
    }
    assertBoundedManifestFiles(
      record.asset.manifest,
      SHADER_LIFECYCLE_LIMITS.promotedShaderFiles,
      "profile-shader-not-promoted",
    );
    const shaderFiles = copyBoundedFileMap(
      record.asset.files,
      SHADER_LIFECYCLE_LIMITS.promotedShaderFiles,
      SHADER_LIFECYCLE_LIMITS.promotedShaderBytes,
      "profile-shader-not-promoted",
    );
    let validated: ShaderAssetManifest;
    try {
      const asset = await validateGpuAssetFiles({ manifest: record.asset.manifest, files: shaderFiles });
      if (asset.assetKind !== "shader") fail("profile-shader-not-promoted");
      validated = asset;
    } catch (cause) {
      if (cause instanceof ShaderLifecyclePlanningError) throw cause;
      fail("profile-shader-not-promoted");
    }
    const manifest = parseShaderVersionManifest(validated.shaderManifest);
    assertBoundedShaderManifest(manifest);
    const entrypointSha256 = requireEntrypointDigest(validated, "profile-shader-not-promoted");
    if (record.shader.shaderId !== manifest.shaderId
      || record.shader.version !== manifest.version
      || record.shader.manifestSha256 !== entrypointSha256
      || !sameShaderRef(recordShader, requestedShader)
      || !sameStorageVerification(record, entrypointSha256, initiallyObservedAt)) {
      fail("profile-shader-not-promoted");
    }
    aggregateManagedUris += 2 + manifest.modules.length
      + (2 * record.storageVerification.dependencies.validationEvidence.length);
    if (aggregateManagedUris > SHADER_LIFECYCLE_LIMITS.profileAggregateManagedUris) {
      fail("profile-shader-not-promoted");
    }
    const sanitizedRecord = sanitizePromotedShaderRecord(record, validated, recordShader);
    await verifyShaderClosureManagedUris(
      manifest,
      sanitizedRecord,
      (uriInput) => input.authority.verifyManagedUri(uriInput),
      deadline,
    );
    promotedByRef.set(recordShaderKey, { record: sanitizedRecord, manifest });
  }

  let resolvedModels: Awaited<ReturnType<ShaderStyleProfileAuthority["resolveCompatibleModels"]>>;
  try {
    resolvedModels = await boundedAuthorityCall(
      (boundedSignal) => input.authority.resolveCompatibleModels({
        profileId: profileManifest.profileId,
        version: profileManifest.version,
        signal: boundedSignal,
      }),
      deadline.signal,
      deadline.remainingMs(),
    );
  } catch (cause) {
    if (cause instanceof ShaderLifecyclePlanningError) throw cause;
    fail("authority-unavailable");
  }
  if (!resolvedModels || resolvedModels.catalogRevision !== expectedCatalogRevision
    || typeof resolvedModels.qualificationContextSha256 !== "string"
    || !Array.isArray(resolvedModels.models)
    || !isDenseArray(resolvedModels.models)
    || resolvedModels.models.length > SHADER_LIFECYCLE_LIMITS.compatibleModels) {
    fail("authority-unavailable");
  }
  const qualificationContextSha256 = requireSha256(
    resolvedModels.qualificationContextSha256,
    "qualification-context-invalid",
  );
  if ([...promotedByRef.values()].some(({ record }) =>
    record.qualificationContextSha256 !== qualificationContextSha256)) {
    fail("qualification-context-invalid");
  }
  assertRawCompatibleModelsPreflight(resolvedModels.models);
  const models: ModelGpuCompatibilityDescriptor[] = [];
  let aggregateModelSemantics = 0;
  for (let modelIndex = 0; modelIndex < resolvedModels.models.length; modelIndex += 1) {
    if ((modelIndex & 63) === 0) deadline.remainingMs();
    const model = resolvedModels.models[modelIndex]!;
    try {
      if (!model || typeof model !== "object" || Array.isArray(model)
        || !Array.isArray(model.providedSemantics)
        || !isDenseArray(model.providedSemantics)
        || model.providedSemantics.length > SHADER_LIFECYCLE_LIMITS.profileSemantics) {
        fail("profile-incompatible");
      }
      aggregateModelSemantics += model.providedSemantics.length;
      if (!Number.isSafeInteger(aggregateModelSemantics)
        || aggregateModelSemantics > SHADER_LIFECYCLE_LIMITS.compatibleModelSemanticTokens) {
        fail("profile-incompatible");
      }
      assertModelCompatibilityIdentities(model, "profile-incompatible");
      models.push(parseModelGpuCompatibilityDescriptor(model));
    } catch {
      fail("profile-incompatible");
    }
  }
  if (models.length === 0) fail("profile-incompatible");
  const modelIdentities = models.map((model) => canonicalizeGpuContract([model.modelId, model.version]));
  if (new Set(modelIdentities).size !== modelIdentities.length) fail("profile-incompatible");

  const selectedShaders: ShaderVersionRef[] = [];
  for (const roleBinding of profileManifest.roles) {
    const selected = promotedByRef.get(shaderIdentityKey(roleBinding.shader));
    if (!selected || !sameShaderRef(selected.record.shader, roleBinding.shader)) {
      fail("profile-shader-not-promoted");
    }
    const role = selected.manifest.renderRoles.find((candidate) => candidate.role === roleBinding.role);
    if (!role || role.pipelineIds.length === 0) fail("profile-incompatible");

    for (const requiredInterface of profileManifest.compatibleModelInterfaces) {
      const shaderInterface = selected.manifest.compatibleModelInterfaces.find((candidate) =>
        sameCompatibleInterface(candidate, requiredInterface));
      if (!shaderInterface) fail("profile-incompatible");
    }
    for (const scope of profileManifest.requiredValidationScopes) {
      const evidence = selected.manifest.additionalValidationEvidence.find((candidate) =>
        candidate.scope === scope.scope
        && candidate.evidence.matrixId === scope.matrixId
        && candidate.evidence.matrixVersion === scope.matrixVersion
        && candidate.evidence.matrixSha256 === scope.matrixSha256);
      if (!evidence) fail("profile-incompatible");
    }
    selectedShaders.push({ ...roleBinding.shader });
  }
  assertDistinctProfileEvidence(promotedByRef);

  const compatibleModelIds = new Set<string>();
  const requiredSemantics = new Set(profileManifest.requiredSemantics);
  for (const selected of selectedShaders) {
    const shader = promotedByRef.get(shaderIdentityKey(selected));
    for (const semantic of shader?.manifest.requirements.semantics ?? []) {
      requiredSemantics.add(semantic);
    }
  }
  const compatibleModelsByInterface = new Map<string, ModelGpuCompatibilityDescriptor[]>();
  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    if ((modelIndex & 255) === 0) deadline.remainingMs();
    const model = models[modelIndex]!;
    const semantics = new Set(model.providedSemantics);
    if (![...requiredSemantics].every((semantic) => semantics.has(semantic))) continue;
    const key = compatibleInterfaceIdentityKey({
      interfaceId: model.gpuInterface.interfaceId,
      interfaceVersion: model.gpuInterface.interfaceVersion,
      manifestSha256: model.gpuInterface.manifestSha256,
      interfaceAbiHash: model.gpuInterface.interfaceAbiHash,
      modelAbiHash: model.modelAbiHash,
    });
    appendIndexValue(compatibleModelsByInterface, key, model);
  }
  for (const requiredInterface of profileManifest.compatibleModelInterfaces) {
    const matchingModels = compatibleModelsByInterface.get(
      compatibleInterfaceIdentityKey(requiredInterface),
    ) ?? [];
    if (matchingModels.length === 0) fail("profile-incompatible");
    for (const model of matchingModels) {
      compatibleModelIds.add(`${model.modelId}@${model.version}`);
    }
  }

  const plannedAt = readAuthorityTime(() => input.authority.now(), "profile-invalid");
  if (Date.parse(plannedAt) < Date.parse(initiallyObservedAt)) fail("profile-invalid");
  for (const selected of promotedByRef.values()) {
    const entrypointSha256 = requireEntrypointDigest(
      selected.record.asset.manifest,
      "profile-shader-not-promoted",
    );
    if (!sameStorageVerification(selected.record, entrypointSha256, plannedAt)) {
      fail("profile-shader-not-promoted");
    }
  }
  const shaders = uniqueSorted(selectedShaders, shaderRefKey);
  const approval = await resolveApproval(
    input.authority,
    input.approvalId,
    {
      purpose: "promote-to-runtime-catalog",
      assetKind: "shader-style-profile",
      assetId: profileManifest.profileId,
      version: profileManifest.version,
      manifestSha256: profileEntrypointSha256,
      closureSha256: computeShaderStyleProfileClosureSha256({
        profile: profileRef,
        profilePackageSha256,
        qualificationContextSha256,
        shaders,
      }),
      qualificationContextSha256,
      runtimeChannel,
      expectedCatalogRevision,
    },
    plannedAt,
    deadline.signal,
    deadline.remainingMs(),
  );
  if (Date.parse(approval.approvedAt) < Date.parse(profileAsset.createdAt)) {
    fail("approval-invalid");
  }

  const completedAt = readAuthorityTime(() => input.authority.now(), "profile-invalid");
  if (Date.parse(completedAt) < Date.parse(plannedAt)) fail("profile-invalid");
  for (const selected of promotedByRef.values()) {
    const entrypointSha256 = requireEntrypointDigest(
      selected.record.asset.manifest,
      "profile-shader-not-promoted",
    );
    const verificationExpiresAt = computeVerificationExpiresAt(
      selected.record.storageVerification.verifiedAt,
      "profile-shader-not-promoted",
    );
    if (!sameStorageVerification(selected.record, entrypointSha256, completedAt)
      || Date.parse(verificationExpiresAt) - Date.parse(completedAt)
        < MIN_VERIFICATION_EXECUTION_WINDOW_MS) {
      fail("profile-shader-not-promoted");
    }
  }

  const shaderDependencies = [...promotedByRef.values()]
    .map(({ record }) => ({
      shader: { ...record.shader },
      priorClosureSha256: record.storageVerification.closureSha256,
      verificationExpiresAt: computeVerificationExpiresAt(
        record.storageVerification.verifiedAt,
        "profile-shader-not-promoted",
      ),
    }))
    .sort((left, right) => compareText(shaderRefKey(left.shader), shaderRefKey(right.shader)));
  const publications = [createLifecyclePublicationPackage(
    profileAsset,
    profileFiles,
    "profile-invalid",
  )] as const;

  const effects: readonly ShaderStyleProfilePromotionEffect[] = [
    {
      order: 1,
      kind: "publish-immutable-version",
      assetKind: "shader-style-profile",
      assetId: profileAsset.assetId,
      version: profileAsset.version,
      entrypoint: profileAsset.entrypoint,
      entrypointSha256: profileEntrypointSha256,
      packageSha256: publications[0].packageSha256,
    },
    {
      order: 2,
      kind: "reverify-profile-promotion-closure",
      profile: { ...profileRef },
      shaderDependencies,
    },
    {
      order: 3,
      kind: "compare-and-swap-catalog",
      assetKind: "shader-style-profile",
      assetId: profileRef.profileId,
      version: profileRef.version,
      manifestUri: profileRef.manifestUri,
      manifestSha256: profileRef.manifestSha256,
      qualificationContextSha256,
      runtimeChannel,
      expectedCatalogRevision,
    },
    {
      order: 4,
      kind: "record-promotion-audit",
      assetKind: "shader-style-profile",
      assetId: profileRef.profileId,
      version: profileRef.version,
      approvalId: approval.approvalId,
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
      qualificationContextSha256,
      plannedAt: completedAt,
      idempotencyKey,
    },
  ];
  const modelIds = [...compatibleModelIds].sort(compareText);
  const fingerprint = fingerprintValue({
    kind: "shader-style-profile-promotion",
    profile: profileRef,
    shaders,
    compatibleModelIds: modelIds,
    qualificationContextSha256,
    runtimeChannel,
    expectedCatalogRevision,
    approval,
    shaderDependencies: shaderDependencies.map(({ shader, priorClosureSha256 }) => ({
      shader,
      priorClosureSha256,
    })),
    idempotencyKey,
  });

  const plan: ShaderStyleProfilePromotionPlan = deepFreeze({
    contractVersion: SHADER_LIFECYCLE_CONTRACT_VERSION,
    kind: "shader-style-profile-promotion",
    featureFlag: GPU_SHADER_STORE_FEATURE_FLAG,
    styleSelectionCapability: GPU_SHADER_STYLE_SELECTION_CAPABILITY,
    profile: { ...profileRef },
    shaders,
    compatibleModelIds: modelIds,
    qualificationContextSha256,
    runtimeChannel,
    expectedCatalogRevision,
    idempotencyKey,
    idempotencyFingerprint: fingerprint,
    publications,
    effects,
  });
  executableLifecyclePlans.add(plan);
  deadline.remainingMs();
  return plan;
}

/** Closed causes that select full-inventory or affected-closure requalification. */
export const SHADER_REQUALIFICATION_CAUSES = Object.freeze([
  "reflection-layout",
  "cpu-codec-packing",
  "canonical-interface",
  "shared-assembly",
  "runtime-compatibility",
  "matrix-policy",
  "webgpu-toolchain",
  "shader-source",
  "style-profile",
  "model-fixture",
] as const);
/** Supported shader requalification change cause. */
export type ShaderRequalificationCause = typeof SHADER_REQUALIFICATION_CAUSES[number];

const COMPLETE_INVENTORY_CAUSES: ReadonlySet<ShaderRequalificationCause> = new Set([
  "reflection-layout",
  "cpu-codec-packing",
  "canonical-interface",
  "shared-assembly",
  "runtime-compatibility",
  "matrix-policy",
  "webgpu-toolchain",
]);

/** Exact promoted shader/profile/model dependency graph supplied by catalog authority. */
export interface ShaderRequalificationInventory {
  readonly shaders: readonly {
    readonly shader: ShaderVersionRef;
    readonly compileUnits: readonly ShaderCompileUnitQualificationRef[];
  }[];
  readonly profiles: readonly {
    readonly profile: ShaderStyleProfileRef;
    readonly shaders: readonly ShaderVersionRef[];
  }[];
  readonly modelFixtures: readonly {
    readonly fixtureId: string;
    readonly fixtureSha256: Sha256Hex;
    readonly shaders: readonly ShaderVersionRef[];
    readonly profiles: readonly ShaderStyleProfileRef[];
  }[];
}

/** Exact compile-unit content admitted into a requalification inventory snapshot. */
export interface ShaderCompileUnitQualificationRef {
  readonly compileUnitId: string;
  readonly compileUnitSha256: Sha256Hex;
}

/** Exact model-fixture content selected for requalification. */
export interface ShaderModelFixtureQualificationRef {
  readonly fixtureId: string;
  readonly fixtureSha256: Sha256Hex;
}

/** Branded deterministic work selection for complete or affected requalification. */
export interface ShaderRequalificationPlan {
  readonly contractVersion: typeof SHADER_LIFECYCLE_CONTRACT_VERSION;
  readonly kind: "shader-requalification";
  readonly scope: "complete-inventory" | "affected-closure";
  readonly inventorySnapshotId: string;
  readonly inventorySha256: Sha256Hex;
  readonly qualificationContextSha256: Sha256Hex;
  readonly catalogRevision: string;
  readonly causes: readonly ShaderRequalificationCause[];
  readonly shaders: readonly ShaderVersionRef[];
  readonly compileUnits: readonly ShaderCompileUnitQualificationRef[];
  readonly profiles: readonly ShaderStyleProfileRef[];
  readonly modelFixtures: readonly ShaderModelFixtureQualificationRef[];
  readonly idempotencyFingerprint: Sha256Hex;
}

/** Trusted content-addressed inventory and qualification-toolchain snapshot. */
export interface ShaderRequalificationInventorySnapshot {
  readonly snapshotId: string;
  readonly catalogRevision: string;
  readonly capturedAt: string;
  readonly inventorySha256: Sha256Hex;
  /** Digest of the exact reflector, packer, assembler, validators, matrix, and toolchain. */
  readonly qualificationContextSha256: Sha256Hex;
  readonly inventory: ShaderRequalificationInventory;
}

/** Trusted inventory authority backed by the promoted catalog snapshot. */
export type ShaderRequalificationInventoryLoader = (input: {
  readonly expectedCatalogRevision: string;
  readonly signal?: AbortSignal;
}) => Promise<ShaderRequalificationInventorySnapshot>;

/** Authority, revision, causes, and changed roots used to plan requalification. */
export interface CreateShaderRequalificationPlanInput {
  readonly loadInventorySnapshot: ShaderRequalificationInventoryLoader;
  readonly expectedCatalogRevision: string;
  readonly causes: readonly ShaderRequalificationCause[];
  readonly changedShaders?: readonly ShaderVersionRef[];
  readonly changedProfiles?: readonly ShaderStyleProfileRef[];
  readonly changedModelFixtureIds?: readonly string[];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Computes the order-independent digest an authoritative inventory snapshot carries. */
export function computeShaderRequalificationInventorySha256(
  inventory: ShaderRequalificationInventory,
): Sha256Hex {
  const normalized = normalizeRequalificationInventory(inventory);
  return fingerprintValue(serializableRequalificationInventory(normalized));
}

/** Selects a deterministic full inventory or affected dependency closure. */
export async function createShaderRequalificationPlan(
  input: CreateShaderRequalificationPlanInput,
): Promise<ShaderRequalificationPlan> {
  assertRecord(input, "requalification-inventory-invalid");
  const deadline = createPlanningDeadline(input.signal, input.timeoutMs);
  if (typeof input.loadInventorySnapshot !== "function") fail("requalification-inventory-invalid");
  const expectedCatalogRevision = requireCatalogRevision(input.expectedCatalogRevision);
  let snapshot: ShaderRequalificationInventorySnapshot;
  try {
    snapshot = await boundedAuthorityCall(
      (boundedSignal) => input.loadInventorySnapshot({
        expectedCatalogRevision,
        signal: boundedSignal,
      }),
      deadline.signal,
      deadline.remainingMs(),
    );
  } catch (cause) {
    if (cause instanceof ShaderLifecyclePlanningError) throw cause;
    fail("authority-unavailable");
  }
  if (!snapshot || snapshot.catalogRevision !== expectedCatalogRevision) {
    fail("catalog-revision-invalid");
  }
  const inventorySnapshotId = requireToken(
    snapshot.snapshotId,
    160,
    "requalification-inventory-invalid",
  );
  requireTimestamp(snapshot.capturedAt, "requalification-inventory-invalid");
  const inventory = normalizeRequalificationInventory(
    snapshot.inventory,
    () => { deadline.remainingMs(); },
  );
  const inventorySha256 = fingerprintValue(serializableRequalificationInventory(inventory));
  if (snapshot.inventorySha256 !== inventorySha256) fail("requalification-inventory-invalid");
  const qualificationContextSha256 = requireSha256(
    snapshot.qualificationContextSha256,
    "requalification-inventory-invalid",
  );
  const causes = requireUniqueValues(
    input.causes,
    SHADER_REQUALIFICATION_CAUSES,
    "requalification-inventory-invalid",
  ).sort(compareText) as ShaderRequalificationCause[];
  if (causes.length === 0) fail("requalification-inventory-invalid");
  const changedShaders = requireBoundedArray<ShaderVersionRef>(
    input.changedShaders === undefined ? [] : input.changedShaders,
    SHADER_LIFECYCLE_LIMITS.inventoryShaders,
    "requalification-inventory-invalid",
  );
  const changedProfiles = requireBoundedArray<ShaderStyleProfileRef>(
    input.changedProfiles === undefined ? [] : input.changedProfiles,
    SHADER_LIFECYCLE_LIMITS.inventoryProfiles,
    "requalification-inventory-invalid",
  );
  const changedModelFixtureIds = requireBoundedArray<string>(
    input.changedModelFixtureIds === undefined ? [] : input.changedModelFixtureIds,
    SHADER_LIFECYCLE_LIMITS.inventoryModelFixtures,
    "requalification-inventory-invalid",
  );
  const changedShaderKeys = changedShaders.map((shader) =>
    shaderIdentityKey(shader, "requalification-inventory-invalid"));
  const changedProfileKeys = changedProfiles.map((profile) =>
    profileIdentityKey(profile, "requalification-inventory-invalid"));
  const normalizedChangedFixtureIds = changedModelFixtureIds.map((fixtureId) =>
    requireToken(fixtureId, 128, "requalification-inventory-invalid"));
  if (new Set(changedShaderKeys).size !== changedShaderKeys.length
    || new Set(changedProfileKeys).size !== changedProfileKeys.length
    || new Set(normalizedChangedFixtureIds).size !== normalizedChangedFixtureIds.length) {
    fail("requalification-inventory-invalid");
  }
  const complete = causes.some((cause) => COMPLETE_INVENTORY_CAUSES.has(cause));
  if (!complete) {
    if (causes.includes("shader-source") && changedShaders.length === 0) {
      fail("requalification-inventory-invalid");
    }
    if (causes.includes("style-profile") && changedProfiles.length === 0) {
      fail("requalification-inventory-invalid");
    }
    if (causes.includes("model-fixture") && changedModelFixtureIds.length === 0) {
      fail("requalification-inventory-invalid");
    }
  }

  const selectedShaderKeys = new Set<string>();
  const selectedProfileKeys = new Set<string>();
  const selectedFixtureIds = new Set<string>();
  if (complete) {
    for (const key of inventory.shaders.keys()) selectedShaderKeys.add(key);
    for (const key of inventory.profiles.keys()) selectedProfileKeys.add(key);
    for (const key of inventory.fixtures.keys()) selectedFixtureIds.add(key);
  } else {
    for (const shader of changedShaders) {
      const key = shaderIdentityKey(shader, "requalification-inventory-invalid");
      if (!inventory.shaders.has(key) || !sameShaderRef(inventory.shaders.get(key)!.shader, shader)) {
        fail("requalification-inventory-invalid");
      }
      selectedShaderKeys.add(key);
    }
    for (const profile of changedProfiles) {
      const key = profileIdentityKey(profile, "requalification-inventory-invalid");
      if (!inventory.profiles.has(key) || !sameProfileRef(inventory.profiles.get(key)!.profile, profile)) {
        fail("requalification-inventory-invalid");
      }
      selectedProfileKeys.add(key);
    }
    for (const id of normalizedChangedFixtureIds) {
      if (!inventory.fixtures.has(id)) fail("requalification-inventory-invalid");
      selectedFixtureIds.add(id);
    }
    if (selectedShaderKeys.size + selectedProfileKeys.size + selectedFixtureIds.size === 0) {
      fail("requalification-inventory-invalid");
    }

    expandRequalificationClosure(
      inventory,
      selectedShaderKeys,
      selectedProfileKeys,
      selectedFixtureIds,
      () => { deadline.remainingMs(); },
    );
  }

  const shaders = [...selectedShaderKeys]
    .map((key) => ({ ...inventory.shaders.get(key)!.shader }))
    .sort((left, right) => compareText(shaderRefKey(left), shaderRefKey(right)));
  const profiles = [...selectedProfileKeys]
    .map((key) => ({ ...inventory.profiles.get(key)!.profile }))
    .sort((left, right) => compareText(profileRefKey(left), profileRefKey(right)));
  const compileUnits = [...selectedShaderKeys]
    .flatMap((key) => inventory.shaders.get(key)!.compileUnits)
    .sort((left, right) => compareText(left.compileUnitId, right.compileUnitId));
  const modelFixtures = [...selectedFixtureIds]
    .map((fixtureId) => {
      const fixture = inventory.fixtures.get(fixtureId)!;
      return { fixtureId, fixtureSha256: fixture.fixtureSha256 };
    })
    .sort((left, right) => compareText(left.fixtureId, right.fixtureId));
  const scope = complete ? "complete-inventory" : "affected-closure";
  const fingerprint = fingerprintValue({
    kind: "shader-requalification",
    scope,
    inventorySha256,
    qualificationContextSha256,
    catalogRevision: expectedCatalogRevision,
    causes,
    shaders,
    compileUnits,
    profiles,
    modelFixtures,
  });
  const plan: ShaderRequalificationPlan = deepFreeze({
    contractVersion: SHADER_LIFECYCLE_CONTRACT_VERSION,
    kind: "shader-requalification",
    scope,
    inventorySnapshotId,
    inventorySha256,
    qualificationContextSha256,
    catalogRevision: expectedCatalogRevision,
    causes,
    shaders,
    compileUnits,
    profiles,
    modelFixtures,
    idempotencyFingerprint: fingerprint,
  });
  executableLifecyclePlans.add(plan);
  deadline.remainingMs();
  return plan;
}

/** One bounded immutable shader/profile version in promoted catalog history. */
export interface ShaderCatalogHistoryEntry {
  readonly assetKind: "shader" | "shader-style-profile";
  readonly assetId: string;
  readonly version: string;
  readonly manifestUri: string;
  readonly manifestSha256: Sha256Hex;
  readonly publicationClosureSha256: Sha256Hex;
  readonly qualificationContextSha256: Sha256Hex;
  readonly runtimeChannel: ShaderRuntimeChannel;
  readonly catalogRevision: string;
  readonly sequence: number;
  readonly state: "current" | "superseded" | "rolled-back" | "candidate";
  readonly rollbackEligibility: "eligible" | "ineligible" | "revoked";
  readonly revokedAt: string | null;
  readonly promotedAt: string;
}

/** Fresh current-catalog proof for one exact shader pinned by a rollback profile. */
export interface ShaderRollbackShaderDependencyVerification {
  readonly state: "promoted";
  readonly shader: ShaderVersionRef;
  readonly runtimeChannel: ShaderRuntimeChannel;
  readonly catalogRevision: string;
  readonly qualificationContextSha256: Sha256Hex;
  readonly closureSha256: Sha256Hex;
  readonly verifiedAt: string;
  readonly revokedAt: null;
}

/** Fresh storage verification of one exact rollback target and qualification context. */
export interface ShaderRollbackTargetVerification {
  readonly status: "version-ready";
  readonly assetKind: "shader" | "shader-style-profile";
  readonly assetId: string;
  readonly version: string;
  readonly manifestUri: string;
  readonly manifestSha256: Sha256Hex;
  readonly verifiedAt: string;
  readonly closureSha256: Sha256Hex;
  readonly qualificationContextSha256: Sha256Hex;
  /** Exact verified profile package digest; shader targets must return null. */
  readonly profilePackageSha256: Sha256Hex | null;
  readonly shaderDependencies: readonly ShaderRollbackShaderDependencyVerification[];
}

/** Canonical current dependency closure bound into profile rollback authorization and CAS. */
export function computeShaderRollbackDependencyClosureSha256(
  dependencies: readonly ShaderRollbackShaderDependencyVerification[],
): Sha256Hex {
  const normalized = validateRollbackShaderDependencies(dependencies);
  return fingerprintValue(normalized.map((dependency) => ({
    shader: dependency.shader,
    runtimeChannel: dependency.runtimeChannel,
    catalogRevision: dependency.catalogRevision,
    qualificationContextSha256: dependency.qualificationContextSha256,
    closureSha256: dependency.closureSha256,
  })));
}

/** Trusted current revision, qualification context, and bounded rollback history. */
export interface ShaderRollbackCatalogSnapshot {
  readonly catalogRevision: string;
  /** Current mandatory qualification context from the trusted catalog policy. */
  readonly currentQualificationContextSha256: Sha256Hex;
  readonly entries: readonly ShaderCatalogHistoryEntry[];
}

/** Canonical digest used to bind a normalized operator reason into authorization. */
export function computeShaderRollbackReasonSha256(reason: string): Sha256Hex {
  return fingerprintValue({
    reason: requireBoundedText(reason, 512, "rollback-target-invalid"),
  });
}

/** Host-owned authorization bound to one exact rollback target and reason. */
export interface ShaderRollbackAuthorization {
  readonly status: "authorized";
  readonly authorizationId: string;
  readonly incidentId: string;
  readonly nonce: string;
  readonly subject: {
    readonly assetKind: "shader" | "shader-style-profile";
    readonly assetId: string;
    readonly runtimeChannel: ShaderRuntimeChannel;
    readonly targetVersion: string;
    readonly targetManifestSha256: Sha256Hex;
    readonly targetPublicationClosureSha256: Sha256Hex;
    readonly targetDependencyClosureSha256: Sha256Hex | null;
    readonly qualificationContextSha256: Sha256Hex;
    readonly expectedCatalogRevision: string;
    readonly reasonSha256: Sha256Hex;
  };
  readonly requestedBy: string;
  readonly authorizedAt: string;
  readonly expiresAt: string;
}

/** Trusted catalog/storage/clock capabilities; never selected by request data. */
export interface ShaderRollbackAuthority {
  loadCatalogSnapshot(input: {
    readonly assetKind: "shader" | "shader-style-profile";
    readonly assetId: string;
    readonly runtimeChannel: ShaderRuntimeChannel;
    readonly targetVersion: string;
    readonly expectedCatalogRevision: string;
    readonly signal?: AbortSignal;
  }): Promise<ShaderRollbackCatalogSnapshot>;
  verifyImmutableTarget(input: {
    readonly target: ShaderCatalogHistoryEntry;
    readonly signal?: AbortSignal;
  }): Promise<ShaderRollbackTargetVerification>;
  resolveRollbackAuthorization(input: {
    readonly authorizationId: string;
    readonly incidentId: string;
    readonly subject: ShaderRollbackAuthorization["subject"];
    readonly signal?: AbortSignal;
  }): Promise<ShaderRollbackAuthorization | null>;
  verifyManagedUri: ShaderManagedUriVerifier;
  now(): string;
}

/** Branded authorized pointer-only rollback plan with one-use CAS subject data. */
export interface ShaderRollbackPlan {
  readonly contractVersion: typeof SHADER_LIFECYCLE_CONTRACT_VERSION;
  readonly kind: "shader-catalog-rollback";
  readonly runtimeChannel: ShaderRuntimeChannel;
  readonly current: ShaderCatalogHistoryEntry;
  readonly target: ShaderCatalogHistoryEntry;
  readonly targetVerification: ShaderRollbackTargetVerification;
  readonly verificationExpiresAt: string;
  readonly targetDependencyClosureSha256: Sha256Hex | null;
  readonly targetShaderDependencies: readonly (ShaderRollbackShaderDependencyVerification & {
    readonly verificationExpiresAt: string;
  })[];
  readonly authorizationId: string;
  readonly authorizationNonce: string;
  readonly authorizationExpiresAt: string;
  readonly incidentId: string;
  readonly requestedBy: string;
  readonly authorizedAt: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly idempotencyFingerprint: Sha256Hex;
  readonly effects: readonly [
    {
      readonly order: 1;
      readonly kind: "reverify-immutable-version";
      readonly assetKind: "shader" | "shader-style-profile";
      readonly assetId: string;
      readonly version: string;
      readonly manifestSha256: Sha256Hex;
      readonly priorClosureSha256: Sha256Hex;
      readonly verificationExpiresAt: string;
      readonly targetDependencyClosureSha256: Sha256Hex | null;
      readonly shaderDependencies: readonly (ShaderRollbackShaderDependencyVerification & {
        readonly verificationExpiresAt: string;
      })[];
    },
    {
      readonly order: 2;
      readonly kind: "compare-and-swap-catalog-with-authorization";
      readonly assetKind: "shader" | "shader-style-profile";
      readonly assetId: string;
      readonly runtimeChannel: ShaderRuntimeChannel;
      readonly expectedCatalogRevision: string;
      readonly targetVersion: string;
      readonly targetManifestUri: string;
      readonly targetManifestSha256: Sha256Hex;
      readonly targetPublicationClosureSha256: Sha256Hex;
      readonly targetDependencyClosureSha256: Sha256Hex | null;
      readonly qualificationContextSha256: Sha256Hex;
      readonly authorizationId: string;
      readonly authorizationNonce: string;
      readonly authorizationExpiresAt: string;
    },
    {
      readonly order: 3;
      readonly kind: "record-rollback-audit";
      readonly authorizationId: string;
      readonly incidentId: string;
      readonly requestedBy: string;
      readonly authorizedAt: string;
      readonly reason: string;
      readonly plannedAt: string;
      readonly idempotencyKey: string;
    },
  ];
}

/** Exact rollback target, incident, authorization, and catalog preconditions. */
export interface CreateShaderRollbackPlanInput {
  readonly authority: ShaderRollbackAuthority;
  readonly assetKind: "shader" | "shader-style-profile";
  readonly assetId: string;
  readonly runtimeChannel: ShaderRuntimeChannel;
  readonly expectedCatalogRevision: string;
  readonly targetVersion: string;
  readonly authorizationId: string;
  readonly incidentId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const ROLLBACK_VERIFICATION_MAX_AGE_MS = 5 * 60 * 1_000;
const MIN_VERIFICATION_EXECUTION_WINDOW_MS = 30 * 1_000;

/** Plans a CAS-only rollback to a freshly reverified prior promoted version. */
export async function createShaderRollbackPlan(
  input: CreateShaderRollbackPlanInput,
): Promise<ShaderRollbackPlan> {
  assertRecord(input, "rollback-target-invalid");
  const deadline = createPlanningDeadline(input.signal, input.timeoutMs);
  if (input.assetKind !== "shader" && input.assetKind !== "shader-style-profile") {
    fail("rollback-target-invalid");
  }
  const [assetId] = requireAssetIdentity(input.assetId, input.targetVersion, "rollback-target-invalid");
  const targetVersion = input.targetVersion;
  const runtimeChannel = requireRuntimeChannel(input.runtimeChannel);
  const expectedCatalogRevision = requireCatalogRevision(input.expectedCatalogRevision);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  if (!input.authority
    || typeof input.authority.loadCatalogSnapshot !== "function"
    || typeof input.authority.verifyImmutableTarget !== "function"
    || typeof input.authority.resolveRollbackAuthorization !== "function"
    || typeof input.authority.verifyManagedUri !== "function"
    || typeof input.authority.now !== "function") fail("rollback-target-invalid");
  const authorizationId = requireToken(input.authorizationId, 160, "rollback-target-invalid");
  const incidentId = requireToken(input.incidentId, 128, "rollback-target-invalid");
  const reason = requireBoundedText(input.reason, 512, "rollback-target-invalid");
  let snapshot: ShaderRollbackCatalogSnapshot;
  try {
    snapshot = await boundedAuthorityCall(
      (boundedSignal) => input.authority.loadCatalogSnapshot({
        assetKind: input.assetKind,
        assetId,
        runtimeChannel,
        targetVersion,
        expectedCatalogRevision,
        signal: boundedSignal,
      }),
      deadline.signal,
      deadline.remainingMs(),
    );
  } catch (cause) {
    if (cause instanceof ShaderLifecyclePlanningError) throw cause;
    fail("authority-unavailable");
  }
  if (!snapshot || snapshot.catalogRevision !== expectedCatalogRevision
    || !Array.isArray(snapshot.entries) || snapshot.entries.length < 2
    || snapshot.entries.length > SHADER_LIFECYCLE_LIMITS.rollbackHistoryEntries
    || !isDenseArray(snapshot.entries)) {
    fail("catalog-revision-invalid");
  }
  const currentQualificationContextSha256 = requireSha256(
    snapshot.currentQualificationContextSha256,
    "rollback-target-invalid",
  );
  const entries = deepFreeze(snapshot.entries.map((entry) => validateHistoryEntry(entry)));
  const sequences = new Set<number>();
  const revisions = new Set<string>();
  const immutableVersions = new Set<string>();
  for (const entry of entries) {
    if (entry.assetKind !== input.assetKind || entry.assetId !== assetId
      || entry.runtimeChannel !== runtimeChannel) fail("rollback-target-invalid");
    const versionKey = canonicalizeGpuContract([
      entry.assetKind,
      entry.assetId,
      entry.runtimeChannel,
      entry.version,
    ]);
    if (sequences.has(entry.sequence) || revisions.has(entry.catalogRevision)
      || immutableVersions.has(versionKey)) {
      fail("rollback-target-invalid");
    }
    sequences.add(entry.sequence);
    revisions.add(entry.catalogRevision);
    immutableVersions.add(versionKey);
  }
  const currentEntries = entries.filter((entry) =>
    entry.assetKind === input.assetKind && entry.assetId === assetId
    && entry.runtimeChannel === runtimeChannel && entry.state === "current");
  if (currentEntries.length !== 1) fail("rollback-target-invalid");
  const current = deepFreeze({ ...currentEntries[0]! });
  if (current.catalogRevision !== expectedCatalogRevision) fail("catalog-revision-invalid");
  if (current.qualificationContextSha256 !== currentQualificationContextSha256) {
    fail("rollback-target-invalid");
  }
  if (current.sequence !== Math.max(...entries.map((entry) => entry.sequence))) {
    fail("rollback-target-invalid");
  }
  const targetEntry = entries.find((entry) =>
    entry.runtimeChannel === runtimeChannel
    && entry.assetKind === current.assetKind
    && entry.assetId === current.assetId
    && entry.version === targetVersion);
  if (!targetEntry
    || targetEntry.state !== "superseded"
    || targetEntry.rollbackEligibility !== "eligible"
    || targetEntry.revokedAt !== null
    || targetEntry.qualificationContextSha256 !== currentQualificationContextSha256
    || targetEntry.sequence >= current.sequence) {
    fail("rollback-target-invalid");
  }
  const target = deepFreeze({ ...targetEntry });
  let verification: ShaderRollbackTargetVerification;
  try {
    verification = await boundedAuthorityCall(
      (boundedSignal) => input.authority.verifyImmutableTarget({ target, signal: boundedSignal }),
      deadline.signal,
      deadline.remainingMs(),
    );
  } catch (cause) {
    if (cause instanceof ShaderLifecyclePlanningError) throw cause;
    fail("authority-unavailable");
  }
  if (!verification
    || verification.status !== "version-ready"
    || verification.assetKind !== target.assetKind
    || verification.assetId !== target.assetId
    || verification.version !== target.version
    || verification.manifestUri !== target.manifestUri
    || verification.manifestSha256 !== target.manifestSha256
    || verification.closureSha256 !== target.publicationClosureSha256
    || verification.qualificationContextSha256 !== target.qualificationContextSha256
    || !Array.isArray(verification.shaderDependencies)
    || !isDenseArray(verification.shaderDependencies)
    || requireSha256(verification.closureSha256, "rollback-target-invalid") !== verification.closureSha256
    || requireSha256(verification.qualificationContextSha256, "rollback-target-invalid")
      !== verification.qualificationContextSha256) {
    fail("rollback-target-invalid");
  }
  const verifiedAt = requireTimestamp(verification.verifiedAt, "rollback-target-invalid");
  const rawShaderDependencies = verification.shaderDependencies;
  await requireManagedUri((uriInput) => input.authority.verifyManagedUri(uriInput), {
    assetKind: target.assetKind,
    assetId: target.assetId,
    version: target.version,
    uri: target.manifestUri,
    purpose: "manifest",
  }, deadline.signal, deadline.remainingMs());
  const plannedAt = readAuthorityTime(() => input.authority.now(), "rollback-target-invalid");
  const verificationAge = Date.parse(plannedAt) - Date.parse(verifiedAt);
  if (verificationAge < 0 || verificationAge > ROLLBACK_VERIFICATION_MAX_AGE_MS) {
    fail("rollback-target-invalid");
  }
  const verificationExpiresAt = computeVerificationExpiresAt(verifiedAt, "rollback-target-invalid");
  const targetShaderDependencies = validateRollbackShaderDependencies(
    rawShaderDependencies,
    {
      runtimeChannel,
      catalogRevision: expectedCatalogRevision,
      qualificationContextSha256: currentQualificationContextSha256,
      plannedAt,
    },
  );
  let profilePackageSha256: Sha256Hex | null;
  if (target.assetKind === "shader") {
    if (verification.profilePackageSha256 !== null || targetShaderDependencies.length !== 0) {
      fail("rollback-target-invalid");
    }
    profilePackageSha256 = null;
  } else {
    if (targetShaderDependencies.length === 0) fail("rollback-target-invalid");
    profilePackageSha256 = requireSha256(
      verification.profilePackageSha256,
      "rollback-target-invalid",
    );
    const recomputedPublicationClosureSha256 = computeShaderStyleProfileClosureSha256({
      profile: requireProfileRef({
        profileId: target.assetId,
        version: target.version,
        manifestUri: target.manifestUri,
        manifestSha256: target.manifestSha256,
      }, "rollback-target-invalid"),
      profilePackageSha256,
      qualificationContextSha256: currentQualificationContextSha256,
      shaders: targetShaderDependencies.map((dependency) => dependency.shader),
    });
    if (recomputedPublicationClosureSha256 !== target.publicationClosureSha256) {
      fail("rollback-target-invalid");
    }
  }
  for (const dependency of targetShaderDependencies) {
    await requireManagedUri((uriInput) => input.authority.verifyManagedUri(uriInput), {
      assetKind: "shader",
      assetId: dependency.shader.shaderId,
      version: dependency.shader.version,
      uri: dependency.shader.manifestUri,
      purpose: "manifest",
    }, deadline.signal, deadline.remainingMs());
  }
  const targetDependencyClosureSha256 = target.assetKind === "shader-style-profile"
    ? computeShaderRollbackDependencyClosureSha256(targetShaderDependencies)
    : null;
  verification = {
    status: "version-ready",
    assetKind: target.assetKind,
    assetId: target.assetId,
    version: target.version,
    manifestUri: target.manifestUri,
    manifestSha256: target.manifestSha256,
    verifiedAt,
    closureSha256: target.publicationClosureSha256,
    qualificationContextSha256: target.qualificationContextSha256,
    profilePackageSha256,
    shaderDependencies: targetShaderDependencies.map(
      ({ verificationExpiresAt: _expiresAt, ...dependency }) => dependency,
    ),
  };
  const authorizationSubject: ShaderRollbackAuthorization["subject"] = {
    assetKind: target.assetKind,
    assetId: target.assetId,
    runtimeChannel,
    targetVersion: target.version,
    targetManifestSha256: target.manifestSha256,
    targetPublicationClosureSha256: target.publicationClosureSha256,
    targetDependencyClosureSha256,
    qualificationContextSha256: target.qualificationContextSha256,
    expectedCatalogRevision,
    reasonSha256: computeShaderRollbackReasonSha256(reason),
  };
  const authorization = await resolveRollbackAuthorization(
    input.authority,
    authorizationId,
    incidentId,
    authorizationSubject,
    plannedAt,
    deadline.signal,
    deadline.remainingMs(),
  );
  const completedAt = readAuthorityTime(() => input.authority.now(), "rollback-target-invalid");
  if (Date.parse(completedAt) < Date.parse(plannedAt)
    || Date.parse(verificationExpiresAt) - Date.parse(completedAt)
      < MIN_VERIFICATION_EXECUTION_WINDOW_MS
    || targetShaderDependencies.some((dependency) =>
      Date.parse(dependency.verificationExpiresAt) - Date.parse(completedAt)
        < MIN_VERIFICATION_EXECUTION_WINDOW_MS)
    || Date.parse(authorization.expiresAt) - Date.parse(completedAt)
      < MIN_VERIFICATION_EXECUTION_WINDOW_MS) {
    fail("rollback-target-invalid");
  }

  const effects: ShaderRollbackPlan["effects"] = [
    {
      order: 1,
      kind: "reverify-immutable-version",
      assetKind: target.assetKind,
      assetId: target.assetId,
      version: target.version,
      manifestSha256: target.manifestSha256,
      priorClosureSha256: verification.closureSha256,
      verificationExpiresAt,
      targetDependencyClosureSha256,
      shaderDependencies: targetShaderDependencies,
    },
    {
      order: 2,
      kind: "compare-and-swap-catalog-with-authorization",
      assetKind: target.assetKind,
      assetId: target.assetId,
      runtimeChannel,
      expectedCatalogRevision,
      targetVersion: target.version,
      targetManifestUri: target.manifestUri,
      targetManifestSha256: target.manifestSha256,
      targetPublicationClosureSha256: target.publicationClosureSha256,
      targetDependencyClosureSha256,
      qualificationContextSha256: target.qualificationContextSha256,
      authorizationId: authorization.authorizationId,
      authorizationNonce: authorization.nonce,
      authorizationExpiresAt: authorization.expiresAt,
    },
    {
      order: 3,
      kind: "record-rollback-audit",
      authorizationId: authorization.authorizationId,
      incidentId,
      requestedBy: authorization.requestedBy,
      authorizedAt: authorization.authorizedAt,
      reason,
      plannedAt: completedAt,
      idempotencyKey,
    },
  ];
  const fingerprint = fingerprintValue({
    kind: "shader-catalog-rollback",
    runtimeChannel,
    current,
    target,
    targetClosureSha256: verification.closureSha256,
    targetDependencyClosureSha256,
    targetShaderDependencies: targetShaderDependencies.map(
      ({ verificationExpiresAt: _expiresAt, ...dependency }) => dependency,
    ),
    authorization,
    incidentId,
    reason,
    idempotencyKey,
  });
  const plan: ShaderRollbackPlan = deepFreeze({
    contractVersion: SHADER_LIFECYCLE_CONTRACT_VERSION,
    kind: "shader-catalog-rollback",
    runtimeChannel,
    current: { ...current },
    target: { ...target },
    targetVerification: { ...verification },
    verificationExpiresAt,
    targetDependencyClosureSha256,
    targetShaderDependencies,
    authorizationId: authorization.authorizationId,
    authorizationNonce: authorization.nonce,
    authorizationExpiresAt: authorization.expiresAt,
    incidentId,
    requestedBy: authorization.requestedBy,
    authorizedAt: authorization.authorizedAt,
    reason,
    idempotencyKey,
    idempotencyFingerprint: fingerprint,
    effects,
  });
  executableLifecyclePlans.add(plan);
  deadline.remainingMs();
  return plan;
}

function assertCoherentAdmissionReceipt(receipt: ShaderAdmissionReceipt): void {
  if (!receipt
    || receipt.contractVersion !== SHADER_ADMISSION_CONTRACT_VERSION
    || receipt.plan.contractVersion !== SHADER_ADMISSION_CONTRACT_VERSION
    || receipt.plan.featureFlagId !== GPU_SHADER_STORE_FEATURE_FLAG
    || receipt.plan.targetRuntime !== "webgpu-wgsl"
    || receipt.shaderId !== receipt.plan.shaderId
    || receipt.version !== receipt.plan.version
    || receipt.plan.steps.length !== SHADER_ADMISSION_OPERATIONS.length
    || receipt.plan.steps.some((step, index) => !step
      || typeof step !== "object"
      || Array.isArray(step)
      || step.operation !== SHADER_ADMISSION_OPERATIONS[index]
      || step.required !== true)) {
    fail("receipt-incoherent");
  }
  const interfaceManifest = receipt.assets.gpuInterface.manifest.gpuInterfaceManifest;
  const shaderManifest = receipt.assets.shader.manifest.shaderManifest;
  requireAssetIdentity(receipt.shaderId, receipt.version, "receipt-incoherent");
  requireAssetIdentity(
    interfaceManifest.interfaceId,
    interfaceManifest.interfaceVersion,
    "receipt-incoherent",
  );
  requireGpuInterfaceRef(receipt.gpuInterface, "receipt-incoherent");
  requireShaderRef(receipt.shader, "receipt-incoherent");
  requireAssetIdentity(
    receipt.assets.evidence.manifest.assetId,
    receipt.assets.evidence.manifest.version,
    "receipt-incoherent",
  );
  assertBoundedShaderManifest(shaderManifest, "receipt-incoherent");
  assertUniqueLogicalInterfaces(shaderManifest.compatibleModelInterfaces, "receipt-incoherent");
  const evidenceRef = receipt.assets.evidence.manifest.validationEvidence;
  const interfaceEntrypoint = requireEntrypointDigest(
    receipt.assets.gpuInterface.manifest,
    "receipt-incoherent",
  );
  const evidenceEntrypoint = requireEntrypointDigest(
    receipt.assets.evidence.manifest,
    "receipt-incoherent",
  );
  const shaderEntrypoint = requireEntrypointDigest(
    receipt.assets.shader.manifest,
    "receipt-incoherent",
  );
  if (receipt.shader.shaderId !== receipt.shaderId
    || receipt.shader.version !== receipt.version
    || receipt.assets.shader.manifest.assetId !== receipt.shaderId
    || receipt.assets.shader.manifest.version !== receipt.version
    || shaderManifest.shaderId !== receipt.shaderId
    || shaderManifest.version !== receipt.version
    || receipt.gpuInterface.interfaceId !== interfaceManifest.interfaceId
    || receipt.gpuInterface.interfaceVersion !== interfaceManifest.interfaceVersion
    || receipt.gpuInterface.interfaceAbiHash !== interfaceManifest.interfaceAbiHash
    || receipt.gpuInterface.modelAbiHash !== interfaceManifest.modelAbiHash
    || interfaceEntrypoint !== receipt.gpuInterface.manifestSha256
    || interfaceEntrypoint !== receipt.qualification.interfaceManifestSha256
    || shaderEntrypoint !== receipt.shader.manifestSha256
    || shaderManifest.gpuInterface.interfaceId !== receipt.gpuInterface.interfaceId
    || shaderManifest.gpuInterface.interfaceVersion !== receipt.gpuInterface.interfaceVersion
    || shaderManifest.gpuInterface.manifestUri !== receipt.gpuInterface.manifestUri
    || shaderManifest.gpuInterface.manifestSha256 !== receipt.gpuInterface.manifestSha256
    || shaderManifest.gpuInterface.interfaceAbiHash !== receipt.gpuInterface.interfaceAbiHash
    || shaderManifest.gpuInterface.modelAbiHash !== receipt.gpuInterface.modelAbiHash
    || receipt.modelAbiHash !== interfaceManifest.modelAbiHash
    || receipt.shaderAbiHash !== shaderManifest.shaderAbiHash
    || evidenceRef.evidenceId !== receipt.qualification.evidenceId
    || shaderManifest.validationEvidence.evidenceId !== evidenceRef.evidenceId
    || evidenceEntrypoint !== evidenceRef.sha256
    || evidenceRef.sha256 !== shaderManifest.validationEvidence.sha256
    || evidenceRef.uri !== shaderManifest.validationEvidence.uri
    || evidenceRef.matrixId !== receipt.qualification.matrixId
    || evidenceRef.matrixVersion !== receipt.qualification.matrixVersion
    || evidenceRef.matrixSha256 !== receipt.qualification.matrixSha256
    || evidenceRef.matrixId !== shaderManifest.validationEvidence.matrixId
    || evidenceRef.matrixVersion !== shaderManifest.validationEvidence.matrixVersion
    || evidenceRef.matrixSha256 !== shaderManifest.validationEvidence.matrixSha256
    || evidenceRef.attestationRef.uri !== shaderManifest.validationEvidence.attestationRef.uri
    || evidenceRef.attestationRef.sha256 !== shaderManifest.validationEvidence.attestationRef.sha256) {
    fail("receipt-incoherent");
  }
  const qualification = receipt.qualification;
  if (!Array.isArray(qualification.moduleDigests)
    || !isDenseArray(qualification.moduleDigests)
    || !Array.isArray(qualification.modelAbiHashes)
    || !isDenseArray(qualification.modelAbiHashes)
    || !Array.isArray(qualification.requiredCompileUnitIds)
    || !isDenseArray(qualification.requiredCompileUnitIds)
    || !Array.isArray(qualification.requiredCellIds)
    || !isDenseArray(qualification.requiredCellIds)
    || qualification.moduleDigests.some((module) => !module
      || typeof module !== "object" || Array.isArray(module)
      || typeof module.moduleId !== "string" || typeof module.sha256 !== "string")
    || qualification.modelAbiHashes.some((hash) =>
      typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash))
    || qualification.requiredCompileUnitIds.some((id) => typeof id !== "string")
    || qualification.requiredCellIds.some((id) => typeof id !== "string")
    || !Number.isSafeInteger(qualification.compileUnits)
    || !Number.isSafeInteger(qualification.cells)
    || !Number.isSafeInteger(qualification.expectedResults)
    || !Number.isSafeInteger(qualification.passedResults)) {
    fail("evidence-incomplete");
  }
  requireTimestamp(qualification.generatedAt, "evidence-incomplete");
  requireSha256(qualification.dataBundleSha256, "evidence-incomplete");
  requireSha256(qualification.shaderManifestCoreSha256, "evidence-incomplete");
  requireSha256(qualification.interfaceManifestSha256, "evidence-incomplete");
  requireSha256(qualification.compileUnitInventorySha256, "evidence-incomplete");
  requireSha256(qualification.subjectBindingSha256, "evidence-incomplete");
  requireSha256(qualification.matrixSha256, "evidence-incomplete");
  const matchingInterface = shaderManifest.compatibleModelInterfaces.some((candidate) =>
    candidate.interfaceId === receipt.gpuInterface.interfaceId
    && candidate.interfaceVersion === receipt.gpuInterface.interfaceVersion
    && candidate.manifestSha256 === receipt.gpuInterface.manifestSha256
    && candidate.interfaceAbiHash === receipt.gpuInterface.interfaceAbiHash
    && candidate.modelAbiHash === receipt.modelAbiHash);
  if (!matchingInterface || !qualification.modelAbiHashes.includes(receipt.modelAbiHash)) {
    fail("receipt-incoherent");
  }
  const receiptModules = qualification.moduleDigests
    .map((module) => `${module.moduleId}:${module.sha256}`).sort(compareText);
  const manifestModules = shaderManifest.modules
    .map((module) => `${module.moduleId}:${module.sha256}`).sort(compareText);
  if (!sameStringArray(receiptModules, manifestModules)) fail("receipt-incoherent");
  if (shaderManifest.modules.length === 0
    || shaderManifest.modules.length > SHADER_LIFECYCLE_LIMITS.shaderModules
    || shaderManifest.additionalValidationEvidence.length !== 0
    || qualification.moduleDigests.length > SHADER_LIFECYCLE_LIMITS.shaderModules
    || qualification.compileUnits <= 0
    || qualification.compileUnits > SHADER_LIFECYCLE_LIMITS.inventoryShaders
    || qualification.cells <= 0
    || qualification.cells > SHADER_LIFECYCLE_LIMITS.profileSemantics
    || qualification.requiredCompileUnitIds.length !== qualification.compileUnits
    || qualification.requiredCellIds.length !== qualification.cells
    || new Set(qualification.requiredCompileUnitIds).size !== qualification.compileUnits
    || new Set(qualification.requiredCellIds).size !== qualification.cells
    || qualification.expectedResults !== qualification.compileUnits * qualification.cells
    || qualification.passedResults !== qualification.expectedResults) {
    fail("evidence-incomplete");
  }
}

async function verifyAdmissionManagedUris(
  receipt: ShaderAdmissionReceipt,
  verifier: ShaderManagedUriVerifier,
  deadline: ReturnType<typeof createPlanningDeadline>,
): Promise<void> {
  const interfaceManifest = receipt.assets.gpuInterface.manifest.gpuInterfaceManifest;
  const shaderManifest = receipt.assets.shader.manifest.shaderManifest;
  const evidenceAsset = receipt.assets.evidence.manifest;
  await requireManagedUri(verifier, {
    assetKind: "gpu-interface",
    assetId: interfaceManifest.interfaceId,
    version: interfaceManifest.interfaceVersion,
    uri: receipt.gpuInterface.manifestUri,
    purpose: "manifest",
  }, deadline.signal, deadline.remainingMs());
  await requireManagedUri(verifier, {
    assetKind: "shader",
    assetId: shaderManifest.shaderId,
    version: shaderManifest.version,
    uri: receipt.shader.manifestUri,
    purpose: "manifest",
  }, deadline.signal, deadline.remainingMs());
  for (const module of shaderManifest.modules) {
    await requireManagedUri(verifier, {
      assetKind: "shader",
      assetId: shaderManifest.shaderId,
      version: shaderManifest.version,
      uri: module.uri,
      purpose: "module",
    }, deadline.signal, deadline.remainingMs());
  }
  await requireManagedUri(verifier, {
    assetKind: "shader-validation-evidence",
    assetId: evidenceAsset.assetId,
    version: evidenceAsset.version,
    uri: evidenceAsset.validationEvidence.uri,
    purpose: "evidence",
  }, deadline.signal, deadline.remainingMs());
  await requireManagedUri(verifier, {
    assetKind: "shader-validation-evidence",
    assetId: evidenceAsset.assetId,
    version: evidenceAsset.version,
    uri: evidenceAsset.validationEvidence.attestationRef.uri,
    purpose: "attestation",
  }, deadline.signal, deadline.remainingMs());
}

async function requireManagedUri(
  verifier: ShaderManagedUriVerifier,
  input: ShaderManagedUriVerificationInput,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<void> {
  requireAssetIdentity(input.assetId, input.version, "managed-uri-invalid");
  requireHttpsUri(input.uri, "managed-uri-invalid");
  let result: boolean;
  try {
    result = await boundedAuthorityCall(
      (boundedSignal) => verifier(Object.freeze({ ...input, signal: boundedSignal })),
      signal,
      timeoutMs,
    );
  } catch (cause) {
    if (cause instanceof ShaderLifecyclePlanningError) throw cause;
    fail("authority-unavailable");
  }
  if (result !== true) fail("managed-uri-invalid");
}

function normalizePromotedShaderClosureDependencies(
  value: PromotedShaderClosureDependencies,
): PromotedShaderClosureDependencies {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !value.gpuInterface || typeof value.gpuInterface !== "object"
    || Array.isArray(value.gpuInterface)
    || !Array.isArray(value.validationEvidence)
    || value.validationEvidence.length === 0
    || value.validationEvidence.length > SHADER_LIFECYCLE_LIMITS.shaderEvidenceScopes + 1
    || !isDenseArray(value.validationEvidence)) {
    fail("profile-shader-not-promoted");
  }
  const [interfaceId, interfaceVersion] = requireAssetIdentity(
    value.gpuInterface.assetId,
    value.gpuInterface.version,
    "profile-shader-not-promoted",
  );
  const gpuInterface = {
    assetId: interfaceId,
    version: interfaceVersion,
    manifestUri: requireHttpsUri(
      value.gpuInterface.manifestUri,
      "profile-shader-not-promoted",
    ),
    manifestSha256: requireSha256(
      value.gpuInterface.manifestSha256,
      "profile-shader-not-promoted",
    ),
  };
  const scopes = new Set<string>();
  const validationEvidence = value.validationEvidence.map((evidence) => {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
      fail("profile-shader-not-promoted");
    }
    const scope = requireToken(evidence.scope, 128, "profile-shader-not-promoted");
    if (scopes.has(scope)) fail("profile-shader-not-promoted");
    scopes.add(scope);
    const [assetId, version] = requireAssetIdentity(
      evidence.assetId,
      evidence.version,
      "profile-shader-not-promoted",
    );
    return {
      scope,
      assetId,
      version,
      evidenceUri: requireHttpsUri(evidence.evidenceUri, "profile-shader-not-promoted"),
      evidenceSha256: requireSha256(evidence.evidenceSha256, "profile-shader-not-promoted"),
      attestationUri: requireHttpsUri(
        evidence.attestationUri,
        "profile-shader-not-promoted",
      ),
      attestationSha256: requireSha256(
        evidence.attestationSha256,
        "profile-shader-not-promoted",
      ),
    };
  });
  if (!scopes.has("universal")) fail("profile-shader-not-promoted");
  return { gpuInterface, validationEvidence };
}

function sameStorageVerification(
  record: PromotedShaderVersionRecord,
  entrypointSha256: Sha256Hex,
  plannedAt: string,
): boolean {
  try {
    return sameStorageVerificationUnchecked(record, entrypointSha256, plannedAt);
  } catch {
    return false;
  }
}

function sameStorageVerificationUnchecked(
  record: PromotedShaderVersionRecord,
  entrypointSha256: Sha256Hex,
  plannedAt: string,
): boolean {
  const verification = record.storageVerification;
  if (!verification || verification.status !== "version-ready") return false;
  const verifiedAt = requireTimestamp(verification.verifiedAt, "profile-shader-not-promoted");
  const age = Date.parse(plannedAt) - Date.parse(verifiedAt);
  const manifest = record.asset.manifest.shaderManifest;
  const dependencies = verification.dependencies;
  if (!dependencies || !dependencies.gpuInterface || !Array.isArray(dependencies.validationEvidence)) {
    return false;
  }
  if (!isDenseArray(dependencies.validationEvidence)
    || dependencies.validationEvidence.length === 0
    || dependencies.validationEvidence.length > SHADER_LIFECYCLE_LIMITS.shaderEvidenceScopes + 1) {
    return false;
  }
  const gpuInterfaceMatches = dependencies.gpuInterface.assetId === manifest.gpuInterface.interfaceId
    && dependencies.gpuInterface.version === manifest.gpuInterface.interfaceVersion
    && dependencies.gpuInterface.manifestUri === manifest.gpuInterface.manifestUri
    && dependencies.gpuInterface.manifestSha256 === manifest.gpuInterface.manifestSha256;
  const universal = dependencies.validationEvidence.find((item) => item.scope === "universal");
  const universalMatches = universal?.assetId === manifest.validationEvidence.evidenceId
    && universal.evidenceUri === manifest.validationEvidence.uri
    && universal.evidenceSha256 === manifest.validationEvidence.sha256
    && universal.attestationUri === manifest.validationEvidence.attestationRef.uri
    && universal.attestationSha256 === manifest.validationEvidence.attestationRef.sha256;
  const additiveMatches = manifest.additionalValidationEvidence.every((expected) => {
    const actual = dependencies.validationEvidence.find((item) => item.scope === expected.scope);
    return actual?.assetId === expected.evidence.evidenceId
      && actual.evidenceUri === expected.evidence.uri
      && actual.evidenceSha256 === expected.evidence.sha256
      && actual.attestationUri === expected.evidence.attestationRef.uri
      && actual.attestationSha256 === expected.evidence.attestationRef.sha256;
  });
  const expectedEvidenceCount = 1 + manifest.additionalValidationEvidence.length;
  const scopes = dependencies.validationEvidence.map((item) => item.scope);
  const packageSha256 = computeShaderLifecyclePackageSha256(record.asset.manifest);
  const closureSha256 = computePromotedShaderClosureSha256({
    shader: record.shader,
    packageSha256,
    qualificationContextSha256: record.qualificationContextSha256,
    dependencies,
  });
  return age >= 0 && age <= ROLLBACK_VERIFICATION_MAX_AGE_MS
    && verification.assetKind === "shader"
    && verification.assetId === record.shader.shaderId
    && verification.version === record.shader.version
    && verification.manifestUri === record.shader.manifestUri
    && verification.manifestSha256 === record.shader.manifestSha256
    && verification.manifestSha256 === entrypointSha256
    && verification.packageSha256 === packageSha256
    && verification.closureSha256 === closureSha256
    && requireSha256(
      record.qualificationContextSha256,
      "profile-shader-not-promoted",
    ) === record.qualificationContextSha256
    && gpuInterfaceMatches
    && universalMatches
    && additiveMatches
    && dependencies.validationEvidence.length === expectedEvidenceCount
    && new Set(scopes).size === scopes.length;
}

function sanitizePromotedShaderRecord(
  record: PromotedShaderVersionRecord,
  manifest: ShaderAssetManifest,
  shader: ShaderVersionRef,
): PromotedShaderVersionRecord {
  const verification = record.storageVerification;
  const dependencies = verification.dependencies;
  return {
    state: "promoted",
    runtimeChannel: record.runtimeChannel,
    catalogRevision: record.catalogRevision,
    qualificationContextSha256: requireSha256(
      record.qualificationContextSha256,
      "profile-shader-not-promoted",
    ),
    promotedAt: record.promotedAt,
    shader: requireShaderRef(shader, "profile-shader-not-promoted"),
    storageVerification: {
      status: "version-ready",
      assetKind: "shader",
      assetId: verification.assetId,
      version: verification.version,
      manifestUri: verification.manifestUri,
      manifestSha256: verification.manifestSha256,
      packageSha256: verification.packageSha256,
      verifiedAt: verification.verifiedAt,
      closureSha256: verification.closureSha256,
      dependencies: {
        gpuInterface: {
          assetId: dependencies.gpuInterface.assetId,
          version: dependencies.gpuInterface.version,
          manifestUri: dependencies.gpuInterface.manifestUri,
          manifestSha256: dependencies.gpuInterface.manifestSha256,
        },
        validationEvidence: dependencies.validationEvidence.map((evidence) => ({
          scope: evidence.scope,
          assetId: evidence.assetId,
          version: evidence.version,
          evidenceUri: evidence.evidenceUri,
          evidenceSha256: evidence.evidenceSha256,
          attestationUri: evidence.attestationUri,
          attestationSha256: evidence.attestationSha256,
        })),
      },
    },
    asset: { manifest, files: new Map() },
  };
}

async function verifyShaderClosureManagedUris(
  manifest: ShaderVersionManifest,
  record: PromotedShaderVersionRecord,
  verifier: ShaderManagedUriVerifier,
  deadline: ReturnType<typeof createPlanningDeadline>,
): Promise<void> {
  const common = {
    assetKind: "shader" as const,
    assetId: manifest.shaderId,
    version: manifest.version,
  };
  await requireManagedUri(verifier, {
    ...common,
    uri: record.shader.manifestUri,
    purpose: "manifest",
  }, deadline.signal, deadline.remainingMs());
  for (const module of manifest.modules) {
    await requireManagedUri(verifier, {
      ...common,
      uri: module.uri,
      purpose: "module",
    }, deadline.signal, deadline.remainingMs());
  }
  const gpu = record.storageVerification.dependencies.gpuInterface;
  await requireManagedUri(verifier, {
    assetKind: "gpu-interface",
    assetId: gpu.assetId,
    version: gpu.version,
    uri: gpu.manifestUri,
    purpose: "manifest",
  }, deadline.signal, deadline.remainingMs());
  for (const evidence of record.storageVerification.dependencies.validationEvidence) {
    await requireManagedUri(verifier, {
      assetKind: "shader-validation-evidence",
      assetId: evidence.assetId,
      version: evidence.version,
      uri: evidence.evidenceUri,
      purpose: "evidence",
    }, deadline.signal, deadline.remainingMs());
    await requireManagedUri(verifier, {
      assetKind: "shader-validation-evidence",
      assetId: evidence.assetId,
      version: evidence.version,
      uri: evidence.attestationUri,
      purpose: "attestation",
    }, deadline.signal, deadline.remainingMs());
  }
}

interface NormalizedShaderRequalificationInventory {
  readonly shaders: Map<string, {
    shader: ShaderVersionRef;
    compileUnits: ShaderCompileUnitQualificationRef[];
  }>;
  readonly profiles: Map<string, { profile: ShaderStyleProfileRef; shaderKeys: string[] }>;
  readonly fixtures: Map<string, {
    fixtureSha256: Sha256Hex;
    shaderKeys: string[];
    profileKeys: string[];
  }>;
}

function normalizeRequalificationInventory(
  inventory: ShaderRequalificationInventory,
  assertActive?: () => void,
): NormalizedShaderRequalificationInventory {
  if (!inventory || !Array.isArray(inventory.shaders)
    || !Array.isArray(inventory.profiles) || !Array.isArray(inventory.modelFixtures)
    || !isDenseArray(inventory.shaders)
    || !isDenseArray(inventory.profiles)
    || !isDenseArray(inventory.modelFixtures)
    || inventory.shaders.length > SHADER_LIFECYCLE_LIMITS.inventoryShaders
    || inventory.profiles.length > SHADER_LIFECYCLE_LIMITS.inventoryProfiles
    || inventory.modelFixtures.length > SHADER_LIFECYCLE_LIMITS.inventoryModelFixtures) {
    fail("requalification-inventory-invalid");
  }
  const shaders = new Map<string, {
    shader: ShaderVersionRef;
    compileUnits: ShaderCompileUnitQualificationRef[];
  }>();
  const compileUnitIds = new Set<string>();
  let edgeCount = 0;
  for (let shaderIndex = 0; shaderIndex < inventory.shaders.length; shaderIndex += 1) {
    if ((shaderIndex & 255) === 0) assertActive?.();
    const item = inventory.shaders[shaderIndex]!;
    assertRecord(item, "requalification-inventory-invalid");
    const shader = requireShaderRef(
      item.shader as ShaderVersionRef,
      "requalification-inventory-invalid",
    );
    const key = shaderIdentityKey(shader, "requalification-inventory-invalid");
    if (shaders.has(key) || !Array.isArray(item.compileUnits)
      || !isDenseArray(item.compileUnits) || item.compileUnits.length === 0
      || compileUnitIds.size + item.compileUnits.length > SHADER_LIFECYCLE_LIMITS.inventoryCompileUnits) {
      fail("requalification-inventory-invalid");
    }
    const units: ShaderCompileUnitQualificationRef[] = [];
    for (let unitIndex = 0; unitIndex < item.compileUnits.length; unitIndex += 1) {
      if ((unitIndex & 255) === 0) assertActive?.();
      const unit = item.compileUnits[unitIndex]!;
      assertRecord(unit, "requalification-inventory-invalid");
      const compileUnitId = requireToken(
        unit.compileUnitId,
        160,
        "requalification-inventory-invalid",
      );
      if (compileUnitIds.has(compileUnitId)) fail("requalification-inventory-invalid");
      compileUnitIds.add(compileUnitId);
      units.push({
        compileUnitId,
        compileUnitSha256: requireSha256(
          unit.compileUnitSha256,
          "requalification-inventory-invalid",
        ),
      });
    }
    units.sort((left, right) => compareText(left.compileUnitId, right.compileUnitId));
    shaders.set(key, { shader: { ...shader }, compileUnits: units });
  }
  if (shaders.size === 0) fail("requalification-inventory-invalid");

  const profiles = new Map<string, { profile: ShaderStyleProfileRef; shaderKeys: string[] }>();
  for (let profileIndex = 0; profileIndex < inventory.profiles.length; profileIndex += 1) {
    if ((profileIndex & 255) === 0) assertActive?.();
    const item = inventory.profiles[profileIndex]!;
    assertRecord(item, "requalification-inventory-invalid");
    if (!Array.isArray(item.shaders) || !isDenseArray(item.shaders)
      || item.shaders.length === 0) {
      fail("requalification-inventory-invalid");
    }
    edgeCount += item.shaders.length;
    if (edgeCount > SHADER_LIFECYCLE_LIMITS.inventoryEdges) {
      fail("requalification-inventory-invalid");
    }
    const profile = requireProfileRef(
      item.profile as ShaderStyleProfileRef,
      "requalification-inventory-invalid",
    );
    assertActive?.();
    const profileShaders = (item.shaders as ShaderVersionRef[]).map((shaderRef) =>
      requireShaderRef(shaderRef, "requalification-inventory-invalid"));
    assertActive?.();
    const key = profileIdentityKey(profile, "requalification-inventory-invalid");
    const shaderKeys = profileShaders.map((shaderRef) =>
      shaderIdentityKey(shaderRef, "requalification-inventory-invalid"));
    if (profiles.has(key) || shaderKeys.length === 0 || new Set(shaderKeys).size !== shaderKeys.length
      || profileShaders.some((shader: ShaderVersionRef, index: number) => {
        const inventoryShader = shaders.get(shaderKeys[index]!);
        return !inventoryShader || !sameShaderRef(inventoryShader.shader, shader);
      })) {
      fail("requalification-inventory-invalid");
    }
    profiles.set(key, { profile: { ...profile }, shaderKeys: shaderKeys.sort(compareText) });
  }

  const fixtures = new Map<string, {
    fixtureSha256: Sha256Hex;
    shaderKeys: string[];
    profileKeys: string[];
  }>();
  for (let fixtureIndex = 0; fixtureIndex < inventory.modelFixtures.length; fixtureIndex += 1) {
    if ((fixtureIndex & 255) === 0) assertActive?.();
    const item = inventory.modelFixtures[fixtureIndex]!;
    assertRecord(item, "requalification-inventory-invalid");
    if (!Array.isArray(item.shaders) || !isDenseArray(item.shaders)
      || !Array.isArray(item.profiles) || !isDenseArray(item.profiles)) {
      fail("requalification-inventory-invalid");
    }
    edgeCount += item.shaders.length + item.profiles.length;
    if (edgeCount > SHADER_LIFECYCLE_LIMITS.inventoryEdges) {
      fail("requalification-inventory-invalid");
    }
    const fixtureId = requireToken(item.fixtureId, 128, "requalification-inventory-invalid");
    const fixtureSha256 = requireSha256(item.fixtureSha256, "requalification-inventory-invalid");
    assertActive?.();
    const fixtureShaders = (item.shaders as ShaderVersionRef[]).map((shaderRef) =>
      requireShaderRef(shaderRef, "requalification-inventory-invalid"));
    const fixtureProfiles = (item.profiles as ShaderStyleProfileRef[]).map((profileRef) =>
      requireProfileRef(profileRef, "requalification-inventory-invalid"));
    assertActive?.();
    const shaderKeys = fixtureShaders.map((shaderRef) =>
      shaderIdentityKey(shaderRef, "requalification-inventory-invalid"));
    const profileKeys = fixtureProfiles.map((profileRef) =>
      profileIdentityKey(profileRef, "requalification-inventory-invalid"));
    if (fixtures.has(fixtureId)
      || new Set(shaderKeys).size !== shaderKeys.length
      || new Set(profileKeys).size !== profileKeys.length
      || fixtureShaders.some((shader: ShaderVersionRef, index: number) => {
        const inventoryShader = shaders.get(shaderKeys[index]!);
        return !inventoryShader || !sameShaderRef(inventoryShader.shader, shader);
      })
      || fixtureProfiles.some((profile: ShaderStyleProfileRef, index: number) => {
        const inventoryProfile = profiles.get(profileKeys[index]!);
        return !inventoryProfile || !sameProfileRef(inventoryProfile.profile, profile);
      })) {
      fail("requalification-inventory-invalid");
    }
    fixtures.set(fixtureId, {
      fixtureSha256,
      shaderKeys: shaderKeys.sort(compareText),
      profileKeys: profileKeys.sort(compareText),
    });
  }
  return { shaders, profiles, fixtures };
}

function serializableRequalificationInventory(inventory: NormalizedShaderRequalificationInventory): unknown {
  return {
    shaders: [...inventory.shaders.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, item]) => ({ shader: item.shader, compileUnits: item.compileUnits })),
    profiles: [...inventory.profiles.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, item]) => ({ profile: item.profile, shaderKeys: item.shaderKeys })),
    modelFixtures: [...inventory.fixtures.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([fixtureId, item]) => ({
        fixtureId,
        fixtureSha256: item.fixtureSha256,
        shaderKeys: item.shaderKeys,
        profileKeys: item.profileKeys,
      })),
  };
}

function expandRequalificationClosure(
  inventory: NormalizedShaderRequalificationInventory,
  selectedShaderKeys: Set<string>,
  selectedProfileKeys: Set<string>,
  selectedFixtureIds: Set<string>,
  assertActive?: () => void,
): void {
  const shaderProfiles = new Map<string, string[]>();
  const shaderFixtures = new Map<string, string[]>();
  const profileFixtures = new Map<string, string[]>();
  let indexedEdges = 0;
  for (const [profileKey, profile] of inventory.profiles) {
    for (const shaderKey of profile.shaderKeys) {
      if ((indexedEdges & 255) === 0) assertActive?.();
      indexedEdges += 1;
      appendIndexValue(shaderProfiles, shaderKey, profileKey);
    }
  }
  for (const [fixtureId, fixture] of inventory.fixtures) {
    for (const shaderKey of fixture.shaderKeys) {
      if ((indexedEdges & 255) === 0) assertActive?.();
      indexedEdges += 1;
      appendIndexValue(shaderFixtures, shaderKey, fixtureId);
    }
    for (const profileKey of fixture.profileKeys) {
      if ((indexedEdges & 255) === 0) assertActive?.();
      indexedEdges += 1;
      appendIndexValue(profileFixtures, profileKey, fixtureId);
    }
  }

  type QueueEntry = { readonly kind: "shader" | "profile" | "fixture"; readonly key: string };
  const queue: QueueEntry[] = [];
  const queued = new Set<string>();
  const enqueue = (kind: QueueEntry["kind"], key: string): void => {
    const queueKey = canonicalizeGpuContract([kind, key]);
    if (!queued.has(queueKey)) {
      queued.add(queueKey);
      queue.push({ kind, key });
    }
  };
  for (const key of selectedShaderKeys) enqueue("shader", key);
  for (const key of selectedProfileKeys) enqueue("profile", key);
  for (const key of selectedFixtureIds) enqueue("fixture", key);

  for (let index = 0; index < queue.length; index += 1) {
    if ((index & 255) === 0) assertActive?.();
    const current = queue[index]!;
    if (current.kind === "shader") {
      for (const profileKey of shaderProfiles.get(current.key) ?? []) {
        if (!selectedProfileKeys.has(profileKey)) selectedProfileKeys.add(profileKey);
        enqueue("profile", profileKey);
      }
      for (const fixtureId of shaderFixtures.get(current.key) ?? []) {
        if (!selectedFixtureIds.has(fixtureId)) selectedFixtureIds.add(fixtureId);
        enqueue("fixture", fixtureId);
      }
    } else if (current.kind === "profile") {
      const profile = inventory.profiles.get(current.key)!;
      for (const shaderKey of profile.shaderKeys) {
        if (!selectedShaderKeys.has(shaderKey)) selectedShaderKeys.add(shaderKey);
        enqueue("shader", shaderKey);
      }
      for (const fixtureId of profileFixtures.get(current.key) ?? []) {
        if (!selectedFixtureIds.has(fixtureId)) selectedFixtureIds.add(fixtureId);
        enqueue("fixture", fixtureId);
      }
    } else {
      const fixture = inventory.fixtures.get(current.key)!;
      for (const shaderKey of fixture.shaderKeys) {
        if (!selectedShaderKeys.has(shaderKey)) selectedShaderKeys.add(shaderKey);
        enqueue("shader", shaderKey);
      }
      for (const profileKey of fixture.profileKeys) {
        if (!selectedProfileKeys.has(profileKey)) selectedProfileKeys.add(profileKey);
        enqueue("profile", profileKey);
      }
    }
  }
}

function appendIndexValue<T>(index: Map<string, T[]>, key: string, value: T): void {
  const values = index.get(key);
  if (values) values.push(value);
  else index.set(key, [value]);
}

function compatibleInterfaceIdentityKey(input: {
  readonly interfaceId: string;
  readonly interfaceVersion: string;
  readonly manifestSha256: Sha256Hex;
  readonly interfaceAbiHash: Sha256Hex;
  readonly modelAbiHash: Sha256Hex;
}): string {
  return canonicalizeGpuContract([
    input.interfaceId,
    input.interfaceVersion,
    input.manifestSha256,
    input.interfaceAbiHash,
    input.modelAbiHash,
  ]);
}

function validateHistoryEntry(entry: ShaderCatalogHistoryEntry): ShaderCatalogHistoryEntry {
  if (!entry || (entry.assetKind !== "shader" && entry.assetKind !== "shader-style-profile")) {
    fail("rollback-target-invalid");
  }
  requireAssetIdentity(entry.assetId, entry.version, "rollback-target-invalid");
  requireHttpsUri(entry.manifestUri, "rollback-target-invalid");
  requireSha256(entry.manifestSha256, "rollback-target-invalid");
  requireSha256(entry.publicationClosureSha256, "rollback-target-invalid");
  requireSha256(entry.qualificationContextSha256, "rollback-target-invalid");
  requireRuntimeChannel(entry.runtimeChannel);
  requireCatalogRevision(entry.catalogRevision);
  requireTimestamp(entry.promotedAt, "rollback-target-invalid");
  if (entry.revokedAt !== null) requireTimestamp(entry.revokedAt, "rollback-target-invalid");
  if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 0
    || !["current", "superseded", "rolled-back", "candidate"].includes(entry.state)
    || !["eligible", "ineligible", "revoked"].includes(entry.rollbackEligibility)
    || (entry.rollbackEligibility === "revoked") !== (entry.revokedAt !== null)) {
    fail("rollback-target-invalid");
  }
  return {
    assetKind: entry.assetKind,
    assetId: entry.assetId,
    version: entry.version,
    manifestUri: entry.manifestUri,
    manifestSha256: entry.manifestSha256,
    publicationClosureSha256: entry.publicationClosureSha256,
    qualificationContextSha256: entry.qualificationContextSha256,
    runtimeChannel: entry.runtimeChannel,
    catalogRevision: entry.catalogRevision,
    sequence: entry.sequence,
    state: entry.state,
    rollbackEligibility: entry.rollbackEligibility,
    revokedAt: entry.revokedAt,
    promotedAt: entry.promotedAt,
  };
}

function validateRollbackShaderDependencies(
  dependencies: readonly ShaderRollbackShaderDependencyVerification[],
  expected?: {
    readonly runtimeChannel: ShaderRuntimeChannel;
    readonly catalogRevision: string;
    readonly qualificationContextSha256: Sha256Hex;
    readonly plannedAt: string;
  },
): (ShaderRollbackShaderDependencyVerification & { readonly verificationExpiresAt: string })[] {
  if (!Array.isArray(dependencies) || !isDenseArray(dependencies)
    || dependencies.length > SHADER_LIFECYCLE_LIMITS.profileRoles) {
    fail("rollback-target-invalid");
  }
  const identities = new Set<string>();
  const normalized = dependencies.map((dependency) => {
    if (!dependency || typeof dependency !== "object" || Array.isArray(dependency)) {
      fail("rollback-target-invalid");
    }
    const shader = requireShaderRef(dependency.shader, "rollback-target-invalid");
    const identity = shaderIdentityKey(shader, "rollback-target-invalid");
    if (identities.has(identity) || dependency.state !== "promoted"
      || dependency.revokedAt !== null
      || !SHADER_RUNTIME_CHANNELS.includes(dependency.runtimeChannel)
      || (expected && dependency.runtimeChannel !== expected.runtimeChannel)
      || (expected && dependency.catalogRevision !== expected.catalogRevision)
      || (expected && dependency.qualificationContextSha256
        !== expected.qualificationContextSha256)) {
      fail("rollback-target-invalid");
    }
    identities.add(identity);
    const catalogRevision = requireToken(
      dependency.catalogRevision,
      128,
      "rollback-target-invalid",
    );
    const qualificationContextSha256 = requireSha256(
      dependency.qualificationContextSha256,
      "rollback-target-invalid",
    );
    const closureSha256 = requireSha256(
      dependency.closureSha256,
      "rollback-target-invalid",
    );
    const verifiedAt = requireTimestamp(dependency.verifiedAt, "rollback-target-invalid");
    const verificationExpiresAt = computeVerificationExpiresAt(
      verifiedAt,
      "rollback-target-invalid",
    );
    if (expected) {
      const age = Date.parse(expected.plannedAt) - Date.parse(verifiedAt);
      if (age < 0 || age > ROLLBACK_VERIFICATION_MAX_AGE_MS) {
        fail("rollback-target-invalid");
      }
    }
    return {
      state: "promoted" as const,
      shader,
      runtimeChannel: dependency.runtimeChannel,
      catalogRevision,
      qualificationContextSha256,
      closureSha256,
      verifiedAt,
      revokedAt: null,
      verificationExpiresAt,
    };
  });
  return normalized.sort((left, right) =>
    compareText(shaderRefKeyForCode(left.shader, "rollback-target-invalid"),
      shaderRefKeyForCode(right.shader, "rollback-target-invalid")));
}

async function resolveQualificationContext(
  authority: Pick<ShaderLifecyclePlanningAuthority, "resolveQualificationContext">,
  receipt: ShaderAdmissionReceipt,
  expectedCatalogRevision: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<ShaderQualificationContextVerification> {
  const interfaceManifest = receipt.assets.gpuInterface.manifest.gpuInterfaceManifest;
  const evidence = receipt.assets.evidence.manifest.validationEvidence;
  const subject: ShaderQualificationContextSubject = deepFreeze({
    admissionContractVersion: receipt.contractVersion,
    shader: requireShaderRef(receipt.shader, "qualification-context-invalid"),
    evidenceId: requireToken(receipt.qualification.evidenceId, 160, "qualification-context-invalid"),
    evidenceSha256: requireSha256(evidence.sha256, "qualification-context-invalid"),
    subjectBindingSha256: requireSha256(
      receipt.qualification.subjectBindingSha256,
      "qualification-context-invalid",
    ),
    matrixId: requireToken(receipt.qualification.matrixId, 160, "qualification-context-invalid"),
    matrixVersion: requireToken(
      receipt.qualification.matrixVersion,
      160,
      "qualification-context-invalid",
    ),
    matrixSha256: requireSha256(
      receipt.qualification.matrixSha256,
      "qualification-context-invalid",
    ),
    gpuInterfaceGeneratedBy: {
      packageVersion: requireToken(
        interfaceManifest.generatedBy.packageVersion,
        160,
        "qualification-context-invalid",
      ),
      reflector: interfaceManifest.generatedBy.reflector,
      reflectorVersion: interfaceManifest.generatedBy.reflectorVersion,
    },
  });
  let verification: ShaderQualificationContextVerification | null;
  try {
    verification = await boundedAuthorityCall(
      (boundedSignal) => authority.resolveQualificationContext({
        expectedCatalogRevision,
        subject,
        signal: boundedSignal,
      }),
      signal,
      timeoutMs,
    );
  } catch (cause) {
    if (cause instanceof ShaderLifecyclePlanningError) throw cause;
    fail("authority-unavailable");
  }
  if (!verification || verification.status !== "current"
    || verification.catalogRevision !== expectedCatalogRevision
    || verification.subjectBindingSha256 !== subject.subjectBindingSha256
    || verification.evidenceSha256 !== subject.evidenceSha256
    || verification.matrixSha256 !== subject.matrixSha256) {
    fail("qualification-context-invalid");
  }
  requireCatalogRevision(verification.catalogRevision);
  const qualificationContextSha256 = requireSha256(
    verification.qualificationContextSha256,
    "qualification-context-invalid",
  );
  return deepFreeze({
    status: "current",
    catalogRevision: expectedCatalogRevision,
    qualificationContextSha256,
    subjectBindingSha256: subject.subjectBindingSha256,
    evidenceSha256: subject.evidenceSha256,
    matrixSha256: subject.matrixSha256,
  });
}

async function resolveApproval(
  authority: Pick<ShaderLifecyclePlanningAuthority, "resolveApproval">,
  approvalIdValue: unknown,
  subject: ShaderLifecycleApproval["subject"],
  plannedAt: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<ShaderLifecycleApproval> {
  const approvalId = requireToken(approvalIdValue, 160, "approval-invalid");
  let input: ShaderLifecycleApproval | null;
  try {
    input = await boundedAuthorityCall(
      (boundedSignal) => authority.resolveApproval({
        approvalId,
        subject: { ...subject },
        signal: boundedSignal,
      }),
      signal,
      timeoutMs,
    );
  } catch (cause) {
    if (cause instanceof ShaderLifecyclePlanningError) throw cause;
    fail("authority-unavailable");
  }
  if (!input || !input.subject || input.approvalId !== approvalId
    || input.subject.purpose !== subject.purpose
    || input.subject.assetKind !== subject.assetKind
    || input.subject.assetId !== subject.assetId
    || input.subject.version !== subject.version
    || input.subject.manifestSha256 !== subject.manifestSha256
    || input.subject.closureSha256 !== subject.closureSha256
    || input.subject.qualificationContextSha256
      !== subject.qualificationContextSha256) fail("approval-invalid");
  if (input.subject.runtimeChannel !== subject.runtimeChannel
    || input.subject.expectedCatalogRevision !== subject.expectedCatalogRevision) {
    fail("approval-invalid");
  }
  requireSha256(input.subject.manifestSha256, "approval-invalid");
  requireSha256(input.subject.closureSha256, "approval-invalid");
  requireSha256(input.subject.qualificationContextSha256, "approval-invalid");
  const approvedBy = requireToken(input.approvedBy, 128, "approval-invalid");
  const approvedAt = requireTimestamp(input.approvedAt, "approval-invalid");
  if (Date.parse(approvedAt) > Date.parse(plannedAt)) fail("approval-invalid");
  return deepFreeze({
    approvalId,
    subject: { ...subject },
    approvedBy,
    approvedAt,
  });
}

async function resolveRollbackAuthorization(
  authority: Pick<ShaderRollbackAuthority, "resolveRollbackAuthorization">,
  authorizationId: string,
  incidentId: string,
  subject: ShaderRollbackAuthorization["subject"],
  plannedAt: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<ShaderRollbackAuthorization> {
  let authorization: ShaderRollbackAuthorization | null;
  try {
    authorization = await boundedAuthorityCall(
      (boundedSignal) => authority.resolveRollbackAuthorization({
        authorizationId,
        incidentId,
        subject: { ...subject },
        signal: boundedSignal,
      }),
      signal,
      timeoutMs,
    );
  } catch (cause) {
    if (cause instanceof ShaderLifecyclePlanningError) throw cause;
    fail("authority-unavailable");
  }
  if (!authorization || !authorization.subject || authorization.status !== "authorized"
    || authorization.authorizationId !== authorizationId
    || authorization.incidentId !== incidentId
    || authorization.subject.assetKind !== subject.assetKind
    || authorization.subject.assetId !== subject.assetId
    || authorization.subject.runtimeChannel !== subject.runtimeChannel
    || authorization.subject.targetVersion !== subject.targetVersion
    || authorization.subject.targetManifestSha256 !== subject.targetManifestSha256
    || authorization.subject.targetPublicationClosureSha256
      !== subject.targetPublicationClosureSha256
    || authorization.subject.targetDependencyClosureSha256
      !== subject.targetDependencyClosureSha256
    || authorization.subject.qualificationContextSha256 !== subject.qualificationContextSha256
    || authorization.subject.expectedCatalogRevision !== subject.expectedCatalogRevision
    || authorization.subject.reasonSha256 !== subject.reasonSha256) {
    fail("rollback-target-invalid");
  }
  requireSha256(authorization.subject.targetManifestSha256, "rollback-target-invalid");
  requireSha256(authorization.subject.targetPublicationClosureSha256, "rollback-target-invalid");
  if (authorization.subject.targetDependencyClosureSha256 !== null) {
    requireSha256(authorization.subject.targetDependencyClosureSha256, "rollback-target-invalid");
  }
  requireSha256(authorization.subject.qualificationContextSha256, "rollback-target-invalid");
  requireSha256(authorization.subject.reasonSha256, "rollback-target-invalid");
  const requestedBy = requireToken(authorization.requestedBy, 128, "rollback-target-invalid");
  const nonce = requireToken(authorization.nonce, 160, "rollback-target-invalid");
  const authorizedAt = requireTimestamp(authorization.authorizedAt, "rollback-target-invalid");
  const expiresAt = requireTimestamp(authorization.expiresAt, "rollback-target-invalid");
  if (Date.parse(authorizedAt) > Date.parse(plannedAt)
    || Date.parse(expiresAt) <= Date.parse(plannedAt)) fail("rollback-target-invalid");
  return deepFreeze({
    status: "authorized",
    authorizationId,
    incidentId,
    nonce,
    subject: { ...subject },
    requestedBy,
    authorizedAt,
    expiresAt,
  });
}

function readAuthorityTime(now: () => string, code: ShaderLifecycleErrorCode): string {
  try {
    return requireTimestamp(now(), code);
  } catch (cause) {
    if (cause instanceof ShaderLifecyclePlanningError) throw cause;
    fail("authority-unavailable");
  }
}

const DEFAULT_AUTHORITY_TIMEOUT_MS = 30_000;
const MAX_AUTHORITY_TIMEOUT_MS = 120_000;

function createPlanningDeadline(parentSignal?: AbortSignal, timeoutMs?: number): {
  readonly signal?: AbortSignal;
  remainingMs(): number;
} {
  const duration = timeoutMs ?? DEFAULT_AUTHORITY_TIMEOUT_MS;
  if (!Number.isInteger(duration) || duration < 1 || duration > MAX_AUTHORITY_TIMEOUT_MS) {
    fail("invalid-input");
  }
  if (parentSignal?.aborted) fail("aborted");
  const expiresAt = performance.now() + duration;
  return {
    signal: parentSignal,
    remainingMs(): number {
      if (parentSignal?.aborted) fail("aborted");
      const remaining = Math.ceil(expiresAt - performance.now());
      if (remaining < 1) fail("timeout");
      return remaining;
    },
  };
}

async function boundedAuthorityCall<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  const duration = timeoutMs ?? DEFAULT_AUTHORITY_TIMEOUT_MS;
  if (!Number.isInteger(duration) || duration < 1 || duration > MAX_AUTHORITY_TIMEOUT_MS) {
    fail("invalid-input");
  }
  if (parentSignal?.aborted) fail("aborted");
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort();
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  if (parentSignal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), duration);
  try {
    return await new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        reject(new ShaderLifecyclePlanningError(parentSignal?.aborted ? "aborted" : "timeout"));
      };
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) {
        controller.signal.removeEventListener("abort", abort);
        abort();
        return;
      }
      let pending: Promise<T>;
      try {
        pending = operation(controller.signal);
      } catch (cause) {
        controller.signal.removeEventListener("abort", abort);
        reject(cause);
        return;
      }
      void pending.then(
        (value) => {
          controller.signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (cause: unknown) => {
          controller.signal.removeEventListener("abort", abort);
          reject(cause);
        },
      );
    });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function assertBoundedManifestFiles(
  manifest: unknown,
  maximumFiles: number,
  code: ShaderLifecycleErrorCode,
): void {
  assertRecord(manifest, code);
  requireDenseBoundedArray(manifest.files, 1, maximumFiles, code);
}

function copyBoundedFileMap(
  files: Map<string, Uint8Array>,
  maximumFiles: number,
  maximumBytes: number,
  code: ShaderLifecycleErrorCode,
): Map<string, Uint8Array> {
  measureBoundedFileMap(files, maximumFiles, maximumBytes, code);
  const copy = new Map<string, Uint8Array>();
  for (const [path, bytes] of files) {
    copy.set(path, bytes.slice());
  }
  return copy;
}

function measureBoundedFileMap(
  files: unknown,
  maximumFiles: number,
  maximumBytes: number,
  code: ShaderLifecycleErrorCode,
): { readonly files: number; readonly bytes: number } {
  if (!(files instanceof Map) || files.size === 0 || files.size > maximumFiles) fail(code);
  let totalBytes = 0;
  for (const [path, bytes] of files) {
    if (typeof path !== "string" || path.length === 0 || path.length > 1_024
      || !(bytes instanceof Uint8Array)) fail(code);
    totalBytes += bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumBytes) fail(code);
  }
  return { files: files.size, bytes: totalBytes };
}

function createLifecyclePublicationPackage(
  manifest: GpuAssetManifest,
  filesValue: unknown,
  code: ShaderLifecycleErrorCode,
): ShaderLifecyclePublicationPackage {
  if (!manifest || !manifest.assetKind) fail(code);
  assertRawGpuAssetManifestPreflight(manifest, code);
  let manifestCopy: GpuAssetManifest;
  try {
    manifestCopy = createGpuAssetManifest(
      JSON.parse(canonicalizeGpuContract(manifest)) as GpuAssetManifest,
    );
  } catch {
    fail(code);
  }
  const files = copyBoundedFileMap(
    filesValue as Map<string, Uint8Array>,
    SHADER_LIFECYCLE_LIMITS.publicationFiles,
    SHADER_LIFECYCLE_LIMITS.publicationBytes,
    code,
  );
  const packageSha256 = computeShaderLifecyclePackageSha256(manifestCopy);
  const copyFiles = (): Map<string, Uint8Array> => {
    const copy = new Map<string, Uint8Array>();
    for (const [path, bytes] of files) copy.set(path, bytes.slice());
    return copy;
  };
  return Object.freeze({
    assetKind: manifestCopy.assetKind,
    assetId: manifestCopy.assetId,
    version: manifestCopy.version,
    manifest: manifestCopy,
    packageSha256,
    copyFiles,
  });
}

function normalizeGpuAssetManifestForClosure(
  manifest: GpuAssetManifest,
  expectedKind: GpuAssetManifest["assetKind"],
): GpuAssetManifest {
  if (!manifest || manifest.assetKind !== expectedKind) fail("receipt-incoherent");
  try {
    return createGpuAssetManifest(
      JSON.parse(canonicalizeGpuContract(manifest)) as GpuAssetManifest,
    );
  } catch (cause) {
    if (cause instanceof ShaderLifecyclePlanningError) throw cause;
    fail("receipt-incoherent");
  }
}

function assertBoundedRawManifestGraph(
  root: unknown,
  code: ShaderLifecycleErrorCode,
): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: root, depth: 0 },
  ];
  let nodes = 0;
  let properties = 0;
  let edges = 0;
  let textCharacters = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (typeof current.value === "string") {
      if (current.value.length > SHADER_LIFECYCLE_LIMITS.rawManifestTextCharacters) fail(code);
      textCharacters += current.value.length;
      if (textCharacters > SHADER_LIFECYCLE_LIMITS.rawManifestGraphTextCharacters) fail(code);
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (current.depth > SHADER_LIFECYCLE_LIMITS.rawManifestGraphDepth) fail(code);
    nodes += 1;
    if (nodes > SHADER_LIFECYCLE_LIMITS.rawManifestGraphNodes) fail(code);
    if (Array.isArray(current.value)) {
      if (Object.getPrototypeOf(current.value) !== Array.prototype) fail(code);
      const entries = requireDenseBoundedArray(
        current.value,
        0,
        SHADER_LIFECYCLE_LIMITS.rawManifestArrayEntries,
        code,
      );
      if (entries.length > SHADER_LIFECYCLE_LIMITS.rawManifestGraphEdges - edges
        || entries.length > SHADER_LIFECYCLE_LIMITS.rawManifestGraphEdges - pending.length) {
        fail(code);
      }
      edges += entries.length;
      for (let index = 0; index < entries.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(entries, String(index));
        if (!descriptor || descriptor.get || descriptor.set) fail(code);
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) fail(code);

    let objectProperties = 0;
    for (const key in current.value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(current.value, key)) continue;
      objectProperties += 1;
      properties += 1;
      if (objectProperties > SHADER_LIFECYCLE_LIMITS.rawManifestObjectProperties
        || properties > SHADER_LIFECYCLE_LIMITS.rawManifestGraphProperties) fail(code);
      if (key.length > SHADER_LIFECYCLE_LIMITS.rawManifestTextCharacters) fail(code);
      textCharacters += key.length;
      if (textCharacters > SHADER_LIFECYCLE_LIMITS.rawManifestGraphTextCharacters) fail(code);
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (!descriptor || descriptor.get || descriptor.set) fail(code);
      if (edges >= SHADER_LIFECYCLE_LIMITS.rawManifestGraphEdges
        || pending.length >= SHADER_LIFECYCLE_LIMITS.rawManifestGraphEdges) fail(code);
      edges += 1;
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
}

function countBoundedOwnEnumerableProperties(
  value: unknown,
  maximum: number,
  code: ShaderLifecycleErrorCode,
): number {
  assertRecord(value, code);
  let count = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    count += 1;
    if (count > maximum) fail(code);
  }
  return count;
}

function assertRawGpuAssetManifestPreflight(
  manifest: unknown,
  code: ShaderLifecycleErrorCode,
): void {
  assertRecord(manifest, code);
  assertBoundedManifestFiles(manifest, SHADER_LIFECYCLE_LIMITS.publicationFiles, code);
  if (manifest.assetKind === "shader-style-profile") {
    assertRawProfileAssetManifestPreflight(manifest, code);
  } else if (manifest.assetKind === "shader") {
    assertRawShaderAssetManifestPreflight(manifest, code);
  } else if (manifest.assetKind === "gpu-interface") {
    assertRawGpuInterfaceAssetManifestPreflight(manifest, code);
  } else if (manifest.assetKind === "model") {
    requireDenseBoundedArray(
      manifest.providedSemantics,
      0,
      SHADER_LIFECYCLE_LIMITS.profileSemantics,
      code,
    );
  }
  assertBoundedRawManifestGraph(manifest, code);
}

function assertRawGpuInterfaceAssetManifestPreflight(
  manifest: unknown,
  code: ShaderLifecycleErrorCode,
): void {
  assertRecord(manifest, code);
  assertBoundedManifestFiles(manifest, SHADER_LIFECYCLE_LIMITS.publicationFiles, code);
  assertRecord(manifest.gpuInterfaceManifest, code);
  const gpuInterfaceManifest = manifest.gpuInterfaceManifest;
  requireDenseBoundedArray(
    gpuInterfaceManifest.modules,
    1,
    SHADER_LIFECYCLE_LIMITS.gpuInterfaceModules,
    code,
  );
  requireDenseBoundedArray(
    gpuInterfaceManifest.records,
    0,
    SHADER_LIFECYCLE_LIMITS.gpuInterfaceRecords,
    code,
  );
  requireDenseBoundedArray(
    gpuInterfaceManifest.bindings,
    0,
    SHADER_LIFECYCLE_LIMITS.gpuInterfaceBindings,
    code,
  );
  requireDenseBoundedArray(
    gpuInterfaceManifest.entryPoints,
    1,
    SHADER_LIFECYCLE_LIMITS.gpuInterfaceEntryPoints,
    code,
  );
  requireDenseBoundedArray(
    gpuInterfaceManifest.vertexInputs,
    0,
    SHADER_LIFECYCLE_LIMITS.gpuInterfaceVertexInputs,
    code,
  );
  requireDenseBoundedArray(
    gpuInterfaceManifest.overrides,
    0,
    SHADER_LIFECYCLE_LIMITS.gpuInterfaceOverrides,
    code,
  );
  assertRecord(gpuInterfaceManifest.modelAbi, code);
  for (const projection of [
    gpuInterfaceManifest.modelAbi.recordNames,
    gpuInterfaceManifest.modelAbi.bindings,
    gpuInterfaceManifest.modelAbi.vertexInputs,
    gpuInterfaceManifest.modelAbi.semantics,
  ]) {
    requireDenseBoundedArray(
      projection,
      0,
      SHADER_LIFECYCLE_LIMITS.gpuInterfaceModelAbiEntries,
      code,
    );
  }
}

function assertRawProfileAssetManifestPreflight(
  manifest: unknown,
  code: ShaderLifecycleErrorCode,
): void {
  assertRecord(manifest, code);
  assertBoundedManifestFiles(manifest, SHADER_LIFECYCLE_LIMITS.profileFiles, code);
  assertRawProfileManifestPreflight(manifest.styleProfileManifest, code);
}

function assertRawProfileManifestPreflight(
  manifest: unknown,
  code: ShaderLifecycleErrorCode,
): asserts manifest is ShaderStyleProfileAssetManifest["styleProfileManifest"] {
  assertRecord(manifest, code);
  requireDenseBoundedArray(
    manifest.roles,
    1,
    SHADER_LIFECYCLE_LIMITS.profileRoles,
    code,
  );
  requireDenseBoundedArray(
    manifest.compatibleModelInterfaces,
    1,
    SHADER_LIFECYCLE_LIMITS.profileInterfaces,
    code,
  );
  requireDenseBoundedArray(
    manifest.requiredValidationScopes,
    0,
    SHADER_LIFECYCLE_LIMITS.profileValidationScopes,
    code,
  );
  requireDenseBoundedArray(
    manifest.requiredSemantics,
    0,
    SHADER_LIFECYCLE_LIMITS.profileSemantics,
    code,
  );
}

function assertRawShaderAssetManifestPreflight(
  manifest: unknown,
  code: ShaderLifecycleErrorCode,
): void {
  assertRecord(manifest, code);
  assertBoundedManifestFiles(manifest, SHADER_LIFECYCLE_LIMITS.promotedShaderFiles, code);
  assertRawShaderManifestPreflight(manifest.shaderManifest, code);
}

function assertRawShaderManifestPreflight(
  manifest: unknown,
  code: ShaderLifecycleErrorCode,
): asserts manifest is ShaderVersionManifest {
  assertRecord(manifest, code);
  requireDenseBoundedArray(
    manifest.modules,
    1,
    SHADER_LIFECYCLE_LIMITS.shaderModules,
    code,
  );
  const pipelines = requireDenseBoundedArray<Record<string, unknown>>(
    manifest.pipelines,
    1,
    SHADER_LIFECYCLE_LIMITS.shaderPipelines,
    code,
  );
  const renderRoles = requireDenseBoundedArray<Record<string, unknown>>(
    manifest.renderRoles,
    1,
    SHADER_LIFECYCLE_LIMITS.profileRoles,
    code,
  );
  requireDenseBoundedArray(
    manifest.compatibleModelInterfaces,
    1,
    SHADER_LIFECYCLE_LIMITS.profileInterfaces,
    code,
  );
  requireDenseBoundedArray(
    manifest.additionalValidationEvidence,
    0,
    SHADER_LIFECYCLE_LIMITS.shaderEvidenceScopes,
    code,
  );
  assertRecord(manifest.requirements, code);
  requireDenseBoundedArray(
    manifest.requirements.semantics,
    0,
    SHADER_LIFECYCLE_LIMITS.profileSemantics,
    code,
  );
  requireDenseBoundedArray(
    manifest.requirements.features,
    0,
    SHADER_LIFECYCLE_LIMITS.shaderRequirementFeatures,
    code,
  );
  requireDenseBoundedArray(
    manifest.requirements.limits,
    0,
    SHADER_LIFECYCLE_LIMITS.shaderRequirementLimits,
    code,
  );
  requireDenseBoundedArray(
    manifest.requirements.formats,
    0,
    SHADER_LIFECYCLE_LIMITS.shaderRequirementFormats,
    code,
  );

  let bindGroupCount = 0;
  let bindGroupEntryCount = 0;
  let stageConstantCount = 0;
  for (const pipeline of pipelines) {
    assertRecord(pipeline, code);
    assertRecord(pipeline.layout, code);
    const bindGroups = requireDenseBoundedArray<Record<string, unknown>>(
      pipeline.layout.bindGroups,
      0,
      SHADER_LIFECYCLE_LIMITS.shaderPipelineBindGroups - bindGroupCount,
      code,
    );
    bindGroupCount += bindGroups.length;
    for (const bindGroup of bindGroups) {
      assertRecord(bindGroup, code);
      const entries = requireDenseBoundedArray(
        bindGroup.entries,
        0,
        Math.min(
          SHADER_LIFECYCLE_LIMITS.shaderPipelineEntriesPerBindGroup,
          SHADER_LIFECYCLE_LIMITS.shaderPipelineBindGroupEntries - bindGroupEntryCount,
        ),
        code,
      );
      bindGroupEntryCount += entries.length;
    }
    for (const stage of [pipeline.compute, pipeline.vertex, pipeline.fragment]) {
      if (stage === undefined || stage === null) continue;
      assertRecord(stage, code);
      const constants = countBoundedOwnEnumerableProperties(
        stage.constants,
        Math.min(
          SHADER_LIFECYCLE_LIMITS.shaderPipelineStageConstants,
          SHADER_LIFECYCLE_LIMITS.shaderPipelineStageConstantsAggregate - stageConstantCount,
        ),
        code,
      );
      stageConstantCount += constants;
    }
  }

  let pipelineIdCount = 0;
  for (const role of renderRoles) {
    assertRecord(role, code);
    const pipelineIds = requireDenseBoundedArray(
      role.pipelineIds,
      1,
      SHADER_LIFECYCLE_LIMITS.shaderRenderRolePipelineIds - pipelineIdCount,
      code,
    );
    pipelineIdCount += pipelineIds.length;
  }
}

function assertRawAdmissionReceiptPreflight(
  receipt: unknown,
  code: ShaderLifecycleErrorCode,
): asserts receipt is ShaderAdmissionReceipt {
  assertRecord(receipt, code);
  assertRecord(receipt.plan, code);
  requireDenseBoundedArray(
    receipt.plan.steps,
    SHADER_ADMISSION_OPERATIONS.length,
    SHADER_ADMISSION_OPERATIONS.length,
    code,
  );
  assertBoundedRawManifestGraph(receipt.plan, code);
  assertRecord(receipt.assets, code);
  assertRecord(receipt.assets.gpuInterface, code);
  assertRawGpuAssetManifestPreflight(receipt.assets.gpuInterface.manifest, code);
  assertRecord(receipt.assets.evidence, code);
  assertRawGpuAssetManifestPreflight(receipt.assets.evidence.manifest, code);
  assertRecord(receipt.assets.shader, code);
  assertRawGpuAssetManifestPreflight(receipt.assets.shader.manifest, code);
  assertRecord(receipt.qualification, code);
  requireDenseBoundedArray(
    receipt.qualification.moduleDigests,
    0,
    SHADER_LIFECYCLE_LIMITS.shaderModules,
    code,
  );
  requireDenseBoundedArray(
    receipt.qualification.modelAbiHashes,
    0,
    SHADER_LIFECYCLE_LIMITS.compatibleModels,
    code,
  );
  requireDenseBoundedArray(
    receipt.qualification.requiredCompileUnitIds,
    0,
    SHADER_LIFECYCLE_LIMITS.inventoryShaders,
    code,
  );
  requireDenseBoundedArray(
    receipt.qualification.requiredCellIds,
    0,
    SHADER_LIFECYCLE_LIMITS.profileSemantics,
    code,
  );
  assertBoundedRawManifestGraph(receipt.shader, code);
  assertBoundedRawManifestGraph(receipt.gpuInterface, code);
  assertBoundedRawManifestGraph(receipt.qualification, code);
}

function assertRawCompatibleModelsPreflight(value: unknown): void {
  const models = requireDenseBoundedArray<Record<string, unknown>>(
    value,
    0,
    SHADER_LIFECYCLE_LIMITS.compatibleModels,
    "profile-incompatible",
  );
  let semanticTokens = 0;
  for (const model of models) {
    assertRecord(model, "profile-incompatible");
    const semantics = requireDenseBoundedArray(
      model.providedSemantics,
      0,
      SHADER_LIFECYCLE_LIMITS.profileSemantics,
      "profile-incompatible",
    );
    if (semantics.length > SHADER_LIFECYCLE_LIMITS.compatibleModelSemanticTokens
      - semanticTokens) fail("profile-incompatible");
    semanticTokens += semantics.length;
  }
  assertBoundedRawManifestGraph(models, "profile-incompatible");
}

function assertBoundedProfileManifest(
  manifest: ShaderStyleProfileAssetManifest["styleProfileManifest"],
): void {
  assertRawProfileManifestPreflight(manifest, "profile-invalid");
  requireAssetIdentity(manifest.profileId, manifest.version, "profile-invalid");
  for (const role of manifest.roles) {
    if (!role || typeof role !== "object" || Array.isArray(role)) fail("profile-invalid");
    requireShaderRef(role.shader, "profile-invalid");
  }
  assertUniqueLogicalInterfaces(manifest.compatibleModelInterfaces, "profile-invalid");
  for (const scope of manifest.requiredValidationScopes) {
    assertValidationMatrixIdentity(scope, "profile-invalid");
  }
}

function assertBoundedShaderManifest(
  manifest: ShaderVersionManifest,
  code: ShaderLifecycleErrorCode = "profile-shader-not-promoted",
): void {
  assertRawShaderManifestPreflight(manifest, code);
  requireAssetIdentity(manifest.shaderId, manifest.version, code);
  assertGpuInterfaceRefIdentity(manifest.gpuInterface, code);
  assertUniqueLogicalInterfaces(
    manifest.compatibleModelInterfaces,
    code,
  );
  assertValidationMatrixIdentity(manifest.validationEvidence, code);
  for (const scopedEvidence of manifest.additionalValidationEvidence) {
    if (!scopedEvidence || typeof scopedEvidence !== "object" || Array.isArray(scopedEvidence)) {
      fail(code);
    }
    assertValidationMatrixIdentity(scopedEvidence.evidence, code);
  }
}

function assertUniqueLogicalInterfaces(
  interfaces: readonly { readonly interfaceId: string; readonly interfaceVersion: string }[],
  code: ShaderLifecycleErrorCode,
): void {
  const identities = new Set<string>();
  for (const item of interfaces) {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(code);
    const [interfaceId, interfaceVersion] = requireAssetIdentity(
      item.interfaceId,
      item.interfaceVersion,
      code,
    );
    const identity = canonicalizeGpuContract([interfaceId, interfaceVersion]);
    if (identities.has(identity)) fail(code);
    identities.add(identity);
  }
}

function assertGpuInterfaceRefIdentity(
  value: unknown,
  code: ShaderLifecycleErrorCode,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const ref = value as { readonly interfaceId?: unknown; readonly interfaceVersion?: unknown };
  requireAssetIdentity(ref.interfaceId, ref.interfaceVersion, code);
}

function requireGpuInterfaceRef(
  value: unknown,
  code: ShaderLifecycleErrorCode,
): ShaderAdmissionReceipt["gpuInterface"] {
  assertRecord(value, code);
  const [interfaceId, interfaceVersion] = requireAssetIdentity(
    value.interfaceId,
    value.interfaceVersion,
    code,
  );
  return {
    interfaceId,
    interfaceVersion,
    manifestUri: requireHttpsUri(value.manifestUri, code),
    manifestSha256: requireSha256(value.manifestSha256, code),
    interfaceAbiHash: requireSha256(value.interfaceAbiHash, code),
    modelAbiHash: requireSha256(value.modelAbiHash, code),
  };
}

function assertValidationMatrixIdentity(
  value: unknown,
  code: ShaderLifecycleErrorCode,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const ref = value as { readonly matrixVersion?: unknown };
  requireImmutableVersion(ref.matrixVersion, code);
}

function assertModelCompatibilityIdentities(
  value: unknown,
  code: ShaderLifecycleErrorCode,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const model = value as {
    readonly modelId?: unknown;
    readonly version?: unknown;
    readonly gpuInterface?: unknown;
    readonly defaultStyleProfile?: unknown;
  };
  requireAssetIdentity(model.modelId, model.version, code);
  assertGpuInterfaceRefIdentity(model.gpuInterface, code);
  if (model.defaultStyleProfile !== null) {
    requireProfileRef(model.defaultStyleProfile as ShaderStyleProfileRef, code);
  }
}

function requireBoundedArray<T>(
  value: unknown,
  maximum: number,
  code: ShaderLifecycleErrorCode,
): readonly T[] {
  return requireDenseBoundedArray(value, 0, maximum, code);
}

function requireDenseBoundedArray<T = unknown>(
  value: unknown,
  minimum: number,
  maximum: number,
  code: ShaderLifecycleErrorCode,
): readonly T[] {
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)
    || minimum < 0 || maximum < minimum
    || !Array.isArray(value)
    || value.length < minimum
    || value.length > maximum
    || !isDenseArray(value)) fail(code);
  return value as readonly T[];
}

function isDenseArray(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return false;
  }
  return true;
}

function requireProfileRef(
  ref: ShaderStyleProfileRef,
  code: ShaderLifecycleErrorCode,
): ShaderStyleProfileRef {
  if (!ref) fail(code);
  const [profileId, version] = requireAssetIdentity(ref.profileId, ref.version, code);
  const manifestUri = requireHttpsUri(ref.manifestUri, code);
  const manifestSha256 = requireSha256(ref.manifestSha256, code);
  return {
    profileId,
    version,
    manifestUri,
    manifestSha256,
  };
}

function requireRuntimeChannel(value: unknown): ShaderRuntimeChannel {
  if (typeof value !== "string" || !SHADER_RUNTIME_CHANNELS.includes(value as ShaderRuntimeChannel)) {
    fail("runtime-channel-invalid");
  }
  return value as ShaderRuntimeChannel;
}

function requireCatalogRevision(value: unknown): string {
  return requireToken(value, 128, "catalog-revision-invalid");
}

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 160
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    fail("idempotency-key-invalid");
  }
  return value;
}

function requireTimestamp(value: unknown, code: ShaderLifecycleErrorCode): string {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) fail(code);
  const parsed = new Date(value);
  if (parsed.toISOString() !== value) fail(code);
  return value;
}

function computeVerificationExpiresAt(
  verifiedAtValue: unknown,
  code: ShaderLifecycleErrorCode,
): string {
  const verifiedAt = requireTimestamp(verifiedAtValue, code);
  const expiresAt = Date.parse(verifiedAt) + ROLLBACK_VERIFICATION_MAX_AGE_MS;
  if (!Number.isSafeInteger(expiresAt) || expiresAt > 8_640_000_000_000_000) fail(code);
  try {
    return new Date(expiresAt).toISOString();
  } catch {
    fail(code);
  }
}

function requireToken(value: unknown, maxLength: number, code: ShaderLifecycleErrorCode): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength
    || value.trim() !== value || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)) {
    fail(code);
  }
  return value;
}

function requireAssetIdentity(
  assetIdValue: unknown,
  versionValue: unknown,
  code: ShaderLifecycleErrorCode,
): readonly [string, string] {
  try {
    const assetId = assertAssetId(assetIdValue);
    const version = requireImmutableVersion(versionValue, code);
    return [assetId, version] as const;
  } catch {
    fail(code);
  }
}

function requireImmutableVersion(
  value: unknown,
  code: ShaderLifecycleErrorCode,
): string {
  try {
    return assertImmutableAssetVersion(value);
  } catch {
    fail(code);
  }
}

function requireBoundedText(value: unknown, maxLength: number, code: ShaderLifecycleErrorCode): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength
    || [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })) {
    fail(code);
  }
  return value.trim();
}

function requireHttpsUri(value: unknown, code: ShaderLifecycleErrorCode): string {
  if (typeof value !== "string" || value.length > 2_048) fail(code);
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    fail(code);
  }
  if (uri.protocol !== "https:" || uri.username || uri.password || uri.hash || uri.search
    || uri.toString() !== value) fail(code);
  return value;
}

function requireSha256(value: unknown, code: ShaderLifecycleErrorCode): Sha256Hex {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(code);
  return value as Sha256Hex;
}

function requireEntrypointDigest(
  manifest: { readonly entrypoint: string; readonly files: readonly { readonly path: string; readonly sha256: string }[] },
  code: ShaderLifecycleErrorCode,
): Sha256Hex {
  const matches = manifest.files.filter((file) => file.path === manifest.entrypoint);
  if (matches.length !== 1) fail(code);
  return requireSha256(matches[0]!.sha256, code);
}

function shaderRefKey(ref: ShaderVersionRef): string {
  return shaderRefKeyForCode(ref, "requalification-inventory-invalid");
}

function shaderRefKeyForCode(ref: ShaderVersionRef, code: ShaderLifecycleErrorCode): string {
  const validated = requireShaderRef(ref, code);
  return canonicalizeGpuContract([
    validated.shaderId,
    validated.version,
    validated.manifestSha256,
    validated.manifestUri,
  ]);
}

function requireShaderRef(
  ref: ShaderVersionRef,
  code: ShaderLifecycleErrorCode,
): ShaderVersionRef {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) fail(code);
  const [shaderId, version] = requireAssetIdentity(ref.shaderId, ref.version, code);
  const manifestUri = requireHttpsUri(ref.manifestUri, code);
  const manifestSha256 = requireSha256(ref.manifestSha256, code);
  return {
    shaderId,
    version,
    manifestUri,
    manifestSha256,
  };
}

function shaderIdentityKey(
  ref: ShaderVersionRef,
  code: ShaderLifecycleErrorCode = "profile-invalid",
): string {
  const validated = requireShaderRef(ref, code);
  return canonicalizeGpuContract([validated.shaderId, validated.version]);
}

function profileIdentityKey(
  ref: ShaderStyleProfileRef,
  code: ShaderLifecycleErrorCode = "requalification-inventory-invalid",
): string {
  const validated = requireProfileRef(ref, code);
  return canonicalizeGpuContract([validated.profileId, validated.version]);
}

function profileRefKey(ref: ShaderStyleProfileRef): string {
  if (!ref) fail("requalification-inventory-invalid");
  requireAssetIdentity(ref.profileId, ref.version, "requalification-inventory-invalid");
  requireHttpsUri(ref.manifestUri, "requalification-inventory-invalid");
  requireSha256(ref.manifestSha256, "requalification-inventory-invalid");
  return canonicalizeGpuContract([
    ref.profileId,
    ref.version,
    ref.manifestSha256,
    ref.manifestUri,
  ]);
}

function sameShaderRef(left: ShaderVersionRef, right: ShaderVersionRef): boolean {
  return left.shaderId === right.shaderId && left.version === right.version
    && left.manifestUri === right.manifestUri && left.manifestSha256 === right.manifestSha256;
}

function sameProfileRef(left: ShaderStyleProfileRef, right: ShaderStyleProfileRef): boolean {
  return left.profileId === right.profileId && left.version === right.version
    && left.manifestUri === right.manifestUri && left.manifestSha256 === right.manifestSha256;
}

function sameCompatibleInterface(
  left: ShaderVersionManifest["compatibleModelInterfaces"][number],
  right: ShaderVersionManifest["compatibleModelInterfaces"][number],
): boolean {
  return left.interfaceId === right.interfaceId
    && left.interfaceVersion === right.interfaceVersion
    && left.manifestSha256 === right.manifestSha256
    && left.interfaceAbiHash === right.interfaceAbiHash
    && left.modelAbiHash === right.modelAbiHash;
}

function assertDistinctProfileEvidence(
  shaders: ReadonlyMap<string, { readonly manifest: ShaderVersionManifest }>,
): void {
  const evidenceIds = new Map<string, string>();
  const artifactUris = new Map<string, string>();
  const artifactDigests = new Map<string, string>();
  for (const [shaderKey, shader] of shaders) {
    const evidenceValues = [
      shader.manifest.validationEvidence,
      ...shader.manifest.additionalValidationEvidence.map((item) => item.evidence),
    ];
    for (const evidence of evidenceValues) {
      const claims = [
        [evidence.evidenceId, evidenceIds],
        [evidence.uri, artifactUris],
        [evidence.attestationRef.uri, artifactUris],
        [evidence.sha256, artifactDigests],
        [evidence.attestationRef.sha256, artifactDigests],
      ] as const;
      for (const [value, owners] of claims) {
        const existing = owners.get(value);
        if (existing !== undefined && existing !== shaderKey) fail("profile-incompatible");
        owners.set(value, shaderKey);
      }
    }
  }
}

function requireUniqueValues<T extends string>(
  values: readonly T[],
  allowed: readonly T[],
  code: ShaderLifecycleErrorCode,
): T[] {
  if (!Array.isArray(values) || !isDenseArray(values) || values.length > allowed.length
    || values.some((value) => !allowed.includes(value))) fail(code);
  if (new Set(values).size !== values.length) fail(code);
  return [...values];
}

function uniqueSorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const value of values) byKey.set(key(value), value);
  return [...byKey.entries()].sort(([left], [right]) => compareText(left, right)).map(([, value]) => value);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fingerprintValue(value: unknown): Sha256Hex {
  return createHash("sha256").update(canonicalizeGpuContract(value)).digest("hex") as Sha256Hex;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertRecord(value: unknown, code: ShaderLifecycleErrorCode): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: ShaderLifecycleErrorCode): never {
  throw new ShaderLifecyclePlanningError(code);
}
