import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidateReceipt = vi.hoisted(() => vi.fn());
vi.mock("@plasius/asset-processing/shader-admission", () => ({
  SHADER_ADMISSION_CONTRACT_VERSION: "2026-07-13.v1",
  SHADER_ADMISSION_OPERATIONS: [
    "assemble-final-wgsl",
    "reflect-gpu-interface",
    "generate-gpu-artifacts",
    "validate-model-fixtures",
    "verify-stable-webgpu-evidence",
    "verify-evidence-attestation",
    "package-immutable-runtime",
  ],
  revalidateShaderAdmissionReceipt: revalidateReceipt,
}));

import {
  ASSET_JSON_CONTENT_TYPE,
  ASSET_WGSL_CONTENT_TYPE,
  createGpuInterfaceAssetManifest,
  createShaderAssetManifest,
  createShaderValidationEvidenceAssetManifest,
  type AssetFileDescriptor,
  type GpuInterfaceAssetManifest,
  type ShaderAssetManifest,
  type ShaderValidationEvidenceAssetManifest,
  type Sha256Hex,
} from "@plasius/asset-contracts";
import {
  SHADER_ADMISSION_CONTRACT_VERSION,
  SHADER_ADMISSION_OPERATIONS,
  type ShaderAdmissionReceipt,
} from "@plasius/asset-processing/shader-admission";
import {
  GPU_INTERFACE_MANIFEST_VERSION,
  SHADER_VERSION_MANIFEST_VERSION,
  SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES,
  canonicalizeGpuContract,
  computeSha256,
  type GpuInterfaceManifest,
  type GpuInterfaceRef,
  type ShaderValidationEvidenceRef,
  type ShaderVersionManifest,
} from "@plasius/gpu-shader";
import {
  SHADER_LIFECYCLE_LIMITS,
  ShaderLifecyclePlanningError,
  assertShaderLifecyclePlanReadyForExecution,
  assertShaderLifecyclePublicationPlanExecutable,
  computeShaderPromotionClosureSha256,
  copyShaderLifecyclePublicationFiles,
  createShaderPromotionPlan,
  type CreateShaderPromotionPlanInput,
  type ShaderLifecyclePlanningAuthority,
} from "../src/shader-lifecycle.js";

const H0 = "0".repeat(64) as Sha256Hex;
const H1 = "1".repeat(64) as Sha256Hex;
const H2 = "2".repeat(64) as Sha256Hex;
const H3 = "3".repeat(64) as Sha256Hex;
const H4 = "4".repeat(64) as Sha256Hex;
const H5 = "5".repeat(64) as Sha256Hex;
const CREATED_AT = "2026-07-13T11:00:00.000Z";
const GENERATED_AT = "2026-07-13T11:30:00.000Z";
const PLANNED_AT = "2026-07-13T12:00:00.000Z";
const CATALOG_REVISION = "catalog-revision-shader-11";

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

function packageOf<TManifest extends GpuInterfaceAssetManifest | ShaderAssetManifest | ShaderValidationEvidenceAssetManifest>(
  manifest: TManifest,
  files: Map<string, Uint8Array>,
) {
  return {
    manifest,
    filePaths: [...files.keys()],
    readFile: (path: string) => files.get(path)?.slice(),
    copyFiles: () => new Map([...files].map(([path, bytes]) => [path, bytes.slice()])),
  };
}

interface PromotionFixture {
  readonly receipt: ShaderAdmissionReceipt;
  readonly authority: ShaderLifecyclePlanningAuthority;
  readonly input: CreateShaderPromotionPlanInput;
}

async function createPromotionFixture(): Promise<PromotionFixture> {
  const policy = SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES[0]!;
  const moduleBytes = new TextEncoder().encode("@compute @workgroup_size(1) fn main() {}");
  const moduleSha256 = await computeSha256(moduleBytes);
  const interfaceManifest: GpuInterfaceManifest = {
    contractVersion: GPU_INTERFACE_MANIFEST_VERSION,
    interfaceId: "model-interface",
    interfaceVersion: "1.0.0",
    modules: [{ moduleId: "main", sha256: moduleSha256 }],
    records: [],
    bindings: [],
    entryPoints: [{
      moduleId: "main",
      name: "main",
      stage: "compute",
      inputs: [],
      outputs: [],
      bindingKeys: [],
      overrideNames: [],
      workgroupSize: [
        { kind: "literal", value: 1 },
        { kind: "literal", value: 1 },
        { kind: "literal", value: 1 },
      ],
      workgroupStorageSize: 0,
    }],
    vertexInputs: [],
    overrides: [],
    modelAbi: { recordNames: [], bindings: [], vertexInputs: [], semantics: [] },
    modelAbiHash: H0,
    interfaceAbiHash: H1,
    generatedBy: {
      packageVersion: "0.1.0",
      reflector: "wgsl_reflect",
      reflectorVersion: "1.5.0",
    },
  };
  const interfaceBytes = new TextEncoder().encode(canonicalizeGpuContract(interfaceManifest));
  const interfaceSha256 = await computeSha256(interfaceBytes);
  const interfaceRef: GpuInterfaceRef = {
    interfaceId: interfaceManifest.interfaceId,
    interfaceVersion: interfaceManifest.interfaceVersion,
    manifestUri: "https://assets.example.invalid/gpu-interfaces/model-interface/1.0.0/interface.json",
    manifestSha256: interfaceSha256,
    interfaceAbiHash: interfaceManifest.interfaceAbiHash,
    modelAbiHash: interfaceManifest.modelAbiHash,
  };
  const interfaceAsset = createGpuInterfaceAssetManifest({
    assetKind: "gpu-interface",
    assetId: interfaceManifest.interfaceId,
    version: interfaceManifest.interfaceVersion,
    entrypoint: "interface.json",
    files: [descriptor(
      "interface.json",
      "gpu-interface-manifest",
      interfaceSha256,
      interfaceBytes.byteLength,
    )],
    sourceAdapter: "local-import",
    createdAt: CREATED_AT,
    gpuInterfaceManifest: interfaceManifest,
  });

  const evidenceBytes = new TextEncoder().encode(canonicalizeGpuContract({ status: "passed" }));
  const evidenceSha256 = await computeSha256(evidenceBytes);
  const attestationBytes = new TextEncoder().encode(canonicalizeGpuContract({ attested: true }));
  const attestationSha256 = await computeSha256(attestationBytes);
  const evidenceRef: ShaderValidationEvidenceRef = {
    evidenceId: "qualification-cartoon",
    uri: "https://assets.example.invalid/shader-evidence/qualification-cartoon/1.0.0/evidence.json",
    sha256: evidenceSha256,
    matrixId: policy.matrixId,
    matrixVersion: policy.matrixVersion,
    matrixSha256: policy.matrixSha256 as Sha256Hex,
    attestationRef: {
      uri: "https://assets.example.invalid/shader-evidence/qualification-cartoon/1.0.0/attestation.json",
      sha256: attestationSha256,
    },
  };
  const evidenceAsset = createShaderValidationEvidenceAssetManifest({
    assetKind: "shader-validation-evidence",
    assetId: evidenceRef.evidenceId,
    version: "1.0.0",
    entrypoint: "evidence.json",
    files: [
      descriptor(
        "evidence.json",
        "shader-validation-evidence",
        evidenceSha256,
        evidenceBytes.byteLength,
      ),
      descriptor(
        "attestation.json",
        "shader-validation-attestation",
        attestationSha256,
        attestationBytes.byteLength,
      ),
    ],
    sourceAdapter: "local-import",
    createdAt: CREATED_AT,
    validationEvidence: evidenceRef,
  });

  const shaderManifest: ShaderVersionManifest = {
    contractVersion: SHADER_VERSION_MANIFEST_VERSION,
    shaderId: "shader-cartoon",
    version: "1.0.0",
    modules: [{
      moduleId: "main",
      uri: "https://assets.example.invalid/shaders/shader-cartoon/1.0.0/main.wgsl",
      byteLength: moduleBytes.byteLength,
      sha256: moduleSha256,
      contentType: ASSET_WGSL_CONTENT_TYPE,
    }],
    gpuInterface: interfaceRef,
    pipelines: [{
      kind: "compute",
      pipelineId: "pipeline.main",
      layout: { bindGroups: [] },
      compute: { moduleId: "main", entryPoint: "main", constants: {} },
    }],
    renderRoles: [{ role: "material", pipelineIds: ["pipeline.main"] }],
    compatibleModelInterfaces: [{
      interfaceId: interfaceRef.interfaceId,
      interfaceVersion: interfaceRef.interfaceVersion,
      manifestSha256: interfaceRef.manifestSha256,
      interfaceAbiHash: interfaceRef.interfaceAbiHash,
      modelAbiHash: interfaceRef.modelAbiHash,
    }],
    requirements: { semantics: [], features: [], limits: [], formats: [] },
    shaderAbiHash: H2,
    validationEvidence: evidenceRef,
    additionalValidationEvidence: [],
  };
  const shaderBytes = new TextEncoder().encode(canonicalizeGpuContract(shaderManifest));
  const shaderSha256 = await computeSha256(shaderBytes);
  const shaderRef = {
    shaderId: shaderManifest.shaderId,
    version: shaderManifest.version,
    manifestUri: "https://assets.example.invalid/shaders/shader-cartoon/1.0.0/shader.json",
    manifestSha256: shaderSha256,
  };
  const shaderAsset = createShaderAssetManifest({
    assetKind: "shader",
    assetId: shaderManifest.shaderId,
    version: shaderManifest.version,
    entrypoint: "shader.json",
    files: [
      descriptor("shader.json", "shader-manifest", shaderSha256, shaderBytes.byteLength),
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
  const receipt = {
    contractVersion: SHADER_ADMISSION_CONTRACT_VERSION,
    plan: {
      contractVersion: SHADER_ADMISSION_CONTRACT_VERSION,
      shaderId: shaderManifest.shaderId,
      version: shaderManifest.version,
      featureFlagId: "asset.pipeline.shader-store.enabled",
      targetRuntime: "webgpu-wgsl",
      steps: SHADER_ADMISSION_OPERATIONS.map((operation) => ({
        operation,
        required: true,
        description: `Required ${operation} step.`,
      })),
    },
    shaderId: shaderManifest.shaderId,
    version: shaderManifest.version,
    modelAbiHash: interfaceManifest.modelAbiHash,
    shaderAbiHash: shaderManifest.shaderAbiHash,
    gpuInterface: interfaceRef,
    shader: shaderRef,
    generatedInterfaceArtifacts: {},
    qualification: {
      evidenceId: evidenceRef.evidenceId,
      generatedAt: GENERATED_AT,
      dataBundleSha256: H2,
      shaderManifestCoreSha256: H3,
      interfaceManifestSha256: interfaceSha256,
      compileUnitInventorySha256: H4,
      subjectBindingSha256: H3,
      matrixId: evidenceRef.matrixId,
      matrixVersion: evidenceRef.matrixVersion,
      matrixSha256: evidenceRef.matrixSha256,
      requiredCompileUnitIds: ["shader-cartoon-main"],
      requiredCellIds: ["ubuntu-swiftshader-chromium"],
      moduleDigests: [{ moduleId: "main", sha256: moduleSha256 }],
      modelAbiHashes: [interfaceManifest.modelAbiHash],
      compileUnits: 1,
      cells: 1,
      expectedResults: 1,
      passedResults: 1,
    },
    assets: {
      gpuInterface: packageOf(interfaceAsset, new Map([["interface.json", interfaceBytes]])),
      evidence: packageOf(evidenceAsset, new Map([
        ["evidence.json", evidenceBytes],
        ["attestation.json", attestationBytes],
      ])),
      shader: packageOf(shaderAsset, new Map([
        ["shader.json", shaderBytes],
        ["main.wgsl", moduleBytes],
      ])),
    },
  } as unknown as ShaderAdmissionReceipt;
  const authority: ShaderLifecyclePlanningAuthority = {
    resolveQualificationContext: vi.fn(async ({ expectedCatalogRevision, subject }) => ({
      status: "current" as const,
      catalogRevision: expectedCatalogRevision,
      qualificationContextSha256: H5,
      subjectBindingSha256: subject.subjectBindingSha256,
      evidenceSha256: subject.evidenceSha256,
      matrixSha256: subject.matrixSha256,
    })),
    resolveApproval: vi.fn(async ({ approvalId, subject }) => ({
      approvalId,
      subject,
      approvedBy: "shader-reviewer",
      approvedAt: "2026-07-13T11:45:00.000Z",
    })),
    verifyManagedUri: vi.fn(async () => true),
    now: vi.fn(() => PLANNED_AT),
  };
  return {
    receipt,
    authority,
    input: {
      receipt,
      verifyCryptographicBundle: vi.fn(async () => true),
      authority,
      approvalId: "approval-shader-cartoon-100",
      runtimeChannel: "stable",
      expectedCatalogRevision: CATALOG_REVISION,
      idempotencyKey: "shader:shader-cartoon:1.0.0:stable",
    },
  };
}

async function expectPlanningCode(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await action();
    throw new Error("Expected shader lifecycle failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(ShaderLifecyclePlanningError);
    expect((error as ShaderLifecyclePlanningError).code).toBe(code);
  }
}

function expectSyncPlanningCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected shader lifecycle failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(ShaderLifecyclePlanningError);
    expect((error as ShaderLifecyclePlanningError).code).toBe(code);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("shader promotion planning", () => {
  it("rejects forged or mutable receipt identities in the public promotion hash", async () => {
    const fixture = await createPromotionFixture();
    const forgedReceipts = [
      {
        ...fixture.receipt,
        shader: { ...fixture.receipt.shader, version: "latest" },
      },
      {
        ...fixture.receipt,
        gpuInterface: { ...fixture.receipt.gpuInterface, interfaceVersion: "latest" },
      },
      {
        ...fixture.receipt,
        assets: {
          ...fixture.receipt.assets,
          shader: {
            ...fixture.receipt.assets.shader,
            manifest: {
              ...fixture.receipt.assets.shader.manifest,
              assetKind: "nonsense",
            },
          },
        },
      },
      {
        ...fixture.receipt,
        contractVersion: "forged-contract",
      },
      {
        ...fixture.receipt,
        shader: { ...fixture.receipt.shader, manifestUri: "blob://arbitrary/shader.json" },
      },
    ] as unknown as readonly ShaderAdmissionReceipt[];

    for (const receipt of forgedReceipts) {
      expectSyncPlanningCode(
        () => computeShaderPromotionClosureSha256({
          receipt,
          qualificationContextSha256: H5,
        }),
        "receipt-incoherent",
      );
    }
  });

  it("hashes only normalized receipt reference and module-digest fields", async () => {
    const fixture = await createPromotionFixture();
    const qualificationContextSha256 = H5;
    const baseline = computeShaderPromotionClosureSha256({
      receipt: fixture.receipt,
      qualificationContextSha256,
    });
    const receiptWithUntrustedExtensions = {
      ...fixture.receipt,
      shader: { ...fixture.receipt.shader, untrusted: "shader-extension" },
      gpuInterface: { ...fixture.receipt.gpuInterface, untrusted: "interface-extension" },
      qualification: {
        ...fixture.receipt.qualification,
        moduleDigests: fixture.receipt.qualification.moduleDigests.map((module) => ({
          ...module,
          untrusted: "module-extension",
        })),
      },
    } as unknown as ShaderAdmissionReceipt;

    expect(computeShaderPromotionClosureSha256({
      receipt: receiptWithUntrustedExtensions,
      qualificationContextSha256,
    })).toBe(baseline);
  });

  it("gives cancellation precedence over receipt preflight", async () => {
    const fixture = await createPromotionFixture();
    const controller = new AbortController();
    controller.abort();

    await expectPlanningCode(
      () => createShaderPromotionPlan({
        ...fixture.input,
        receipt: null as unknown as ShaderAdmissionReceipt,
        signal: controller.signal,
      }),
      "aborted",
    );
    expect(revalidateReceipt).not.toHaveBeenCalled();
    expect(fixture.authority.resolveQualificationContext).not.toHaveBeenCalled();
    expect(fixture.authority.resolveApproval).not.toHaveBeenCalled();
  });

  it("rejects oversized and sparse raw receipt shader manifests before revalidation or authorities", async () => {
    const fixture = await createPromotionFixture();
    const shaderAsset = fixture.receipt.assets.shader.manifest;
    const base = shaderAsset.shaderManifest;
    const manifests = [
      {
        ...base,
        pipelines: new Array(SHADER_LIFECYCLE_LIMITS.shaderPipelines + 1)
          .fill(base.pipelines[0]!),
      },
      {
        ...base,
        renderRoles: [{
          ...base.renderRoles[0]!,
          pipelineIds: new Array(1),
        }],
      },
    ] as unknown as readonly ShaderVersionManifest[];

    for (const shaderManifest of manifests) {
      vi.clearAllMocks();
      const receipt = {
        ...fixture.receipt,
        assets: {
          ...fixture.receipt.assets,
          shader: {
            ...fixture.receipt.assets.shader,
            manifest: {
              ...shaderAsset,
              shaderManifest,
            },
          },
        },
      } as ShaderAdmissionReceipt;
      revalidateReceipt.mockResolvedValue({ ok: true, value: receipt });

      await expectPlanningCode(
        () => createShaderPromotionPlan({ ...fixture.input, receipt }),
        "receipt-incoherent",
      );
      expect(revalidateReceipt).not.toHaveBeenCalled();
      expect(fixture.input.verifyCryptographicBundle).not.toHaveBeenCalled();
      expect(fixture.authority.resolveQualificationContext).not.toHaveBeenCalled();
      expect(fixture.authority.resolveApproval).not.toHaveBeenCalled();
      expect(fixture.authority.verifyManagedUri).not.toHaveBeenCalled();
    }
  });

  it("preflights receipt interface and evidence assets before revalidation or authorities", async () => {
    const fixture = await createPromotionFixture();
    const interfaceAsset = fixture.receipt.assets.gpuInterface.manifest;
    const evidenceAsset = fixture.receipt.assets.evidence.manifest;
    const interfaceManifest = interfaceAsset.gpuInterfaceManifest;
    const receipts = [
      {
        ...fixture.receipt,
        assets: {
          ...fixture.receipt.assets,
          gpuInterface: {
            ...fixture.receipt.assets.gpuInterface,
            manifest: {
              ...interfaceAsset,
              files: new Array(SHADER_LIFECYCLE_LIMITS.publicationFiles + 1)
                .fill(interfaceAsset.files[0]!),
            },
          },
        },
      },
      {
        ...fixture.receipt,
        assets: {
          ...fixture.receipt.assets,
          gpuInterface: {
            ...fixture.receipt.assets.gpuInterface,
            manifest: {
              ...interfaceAsset,
              gpuInterfaceManifest: {
                ...interfaceManifest,
                entryPoints: new Array(SHADER_LIFECYCLE_LIMITS.gpuInterfaceEntryPoints + 1)
                  .fill(interfaceManifest.entryPoints[0]!),
              },
            },
          },
        },
      },
      {
        ...fixture.receipt,
        assets: {
          ...fixture.receipt.assets,
          gpuInterface: {
            ...fixture.receipt.assets.gpuInterface,
            manifest: {
              ...interfaceAsset,
              gpuInterfaceManifest: {
                ...interfaceManifest,
                records: new Array(1),
              },
            },
          },
        },
      },
      {
        ...fixture.receipt,
        assets: {
          ...fixture.receipt.assets,
          evidence: {
            ...fixture.receipt.assets.evidence,
            manifest: {
              ...evidenceAsset,
              files: new Array(SHADER_LIFECYCLE_LIMITS.publicationFiles + 1)
                .fill(evidenceAsset.files[0]!),
            },
          },
        },
      },
    ] as unknown as readonly ShaderAdmissionReceipt[];

    for (const receipt of receipts) {
      vi.clearAllMocks();
      revalidateReceipt.mockResolvedValue({ ok: true, value: receipt });
      await expectPlanningCode(
        () => createShaderPromotionPlan({ ...fixture.input, receipt }),
        "receipt-incoherent",
      );
      expect(revalidateReceipt).not.toHaveBeenCalled();
      expect(fixture.input.verifyCryptographicBundle).not.toHaveBeenCalled();
      expect(fixture.authority.resolveQualificationContext).not.toHaveBeenCalled();
      expect(fixture.authority.resolveApproval).not.toHaveBeenCalled();
    }
  });

  it("revalidates exact admission, binds approval, and retains all publication bytes", async () => {
    const fixture = await createPromotionFixture();
    revalidateReceipt.mockResolvedValue({ ok: true, value: fixture.receipt });

    const plan = await createShaderPromotionPlan(fixture.input);

    expect(revalidateReceipt).toHaveBeenCalledWith({
      receipt: fixture.receipt,
      verifyCryptographicBundle: fixture.input.verifyCryptographicBundle,
      signal: undefined,
      timeoutMs: expect.any(Number),
    });
    expect(fixture.authority.resolveQualificationContext).toHaveBeenCalledWith({
      expectedCatalogRevision: CATALOG_REVISION,
      subject: {
        admissionContractVersion: fixture.receipt.contractVersion,
        shader: fixture.receipt.shader,
        evidenceId: fixture.receipt.qualification.evidenceId,
        evidenceSha256: fixture.receipt.assets.evidence.manifest.validationEvidence.sha256,
        subjectBindingSha256: fixture.receipt.qualification.subjectBindingSha256,
        matrixId: fixture.receipt.qualification.matrixId,
        matrixVersion: fixture.receipt.qualification.matrixVersion,
        matrixSha256: fixture.receipt.qualification.matrixSha256,
        gpuInterfaceGeneratedBy:
          fixture.receipt.assets.gpuInterface.manifest.gpuInterfaceManifest.generatedBy,
      },
      signal: expect.any(AbortSignal),
    });
    expect(fixture.authority.resolveApproval).toHaveBeenCalledWith({
      approvalId: "approval-shader-cartoon-100",
      subject: {
        purpose: "promote-to-runtime-catalog",
        assetKind: "shader",
        assetId: "shader-cartoon",
        version: "1.0.0",
        manifestSha256: fixture.receipt.shader.manifestSha256,
        closureSha256: computeShaderPromotionClosureSha256({
          receipt: fixture.receipt,
          qualificationContextSha256: H5,
        }),
        qualificationContextSha256: H5,
        runtimeChannel: "stable",
        expectedCatalogRevision: CATALOG_REVISION,
      },
      signal: expect.any(AbortSignal),
    });
    expect(plan.effects.map((effect) => [effect.order, effect.kind])).toEqual([
      [1, "publish-immutable-version"],
      [2, "publish-immutable-version"],
      [3, "publish-immutable-version"],
      [4, "compare-and-swap-catalog"],
      [5, "record-promotion-audit"],
    ]);
    expect(plan.publications).toHaveLength(3);
    expect(plan.qualificationContextSha256).toBe(H5);
    expect(plan.effects.slice(3).every((effect) =>
      "qualificationContextSha256" in effect
      && effect.qualificationContextSha256 === H5)).toBe(true);
    expect(plan.publications.every((item) => /^[a-f0-9]{64}$/u.test(item.packageSha256))).toBe(true);
    expect(() => assertShaderLifecyclePublicationPlanExecutable(plan)).not.toThrow();
    expect(() => assertShaderLifecyclePlanReadyForExecution(
      plan,
      { now: () => PLANNED_AT },
    )).not.toThrow();
    const shaderFiles = copyShaderLifecyclePublicationFiles(
      plan,
      "shader",
      "shader-cartoon",
      "1.0.0",
    );
    const changedModule = shaderFiles.get("main.wgsl")!;
    changedModule[0] = (changedModule[0] ?? 0) ^ 0xff;
    expect(copyShaderLifecyclePublicationFiles(
      plan,
      "shader",
      "shader-cartoon",
      "1.0.0",
    ).get("main.wgsl")![0]).not.toBe(shaderFiles.get("main.wgsl")![0]);
  });

  it("keeps idempotency stable when only the planning clock changes", async () => {
    const fixture = await createPromotionFixture();
    revalidateReceipt.mockResolvedValue({ ok: true, value: fixture.receipt });
    const first = await createShaderPromotionPlan(fixture.input);
    fixture.authority.now = vi.fn(() => "2026-07-13T12:00:30.000Z");
    const second = await createShaderPromotionPlan({ ...fixture.input, authority: fixture.authority });
    expect(second.effects).not.toEqual(first.effects);
    expect(second.idempotencyFingerprint).toBe(first.idempotencyFingerprint);
  });

  it.each([
    ["aborted", "aborted"],
    ["timeout", "timeout"],
    ["receipt-invalid", "admission-revalidation-failed"],
  ])("maps revalidation diagnostic %s to %s", async (diagnostic, expected) => {
    const fixture = await createPromotionFixture();
    revalidateReceipt.mockResolvedValue({
      ok: false,
      diagnostics: [{ code: diagnostic, stage: "revalidate-receipt", severity: "error", message: "safe" }],
    });
    await expectPlanningCode(() => createShaderPromotionPlan(fixture.input), expected);
  });

  it("rejects a revalidator that substitutes a different receipt instance", async () => {
    const fixture = await createPromotionFixture();
    revalidateReceipt.mockResolvedValue({ ok: true, value: { ...fixture.receipt } });
    await expectPlanningCode(
      () => createShaderPromotionPlan(fixture.input),
      "admission-revalidation-failed",
    );
  });

  it("rejects incoherent interface, evidence, duplicate ABI, additive evidence, and result counts", async () => {
    const fixture = await createPromotionFixture();
    const shaderAsset = fixture.receipt.assets.shader.manifest;
    const shaderManifest = shaderAsset.shaderManifest;
    const variants: ShaderAdmissionReceipt[] = [
      {
        ...fixture.receipt,
        assets: {
          ...fixture.receipt.assets,
          shader: {
            ...fixture.receipt.assets.shader,
            manifest: {
              ...shaderAsset,
              shaderManifest: {
                ...shaderManifest,
                gpuInterface: {
                  ...shaderManifest.gpuInterface,
                  manifestUri: "https://assets.example.invalid/wrong/interface.json",
                },
              },
            },
          },
        },
      },
      {
        ...fixture.receipt,
        assets: {
          ...fixture.receipt.assets,
          shader: {
            ...fixture.receipt.assets.shader,
            manifest: {
              ...shaderAsset,
              shaderManifest: {
                ...shaderManifest,
                validationEvidence: { ...shaderManifest.validationEvidence, evidenceId: "other-evidence" },
              },
            },
          },
        },
      },
      {
        ...fixture.receipt,
        assets: {
          ...fixture.receipt.assets,
          shader: {
            ...fixture.receipt.assets.shader,
            manifest: {
              ...shaderAsset,
              shaderManifest: {
                ...shaderManifest,
                compatibleModelInterfaces: [
                  ...shaderManifest.compatibleModelInterfaces,
                  { ...shaderManifest.compatibleModelInterfaces[0]!, manifestSha256: H4 },
                ],
              },
            },
          },
        },
      },
      {
        ...fixture.receipt,
        assets: {
          ...fixture.receipt.assets,
          shader: {
            ...fixture.receipt.assets.shader,
            manifest: {
              ...shaderAsset,
              shaderManifest: {
                ...shaderManifest,
                additionalValidationEvidence: [{ scope: "xr", evidence: shaderManifest.validationEvidence }],
              },
            },
          },
        },
      },
      {
        ...fixture.receipt,
        qualification: { ...fixture.receipt.qualification, passedResults: 0 },
      },
    ];
    for (const variant of variants) {
      revalidateReceipt.mockResolvedValueOnce({ ok: true, value: variant });
      await expectPlanningCode(
        () => createShaderPromotionPlan({ ...fixture.input, receipt: variant }),
        variant === variants[4] || variant === variants[3] ? "evidence-incomplete" : "receipt-incoherent",
      );
    }
  });

  it("rejects approval substitutions, future approval, and approval older than qualification", async () => {
    const fixture = await createPromotionFixture();
    revalidateReceipt.mockResolvedValue({ ok: true, value: fixture.receipt });
    const authorities: ShaderLifecyclePlanningAuthority[] = [
      {
        ...fixture.authority,
        resolveApproval: vi.fn(async ({ approvalId, subject }) => ({
          approvalId,
          subject: { ...subject, runtimeChannel: "preview" },
          approvedBy: "shader-reviewer",
          approvedAt: "2026-07-13T11:45:00.000Z",
        })),
      },
      {
        ...fixture.authority,
        resolveApproval: vi.fn(async ({ approvalId, subject }) => ({
          approvalId,
          subject,
          approvedBy: "shader-reviewer",
          approvedAt: "2026-07-13T12:00:01.000Z",
        })),
      },
      {
        ...fixture.authority,
        resolveApproval: vi.fn(async ({ approvalId, subject }) => ({
          approvalId,
          subject,
          approvedBy: "shader-reviewer",
          approvedAt: "2026-07-13T11:29:59.999Z",
        })),
      },
    ];
    for (const authority of authorities) {
      await expectPlanningCode(
        () => createShaderPromotionPlan({ ...fixture.input, authority }),
        "approval-invalid",
      );
    }
  });

  it("rejects missing, stale, substituted, and unavailable qualification contexts", async () => {
    const fixture = await createPromotionFixture();
    revalidateReceipt.mockResolvedValue({ ok: true, value: fixture.receipt });
    const invalidResolvers: ShaderLifecyclePlanningAuthority["resolveQualificationContext"][] = [
      vi.fn(async () => null),
      vi.fn(async ({ subject }) => ({
        status: "current" as const,
        catalogRevision: "catalog-stale",
        qualificationContextSha256: H5,
        subjectBindingSha256: subject.subjectBindingSha256,
        evidenceSha256: subject.evidenceSha256,
        matrixSha256: subject.matrixSha256,
      })),
      vi.fn(async ({ expectedCatalogRevision, subject }) => ({
        status: "current" as const,
        catalogRevision: expectedCatalogRevision,
        qualificationContextSha256: H5,
        subjectBindingSha256: H4,
        evidenceSha256: subject.evidenceSha256,
        matrixSha256: subject.matrixSha256,
      })),
    ];
    for (const resolveQualificationContext of invalidResolvers) {
      await expectPlanningCode(
        () => createShaderPromotionPlan({
          ...fixture.input,
          authority: { ...fixture.authority, resolveQualificationContext },
        }),
        "qualification-context-invalid",
      );
    }
    await expectPlanningCode(
      () => createShaderPromotionPlan({
        ...fixture.input,
        authority: {
          ...fixture.authority,
          resolveQualificationContext: vi.fn(async () => {
            throw new Error("context authority unavailable");
          }),
        },
      }),
      "authority-unavailable",
    );
  });

  it("rejects unmanaged URIs and maps policy dependency failures", async () => {
    const fixture = await createPromotionFixture();
    revalidateReceipt.mockResolvedValue({ ok: true, value: fixture.receipt });
    await expectPlanningCode(
      () => createShaderPromotionPlan({
        ...fixture.input,
        authority: { ...fixture.authority, verifyManagedUri: vi.fn(async () => false) },
      }),
      "managed-uri-invalid",
    );
    await expectPlanningCode(
      () => createShaderPromotionPlan({
        ...fixture.input,
        authority: {
          ...fixture.authority,
          verifyManagedUri: vi.fn(async () => { throw new Error("policy unavailable"); }),
        },
      }),
      "authority-unavailable",
    );
  });

  it("rejects cancellation, bad channels/revisions/keys, and package-copy failures", async () => {
    const fixture = await createPromotionFixture();
    revalidateReceipt.mockResolvedValue({ ok: true, value: fixture.receipt });
    const controller = new AbortController();
    controller.abort();
    await expectPlanningCode(
      () => createShaderPromotionPlan({ ...fixture.input, signal: controller.signal }),
      "aborted",
    );
    await expectPlanningCode(
      () => createShaderPromotionPlan({ ...fixture.input, runtimeChannel: "other" as "stable" }),
      "runtime-channel-invalid",
    );
    await expectPlanningCode(
      () => createShaderPromotionPlan({ ...fixture.input, expectedCatalogRevision: "revision with spaces" }),
      "catalog-revision-invalid",
    );
    await expectPlanningCode(
      () => createShaderPromotionPlan({ ...fixture.input, idempotencyKey: "short" }),
      "idempotency-key-invalid",
    );
    const brokenReceipt = {
      ...fixture.receipt,
      assets: {
        ...fixture.receipt.assets,
        shader: { ...fixture.receipt.assets.shader, copyFiles: () => { throw new Error("copy failed"); } },
      },
    } as ShaderAdmissionReceipt;
    revalidateReceipt.mockResolvedValueOnce({ ok: true, value: brokenReceipt });
    await expectPlanningCode(
      () => createShaderPromotionPlan({ ...fixture.input, receipt: brokenReceipt }),
      "receipt-incoherent",
    );
  });
});
