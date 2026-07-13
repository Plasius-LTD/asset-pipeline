import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@plasius/gpu-shader/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@plasius/gpu-shader/node")>();
  return { ...actual, admitQualificationBundle: vi.fn() };
});

vi.mock("@plasius/gpu-shader/testing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@plasius/gpu-shader/testing")>();
  return {
    ...actual,
    validateShaderValidationEvidence: vi.fn(),
    verifyShaderValidationEvidenceAttestation: vi.fn(),
  };
});

import {
  SHADER_COMPILE_UNIT_VERSION,
  SHADER_VALIDATION_EVIDENCE_VERSION,
  SHADER_VERSION_MANIFEST_VERSION,
  SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES,
  canonicalizeGpuContract,
  computeGpuAbiHash,
  computeSha256,
  computeShaderManifestCoreSha256,
  type GpuInterfaceManifest,
  type GpuInterfaceRef,
  type SerializableGpuComputePipelineDescriptor,
  type ShaderQualificationBundleManifest,
  type ShaderValidationEvidence,
  type ShaderValidationEvidenceAttestationRef,
  type ShaderVersionManifestCore,
  type Sha256Hex,
  type StableWebGpuMatrixManifest,
} from "@plasius/gpu-shader";
import {
  admitQualificationBundle,
  reflectGpuInterface,
} from "@plasius/gpu-shader/node";
import {
  validateShaderValidationEvidence,
  verifyShaderValidationEvidenceAttestation,
} from "@plasius/gpu-shader/testing";
import {
  admitShaderQualification,
  isTrustedShaderAdmissionReceipt,
  type ShaderAdmissionInput,
  type ShaderAdmissionReceipt,
} from "@plasius/asset-processing/shader-admission";
import {
  ShaderLifecyclePlanningError,
  assertShaderLifecyclePublicationPlanExecutable,
  createShaderPromotionPlan,
  type ShaderLifecyclePlanningAuthority,
} from "../src/shader-lifecycle.js";

const require = createRequire(import.meta.url);
const shaderPackageRoot = dirname(require.resolve("@plasius/gpu-shader/package.json"));
const stableMatrixPath = resolve(
  shaderPackageRoot,
  "matrices/stable-webgpu-2026-07-13.json",
);

const WGSL = `
struct ModelData {
  value: vec4f,
}

@group(0) @binding(0) var<storage, read_write> model: ModelData;

@compute @workgroup_size(1)
fn main() {
  model.value.x = model.value.x + 1.0;
}
`.trim();

const pipeline: SerializableGpuComputePipelineDescriptor = {
  kind: "compute",
  pipelineId: "model-compute",
  layout: {
    bindGroups: [{
      group: 0,
      entries: [{
        group: 0,
        binding: 0,
        resource: {
          kind: "buffer",
          addressSpace: "storage",
          access: "read_write",
          recordName: "ModelData",
          minimumBindingSize: 16,
        },
        visibility: ["compute"],
      }],
    }],
  },
  compute: { moduleId: "compute", entryPoint: "main", constants: {} },
};

interface IntegrationFixture {
  readonly admitted: Awaited<ReturnType<typeof admitQualificationBundle>>;
  readonly evidence: ShaderValidationEvidence;
  readonly attestationRef: ShaderValidationEvidenceAttestationRef;
  readonly input: ShaderAdmissionInput;
}

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(canonicalizeGpuContract(value));

async function createFixture(): Promise<IntegrationFixture> {
  const gpuInterface: GpuInterfaceManifest = await reflectGpuInterface({
    interfaceId: "model-interface",
    interfaceVersion: "1.0.0",
    modules: [{ moduleId: "compute", source: WGSL }],
    pipelines: [pipeline],
    modelFacingRecordNames: ["ModelData"],
    modelFacingBindings: [{
      moduleId: "compute",
      group: 0,
      binding: 0,
      semantic: "model.data",
    }],
    semantics: [{
      semantic: "model.data",
      source: { kind: "binding", moduleId: "compute", group: 0, binding: 0 },
    }],
  });
  const interfaceBytes = encode(gpuInterface);
  const interfaceSha256 = await computeSha256(interfaceBytes);
  const gpuInterfaceRef: GpuInterfaceRef = {
    interfaceId: gpuInterface.interfaceId,
    interfaceVersion: gpuInterface.interfaceVersion,
    manifestUri: "https://assets.example.invalid/interfaces/model-interface/1.0.0/interface.json",
    manifestSha256: interfaceSha256,
    interfaceAbiHash: gpuInterface.interfaceAbiHash,
    modelAbiHash: gpuInterface.modelAbiHash,
  };
  const moduleBytes = new TextEncoder().encode(WGSL);
  const moduleSha256 = await computeSha256(moduleBytes);
  const requirements = {
    semantics: ["model.data"],
    features: [],
    limits: [
      { name: "maxBindGroups", comparator: "at-least" as const, value: 1 },
      { name: "maxBindingsPerBindGroup", comparator: "at-least" as const, value: 1 },
      { name: "maxComputeWorkgroupSizeX", comparator: "at-least" as const, value: 1 },
      { name: "maxComputeWorkgroupSizeY", comparator: "at-least" as const, value: 1 },
      { name: "maxComputeWorkgroupSizeZ", comparator: "at-least" as const, value: 1 },
      { name: "maxComputeInvocationsPerWorkgroup", comparator: "at-least" as const, value: 1 },
      { name: "maxStorageBuffersPerShaderStage", comparator: "at-least" as const, value: 1 },
      { name: "maxStorageBufferBindingSize", comparator: "at-least" as const, value: 16 },
    ],
    formats: [],
  };
  const shaderAbiHash = await computeGpuAbiHash({
    kind: "shader",
    interface: gpuInterface,
    pipelines: [pipeline],
    requirements,
  });
  const shaderManifestCore: ShaderVersionManifestCore = {
    contractVersion: SHADER_VERSION_MANIFEST_VERSION,
    shaderId: "shader-cartoon",
    version: "1.0.0",
    modules: [{
      moduleId: "compute",
      uri: "https://assets.example.invalid/shaders/shader-cartoon/1.0.0/modules/compute.wgsl",
      byteLength: moduleBytes.byteLength,
      sha256: moduleSha256,
      contentType: "text/wgsl; charset=utf-8",
    }],
    gpuInterface: gpuInterfaceRef,
    pipelines: [pipeline],
    renderRoles: [{ role: "material", pipelineIds: [pipeline.pipelineId] }],
    compatibleModelInterfaces: [{
      interfaceId: gpuInterface.interfaceId,
      interfaceVersion: gpuInterface.interfaceVersion,
      manifestSha256: interfaceSha256,
      interfaceAbiHash: gpuInterface.interfaceAbiHash,
      modelAbiHash: gpuInterface.modelAbiHash,
    }],
    requirements,
    shaderAbiHash,
  };
  const inventory = {
    contractVersion: SHADER_COMPILE_UNIT_VERSION,
    inventoryId: "shader-cartoon",
    version: "1.0.0",
    repository: "Example-Org/shader-cartoon",
    fragments: [],
    compileUnits: [],
  };
  const inventorySha256 = await computeSha256(canonicalizeGpuContract(inventory));
  const coreSha256 = await computeShaderManifestCoreSha256(shaderManifestCore);
  const matrixBytes = new Uint8Array(await readFile(stableMatrixPath));
  const matrixText = new TextDecoder("utf-8", { fatal: true }).decode(matrixBytes);
  const matrix = JSON.parse(matrixText) as StableWebGpuMatrixManifest;
  const policy = SUPPORTED_STABLE_WEBGPU_MATRIX_POLICIES[0];
  if (!policy || await computeSha256(matrixBytes) !== policy.matrixSha256) {
    throw new Error("Stable policy fixture is unavailable.");
  }
  const requiredCellIds = matrix.cells.map((cell) => cell.cellId);
  const sourceArchiveBytes = Uint8Array.from([1, 2, 3, 4]);
  const dataBundleSha256 = await computeSha256(sourceArchiveBytes);
  const bundle = {
    contractVersion: "1.0.0",
    inventory,
    subject: {
      shaderManifestCore: {
        shaderId: shaderManifestCore.shaderId,
        version: shaderManifestCore.version,
        sha256: coreSha256,
      },
      compileUnitInventorySha256: inventorySha256,
      shaderAbiHash,
      interfaceManifestSha256: interfaceSha256,
      modelAbiHashes: [gpuInterface.modelAbiHash],
      modules: [{ moduleId: "compute", sha256: moduleSha256 }],
      requiredCompileUnitIds: ["shader-cartoon-main"],
      requiredCellIds,
    },
    shaderManifestCorePath: "shader-core.json",
    gpuInterfaceManifest: { path: "interface.json", sha256: interfaceSha256 },
    modelCompatibilityFixtures: [],
    modules: [{ moduleId: "compute", path: "compute.wgsl", sha256: moduleSha256 }],
    fixtures: [],
  } as unknown as ShaderQualificationBundleManifest;
  const evidence = {
    contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
    evidenceId: "qualification-cartoon",
    status: "passed",
    generatedAt: "2026-07-13T11:00:00.000Z",
    subjectBindingSha256: "9".repeat(64) as Sha256Hex,
    subject: { ...bundle.subject, dataBundleSha256 },
    matrixRef: {
      matrixId: policy.matrixId,
      version: policy.matrixVersion,
      sha256: policy.matrixSha256 as Sha256Hex,
    },
    toolchain: {
      packageVersion: "0.1.1",
      reflectorVersion: "1.5.0",
      harness: {
        id: "trusted-harness",
        version: "1.0.0",
        sha256: "8".repeat(64) as Sha256Hex,
      },
    },
    qualificationPreflightProvenance: {},
    counts: {
      compileUnits: 1,
      cells: requiredCellIds.length,
      expectedResults: requiredCellIds.length,
      passedResults: requiredCellIds.length,
    },
    cellRuns: [],
    results: [],
  } as unknown as ShaderValidationEvidence;
  const evidenceBytes = encode(evidence);
  const attestationBundleBytes = encode({ bundle: true });
  const attestationRef = {
    contractVersion: SHADER_VALIDATION_EVIDENCE_VERSION,
    kind: "shader-validation-evidence-attestation-ref",
    evidence: { name: "evidence.json", sha256: await computeSha256(evidenceBytes) },
    attestation: {
      id: "attestation-cartoon",
      url: "https://github.com/Example-Org/shader-cartoon/attestations/123",
      bundle: {
        name: "attestation-bundle.json",
        sha256: await computeSha256(attestationBundleBytes),
      },
    },
    producer: {
      repository: "Example-Org/shader-cartoon",
      runId: "123",
      runAttempt: 1,
      trustedWorkflowRepository: "Example-Org/gpu-shader",
      trustedWorkflowRef: "Example-Org/gpu-shader/.github/workflows/qualify.yml@refs/heads/main",
      trustedWorkflowSha: { algorithm: "sha1", hex: "7".repeat(40) },
    },
  } as unknown as ShaderValidationEvidenceAttestationRef;
  const attestationReferenceBytes = encode(attestationRef);
  const admitted = {
    root: "/trusted/extraction",
    manifest: bundle,
    shaderManifestCore,
    fixtures: new Map(),
    gpuInterface,
    modelFixtures: new Map([["model-fixture", {}]]),
    fileBytes: new Map([
      ["interface.json", interfaceBytes],
      ["compute.wgsl", moduleBytes],
    ]),
  } as unknown as IntegrationFixture["admitted"];

  return {
    admitted,
    evidence,
    attestationRef,
    input: {
      sourceArchiveBytes,
      materializeQualificationBundle: vi.fn(async ({ sourceArchiveSha256 }) => ({
        directory: "/trusted/extraction",
        sourceArchiveSha256,
      })),
      matrixBytes,
      validationEvidenceBytes: evidenceBytes,
      validationEvidenceUri: "https://assets.example.invalid/evidence/qualification-cartoon/1.0.0/evidence.json",
      attestationReferenceBytes,
      attestationReferenceUri: "https://assets.example.invalid/evidence/qualification-cartoon/1.0.0/attestation-ref.json",
      attestationBundleBytes,
      shaderManifestUri: "https://assets.example.invalid/shaders/shader-cartoon/1.0.0/shader.json",
      evidenceAssetVersion: "1.0.0",
      sourceAdapter: "local-import",
      createdAt: "2026-07-13T12:00:00.000Z",
      verifyCryptographicBundle: vi.fn(async () => true),
      timeoutMs: 5_000,
    },
  };
}

const mockedAdmitBundle = vi.mocked(admitQualificationBundle);
const mockedValidateEvidence = vi.mocked(validateShaderValidationEvidence);
const mockedVerifyAttestation = vi.mocked(verifyShaderValidationEvidenceAttestation);

function installQualificationBoundaries(fixture: IntegrationFixture): void {
  mockedAdmitBundle.mockResolvedValue(fixture.admitted);
  mockedValidateEvidence.mockResolvedValue({ ok: true, value: fixture.evidence });
  mockedVerifyAttestation.mockImplementation(async (input) => {
    const verified = await input.verifyCryptographicBundle({
      ref: fixture.attestationRef,
      evidenceBytes: input.evidenceBytes,
      bundleBytes: input.bundleBytes,
    });
    return verified
      ? { ok: true, value: fixture.attestationRef }
      : {
          ok: false,
          diagnostics: [{
            code: "invalid-contract",
            severity: "error",
            message: "External build-provenance cryptographic verification failed.",
          }],
        };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("real shader admission receipt promotion boundary", () => {
  it("promotes only the original process-branded receipt over the packaged matrix", async () => {
    const fixture = await createFixture();
    installQualificationBoundaries(fixture);
    expect((await import("@plasius/gpu-shader/node")).admitQualificationBundle)
      .toBe(mockedAdmitBundle);
    const admission = await admitShaderQualification(fixture.input);
    expect(fixture.input.materializeQualificationBundle).toHaveBeenCalledOnce();
    expect(mockedAdmitBundle).toHaveBeenCalledOnce();
    expect(
      admission.ok,
      admission.ok ? undefined : JSON.stringify(admission.diagnostics),
    ).toBe(true);
    if (!admission.ok) return;
    const receipt = admission.value;
    expect(isTrustedShaderAdmissionReceipt(receipt)).toBe(true);
    expect(isTrustedShaderAdmissionReceipt({ ...receipt })).toBe(false);

    const authority: ShaderLifecyclePlanningAuthority = {
      resolveQualificationContext: vi.fn(async ({ expectedCatalogRevision, subject }) => ({
        status: "current" as const,
        catalogRevision: expectedCatalogRevision,
        qualificationContextSha256: "5".repeat(64) as Sha256Hex,
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
      now: vi.fn(() => "2026-07-13T12:00:00.000Z"),
    };
    const createPlan = (candidate: ShaderAdmissionReceipt) => createShaderPromotionPlan({
      receipt: candidate,
      verifyCryptographicBundle: fixture.input.verifyCryptographicBundle,
      authority,
      approvalId: "approval-shader-cartoon-100",
      runtimeChannel: "stable",
      expectedCatalogRevision: "catalog-revision-100",
      idempotencyKey: "shader:shader-cartoon:1.0.0:stable",
    });

    const plan = await createPlan(receipt);
    expect(plan.publications.map((publication) => publication.manifest.assetKind)).toEqual([
      "gpu-interface",
      "shader-validation-evidence",
      "shader",
    ]);
    expect(plan.effects.map((effect) => effect.kind)).toEqual([
      "publish-immutable-version",
      "publish-immutable-version",
      "publish-immutable-version",
      "compare-and-swap-catalog",
      "record-promotion-audit",
    ]);
    expect(mockedValidateEvidence).toHaveBeenCalledTimes(2);
    expect(mockedVerifyAttestation).toHaveBeenCalledTimes(2);
    expect(fixture.input.verifyCryptographicBundle).toHaveBeenCalledTimes(2);
    expect(() => assertShaderLifecyclePublicationPlanExecutable(plan)).not.toThrow();

    await expect(createPlan({ ...receipt } as ShaderAdmissionReceipt)).rejects.toMatchObject({
      code: "admission-revalidation-failed",
    } satisfies Partial<ShaderLifecyclePlanningError>);
  });
});
