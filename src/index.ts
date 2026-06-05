export const ASSET_PIPELINE_PACKAGE = "@plasius/asset-pipeline";
export const ASSET_PIPELINE_FEATURE_FLAG_ID = "asset.pipeline.unified-ai-assets.enabled";

export const PIPELINE_STATES = Object.freeze([
  "requested",
  "intake-uploaded",
  "validated",
  "processing",
  "processed",
  "rendering-review",
  "reviewed",
  "awaiting-approval",
  "approved",
  "promoting",
  "promoted",
  "rejected",
  "failed",
  "rolled-back",
] as const);

export type PipelineState = typeof PIPELINE_STATES[number];

export interface PipelineTransition {
  readonly from: PipelineState;
  readonly to: PipelineState;
  readonly reason: string;
}

export interface AssetPipelinePlan {
  readonly assetId: string;
  readonly jobId: string;
  readonly sourceAdapter: "local-import" | "ai-generate" | "ai-modify" | "texture-regenerate" | "processor-retry";
  readonly requiredStates: readonly PipelineState[];
  readonly promotionRequiresApproval: boolean;
}

const TRANSITIONS: ReadonlyMap<PipelineState, readonly PipelineState[]> = new Map([
  ["requested", ["intake-uploaded", "failed"]],
  ["intake-uploaded", ["validated", "failed"]],
  ["validated", ["processing", "rejected", "failed"]],
  ["processing", ["processed", "failed"]],
  ["processed", ["rendering-review", "failed"]],
  ["rendering-review", ["reviewed", "failed"]],
  ["reviewed", ["awaiting-approval", "rejected", "failed"]],
  ["awaiting-approval", ["approved", "rejected"]],
  ["approved", ["promoting", "rejected"]],
  ["promoting", ["promoted", "failed"]],
  ["promoted", ["rolled-back"]],
  ["rejected", []],
  ["failed", []],
  ["rolled-back", []],
]);

export function canTransitionAssetJob(from: PipelineState, to: PipelineState): boolean {
  return TRANSITIONS.get(from)?.includes(to) ?? false;
}

export function assertPipelineTransition(transition: PipelineTransition): PipelineTransition {
  if (!canTransitionAssetJob(transition.from, transition.to)) {
    throw new Error(`Unsupported asset pipeline transition: ${transition.from} -> ${transition.to}`);
  }
  return Object.freeze({ ...transition });
}

export function createAssetPipelinePlan(
  input: Omit<AssetPipelinePlan, "requiredStates" | "promotionRequiresApproval"> &
    Partial<Pick<AssetPipelinePlan, "requiredStates" | "promotionRequiresApproval">>
): AssetPipelinePlan {
  const requiredStates = input.requiredStates ?? [
    "requested",
    "intake-uploaded",
    "validated",
    "processing",
    "processed",
    "rendering-review",
    "reviewed",
    "awaiting-approval",
    "approved",
    "promoting",
    "promoted",
  ];
  return Object.freeze({
    ...input,
    requiredStates: Object.freeze([...requiredStates]),
    promotionRequiresApproval: input.promotionRequiresApproval ?? true,
  });
}
