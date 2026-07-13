import { describe, expect, it, vi } from "vitest";

import type {
  ShaderStyleProfileRef,
  ShaderVersionRef,
  Sha256Hex,
} from "@plasius/asset-contracts";
import {
  SHADER_LIFECYCLE_CONTRACT_VERSION,
  ShaderLifecyclePlanningError,
  assertShaderLifecyclePlanExecutable,
  assertShaderLifecyclePlanReadyForExecution,
  computeShaderRequalificationInventorySha256,
  computeShaderRollbackDependencyClosureSha256,
  computeShaderRollbackReasonSha256,
  computeShaderStyleProfileClosureSha256,
  createShaderRequalificationPlan,
  createShaderRollbackPlan,
  type CreateShaderRollbackPlanInput,
  type ShaderCatalogHistoryEntry,
  type ShaderRequalificationInventory,
  type ShaderRequalificationInventorySnapshot,
  type ShaderRollbackAuthority,
} from "../src/shader-lifecycle.js";

const H0 = "0".repeat(64) as Sha256Hex;
const H1 = "1".repeat(64) as Sha256Hex;
const H2 = "2".repeat(64) as Sha256Hex;
const H3 = "3".repeat(64) as Sha256Hex;
const H4 = "4".repeat(64) as Sha256Hex;
const H5 = "5".repeat(64) as Sha256Hex;
const EXPECTED_CATALOG_REVISION = "catalog-revision-3";
const CAPTURED_AT = "2026-07-13T12:08:00.000Z";
const VERIFIED_AT = "2026-07-13T12:09:00.000Z";
const PLANNED_AT = "2026-07-13T12:10:00.000Z";

function shaderRef(
  shaderId: string,
  version: string,
  manifestSha256: Sha256Hex,
): ShaderVersionRef {
  return {
    shaderId,
    version,
    manifestUri: `https://assets.example.invalid/shaders/${shaderId}/${version}/manifest.json`,
    manifestSha256,
  };
}

function profileRef(
  profileId: string,
  version: string,
  manifestSha256: Sha256Hex,
): ShaderStyleProfileRef {
  return {
    profileId,
    version,
    manifestUri: `https://assets.example.invalid/profiles/${profileId}/${version}/manifest.json`,
    manifestSha256,
  };
}

function expectPlanningCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected ShaderLifecyclePlanningError.");
  } catch (error) {
    expect(error).toBeInstanceOf(ShaderLifecyclePlanningError);
    expect((error as ShaderLifecyclePlanningError).code).toBe(code);
  }
}

async function expectPlanningCodeAsync(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
    throw new Error("Expected ShaderLifecyclePlanningError.");
  } catch (error) {
    expect(error).toBeInstanceOf(ShaderLifecyclePlanningError);
    expect((error as ShaderLifecyclePlanningError).code).toBe(code);
  }
}

function requalificationFixture(): {
  inventory: ShaderRequalificationInventory;
  shaders: readonly ShaderVersionRef[];
  profiles: readonly ShaderStyleProfileRef[];
} {
  const shaders = [
    shaderRef("shader-alpha", "1.0.0", H0),
    shaderRef("shader-beta", "2.0.0", H1),
    shaderRef("shader-gamma", "3.0.0", H2),
  ] as const;
  const profiles = [
    profileRef("style-alpha", "1.0.0", H3),
    profileRef("style-gamma", "1.0.0", H4),
  ] as const;
  return {
    shaders,
    profiles,
    inventory: {
      shaders: [
        { shader: shaders[1], compileUnits: [
          { compileUnitId: "unit-beta-2", compileUnitSha256: H2 },
          { compileUnitId: "unit-beta-1", compileUnitSha256: H1 },
        ] },
        { shader: shaders[2], compileUnits: [
          { compileUnitId: "unit-gamma", compileUnitSha256: H3 },
        ] },
        { shader: shaders[0], compileUnits: [
          { compileUnitId: "unit-alpha", compileUnitSha256: H0 },
        ] },
      ],
      profiles: [
        { profile: profiles[1], shaders: [shaders[2]] },
        { profile: profiles[0], shaders: [shaders[1], shaders[0]] },
      ],
      modelFixtures: [
        { fixtureId: "fixture-gamma", fixtureSha256: H4, shaders: [shaders[2]], profiles: [] },
        { fixtureId: "fixture-alpha", fixtureSha256: H3, shaders: [], profiles: [profiles[0]] },
      ],
    },
  };
}

function inventoryLoader(
  inventory: ShaderRequalificationInventory,
  overrides: Partial<Omit<ShaderRequalificationInventorySnapshot, "inventory">> = {},
) {
  const snapshot: ShaderRequalificationInventorySnapshot = {
    snapshotId: "inventory-snapshot-123",
    catalogRevision: EXPECTED_CATALOG_REVISION,
    capturedAt: CAPTURED_AT,
    inventorySha256: computeShaderRequalificationInventorySha256(inventory),
    qualificationContextSha256: H5,
    inventory,
    ...overrides,
  };
  return vi.fn(async () => snapshot);
}

function historyEntry(
  version: string,
  sequence: number,
  state: ShaderCatalogHistoryEntry["state"],
  overrides: Partial<ShaderCatalogHistoryEntry> = {},
): ShaderCatalogHistoryEntry {
  return {
    assetKind: "shader",
    assetId: "shader-realistic",
    version,
    manifestUri: `https://assets.example.invalid/shaders/shader-realistic/${version}/manifest.json`,
    manifestSha256: sequence === 1 ? H1 : sequence === 2 ? H2 : H3,
    publicationClosureSha256: H5,
    qualificationContextSha256: H4,
    runtimeChannel: "stable",
    catalogRevision: `catalog-revision-${sequence}`,
    sequence,
    state,
    rollbackEligibility: state === "superseded" ? "eligible" : "ineligible",
    revokedAt: null,
    promotedAt: `2026-07-13T12:0${Math.min(sequence, 9)}:00.000Z`,
    ...overrides,
  };
}

function rollbackHistory(): readonly ShaderCatalogHistoryEntry[] {
  return [
    historyEntry("3.0.0", 3, "current"),
    historyEntry("1.0.0", 1, "superseded"),
  ];
}

function rollbackAuthority(
  entries: readonly ShaderCatalogHistoryEntry[] = rollbackHistory(),
  overrides: Partial<ShaderRollbackAuthority> = {},
): ShaderRollbackAuthority {
  return {
    loadCatalogSnapshot: vi.fn(async () => ({
      catalogRevision: EXPECTED_CATALOG_REVISION,
      currentQualificationContextSha256: H4,
      entries,
    })),
    verifyImmutableTarget: vi.fn(async ({ target }) => ({
      status: "version-ready" as const,
      assetKind: target.assetKind,
      assetId: target.assetId,
      version: target.version,
      manifestUri: target.manifestUri,
      manifestSha256: target.manifestSha256,
      verifiedAt: VERIFIED_AT,
      closureSha256: H5,
      qualificationContextSha256: H4,
      profilePackageSha256: null,
      shaderDependencies: [],
    })),
    resolveRollbackAuthorization: vi.fn(async ({ authorizationId, incidentId, subject }) => ({
      status: "authorized" as const,
      authorizationId,
      incidentId,
      nonce: "rollback-nonce-123",
      subject,
      requestedBy: "operator@example.invalid",
      authorizedAt: "2026-07-13T12:08:30.000Z",
      expiresAt: "2026-07-13T12:20:00.000Z",
    })),
    verifyManagedUri: vi.fn(async () => true),
    now: vi.fn(() => PLANNED_AT),
    ...overrides,
  };
}

function rollbackInput(
  authority: ShaderRollbackAuthority,
  overrides: Partial<Omit<CreateShaderRollbackPlanInput, "authority">> = {},
): CreateShaderRollbackPlanInput {
  return {
    authority,
    assetKind: "shader",
    assetId: "shader-realistic",
    runtimeChannel: "stable",
    expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
    targetVersion: "1.0.0",
    authorizationId: "rollback-authorization-123",
    incidentId: "incident-123",
    reason: "Regressed material output",
    idempotencyKey: "rollback:shader-realistic:incident-123",
    ...overrides,
  };
}

describe("shader requalification planning", () => {
  it("hashes equivalent inventories independently of declaration order", () => {
    const fixture = requalificationFixture();
    const reordered: ShaderRequalificationInventory = {
      shaders: [...fixture.inventory.shaders].reverse().map((item) => ({
        ...item,
        compileUnits: [...item.compileUnits].reverse(),
      })),
      profiles: [...fixture.inventory.profiles].reverse().map((item) => ({
        ...item,
        shaders: [...item.shaders].reverse(),
      })),
      modelFixtures: [...fixture.inventory.modelFixtures].reverse(),
    };

    expect(computeShaderRequalificationInventorySha256(fixture.inventory)).toBe(
      computeShaderRequalificationInventorySha256(reordered),
    );
  });

  it("loads, binds, and freezes the complete authoritative inventory deterministically", async () => {
    const fixture = requalificationFixture();
    const loadInventorySnapshot = inventoryLoader(fixture.inventory);
    const plan = await createShaderRequalificationPlan({
      loadInventorySnapshot,
      expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
      causes: ["webgpu-toolchain", "model-fixture"],
    });
    const reorderedInventory: ShaderRequalificationInventory = {
      shaders: [...fixture.inventory.shaders].reverse(),
      profiles: [...fixture.inventory.profiles].reverse(),
      modelFixtures: [...fixture.inventory.modelFixtures].reverse(),
    };
    const reordered = await createShaderRequalificationPlan({
      loadInventorySnapshot: inventoryLoader(reorderedInventory),
      expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
      causes: ["model-fixture", "webgpu-toolchain"],
    });

    expect(plan).toEqual(reordered);
    expect(loadInventorySnapshot).toHaveBeenCalledOnce();
    expect(loadInventorySnapshot).toHaveBeenCalledWith({
      expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
      signal: expect.any(AbortSignal),
    });
    expect(plan).toMatchObject({
      contractVersion: SHADER_LIFECYCLE_CONTRACT_VERSION,
      kind: "shader-requalification",
      scope: "complete-inventory",
      inventorySnapshotId: "inventory-snapshot-123",
      inventorySha256: computeShaderRequalificationInventorySha256(fixture.inventory),
      qualificationContextSha256: H5,
      catalogRevision: EXPECTED_CATALOG_REVISION,
      causes: ["model-fixture", "webgpu-toolchain"],
      compileUnits: [
        { compileUnitId: "unit-alpha", compileUnitSha256: H0 },
        { compileUnitId: "unit-beta-1", compileUnitSha256: H1 },
        { compileUnitId: "unit-beta-2", compileUnitSha256: H2 },
        { compileUnitId: "unit-gamma", compileUnitSha256: H3 },
      ],
      modelFixtures: [
        { fixtureId: "fixture-alpha", fixtureSha256: H3 },
        { fixtureId: "fixture-gamma", fixtureSha256: H4 },
      ],
    });
    expect(plan.shaders.map((shader) => shader.shaderId)).toEqual([
      "shader-alpha",
      "shader-beta",
      "shader-gamma",
    ]);
    expect(plan.profiles.map((profile) => profile.profileId)).toEqual([
      "style-alpha",
      "style-gamma",
    ]);
    expect(plan.idempotencyFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.shaders)).toBe(true);
  });

  it("selects the transitive affected closure from shaders and fixtures", async () => {
    const fixture = requalificationFixture();
    const fromShader = await createShaderRequalificationPlan({
      loadInventorySnapshot: inventoryLoader(fixture.inventory),
      expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
      causes: ["shader-source"],
      changedShaders: [fixture.shaders[0]!],
    });
    expect(fromShader).toMatchObject({
      scope: "affected-closure",
      compileUnits: [
        { compileUnitId: "unit-alpha" },
        { compileUnitId: "unit-beta-1" },
        { compileUnitId: "unit-beta-2" },
      ],
      modelFixtures: [{ fixtureId: "fixture-alpha", fixtureSha256: H3 }],
    });
    expect(fromShader.shaders.map((shader) => shader.shaderId)).toEqual([
      "shader-alpha",
      "shader-beta",
    ]);
    expect(fromShader.profiles.map((profile) => profile.profileId)).toEqual(["style-alpha"]);

    const fromFixture = await createShaderRequalificationPlan({
      loadInventorySnapshot: inventoryLoader(fixture.inventory),
      expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
      causes: ["model-fixture"],
      changedModelFixtureIds: ["fixture-gamma"],
    });
    expect(fromFixture.shaders.map((shader) => shader.shaderId)).toEqual(["shader-gamma"]);
    expect(fromFixture.profiles.map((profile) => profile.profileId)).toEqual(["style-gamma"]);
    expect(fromFixture.modelFixtures).toEqual([{ fixtureId: "fixture-gamma", fixtureSha256: H4 }]);
  });

  it("rejects stale revisions, stale hashes, and unavailable inventory authorities", async () => {
    const fixture = requalificationFixture();
    await expectPlanningCodeAsync(
      () => createShaderRequalificationPlan({
        loadInventorySnapshot: inventoryLoader(fixture.inventory, { catalogRevision: "catalog-revision-stale" }),
        expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
        causes: ["webgpu-toolchain"],
      }),
      "catalog-revision-invalid",
    );
    await expectPlanningCodeAsync(
      () => createShaderRequalificationPlan({
        loadInventorySnapshot: inventoryLoader(fixture.inventory, { inventorySha256: H5 }),
        expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
        causes: ["webgpu-toolchain"],
      }),
      "requalification-inventory-invalid",
    );
    await expectPlanningCodeAsync(
      () => createShaderRequalificationPlan({
        loadInventorySnapshot: vi.fn(async () => { throw new Error("catalog unavailable"); }),
        expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
        causes: ["webgpu-toolchain"],
      }),
      "authority-unavailable",
    );
  });

  it("rejects duplicate, dangling, and ambiguous inventory identities", async () => {
    const fixture = requalificationFixture();
    const invalidInventories: ShaderRequalificationInventory[] = [
      { ...fixture.inventory, shaders: [...fixture.inventory.shaders, fixture.inventory.shaders[0]!] },
      {
        ...fixture.inventory,
        shaders: fixture.inventory.shaders.map((item, index) => ({
          ...item,
          compileUnits: index === 0
            ? [{ compileUnitId: "unit-alpha", compileUnitSha256: H0 }]
            : item.compileUnits,
        })),
      },
      {
        ...fixture.inventory,
        profiles: [{
          profile: fixture.profiles[0]!,
          shaders: [shaderRef("shader-missing", "1.0.0", H5)],
        }],
      },
      {
        ...fixture.inventory,
        modelFixtures: [{
          fixtureId: "fixture-dangling",
          fixtureSha256: H5,
          shaders: [],
          profiles: [profileRef("style-missing", "1.0.0", H5)],
        }],
      },
    ];

    for (const inventory of invalidInventories) {
      const loadInventorySnapshot = vi.fn(async (): Promise<ShaderRequalificationInventorySnapshot> => ({
        snapshotId: "inventory-invalid",
        catalogRevision: EXPECTED_CATALOG_REVISION,
        capturedAt: CAPTURED_AT,
        inventorySha256: H5,
        qualificationContextSha256: H5,
        inventory,
      }));
      await expectPlanningCodeAsync(
        () => createShaderRequalificationPlan({
          loadInventorySnapshot,
          expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
          causes: ["shader-source"],
          changedShaders: [fixture.shaders[0]!],
        }),
        "requalification-inventory-invalid",
      );
    }
  });

  it("rejects duplicate causes and missing or unknown affected roots", async () => {
    const fixture = requalificationFixture();
    await expectPlanningCodeAsync(
      () => createShaderRequalificationPlan({
        loadInventorySnapshot: inventoryLoader(fixture.inventory),
        expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
        causes: ["shader-source", "shader-source"],
        changedShaders: [fixture.shaders[0]!],
      }),
      "requalification-inventory-invalid",
    );
    await expectPlanningCodeAsync(
      () => createShaderRequalificationPlan({
        loadInventorySnapshot: inventoryLoader(fixture.inventory),
        expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
        causes: ["shader-source"],
        changedShaders: [shaderRef("shader-alpha", "latest", H0)],
      }),
      "requalification-inventory-invalid",
    );
    await expectPlanningCodeAsync(
      () => createShaderRequalificationPlan({
        loadInventorySnapshot: inventoryLoader(fixture.inventory),
        expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
        causes: ["shader-source"],
      }),
      "requalification-inventory-invalid",
    );
    await expectPlanningCodeAsync(
      () => createShaderRequalificationPlan({
        loadInventorySnapshot: inventoryLoader(fixture.inventory),
        expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
        causes: ["style-profile"],
        changedProfiles: [profileRef("style-missing", "1.0.0", H5)],
      }),
      "requalification-inventory-invalid",
    );
  });

  it("rejects malformed inventories before an authority snapshot can be hashed", () => {
    const fixture = requalificationFixture();
    expectPlanningCode(
      () => computeShaderRequalificationInventorySha256({
        ...fixture.inventory,
        shaders: [],
      }),
      "requalification-inventory-invalid",
    );
  });

  it("rejects sparse nested inventory and changed-root arrays with stable errors", async () => {
    const fixture = requalificationFixture();
    const sparseShaderRefs = new Array<ShaderVersionRef>(1);
    const sparseInventory: ShaderRequalificationInventory = {
      ...fixture.inventory,
      profiles: [{
        profile: fixture.profiles[0]!,
        shaders: sparseShaderRefs,
      }],
    };

    expectPlanningCode(
      () => computeShaderRequalificationInventorySha256(sparseInventory),
      "requalification-inventory-invalid",
    );

    const loadInventorySnapshot = vi.fn(async (): Promise<ShaderRequalificationInventorySnapshot> => ({
      snapshotId: "inventory-sparse",
      catalogRevision: EXPECTED_CATALOG_REVISION,
      capturedAt: CAPTURED_AT,
      inventorySha256: H5,
      qualificationContextSha256: H5,
      inventory: sparseInventory,
    }));
    await expectPlanningCodeAsync(
      () => createShaderRequalificationPlan({
        loadInventorySnapshot,
        expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
        causes: ["style-profile"],
        changedProfiles: [fixture.profiles[0]!],
      }),
      "requalification-inventory-invalid",
    );
    await expectPlanningCodeAsync(
      () => createShaderRequalificationPlan({
        loadInventorySnapshot: inventoryLoader(fixture.inventory),
        expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
        causes: ["style-profile"],
        changedProfiles: new Array<ShaderStyleProfileRef>(1),
      }),
      "requalification-inventory-invalid",
    );
  });

  it("binds content and qualification context, but not volatile snapshot metadata", async () => {
    const fixture = requalificationFixture();
    const base = await createShaderRequalificationPlan({
      loadInventorySnapshot: inventoryLoader(fixture.inventory),
      expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
      causes: ["webgpu-toolchain"],
    });
    const volatile = await createShaderRequalificationPlan({
      loadInventorySnapshot: inventoryLoader(fixture.inventory, {
        snapshotId: "inventory-snapshot-refreshed",
        capturedAt: "2026-07-13T12:09:30.000Z",
      }),
      expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
      causes: ["webgpu-toolchain"],
    });
    const changedContext = await createShaderRequalificationPlan({
      loadInventorySnapshot: inventoryLoader(fixture.inventory, {
        qualificationContextSha256: H4,
      }),
      expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
      causes: ["webgpu-toolchain"],
    });
    const changedInventory: ShaderRequalificationInventory = {
      ...fixture.inventory,
      shaders: fixture.inventory.shaders.map((item, index) => index === 0
        ? {
            ...item,
            compileUnits: item.compileUnits.map((unit, unitIndex) => unitIndex === 0
              ? { ...unit, compileUnitSha256: H5 }
              : unit),
          }
        : item),
    };
    const changedContent = await createShaderRequalificationPlan({
      loadInventorySnapshot: inventoryLoader(changedInventory),
      expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
      causes: ["webgpu-toolchain"],
    });

    expect(volatile.inventorySnapshotId).not.toBe(base.inventorySnapshotId);
    expect(volatile.idempotencyFingerprint).toBe(base.idempotencyFingerprint);
    expect(changedContext.idempotencyFingerprint).not.toBe(base.idempotencyFingerprint);
    expect(changedContent.idempotencyFingerprint).not.toBe(base.idempotencyFingerprint);
  });

  it("brands executable plans so serialized or forged work cannot reach an executor", async () => {
    const fixture = requalificationFixture();
    const plan = await createShaderRequalificationPlan({
      loadInventorySnapshot: inventoryLoader(fixture.inventory),
      expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
      causes: ["webgpu-toolchain"],
    });

    expect(() => assertShaderLifecyclePlanExecutable(plan)).not.toThrow();
    expect(() => assertShaderLifecyclePlanReadyForExecution(plan, {
      now: () => PLANNED_AT,
    })).not.toThrow();
    expectPlanningCode(
      () => assertShaderLifecyclePlanExecutable(JSON.parse(JSON.stringify(plan))),
      "invalid-input",
    );
    expectPlanningCode(
      () => assertShaderLifecyclePlanReadyForExecution({ ...plan }, {
        now: () => PLANNED_AT,
      }),
      "invalid-input",
    );
  });
});

describe("shader catalog rollback planning", () => {
  it("uses authority data to create mandatory reverify, CAS, and audit effects", async () => {
    const authority = rollbackAuthority();
    const plan = await createShaderRollbackPlan(rollbackInput(authority));

    expect(authority.loadCatalogSnapshot).toHaveBeenCalledOnce();
    expect(authority.loadCatalogSnapshot).toHaveBeenCalledWith({
      assetKind: "shader",
      assetId: "shader-realistic",
      runtimeChannel: "stable",
      targetVersion: "1.0.0",
      expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
      signal: expect.any(AbortSignal),
    });
    expect(authority.verifyImmutableTarget).toHaveBeenCalledWith({
      target: expect.objectContaining({ version: "1.0.0", state: "superseded" }),
      signal: expect.any(AbortSignal),
    });
    expect(authority.verifyManagedUri).toHaveBeenCalledWith({
      assetKind: "shader",
      assetId: "shader-realistic",
      version: "1.0.0",
      uri: "https://assets.example.invalid/shaders/shader-realistic/1.0.0/manifest.json",
      purpose: "manifest",
      signal: expect.any(AbortSignal),
    });
    expect(authority.resolveRollbackAuthorization).toHaveBeenCalledWith({
      authorizationId: "rollback-authorization-123",
      incidentId: "incident-123",
      subject: {
        assetKind: "shader",
        assetId: "shader-realistic",
        runtimeChannel: "stable",
        targetVersion: "1.0.0",
        targetManifestSha256: H1,
        targetPublicationClosureSha256: H5,
        targetDependencyClosureSha256: null,
        qualificationContextSha256: H4,
        expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
        reasonSha256: computeShaderRollbackReasonSha256("Regressed material output"),
      },
      signal: expect.any(AbortSignal),
    });
    expect(plan).toMatchObject({
      contractVersion: SHADER_LIFECYCLE_CONTRACT_VERSION,
      kind: "shader-catalog-rollback",
      runtimeChannel: "stable",
      current: { version: "3.0.0", state: "current" },
      target: { version: "1.0.0", state: "superseded" },
      targetVerification: { status: "version-ready", closureSha256: H5 },
      verificationExpiresAt: "2026-07-13T12:14:00.000Z",
      authorizationId: "rollback-authorization-123",
      authorizationNonce: "rollback-nonce-123",
      requestedBy: "operator@example.invalid",
      effects: [
        {
          order: 1,
          kind: "reverify-immutable-version",
          version: "1.0.0",
          priorClosureSha256: H5,
          verificationExpiresAt: "2026-07-13T12:14:00.000Z",
        },
        {
          order: 2,
          kind: "compare-and-swap-catalog-with-authorization",
          expectedCatalogRevision: EXPECTED_CATALOG_REVISION,
          targetVersion: "1.0.0",
        },
        {
          order: 3,
          kind: "record-rollback-audit",
          authorizationId: "rollback-authorization-123",
          incidentId: "incident-123",
          plannedAt: PLANNED_AT,
        },
      ],
    });
    expect(plan.idempotencyFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.effects)).toBe(true);
  });

  it("does not authorize rollback when immutable-target verification tries to mutate history", async () => {
    let mutationAttempts = 0;
    let mutationFailures = 0;
    let suppliedTarget: ShaderCatalogHistoryEntry | undefined;
    const history = rollbackHistory();
    const authority = rollbackAuthority(history, {
      verifyImmutableTarget: vi.fn(async ({ target }) => {
        suppliedTarget = target;
        const mutations: readonly (readonly [keyof ShaderCatalogHistoryEntry, unknown])[] = [
          ["assetId", "shader-substituted"],
          ["version", "9.9.9"],
          ["rollbackEligibility", "ineligible"],
          ["qualificationContextSha256", H0],
          ["publicationClosureSha256", H0],
        ];
        for (const [key, value] of mutations) {
          mutationAttempts += 1;
          try {
            Object.defineProperty(target, key, {
              configurable: true,
              enumerable: true,
              value,
              writable: true,
            });
          } catch {
            mutationFailures += 1;
          }
        }
        if (mutationFailures > 0) throw new Error("immutable rollback target");
        return {
          status: "version-ready" as const,
          assetKind: target.assetKind,
          assetId: target.assetId,
          version: target.version,
          manifestUri: target.manifestUri,
          manifestSha256: target.manifestSha256,
          verifiedAt: VERIFIED_AT,
          closureSha256: target.publicationClosureSha256,
          qualificationContextSha256: target.qualificationContextSha256,
          profilePackageSha256: null,
          shaderDependencies: [],
        };
      }),
    });

    await expectPlanningCodeAsync(
      () => createShaderRollbackPlan(rollbackInput(authority)),
      "authority-unavailable",
    );
    expect(mutationAttempts).toBe(5);
    expect(mutationFailures).toBe(5);
    expect(suppliedTarget).not.toBe(history[1]);
    expect(Object.isFrozen(suppliedTarget)).toBe(true);
    expect(Object.isFrozen(history[1])).toBe(false);
    expect(history[1]).toMatchObject({
      assetId: "shader-realistic",
      version: "1.0.0",
      rollbackEligibility: "eligible",
      qualificationContextSha256: H4,
      publicationClosureSha256: H5,
    });
    expect(authority.resolveRollbackAuthorization).not.toHaveBeenCalled();
  });

  it("rejects mutable version aliases before loading rollback history", async () => {
    const authority = rollbackAuthority();
    await expectPlanningCodeAsync(
      () => createShaderRollbackPlan(rollbackInput(authority, { targetVersion: "latest" })),
      "rollback-target-invalid",
    );
    expect(authority.loadCatalogSnapshot).not.toHaveBeenCalled();
  });

  it("binds freshly promoted, non-revoked shader dependencies into profile rollback", async () => {
    const shaderDependency = {
      state: "promoted" as const,
      shader: shaderRef("shader-realistic", "1.0.0", H1),
      runtimeChannel: "stable" as const,
      catalogRevision: EXPECTED_CATALOG_REVISION,
      qualificationContextSha256: H4,
      closureSha256: H3,
      verifiedAt: VERIFIED_AT,
      revokedAt: null,
    };
    const profileTarget = historyEntry("1.0.0", 1, "superseded", {
      assetKind: "shader-style-profile",
      assetId: "style-realistic",
    });
    const profileEntries = [
      historyEntry("2.0.0", 3, "current", {
        assetKind: "shader-style-profile",
        assetId: "style-realistic",
      }),
      {
        ...profileTarget,
        publicationClosureSha256: computeShaderStyleProfileClosureSha256({
          profile: {
            profileId: profileTarget.assetId,
            version: profileTarget.version,
            manifestUri: profileTarget.manifestUri,
            manifestSha256: profileTarget.manifestSha256,
          },
          profilePackageSha256: H2,
          qualificationContextSha256: H4,
          shaders: [shaderDependency.shader],
        }),
      },
    ];
    const authority = rollbackAuthority(profileEntries, {
      verifyImmutableTarget: vi.fn(async ({ target }) => ({
        status: "version-ready" as const,
        assetKind: target.assetKind,
        assetId: target.assetId,
        version: target.version,
        manifestUri: target.manifestUri,
        manifestSha256: target.manifestSha256,
        verifiedAt: VERIFIED_AT,
        closureSha256: target.publicationClosureSha256,
        qualificationContextSha256: H4,
        profilePackageSha256: H2,
        shaderDependencies: [shaderDependency],
      })),
    });
    const plan = await createShaderRollbackPlan(rollbackInput(authority, {
      assetKind: "shader-style-profile",
      assetId: "style-realistic",
    }));
    const dependencyClosure = computeShaderRollbackDependencyClosureSha256([shaderDependency]);

    expect(plan.targetDependencyClosureSha256).toBe(dependencyClosure);
    expect(plan.targetVerification.profilePackageSha256).toBe(H2);
    expect(plan.targetShaderDependencies).toEqual([{
      ...shaderDependency,
      verificationExpiresAt: "2026-07-13T12:14:00.000Z",
    }]);
    expect(plan.effects[1]).toMatchObject({
      targetDependencyClosureSha256: dependencyClosure,
    });
    expect(authority.verifyManagedUri).toHaveBeenCalledWith(expect.objectContaining({
      assetKind: "shader",
      assetId: "shader-realistic",
      version: "1.0.0",
      uri: shaderDependency.shader.manifestUri,
    }));
    expect(() => assertShaderLifecyclePlanReadyForExecution(plan, {
      now: () => "2026-07-13T12:13:30.000Z",
    })).not.toThrow();
    expectPlanningCode(
      () => assertShaderLifecyclePlanReadyForExecution(plan, {
        now: () => "2026-07-13T12:13:30.001Z",
      }),
      "rollback-target-invalid",
    );

    await expectPlanningCodeAsync(
      () => createShaderRollbackPlan(rollbackInput(rollbackAuthority(profileEntries), {
        assetKind: "shader-style-profile",
        assetId: "style-realistic",
      })),
      "rollback-target-invalid",
    );
    const revokedAuthority = rollbackAuthority(profileEntries, {
      verifyImmutableTarget: vi.fn(async ({ target }) => ({
        status: "version-ready" as const,
        assetKind: target.assetKind,
        assetId: target.assetId,
        version: target.version,
        manifestUri: target.manifestUri,
        manifestSha256: target.manifestSha256,
        verifiedAt: VERIFIED_AT,
        closureSha256: target.publicationClosureSha256,
        qualificationContextSha256: H4,
        profilePackageSha256: H2,
        shaderDependencies: [{
          ...shaderDependency,
          revokedAt: "2026-07-13T12:09:30.000Z",
        } as never],
      })),
    });
    await expectPlanningCodeAsync(
      () => createShaderRollbackPlan(rollbackInput(revokedAuthority, {
        assetKind: "shader-style-profile",
        assetId: "style-realistic",
      })),
      "rollback-target-invalid",
    );
  });

  it("rejects a shader dependency substituted into an immutable profile rollback", async () => {
    const legitimateShader = shaderRef("shader-realistic", "1.0.0", H1);
    const target = historyEntry("1.0.0", 1, "superseded", {
      assetKind: "shader-style-profile",
      assetId: "style-realistic",
    });
    const publicationClosureSha256 = computeShaderStyleProfileClosureSha256({
      profile: {
        profileId: target.assetId,
        version: target.version,
        manifestUri: target.manifestUri,
        manifestSha256: target.manifestSha256,
      },
      profilePackageSha256: H2,
      qualificationContextSha256: H4,
      shaders: [legitimateShader],
    });
    const profileEntries = [
      historyEntry("2.0.0", 3, "current", {
        assetKind: "shader-style-profile",
        assetId: "style-realistic",
      }),
      { ...target, publicationClosureSha256 },
    ];
    const authority = rollbackAuthority(profileEntries, {
      verifyImmutableTarget: vi.fn(async ({ target: rollbackTarget }) => ({
        status: "version-ready" as const,
        assetKind: rollbackTarget.assetKind,
        assetId: rollbackTarget.assetId,
        version: rollbackTarget.version,
        manifestUri: rollbackTarget.manifestUri,
        manifestSha256: rollbackTarget.manifestSha256,
        verifiedAt: VERIFIED_AT,
        closureSha256: rollbackTarget.publicationClosureSha256,
        qualificationContextSha256: H4,
        profilePackageSha256: H2,
        shaderDependencies: [{
          state: "promoted" as const,
          shader: shaderRef("shader-not-in-profile", "9.0.0", H3),
          runtimeChannel: "stable" as const,
          catalogRevision: EXPECTED_CATALOG_REVISION,
          qualificationContextSha256: H4,
          closureSha256: H3,
          verifiedAt: VERIFIED_AT,
          revokedAt: null,
        }],
      })),
    });

    await expectPlanningCodeAsync(
      () => createShaderRollbackPlan(rollbackInput(authority, {
        assetKind: "shader-style-profile",
        assetId: "style-realistic",
      })),
      "rollback-target-invalid",
    );
    expect(authority.resolveRollbackAuthorization).not.toHaveBeenCalled();
  });

  it("is deterministic for authoritative history declaration order", async () => {
    const history = rollbackHistory();
    const first = await createShaderRollbackPlan(rollbackInput(rollbackAuthority(history)));
    const reordered = await createShaderRollbackPlan(
      rollbackInput(rollbackAuthority([...history].reverse())),
    );
    expect(first).toEqual(reordered);
  });

  it("rejects current, newer, unpromoted, and cross-channel rollback targets", async () => {
    const current = rollbackHistory()[0]!;
    const invalidTargets = [
      historyEntry("1.0.0", 1, "current"),
      historyEntry("1.0.0", 4, "superseded", { catalogRevision: "catalog-revision-4" }),
      historyEntry("1.0.0", 1, "candidate"),
      historyEntry("1.0.0", 1, "superseded", { runtimeChannel: "preview" }),
    ];

    for (const target of invalidTargets) {
      await expectPlanningCodeAsync(
        () => createShaderRollbackPlan(rollbackInput(rollbackAuthority([current, target]))),
        "rollback-target-invalid",
      );
    }
  });

  it("rejects stale, mismatched, and non-ready immutable target verification", async () => {
    const target = rollbackHistory()[1]!;
    const verification = {
      status: "version-ready" as const,
      assetKind: target.assetKind,
      assetId: target.assetId,
      version: target.version,
      manifestUri: target.manifestUri,
      manifestSha256: target.manifestSha256,
      verifiedAt: VERIFIED_AT,
      closureSha256: H5,
      qualificationContextSha256: H4,
      profilePackageSha256: null,
      shaderDependencies: [],
    };
    const invalidVerifications = [
      { ...verification, status: "not-ready" },
      { ...verification, manifestUri: "https://assets.example.invalid/wrong/manifest.json" },
      { ...verification, manifestSha256: H4 },
      { ...verification, closureSha256: "not-a-digest" },
      { ...verification, profilePackageSha256: H2 },
      {
        ...verification,
        shaderDependencies: [{
          state: "promoted" as const,
          shader: shaderRef("shader-not-in-profile", "9.0.0", H3),
          runtimeChannel: "stable" as const,
          catalogRevision: EXPECTED_CATALOG_REVISION,
          qualificationContextSha256: H4,
          closureSha256: H3,
          verifiedAt: VERIFIED_AT,
          revokedAt: null,
        }],
      },
    ];
    for (const invalid of invalidVerifications) {
      await expectPlanningCodeAsync(
        () => createShaderRollbackPlan(rollbackInput(rollbackAuthority(rollbackHistory(), {
          verifyImmutableTarget: vi.fn(async () => invalid as never),
        }))),
        "rollback-target-invalid",
      );
    }
    await expectPlanningCodeAsync(
      () => createShaderRollbackPlan(rollbackInput(rollbackAuthority(rollbackHistory(), {
        verifyImmutableTarget: vi.fn(async () => ({
          ...verification,
          verifiedAt: "2026-07-13T12:04:59.999Z",
        })),
      }))),
      "rollback-target-invalid",
    );
  });

  it("rejects unmanaged target URIs and stale authority revisions", async () => {
    await expectPlanningCodeAsync(
      () => createShaderRollbackPlan(rollbackInput(rollbackAuthority(rollbackHistory(), {
        verifyManagedUri: vi.fn(async () => false),
      }))),
      "managed-uri-invalid",
    );
    await expectPlanningCodeAsync(
      () => createShaderRollbackPlan(rollbackInput(rollbackAuthority(rollbackHistory(), {
        loadCatalogSnapshot: vi.fn(async () => ({
          catalogRevision: "catalog-revision-stale",
          currentQualificationContextSha256: H4,
          entries: rollbackHistory(),
        })),
      }))),
      "catalog-revision-invalid",
    );
  });

  it("maps catalog and immutable-verifier dependency failures to authority-unavailable", async () => {
    await expectPlanningCodeAsync(
      () => createShaderRollbackPlan(rollbackInput(rollbackAuthority(rollbackHistory(), {
        loadCatalogSnapshot: vi.fn(async () => { throw new Error("catalog unavailable"); }),
      }))),
      "authority-unavailable",
    );
    await expectPlanningCodeAsync(
      () => createShaderRollbackPlan(rollbackInput(rollbackAuthority(rollbackHistory(), {
        verifyImmutableTarget: vi.fn(async () => { throw new Error("storage unavailable"); }),
      }))),
      "authority-unavailable",
    );
  });

  it("rejects duplicate history sequences and revisions", async () => {
    const history = rollbackHistory();
    const target = history[1]!;
    await expectPlanningCodeAsync(
      () => createShaderRollbackPlan(rollbackInput(rollbackAuthority([
        history[0]!,
        target,
        historyEntry("2.0.0", 1, "superseded", { catalogRevision: "catalog-revision-2" }),
      ]))),
      "rollback-target-invalid",
    );
    await expectPlanningCodeAsync(
      () => createShaderRollbackPlan(rollbackInput(rollbackAuthority([
        history[0]!,
        target,
        historyEntry("2.0.0", 2, "superseded", { catalogRevision: target.catalogRevision }),
      ]))),
      "rollback-target-invalid",
    );
  });

  it("requires an eligible target under the current qualification context", async () => {
    const history = rollbackHistory();
    const invalidTargets = [
      { ...history[1]!, rollbackEligibility: "revoked" as const, revokedAt: VERIFIED_AT },
      { ...history[1]!, rollbackEligibility: "ineligible" as const },
      { ...history[1]!, qualificationContextSha256: H3 },
    ];
    for (const target of invalidTargets) {
      await expectPlanningCodeAsync(
        () => createShaderRollbackPlan(rollbackInput(rollbackAuthority([history[0]!, target]))),
        "rollback-target-invalid",
      );
    }
    await expectPlanningCodeAsync(
      () => createShaderRollbackPlan(rollbackInput(rollbackAuthority(history, {
        loadCatalogSnapshot: vi.fn(async () => ({
          catalogRevision: EXPECTED_CATALOG_REVISION,
          currentQualificationContextSha256: H3,
          entries: history,
        })),
      }))),
      "rollback-target-invalid",
    );
  });

  it("rejects mismatched, expired, or short-lived rollback authorization", async () => {
    const makeAuthorization = (
      mutate: (authorization: Awaited<ReturnType<ShaderRollbackAuthority["resolveRollbackAuthorization"]>>) => unknown,
    ): ShaderRollbackAuthority => rollbackAuthority(rollbackHistory(), {
      resolveRollbackAuthorization: vi.fn(async ({ authorizationId, incidentId, subject }) => mutate({
        status: "authorized" as const,
        authorizationId,
        incidentId,
        nonce: "rollback-nonce-123",
        subject,
        requestedBy: "operator@example.invalid",
        authorizedAt: "2026-07-13T12:08:30.000Z",
        expiresAt: "2026-07-13T12:20:00.000Z",
      }) as never),
    });
    const authorities = [
      makeAuthorization((authorization) => ({
        ...authorization!,
        nonce: "",
      })),
      makeAuthorization((authorization) => ({
        ...authorization!,
        subject: { ...authorization!.subject, reasonSha256: H0 },
      })),
      makeAuthorization((authorization) => ({
        ...authorization!,
        expiresAt: "2026-07-13T12:10:29.999Z",
      })),
      makeAuthorization((authorization) => ({
        ...authorization!,
        authorizedAt: "2026-07-13T12:10:01.000Z",
      })),
    ];

    for (const authority of authorities) {
      await expectPlanningCodeAsync(
        () => createShaderRollbackPlan(rollbackInput(authority)),
        "rollback-target-invalid",
      );
    }
  });

  it("requires a branded rollback plan with fresh verification and authorization at execution", async () => {
    const plan = await createShaderRollbackPlan(rollbackInput(rollbackAuthority()));

    expect(() => assertShaderLifecyclePlanReadyForExecution(plan, {
      now: () => "2026-07-13T12:13:29.999Z",
    })).not.toThrow();
    expectPlanningCode(
      () => assertShaderLifecyclePlanReadyForExecution(plan, {
        now: () => "2026-07-13T12:13:30.001Z",
      }),
      "rollback-target-invalid",
    );
    expectPlanningCode(
      () => assertShaderLifecyclePlanReadyForExecution(JSON.parse(JSON.stringify(plan)), {
        now: () => PLANNED_AT,
      }),
      "invalid-input",
    );
    expectPlanningCode(
      () => assertShaderLifecyclePlanReadyForExecution(plan, { now: () => "untrusted-time" }),
      "invalid-input",
    );
  });
});
