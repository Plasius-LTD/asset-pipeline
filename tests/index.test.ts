import { describe, expect, it } from "vitest";
import { assertPipelineTransition, canTransitionAssetJob, createAssetPipelinePlan } from "../src/index.js";

describe("asset pipeline", () => {
  it("allows only explicit state transitions", () => {
    expect(canTransitionAssetJob("requested", "intake-uploaded")).toBe(true);
    expect(canTransitionAssetJob("requested", "promoted")).toBe(false);
    expect(canTransitionAssetJob("rolled-back", "requested")).toBe(false);
    expect(() => assertPipelineTransition({ from: "requested", to: "promoted", reason: "skip" })).toThrow(/Unsupported/);
    expect(assertPipelineTransition({ from: "requested", to: "failed", reason: "invalid source" })).toEqual({
      from: "requested",
      to: "failed",
      reason: "invalid source",
    });
  });

  it("creates approval-gated pipeline plans", () => {
    const plan = createAssetPipelinePlan({
      assetId: "eames-lounge-chair-ottoman",
      jobId: "job-1",
      sourceAdapter: "local-import",
    });

    expect(plan.promotionRequiresApproval).toBe(true);
    expect(plan.requiredStates).toContain("rendering-review");
  });

  it("preserves custom pipeline plan policy", () => {
    const plan = createAssetPipelinePlan({
      assetId: "eames-lounge-chair-ottoman",
      jobId: "job-2",
      sourceAdapter: "processor-retry",
      requiredStates: ["requested", "processed"],
      promotionRequiresApproval: false,
    });

    expect(plan.requiredStates).toEqual(["requested", "processed"]);
    expect(plan.promotionRequiresApproval).toBe(false);
  });
});
