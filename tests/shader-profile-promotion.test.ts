import { describe, expect, it, vi } from "vitest";

import {
  ASSET_JSON_CONTENT_TYPE,
  ASSET_WGSL_CONTENT_TYPE,
  createShaderAssetManifest,
  createShaderStyleProfileAssetManifest,
  type AssetFileDescriptor,
  type ModelGpuCompatibilityDescriptor,
  type ShaderAssetManifest,
  type ShaderStyleProfileAssetManifest,
  type ShaderStyleProfileRef,
  type ShaderVersionRef,
  type Sha256Hex,
} from "@plasius/asset-contracts";
import {
  SHADER_STYLE_PROFILE_MANIFEST_VERSION,
  SHADER_VERSION_MANIFEST_VERSION,
  SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES,
  canonicalizeGpuContract,
  computeSha256,
  type GpuInterfaceRef,
  type ShaderStyleProfileManifest,
  type ShaderValidationEvidenceRef,
  type ShaderVersionManifest,
} from "@plasius/gpu-shader";
import {
  SHADER_LIFECYCLE_LIMITS,
  ShaderLifecyclePlanningError,
  assertShaderLifecyclePlanExecutable,
  assertShaderLifecyclePlanReadyForExecution,
  assertShaderLifecyclePublicationPlanExecutable,
  computePromotedShaderClosureSha256,
  computeShaderLifecyclePackageSha256,
  copyShaderLifecyclePublicationFiles,
  createShaderStyleProfilePromotionPlan,
  type CreateShaderStyleProfilePromotionPlanInput,
  type PromotedShaderClosureDependencies,
  type PromotedShaderVersionRecord,
  type ShaderStyleProfileAuthority,
} from "../src/shader-lifecycle.js";

const H0 = "0".repeat(64) as Sha256Hex;
const H1 = "1".repeat(64) as Sha256Hex;
const H2 = "2".repeat(64) as Sha256Hex;
const H3 = "3".repeat(64) as Sha256Hex;
const H4 = "4".repeat(64) as Sha256Hex;
const H5 = "5".repeat(64) as Sha256Hex;
const CATALOG_REVISION = "catalog-revision-profile-7";
const CREATED_AT = "2026-07-13T12:00:00.000Z";
const VERIFIED_AT = "2026-07-13T12:08:00.000Z";
const PLANNED_AT = "2026-07-13T12:10:00.000Z";

function descriptor(
  path: string,
  role: AssetFileDescriptor["role"],
  sha256: Sha256Hex,
  byteLength: number,
  contentType: AssetFileDescriptor["contentType"] = ASSET_JSON_CONTENT_TYPE,
  moduleId?: string,
): AssetFileDescriptor {
  return { path, role, sha256, byteLength, contentType, ...(moduleId ? { moduleId } : {}) };
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ShaderLifecyclePlanningError);
  expect((error as ShaderLifecyclePlanningError).code).toBe(code);
}

async function expectPlanningCode(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await action();
    throw new Error("Expected shader lifecycle failure.");
  } catch (error) {
    expectCode(error, code);
  }
}

interface ProfileFixture {
  readonly input: CreateShaderStyleProfilePromotionPlanInput;
  readonly authority: ShaderStyleProfileAuthority;
  readonly record: PromotedShaderVersionRecord;
  readonly model: ModelGpuCompatibilityDescriptor;
  readonly profileAsset: ShaderStyleProfileAssetManifest;
  readonly profileFiles: Map<string, Uint8Array>;
  readonly profileRef: ShaderStyleProfileRef;
  readonly shaderAsset: ShaderAssetManifest;
  readonly shaderFiles: Map<string, Uint8Array>;
  readonly shaderRef: ShaderVersionRef;
}

async function withProfileManifest(
  fixture: ProfileFixture,
  styleProfileManifest: ShaderStyleProfileManifest,
): Promise<CreateShaderStyleProfilePromotionPlanInput> {
  const bytes = new TextEncoder().encode(canonicalizeGpuContract(styleProfileManifest));
  const sha256 = await computeSha256(bytes);
  const manifest: ShaderStyleProfileAssetManifest = {
    ...fixture.profileAsset,
    files: fixture.profileAsset.files.map((file) => file.path === fixture.profileAsset.entrypoint
      ? { ...file, byteLength: bytes.byteLength, sha256 }
      : file),
    styleProfileManifest,
  };
  return {
    ...fixture.input,
    profile: {
      manifest,
      files: new Map([[fixture.profileAsset.entrypoint, bytes]]),
      ref: { ...fixture.profileRef, manifestSha256: sha256 },
    },
  };
}

async function withPromotedShaderManifest(
  fixture: ProfileFixture,
  shaderManifest: ShaderVersionManifest,
): Promise<PromotedShaderVersionRecord> {
  const bytes = new TextEncoder().encode(canonicalizeGpuContract(shaderManifest));
  const sha256 = await computeSha256(bytes);
  return {
    ...fixture.record,
    asset: {
      manifest: {
        ...fixture.shaderAsset,
        files: fixture.shaderAsset.files.map((file) => file.path === fixture.shaderAsset.entrypoint
          ? { ...file, byteLength: bytes.byteLength, sha256 }
          : file),
        shaderManifest,
      },
      files: new Map([
        ...fixture.shaderFiles,
        [fixture.shaderAsset.entrypoint, bytes],
      ]),
    },
  };
}

async function createProfileFixture(): Promise<ProfileFixture> {
  const policy = SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES[0]!;
  const gpuInterface: GpuInterfaceRef = {
    interfaceId: "model-interface",
    interfaceVersion: "1.0.0",
    manifestUri: "https://assets.example.invalid/gpu-interfaces/model-interface/1.0.0/interface.json",
    manifestSha256: H0,
    interfaceAbiHash: H1,
    modelAbiHash: H2,
  };
  const evidence: ShaderValidationEvidenceRef = {
    evidenceId: "qualification-realistic",
    uri: "https://assets.example.invalid/shader-evidence/qualification-realistic/1.0.0/evidence.json",
    sha256: H3,
    matrixId: policy.matrixId,
    matrixVersion: policy.matrixVersion,
    matrixSha256: policy.matrixSha256 as Sha256Hex,
    attestationRef: {
      uri: "https://assets.example.invalid/shader-evidence/qualification-realistic/1.0.0/attestation.json",
      sha256: H4,
    },
  };
  const moduleBytes = new TextEncoder().encode("@compute @workgroup_size(1) fn main() {}");
  const moduleSha256 = await computeSha256(moduleBytes);
  const shaderManifest: ShaderVersionManifest = {
    contractVersion: SHADER_VERSION_MANIFEST_VERSION,
    shaderId: "shader-realistic",
    version: "1.0.0",
    modules: [{
      moduleId: "main",
      uri: "https://assets.example.invalid/shaders/shader-realistic/1.0.0/main.wgsl",
      byteLength: moduleBytes.byteLength,
      sha256: moduleSha256,
      contentType: ASSET_WGSL_CONTENT_TYPE,
    }],
    gpuInterface,
    pipelines: [{
      kind: "compute",
      pipelineId: "pipeline.main",
      layout: { bindGroups: [] },
      compute: { moduleId: "main", entryPoint: "main", constants: {} },
    }],
    renderRoles: [{ role: "material", pipelineIds: ["pipeline.main"] }],
    compatibleModelInterfaces: [{
      interfaceId: gpuInterface.interfaceId,
      interfaceVersion: gpuInterface.interfaceVersion,
      manifestSha256: gpuInterface.manifestSha256,
      interfaceAbiHash: gpuInterface.interfaceAbiHash,
      modelAbiHash: gpuInterface.modelAbiHash,
    }],
    requirements: { semantics: ["model.position"], features: [], limits: [], formats: [] },
    shaderAbiHash: H4,
    validationEvidence: evidence,
    additionalValidationEvidence: [],
  };
  const shaderManifestBytes = new TextEncoder().encode(canonicalizeGpuContract(shaderManifest));
  const shaderManifestSha256 = await computeSha256(shaderManifestBytes);
  const shaderRef: ShaderVersionRef = {
    shaderId: shaderManifest.shaderId,
    version: shaderManifest.version,
    manifestUri: "https://assets.example.invalid/shaders/shader-realistic/1.0.0/shader.json",
    manifestSha256: shaderManifestSha256,
  };
  const shaderAsset = createShaderAssetManifest({
    assetKind: "shader",
    assetId: shaderManifest.shaderId,
    version: shaderManifest.version,
    entrypoint: "shader.json",
    files: [
      descriptor(
        "shader.json",
        "shader-manifest",
        shaderManifestSha256,
        shaderManifestBytes.byteLength,
      ),
      descriptor(
        "main.wgsl",
        "wgsl",
        moduleSha256,
        moduleBytes.byteLength,
        ASSET_WGSL_CONTENT_TYPE,
        "main",
      ),
    ],
    sourceAdapter: "local-import",
    createdAt: CREATED_AT,
    shaderManifest,
  });
  const shaderFiles = new Map<string, Uint8Array>([
    ["shader.json", shaderManifestBytes],
    ["main.wgsl", moduleBytes],
  ]);
  const dependencies: PromotedShaderClosureDependencies = {
    gpuInterface: {
      assetId: gpuInterface.interfaceId,
      version: gpuInterface.interfaceVersion,
      manifestUri: gpuInterface.manifestUri,
      manifestSha256: gpuInterface.manifestSha256,
    },
    validationEvidence: [{
      scope: "universal",
      assetId: evidence.evidenceId,
      version: "1.0.0",
      evidenceUri: evidence.uri,
      evidenceSha256: evidence.sha256,
      attestationUri: evidence.attestationRef.uri,
      attestationSha256: evidence.attestationRef.sha256,
    }],
  };
  const packageSha256 = computeShaderLifecyclePackageSha256(shaderAsset);
  const record: PromotedShaderVersionRecord = {
    state: "promoted",
    runtimeChannel: "stable",
    catalogRevision: CATALOG_REVISION,
    qualificationContextSha256: H5,
    promotedAt: "2026-07-13T12:09:00.000Z",
    shader: shaderRef,
    storageVerification: {
      status: "version-ready",
      assetKind: "shader",
      assetId: shaderRef.shaderId,
      version: shaderRef.version,
      manifestUri: shaderRef.manifestUri,
      manifestSha256: shaderRef.manifestSha256,
      packageSha256,
      verifiedAt: VERIFIED_AT,
      closureSha256: computePromotedShaderClosureSha256({
        shader: shaderRef,
        packageSha256,
        qualificationContextSha256: H5,
        dependencies,
      }),
      dependencies,
    },
    asset: { manifest: shaderAsset, files: shaderFiles },
  };

  const profileManifest: ShaderStyleProfileManifest = {
    contractVersion: SHADER_STYLE_PROFILE_MANIFEST_VERSION,
    profileId: "style-realistic",
    version: "1.0.0",
    style: "realistic",
    roles: [{ role: "material", shader: shaderRef }],
    compatibleModelInterfaces: [...shaderManifest.compatibleModelInterfaces],
    requiredSemantics: ["model.position"],
    requiredValidationScopes: [],
  };
  const profileManifestBytes = new TextEncoder().encode(canonicalizeGpuContract(profileManifest));
  const profileManifestSha256 = await computeSha256(profileManifestBytes);
  const profileRef: ShaderStyleProfileRef = {
    profileId: profileManifest.profileId,
    version: profileManifest.version,
    manifestUri: "https://assets.example.invalid/shader-style-profiles/style-realistic/1.0.0/profile.json",
    manifestSha256: profileManifestSha256,
  };
  const profileAsset = createShaderStyleProfileAssetManifest({
    assetKind: "shader-style-profile",
    assetId: profileManifest.profileId,
    version: profileManifest.version,
    entrypoint: "profile.json",
    files: [descriptor(
      "profile.json",
      "shader-style-profile-manifest",
      profileManifestSha256,
      profileManifestBytes.byteLength,
    )],
    sourceAdapter: "local-import",
    createdAt: CREATED_AT,
    styleProfileManifest: profileManifest,
  });
  const callerProfileAsset = JSON.parse(
    canonicalizeGpuContract(profileAsset),
  ) as ShaderStyleProfileAssetManifest;
  const profileFiles = new Map<string, Uint8Array>([["profile.json", profileManifestBytes]]);
  const model: ModelGpuCompatibilityDescriptor = {
    modelId: "model-character",
    version: "1.0.0",
    gpuInterface,
    modelAbiHash: gpuInterface.modelAbiHash,
    providedSemantics: ["model.position"],
    defaultStyleProfile: null,
  };
  const authority: ShaderStyleProfileAuthority = {
    resolveApproval: vi.fn(async ({ approvalId, subject }) => ({
      approvalId,
      subject,
      approvedBy: "shader-reviewer",
      approvedAt: "2026-07-13T12:09:30.000Z",
    })),
    now: vi.fn(() => PLANNED_AT),
    resolvePromotedShader: vi.fn(async () => record),
    resolveCompatibleModels: vi.fn(async () => ({
      catalogRevision: CATALOG_REVISION,
      qualificationContextSha256: H5,
      models: [model],
    })),
    verifyManagedUri: vi.fn(async () => true),
  };
  return {
    authority,
    record,
    model,
    profileAsset: callerProfileAsset,
    profileFiles,
    profileRef,
    shaderAsset,
    shaderFiles,
    shaderRef,
    input: {
      profile: { manifest: callerProfileAsset, files: profileFiles, ref: profileRef },
      authority,
      approvalId: "approval-style-realistic-100",
      runtimeChannel: "stable",
      expectedCatalogRevision: CATALOG_REVISION,
      idempotencyKey: "profile:style-realistic:1.0.0:stable",
    },
  };
}

describe("shader style profile promotion", () => {
  it("rejects oversized and sparse raw profile declarations before downstream authorities", async () => {
    const fixture = await createProfileFixture();
    const base = fixture.profileAsset.styleProfileManifest;
    const fullText = "x".repeat(SHADER_LIFECYCLE_LIMITS.rawManifestTextCharacters);
    let aggregateEdgeGraph: unknown = "leaf";
    for (let depth = 0; depth < 5; depth += 1) {
      aggregateEdgeGraph = new Array(SHADER_LIFECYCLE_LIMITS.rawManifestArrayEntries)
        .fill(aggregateEdgeGraph);
    }
    const manifests = [
      {
        ...base,
        roles: new Array(SHADER_LIFECYCLE_LIMITS.profileRoles + 1).fill(base.roles[0]!),
      },
      {
        ...base,
        compatibleModelInterfaces: new Array(SHADER_LIFECYCLE_LIMITS.profileInterfaces + 1)
          .fill(base.compatibleModelInterfaces[0]!),
      },
      {
        ...base,
        requiredValidationScopes: new Array(
          SHADER_LIFECYCLE_LIMITS.profileValidationScopes + 1,
        ).fill({}),
      },
      {
        ...base,
        requiredSemantics: new Array(SHADER_LIFECYCLE_LIMITS.profileSemantics + 1)
          .fill("model.position"),
      },
      {
        ...base,
        compatibleModelInterfaces: new Array(1),
      },
      {
        ...base,
        style: `${fullText}x`,
      },
      {
        ...base,
        requiredSemantics: new Array(
          Math.floor(
            SHADER_LIFECYCLE_LIMITS.rawManifestGraphTextCharacters
              / SHADER_LIFECYCLE_LIMITS.rawManifestTextCharacters,
          ) + 1,
        ).fill(fullText),
      },
      {
        ...base,
        [`${fullText}x`]: true,
      },
      {
        ...base,
        ...Object.fromEntries(
          new Array(SHADER_LIFECYCLE_LIMITS.rawManifestObjectProperties + 1)
            .fill(undefined)
            .map((_, index) => [`extra_${index}`, index]),
        ),
      },
      {
        ...base,
        aggregateEdgeGraph,
      },
    ] as unknown as readonly ShaderStyleProfileManifest[];

    for (const styleProfileManifest of manifests) {
      vi.clearAllMocks();
      await expectPlanningCode(
        () => createShaderStyleProfilePromotionPlan({
          ...fixture.input,
          profile: {
            ...fixture.input.profile,
            manifest: {
              ...fixture.profileAsset,
              styleProfileManifest,
            },
          },
        }),
        "profile-invalid",
      );
      expect(fixture.authority.verifyManagedUri).not.toHaveBeenCalled();
      expect(fixture.authority.resolvePromotedShader).not.toHaveBeenCalled();
      expect(fixture.authority.resolveCompatibleModels).not.toHaveBeenCalled();
      expect(fixture.authority.resolveApproval).not.toHaveBeenCalled();
    }
  });

  it("allows a manifest file plus every declared shader module at the exported ceiling", () => {
    expect(SHADER_LIFECYCLE_LIMITS.promotedShaderFiles)
      .toBeGreaterThan(SHADER_LIFECYCLE_LIMITS.shaderModules);
    expect(SHADER_LIFECYCLE_LIMITS.publicationFiles)
      .toBeGreaterThan(SHADER_LIFECYCLE_LIMITS.shaderModules);
  });

  it("rejects oversized and sparse raw promoted-shader manifests before downstream authorities", async () => {
    const fixture = await createProfileFixture();
    const base = fixture.shaderAsset.shaderManifest;
    const sparseBindGroups = new Array(1);
    const pipeline = base.pipelines[0]!;
    const role = base.renderRoles[0]!;
    const fullBindGroupEntries = new Array(
      SHADER_LIFECYCLE_LIMITS.shaderPipelineEntriesPerBindGroup,
    ).fill({});
    const aggregateBindGroups = new Array(
      Math.floor(
        SHADER_LIFECYCLE_LIMITS.shaderPipelineBindGroupEntries
          / SHADER_LIFECYCLE_LIMITS.shaderPipelineEntriesPerBindGroup,
      ) + 1,
    ).fill(undefined).map((_, group) => ({ group, entries: fullBindGroupEntries }));
    const stage = "compute" in pipeline ? pipeline.compute : undefined;
    const fullStageConstants = Object.fromEntries(
      new Array(SHADER_LIFECYCLE_LIMITS.shaderPipelineStageConstants)
        .fill(undefined)
        .map((_, index) => [`OVERRIDE_${index}`, index]),
    );
    const aggregateConstantPipelines = new Array(
      Math.floor(
        SHADER_LIFECYCLE_LIMITS.shaderPipelineStageConstantsAggregate
          / SHADER_LIFECYCLE_LIMITS.shaderPipelineStageConstants,
      ) + 1,
    ).fill(undefined).map((_, index) => ({
      ...pipeline,
      pipelineId: `pipeline.constant.${index}`,
      compute: { ...stage, constants: fullStageConstants },
    }));
    const manifests = [
      {
        ...base,
        modules: new Array(SHADER_LIFECYCLE_LIMITS.shaderModules + 1).fill(base.modules[0]!),
      },
      {
        ...base,
        pipelines: new Array(SHADER_LIFECYCLE_LIMITS.shaderPipelines + 1).fill(pipeline),
      },
      {
        ...base,
        renderRoles: new Array(SHADER_LIFECYCLE_LIMITS.profileRoles + 1).fill(role),
      },
      {
        ...base,
        renderRoles: [{
          ...role,
          pipelineIds: new Array(SHADER_LIFECYCLE_LIMITS.shaderRenderRolePipelineIds + 1)
            .fill(role.pipelineIds[0]!),
        }],
      },
      {
        ...base,
        compatibleModelInterfaces: new Array(SHADER_LIFECYCLE_LIMITS.profileInterfaces + 1)
          .fill(base.compatibleModelInterfaces[0]!),
      },
      {
        ...base,
        additionalValidationEvidence: new Array(SHADER_LIFECYCLE_LIMITS.shaderEvidenceScopes + 1)
          .fill({}),
      },
      {
        ...base,
        requirements: {
          ...base.requirements,
          semantics: new Array(SHADER_LIFECYCLE_LIMITS.profileSemantics + 1)
            .fill("model.position"),
        },
      },
      {
        ...base,
        requirements: {
          ...base.requirements,
          features: new Array(SHADER_LIFECYCLE_LIMITS.shaderRequirementFeatures + 1)
            .fill("feature"),
        },
      },
      {
        ...base,
        requirements: {
          ...base.requirements,
          limits: new Array(SHADER_LIFECYCLE_LIMITS.shaderRequirementLimits + 1).fill({}),
        },
      },
      {
        ...base,
        requirements: {
          ...base.requirements,
          formats: new Array(SHADER_LIFECYCLE_LIMITS.shaderRequirementFormats + 1)
            .fill("rgba8unorm"),
        },
      },
      {
        ...base,
        pipelines: [{
          ...pipeline,
          layout: {
            bindGroups: new Array(SHADER_LIFECYCLE_LIMITS.shaderPipelineBindGroups + 1)
              .fill({ group: 0, entries: [] }),
          },
        }],
      },
      {
        ...base,
        pipelines: [{
          ...pipeline,
          compute: {
            ...stage,
            constants: Object.fromEntries(
              new Array(SHADER_LIFECYCLE_LIMITS.shaderPipelineStageConstants + 1)
                .fill(undefined)
                .map((_, index) => [`OVERRIDE_${index}`, index]),
            ),
          },
        }],
      },
      {
        ...base,
        pipelines: aggregateConstantPipelines,
      },
      {
        ...base,
        pipelines: [{
          ...pipeline,
          layout: { bindGroups: aggregateBindGroups },
        }],
      },
      {
        ...base,
        pipelines: [{
          ...pipeline,
          layout: {
            bindGroups: [{
              group: 0,
              entries: new Array(
                SHADER_LIFECYCLE_LIMITS.shaderPipelineEntriesPerBindGroup + 1,
              ).fill({}),
            }],
          },
        }],
      },
      {
        ...base,
        pipelines: [{
          ...pipeline,
          layout: { bindGroups: sparseBindGroups },
        }],
      },
    ] as unknown as readonly ShaderVersionManifest[];

    for (const shaderManifest of manifests) {
      vi.clearAllMocks();
      const record = {
        ...fixture.record,
        asset: {
          ...fixture.record.asset,
          manifest: {
            ...fixture.shaderAsset,
            shaderManifest,
          },
        },
      } as PromotedShaderVersionRecord;
      const authority = {
        ...fixture.authority,
        resolvePromotedShader: vi.fn(async () => record),
      };

      await expectPlanningCode(
        () => createShaderStyleProfilePromotionPlan({ ...fixture.input, authority }),
        "profile-shader-not-promoted",
      );
      expect(authority.resolvePromotedShader).toHaveBeenCalledTimes(1);
      expect(authority.resolveCompatibleModels).not.toHaveBeenCalled();
      expect(authority.resolveApproval).not.toHaveBeenCalled();
    }
  });

  it("closes exact promoted shaders and returns a branded, byte-retaining publication plan", async () => {
    const fixture = await createProfileFixture();
    expect(Object.isFrozen(fixture.profileAsset)).toBe(false);

    const plan = await createShaderStyleProfilePromotionPlan(fixture.input);

    expect(fixture.authority.resolvePromotedShader).toHaveBeenCalledWith({
      shader: fixture.shaderRef,
      runtimeChannel: "stable",
      expectedCatalogRevision: CATALOG_REVISION,
      signal: expect.any(AbortSignal),
    });
    expect(fixture.authority.resolveCompatibleModels).toHaveBeenCalledWith({
      profileId: "style-realistic",
      version: "1.0.0",
      signal: expect.any(AbortSignal),
    });
    expect(plan).toMatchObject({
      kind: "shader-style-profile-promotion",
      profile: fixture.profileRef,
      shaders: [fixture.shaderRef],
      compatibleModelIds: ["model-character@1.0.0"],
      qualificationContextSha256: H5,
      effects: [
        { order: 1, kind: "publish-immutable-version", packageSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
        {
          order: 2,
          kind: "reverify-profile-promotion-closure",
          shaderDependencies: [{
            shader: fixture.shaderRef,
            priorClosureSha256: fixture.record.storageVerification.closureSha256,
            verificationExpiresAt: "2026-07-13T12:13:00.000Z",
          }],
        },
        { order: 3, kind: "compare-and-swap-catalog" },
        { order: 4, kind: "record-promotion-audit", approvalId: "approval-style-realistic-100" },
      ],
    });
    expect(() => assertShaderLifecyclePlanExecutable(plan)).not.toThrow();
    expect(() => assertShaderLifecyclePublicationPlanExecutable(plan)).not.toThrow();
    expect(() => assertShaderLifecyclePlanReadyForExecution(
      plan,
      { now: () => "2026-07-13T12:10:01.000Z" },
    )).not.toThrow();
    expect(() => assertShaderLifecyclePlanReadyForExecution(
      plan,
      { now: () => "2026-07-13T12:13:00.000Z" },
    )).toThrow(ShaderLifecyclePlanningError);
    expect(() => assertShaderLifecyclePlanExecutable({ ...plan })).toThrow(ShaderLifecyclePlanningError);
    expect(() => assertShaderLifecyclePlanExecutable(JSON.parse(JSON.stringify(plan)))).toThrow(
      ShaderLifecyclePlanningError,
    );

    const first = copyShaderLifecyclePublicationFiles(
      plan,
      "shader-style-profile",
      "style-realistic",
      "1.0.0",
    );
    const firstBytes = first.get("profile.json")!;
    firstBytes[0] = (firstBytes[0] ?? 0) ^ 0xff;
    const second = copyShaderLifecyclePublicationFiles(
      plan,
      "shader-style-profile",
      "style-realistic",
      "1.0.0",
    );
    expect(second.get("profile.json")).toEqual(fixture.profileFiles.get("profile.json"));
    expect(Object.isFrozen(fixture.profileAsset)).toBe(false);
    expect(Object.isFrozen(plan.publications[0]!.manifest)).toBe(true);
  });

  it("keeps idempotency stable across refreshed storage proof timestamps", async () => {
    const firstFixture = await createProfileFixture();
    const first = await createShaderStyleProfilePromotionPlan(firstFixture.input);
    const secondFixture = await createProfileFixture();
    const refreshed = {
      ...secondFixture.record,
      storageVerification: {
        ...secondFixture.record.storageVerification,
        verifiedAt: "2026-07-13T12:08:30.000Z",
      },
    };
    secondFixture.authority.resolvePromotedShader = vi.fn(async () => refreshed);
    const second = await createShaderStyleProfilePromotionPlan({
      ...secondFixture.input,
      authority: secondFixture.authority,
    });

    expect(second.effects).not.toEqual(first.effects);
    expect(second.idempotencyFingerprint).toBe(first.idempotencyFingerprint);
  });

  it("rejects missing, stale-revision, malformed, and stale-storage shader records", async () => {
    const fixture = await createProfileFixture();
    const cases: Array<[unknown, string]> = [
      [null, "profile-shader-not-promoted"],
      [{ ...fixture.record, catalogRevision: "catalog-stale" }, "profile-shader-not-promoted"],
      [{ shader: null }, "profile-shader-not-promoted"],
      [{
        ...fixture.record,
        storageVerification: {
          ...fixture.record.storageVerification,
          verifiedAt: "2026-07-13T12:04:59.999Z",
        },
      }, "profile-shader-not-promoted"],
      [{
        ...fixture.record,
        storageVerification: {
          ...fixture.record.storageVerification,
          packageSha256: H0,
        },
      }, "profile-shader-not-promoted"],
      [{
        ...fixture.record,
        storageVerification: {
          ...fixture.record.storageVerification,
          dependencies: { gpuInterface: null, validationEvidence: [null] },
        },
      }, "profile-shader-not-promoted"],
      [{
        ...fixture.record,
        storageVerification: {
          ...fixture.record.storageVerification,
          dependencies: {
            ...fixture.record.storageVerification.dependencies,
            validationEvidence: new Array(1),
          },
        },
      }, "profile-shader-not-promoted"],
    ];
    for (const [record, code] of cases) {
      const authority = {
        ...fixture.authority,
        resolvePromotedShader: vi.fn(async () => record as PromotedShaderVersionRecord | null),
      };
      await expectPlanningCode(
        () => createShaderStyleProfilePromotionPlan({ ...fixture.input, authority }),
        code,
      );
    }
  });

  it("rejects unmanaged closure URIs and authority dependency failures", async () => {
    const fixture = await createProfileFixture();
    await expectPlanningCode(
      () => createShaderStyleProfilePromotionPlan({
        ...fixture.input,
        authority: { ...fixture.authority, verifyManagedUri: vi.fn(async () => false) },
      }),
      "managed-uri-invalid",
    );
    await expectPlanningCode(
      () => createShaderStyleProfilePromotionPlan({
        ...fixture.input,
        authority: {
          ...fixture.authority,
          resolvePromotedShader: vi.fn(async () => { throw new Error("catalog unavailable"); }),
        },
      }),
      "authority-unavailable",
    );
    await expectPlanningCode(
      () => createShaderStyleProfilePromotionPlan({
        ...fixture.input,
        authority: {
          ...fixture.authority,
          resolveCompatibleModels: vi.fn(async () => ({
            catalogRevision: CATALOG_REVISION,
            qualificationContextSha256: H5,
            models: new Array<ModelGpuCompatibilityDescriptor>(1),
          })),
        },
      }),
      "authority-unavailable",
    );
  });

  it("rejects incompatible, duplicate, oversized, and stale model snapshots", async () => {
    const fixture = await createProfileFixture();
    const incompatible = { ...fixture.model, providedSemantics: [] };
    const propertyHeavyModel = {
      ...fixture.model,
      ...Object.fromEntries(
        new Array(SHADER_LIFECYCLE_LIMITS.rawManifestObjectProperties + 1)
          .fill(undefined)
          .map((_, index) => [`untrusted_${index}`, index]),
      ),
    } as unknown as ModelGpuCompatibilityDescriptor;
    const authorities: ShaderStyleProfileAuthority[] = [
      {
        ...fixture.authority,
        resolveCompatibleModels: vi.fn(async () => ({
          catalogRevision: CATALOG_REVISION,
          qualificationContextSha256: H5,
          models: [incompatible],
        })),
      },
      {
        ...fixture.authority,
        resolveCompatibleModels: vi.fn(async () => ({
          catalogRevision: CATALOG_REVISION,
          qualificationContextSha256: H5,
          models: [fixture.model, fixture.model],
        })),
      },
      {
        ...fixture.authority,
        resolveCompatibleModels: vi.fn(async () => ({
          catalogRevision: CATALOG_REVISION,
          qualificationContextSha256: H5,
          models: [propertyHeavyModel],
        })),
      },
    ];
    for (const authority of authorities) {
      await expectPlanningCode(
        () => createShaderStyleProfilePromotionPlan({ ...fixture.input, authority }),
        "profile-incompatible",
      );
    }
    await expectPlanningCode(
      () => createShaderStyleProfilePromotionPlan({
        ...fixture.input,
        authority: {
          ...fixture.authority,
          resolveCompatibleModels: vi.fn(async () => ({
            catalogRevision: "catalog-stale",
            qualificationContextSha256: H5,
            models: [fixture.model],
          })),
        },
      }),
      "authority-unavailable",
    );
    await expectPlanningCode(
      () => createShaderStyleProfilePromotionPlan({
        ...fixture.input,
        authority: {
          ...fixture.authority,
          resolveCompatibleModels: vi.fn(async () => ({
            catalogRevision: CATALOG_REVISION,
            qualificationContextSha256: H5,
            models: Array.from({ length: 4_097 }, () => fixture.model),
          })),
        },
      }),
      "authority-unavailable",
    );
    await expectPlanningCode(
      () => createShaderStyleProfilePromotionPlan({
        ...fixture.input,
        authority: {
          ...fixture.authority,
          resolveCompatibleModels: vi.fn(async () => ({
            catalogRevision: CATALOG_REVISION,
            qualificationContextSha256: H4,
            models: [fixture.model],
          })),
        },
      }),
      "qualification-context-invalid",
    );
    await expectPlanningCode(
      () => createShaderStyleProfilePromotionPlan({
        ...fixture.input,
        authority: {
          ...fixture.authority,
          resolveCompatibleModels: vi.fn(async () => ({
            catalogRevision: CATALOG_REVISION,
            qualificationContextSha256: H5,
            models: [{
              ...fixture.model,
              providedSemantics: Array.from(
                { length: 513 },
                (_, index) => `model.semantic.${index}`,
              ),
            }],
          })),
        },
      }),
      "profile-incompatible",
    );
    const aggregateHeavyModels = Array.from({ length: 129 }, (_, modelIndex) => ({
      ...fixture.model,
      modelId: `model-character-${modelIndex}`,
      version: `1.0.${modelIndex}`,
      providedSemantics: [
        "model.position",
        ...Array.from(
          { length: 511 },
          (_, semanticIndex) => `model.semantic.${modelIndex}.${semanticIndex}`,
        ),
      ],
    }));
    await expectPlanningCode(
      () => createShaderStyleProfilePromotionPlan({
        ...fixture.input,
        authority: {
          ...fixture.authority,
          resolveCompatibleModels: vi.fn(async () => ({
            catalogRevision: CATALOG_REVISION,
            qualificationContextSha256: H5,
            models: aggregateHeavyModels,
          })),
        },
      }),
      "profile-incompatible",
    );
    await expectPlanningCode(
      () => createShaderStyleProfilePromotionPlan({
        ...fixture.input,
        authority: {
          ...fixture.authority,
          resolveCompatibleModels: vi.fn(async () => ({
            catalogRevision: CATALOG_REVISION,
            qualificationContextSha256: H5,
            models: [{ ...fixture.model, version: "latest" }],
          })),
        },
      }),
      "profile-incompatible",
    );
  });

  it("rejects mutable aliases at every nested model compatibility boundary", async () => {
    const fixture = await createProfileFixture();
    const defaultStyleProfile: ShaderStyleProfileRef = {
      ...fixture.profileRef,
      version: "latest",
    };
    const models: ModelGpuCompatibilityDescriptor[] = [
      { ...fixture.model, version: "latest" },
      {
        ...fixture.model,
        gpuInterface: { ...fixture.model.gpuInterface, interfaceVersion: "latest" },
      },
      { ...fixture.model, defaultStyleProfile },
    ];

    for (const model of models) {
      const authority: ShaderStyleProfileAuthority = {
        ...fixture.authority,
        resolveCompatibleModels: vi.fn(async () => ({
          catalogRevision: CATALOG_REVISION,
          qualificationContextSha256: H5,
          models: [model],
        })),
      };
      await expectPlanningCode(
        () => createShaderStyleProfilePromotionPlan({ ...fixture.input, authority }),
        "profile-incompatible",
      );
      expect(authority.resolveApproval).not.toHaveBeenCalled();
    }
  });

  it("rejects mutable aliases in profile refs, interfaces, role shaders, and matrix scopes", async () => {
    const fixture = await createProfileFixture();
    await expectPlanningCode(
      () => createShaderStyleProfilePromotionPlan({
        ...fixture.input,
        profile: {
          ...fixture.input.profile,
          ref: { ...fixture.profileRef, version: "latest" },
        },
      }),
      "profile-invalid",
    );

    const manifests: ShaderStyleProfileManifest[] = [
      {
        ...fixture.profileAsset.styleProfileManifest,
        version: "latest",
      },
      {
        ...fixture.profileAsset.styleProfileManifest,
        compatibleModelInterfaces: [{
          ...fixture.profileAsset.styleProfileManifest.compatibleModelInterfaces[0]!,
          interfaceVersion: "latest",
        }],
      },
      {
        ...fixture.profileAsset.styleProfileManifest,
        roles: [{
          ...fixture.profileAsset.styleProfileManifest.roles[0]!,
          shader: {
            ...fixture.profileAsset.styleProfileManifest.roles[0]!.shader,
            version: "latest",
          },
        }],
      },
      {
        ...fixture.profileAsset.styleProfileManifest,
        requiredValidationScopes: [{
          scope: "xr",
          matrixId: "xr-webgpu",
          matrixVersion: "latest",
          matrixSha256: H0,
        }],
      },
    ];
    for (const manifest of manifests) {
      const input = await withProfileManifest(fixture, manifest);
      await expectPlanningCode(
        () => createShaderStyleProfilePromotionPlan(input),
        "profile-invalid",
      );
      expect(fixture.authority.resolvePromotedShader).not.toHaveBeenCalled();
    }
  });

  it("rejects mutable aliases in promoted shader, interface, and evidence references", async () => {
    const fixture = await createProfileFixture();
    const aliasedShaderRefRecord: PromotedShaderVersionRecord = {
      ...fixture.record,
      shader: { ...fixture.shaderRef, version: "latest" },
    };
    await expectPlanningCode(
      () => createShaderStyleProfilePromotionPlan({
        ...fixture.input,
        authority: {
          ...fixture.authority,
          resolvePromotedShader: vi.fn(async () => aliasedShaderRefRecord),
        },
      }),
      "profile-shader-not-promoted",
    );

    const shaderManifests: ShaderVersionManifest[] = [
      {
        ...fixture.shaderAsset.shaderManifest,
        version: "latest",
      },
      {
        ...fixture.shaderAsset.shaderManifest,
        gpuInterface: {
          ...fixture.shaderAsset.shaderManifest.gpuInterface,
          interfaceVersion: "latest",
        },
      },
      {
        ...fixture.shaderAsset.shaderManifest,
        compatibleModelInterfaces: [{
          ...fixture.shaderAsset.shaderManifest.compatibleModelInterfaces[0]!,
          interfaceVersion: "latest",
        }],
      },
      {
        ...fixture.shaderAsset.shaderManifest,
        validationEvidence: {
          ...fixture.shaderAsset.shaderManifest.validationEvidence,
          matrixVersion: "latest",
        },
      },
      {
        ...fixture.shaderAsset.shaderManifest,
        additionalValidationEvidence: [{
          scope: "xr",
          evidence: {
            ...fixture.shaderAsset.shaderManifest.validationEvidence,
            evidenceId: "qualification-realistic-xr",
            matrixId: "xr-webgpu",
            matrixVersion: "latest",
          },
        }],
      },
    ];
    for (const shaderManifest of shaderManifests) {
      const record = await withPromotedShaderManifest(fixture, shaderManifest);
      await expectPlanningCode(
        () => createShaderStyleProfilePromotionPlan({
          ...fixture.input,
          authority: {
            ...fixture.authority,
            resolvePromotedShader: vi.fn(async () => record),
          },
        }),
        "profile-shader-not-promoted",
      );
      expect(fixture.authority.resolveCompatibleModels).not.toHaveBeenCalled();
    }
  });

  it("binds approval to exact package, channel, revision, and immutable shader closure", async () => {
    const fixture = await createProfileFixture();
    const mismatches = [
      { runtimeChannel: "preview" },
      { expectedCatalogRevision: "catalog-other" },
      { closureSha256: H0 },
      { manifestSha256: H0 },
    ];
    for (const mismatch of mismatches) {
      const authority: ShaderStyleProfileAuthority = {
        ...fixture.authority,
        resolveApproval: vi.fn(async ({ approvalId, subject }) => ({
          approvalId,
          subject: { ...subject, ...mismatch } as typeof subject,
          approvedBy: "shader-reviewer",
          approvedAt: "2026-07-13T12:09:30.000Z",
        })),
      };
      await expectPlanningCode(
        () => createShaderStyleProfilePromotionPlan({ ...fixture.input, authority }),
        "approval-invalid",
      );
    }
  });

  it("fails closed for modified profile bytes, cancellation, and elapsed deadlines", async () => {
    const fixture = await createProfileFixture();
    const modifiedFiles = new Map(fixture.profileFiles);
    modifiedFiles.set("profile.json", new TextEncoder().encode("{}"));
    await expectPlanningCode(
      () => createShaderStyleProfilePromotionPlan({
        ...fixture.input,
        profile: { ...fixture.input.profile, files: modifiedFiles },
      }),
      "profile-invalid",
    );

    const controller = new AbortController();
    controller.abort();
    await expectPlanningCode(
      () => createShaderStyleProfilePromotionPlan({ ...fixture.input, signal: controller.signal }),
      "aborted",
    );
    await expectPlanningCode(
      () => createShaderStyleProfilePromotionPlan({
        ...fixture.input,
        timeoutMs: 1,
        authority: {
          ...fixture.authority,
          resolvePromotedShader: vi.fn(async () =>
            new Promise<PromotedShaderVersionRecord | null>(() => undefined)),
        },
      }),
      "timeout",
    );
  });
});
