import { describe, expect, it } from "vitest";

import type {
  ShaderStyleProfileRef,
  ShaderVersionRef,
  Sha256Hex,
} from "@plasius/asset-contracts";
import {
  ShaderLifecyclePlanningError,
  computePromotedShaderClosureSha256,
  computeShaderStyleProfileClosureSha256,
  type PromotedShaderClosureDependencies,
} from "../src/shader-lifecycle.js";

const H0 = "0".repeat(64) as Sha256Hex;
const H1 = "1".repeat(64) as Sha256Hex;
const H2 = "2".repeat(64) as Sha256Hex;
const H3 = "3".repeat(64) as Sha256Hex;

const shader: ShaderVersionRef = {
  shaderId: "shader-realistic",
  version: "1.0.0",
  manifestUri: "https://assets.example.invalid/shaders/shader-realistic/1.0.0/shader.json",
  manifestSha256: H0,
};

const profile: ShaderStyleProfileRef = {
  profileId: "style-realistic",
  version: "1.0.0",
  manifestUri: "https://assets.example.invalid/profiles/style-realistic/1.0.0/profile.json",
  manifestSha256: H1,
};

const dependencies: PromotedShaderClosureDependencies = {
  gpuInterface: {
    assetId: "model-interface",
    version: "1.0.0",
    manifestUri: "https://assets.example.invalid/interfaces/model-interface/1.0.0/interface.json",
    manifestSha256: H2,
  },
  validationEvidence: [{
    scope: "universal",
    assetId: "qualification-realistic",
    version: "1.0.0",
    evidenceUri: "https://assets.example.invalid/evidence/qualification-realistic/1.0.0/evidence.json",
    evidenceSha256: H2,
    attestationUri: "https://assets.example.invalid/evidence/qualification-realistic/1.0.0/attestation.json",
    attestationSha256: H3,
  }],
};

function expectCode(action: () => unknown, code: string): void {
  expect(action).toThrowError(ShaderLifecyclePlanningError);
  try {
    action();
  } catch (error) {
    expect((error as ShaderLifecyclePlanningError).code).toBe(code);
  }
}

describe("shader lifecycle closure hashes", () => {
  it("hashes only validated exact promoted-shader closure inputs", () => {
    expect(computePromotedShaderClosureSha256({
      shader,
      packageSha256: H1,
      qualificationContextSha256: H3,
      dependencies,
    })).toMatch(/^[a-f0-9]{64}$/u);

    const invalidInputs = [
      { shader: { ...shader, version: "latest" } },
      { packageSha256: "not-a-digest" as Sha256Hex },
      {
        dependencies: {
          ...dependencies,
          gpuInterface: { ...dependencies.gpuInterface, version: "1.x" },
        },
      },
      {
        dependencies: {
          ...dependencies,
          validationEvidence: [{
            ...dependencies.validationEvidence[0]!,
            version: "current",
          }],
        },
      },
      {
        dependencies: {
          ...dependencies,
          validationEvidence: [{
            ...dependencies.validationEvidence[0]!,
            scope: "xr",
          }],
        },
      },
    ];
    for (const invalid of invalidInputs) {
      expectCode(() => computePromotedShaderClosureSha256({
        shader,
        packageSha256: H1,
        qualificationContextSha256: H3,
        dependencies,
        ...invalid,
      }), "profile-shader-not-promoted");
    }
  });

  it("hashes only non-empty exact style-profile closures", () => {
    expect(computeShaderStyleProfileClosureSha256({
      profile,
      profilePackageSha256: H2,
      qualificationContextSha256: H3,
      shaders: [shader],
    })).toMatch(/^[a-f0-9]{64}$/u);

    const invalidInputs = [
      { profile: { ...profile, version: "stable" } },
      { profilePackageSha256: "not-a-digest" as Sha256Hex },
      { shaders: [] },
      { shaders: [{ ...shader, version: "next" }] },
      { shaders: [shader, { ...shader, manifestSha256: H3 }] },
    ];
    for (const invalid of invalidInputs) {
      expectCode(() => computeShaderStyleProfileClosureSha256({
        profile,
        profilePackageSha256: H2,
        qualificationContextSha256: H3,
        shaders: [shader],
        ...invalid,
      }), "profile-invalid");
    }
  });
});
