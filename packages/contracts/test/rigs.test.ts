import { describe, expect, test } from "bun:test";
import {
  CreateRigRequest,
  ProposeRigChangeRequest,
  RIG_SETUP_SCRIPT_MAX_CHARS,
  Rig,
  RigChange,
  RigChangeKind,
  RigChangeStatus,
  RigCheck,
  RigVersion,
  UpdateRigRequest,
} from "../src/index";
import {
  RigChangePlatformSurfaceValidationTarget,
  RigPlatformSurfaceValidationReceipt,
} from "../src/rig-platform-surface-validation";

describe("rig contracts", () => {
  test("RigCheck requires a non-empty name and command", () => {
    expect(RigCheck.safeParse({ name: "lint", command: "eslint ." }).success).toBe(true);
    expect(RigCheck.safeParse({ name: "", command: "x" }).success).toBe(false);
    expect(RigCheck.safeParse({ name: "x", command: "" }).success).toBe(false);
  });

  test("CreateRigRequest requires a name and defaults the list fields to []", () => {
    const parsed = CreateRigRequest.parse({ name: "dev" });
    expect(parsed.checks).toEqual([]);
    expect(parsed.credentialHooks).toEqual([]);
    expect(parsed.defaultVariableSetIds).toEqual([]);
    expect(CreateRigRequest.safeParse({ name: "" }).success).toBe(false);
    // A malformed check shape is rejected up front.
    expect(CreateRigRequest.safeParse({ name: "dev", checks: [{ name: "x" }] }).success).toBe(
      false,
    );
    // Non-uuid default variable set ids are rejected.
    expect(
      CreateRigRequest.safeParse({ name: "dev", defaultVariableSetIds: ["not-a-uuid"] }).success,
    ).toBe(false);
    expect(CreateRigRequest.safeParse({ name: "dev", image: "ubuntu:24.04" }).success).toBe(false);
  });

  test("rig setup scripts accept 1 MiB and reject larger definitions", () => {
    const maximum = "x".repeat(RIG_SETUP_SCRIPT_MAX_CHARS);
    expect(CreateRigRequest.safeParse({ name: "large", setupScript: maximum }).success).toBe(true);
    expect(
      ProposeRigChangeRequest.safeParse({
        kind: "definition_edit",
        payload: { setupScript: maximum },
      }).success,
    ).toBe(true);
    expect(
      CreateRigRequest.safeParse({ name: "too-large", setupScript: `${maximum}x` }).success,
    ).toBe(false);
  });

  test("UpdateRigRequest accepts a nullable description and partial fields", () => {
    expect(UpdateRigRequest.safeParse({}).success).toBe(true);
    expect(UpdateRigRequest.safeParse({ description: null }).success).toBe(true);
    expect(UpdateRigRequest.safeParse({ name: "" }).success).toBe(false);
  });

  test("ProposeRigChangeRequest is a kind-discriminated union", () => {
    expect(RigChangeKind.options).toEqual(["setup_append", "definition_edit"]);
    expect(
      ProposeRigChangeRequest.safeParse({
        kind: "setup_append",
        payload: { command: "apt-get install -y jq" },
      }).success,
    ).toBe(true);
    // setup_append requires a command.
    expect(ProposeRigChangeRequest.safeParse({ kind: "setup_append", payload: {} }).success).toBe(
      false,
    );
    // definition_edit accepts partial setup/check content but rejects an
    // explicit base-image override.
    expect(
      ProposeRigChangeRequest.safeParse({
        kind: "definition_edit",
        payload: { setupScript: "apt-get install -y jq", changelog: "add jq" },
      }).success,
    ).toBe(true);
    expect(
      ProposeRigChangeRequest.safeParse({
        kind: "definition_edit",
        payload: { image: "ubuntu:24.10" },
      }).success,
    ).toBe(false);
    // Unknown kind is rejected by the union.
    expect(
      ProposeRigChangeRequest.safeParse({ kind: "delete_everything", payload: {} }).success,
    ).toBe(false);
  });

  test("RigChangeStatus enumerates the full lifecycle", () => {
    expect([...RigChangeStatus.options].sort()).toEqual([
      "failed",
      "merged",
      "proposed",
      "rejected",
      "verifying",
    ]);
  });

  test("platform-surface validation receipts remain strict on the server-only subpath", () => {
    const receipt = {
      version: 2,
      checkedAt: "2026-08-30T12:00:00.000Z",
      binding: {
        leaseId: "11111111-2222-4333-8444-555555555555",
        sandboxGroupId: "22222222-3333-4444-8555-666666666666",
        leaseEpoch: 2,
        workspaceGeneration: 1,
        instanceId: "sandbox-test",
        backendId: "modal",
        rigVersionId: "22222222-3333-4444-8555-666666666666",
      },
      terminal: {
        status: "passed",
        cwd: "/workspace",
        uid: 0,
        bunVersion: "1.4.0",
        interactive: true,
      },
      browser: {
        status: "passed",
        browserSessionId: "33333333-4444-4555-8666-777777777777",
        controllerGeneration: "controller-generation",
        targetId: "page-1",
        observedTargetGeneration: "target-generation",
      },
      computer: { status: "disabled" },
    };

    expect(RigPlatformSurfaceValidationReceipt.safeParse(receipt).success).toBe(true);
    expect(RigPlatformSurfaceValidationReceipt.safeParse({ ...receipt, version: 1 }).success).toBe(
      true,
    );
    expect(
      RigPlatformSurfaceValidationReceipt.safeParse({
        ...receipt,
        terminal: { ...receipt.terminal, bunVersion: "1.4.1" },
      }).success,
    ).toBe(false);
    expect(
      RigPlatformSurfaceValidationReceipt.safeParse({ ...receipt, unexpected: true }).success,
    ).toBe(false);

    const change = {
      id: "44444444-5555-4666-8777-888888888888",
      rigId: "55555555-6666-4777-8888-999999999999",
      baseVersionId: receipt.binding.rigVersionId,
      kind: "setup_append",
      payload: { command: "true" },
      status: "proposed",
      proposedBy: "session:test",
      verification: { passed: true, platformSurfaceValidation: receipt },
      resultVersionId: null,
      createdAt: receipt.checkedAt,
      updatedAt: receipt.checkedAt,
    };
    expect(RigChangePlatformSurfaceValidationTarget.safeParse(change).success).toBe(true);
    expect(
      RigChangePlatformSurfaceValidationTarget.safeParse({
        ...change,
        verification: {
          passed: true,
          platformSurfaceValidation: {
            ...receipt,
            terminal: { ...receipt.terminal, bunVersion: "1.4.1" },
          },
        },
      }).success,
    ).toBe(false);
  });

  test("RigChange validates an embedded platform-surface receipt with the canonical strict schema", () => {
    const receipt = {
      version: 2,
      checkedAt: "2026-08-30T12:00:00.000Z",
      binding: {
        leaseId: "11111111-2222-4333-8444-555555555555",
        sandboxGroupId: "22222222-3333-4444-8555-666666666666",
        leaseEpoch: 2,
        workspaceGeneration: 1,
        instanceId: "sandbox-test",
        backendId: "modal",
        rigVersionId: "22222222-3333-4444-8555-666666666666",
      },
      terminal: { status: "disabled" },
      browser: {
        status: "passed",
        browserSessionId: "33333333-4444-4555-8666-777777777777",
        controllerGeneration: "controller-generation",
        targetId: "page-1",
        observedTargetGeneration: "target-generation",
      },
      computer: { status: "disabled" },
    };
    const change = {
      id: "55555555-5555-4555-8555-555555555555",
      rigId: "22222222-2222-4222-8222-222222222222",
      baseVersionId: "11111111-1111-4111-8111-111111111111",
      kind: "setup_append",
      payload: { command: "true" },
      status: "proposed",
      proposedBy: null,
      verification: {
        passed: true,
        futureField: 1,
        platformSurfaceValidation: receipt,
      },
      resultVersionId: null,
      createdAt: "2026-08-30T12:00:00.000Z",
      updatedAt: "2026-08-30T12:00:00.000Z",
    };
    expect(RigChange.safeParse(change).success).toBe(true);
    expect(
      RigChange.safeParse({
        ...change,
        verification: { ...change.verification, platformSurfaceValidation: { version: 1 } },
      }).success,
    ).toBe(false);
    expect(
      RigChange.safeParse({
        ...change,
        verification: {
          ...change.verification,
          platformSurfaceValidation: { ...receipt, unexpected: true },
        },
      }).success,
    ).toBe(false);
    expect(
      RigChange.safeParse({
        ...change,
        verification: {
          ...change.verification,
          platformSurfaceValidation: {
            ...receipt,
            binding: { ...receipt.binding, rigVersionId: "not-a-uuid" },
          },
        },
      }).success,
    ).toBe(false);
  });

  test("Rig / RigVersion / RigChange parse representative rows", () => {
    const version = {
      id: "11111111-1111-4111-8111-111111111111",
      rigId: "22222222-2222-4222-8222-222222222222",
      version: 1,
      image: "ubuntu:24.04",
      setupScript: "apt-get install -y ripgrep",
      checks: [{ name: "rg", command: "rg --version" }],
      credentialHooks: ["azure-cli-login"],
      defaultVariableSetIds: [],
      changelog: "Initial version",
      providerImages: {},
      createdBy: "user:alice",
      active: true,
      verificationStatus: "passed",
      createdAt: "2026-07-08T00:00:00.000Z",
    };
    expect(RigVersion.safeParse(version).success).toBe(true);
    expect(RigVersion.safeParse({ ...version, verificationStatus: "running" }).success).toBe(false);

    const providerImage = {
      backend: "modal",
      provider: "modal",
      status: "ready",
      contentHash: `sha256:${"1".repeat(64)}`,
      setupHash: `sha256:${"2".repeat(64)}`,
      sourceImage: "ubuntu:24.04",
      buildRequestId: "66666666-6666-4666-8666-666666666666",
      imageId: "im-rig-v1",
      imageDigest: null,
      artifactId: "77777777-7777-4777-8777-777777777777",
      providerBindingKeyHash: `sha256:${"3".repeat(64)}`,
      coldBootValidation: {
        version: 1,
        checkedAt: "2026-07-08T00:00:00.500Z",
      },
      provenance: {
        kind: "rig_verification",
        targetKind: "version",
        targetId: version.id,
      },
      startedAt: "2026-07-08T00:00:00.000Z",
      finishedAt: "2026-07-08T00:00:01.000Z",
      error: null,
    };
    expect(
      RigVersion.safeParse({ ...version, providerImages: { modal: providerImage } }).success,
    ).toBe(true);
    expect(
      RigVersion.safeParse({
        ...version,
        providerImages: {
          modal: { ...providerImage, imageId: null, imageDigest: null },
        },
      }).success,
    ).toBe(false);
    expect(
      RigVersion.safeParse({
        ...version,
        providerImages: {
          modal: { ...providerImage, status: "failed", error: null },
        },
      }).success,
    ).toBe(false);
    expect(
      RigVersion.safeParse({
        ...version,
        providerImages: {
          modal: {
            ...providerImage,
            status: "failed",
            imageId: null,
            artifactId: providerImage.artifactId,
            finishedAt: "2026-07-08T00:00:02.000Z",
            error: { code: "failed", message: "failed", retryable: true },
          },
        },
      }).success,
    ).toBe(false);

    const rig = {
      id: "22222222-2222-4222-8222-222222222222",
      accountId: "33333333-3333-4333-8333-333333333333",
      workspaceId: "44444444-4444-4444-8444-444444444444",
      scope: "workspace",
      generation: 1,
      status: "active",
      name: "dev-machine",
      description: null,
      createdBy: "user:alice",
      activeVersion: version,
      activeVersionHealth: null,
      versionCount: 1,
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    };
    expect(Rig.safeParse(rig).success).toBe(true);
    expect(Rig.safeParse({ ...rig, activeVersion: null }).success).toBe(true);
    expect(
      Rig.safeParse({
        ...rig,
        activeVersionHealth: { checkHealth: "passing", lastVerifiedAt: "2026-07-08T00:00:00.000Z" },
      }).success,
    ).toBe(true);

    const change = {
      id: "55555555-5555-4555-8555-555555555555",
      rigId: rig.id,
      baseVersionId: version.id,
      kind: "setup_append",
      payload: { command: "apt-get install -y jq" },
      status: "proposed",
      proposedBy: "session:s1",
      // The verification schema is passthrough — extra M4 keys survive.
      verification: { startedAt: "2026-07-08T00:00:00.000Z", futureField: 1 },
      resultVersionId: null,
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    };
    const parsedChange = RigChange.parse(change);
    expect(parsedChange.verification).toMatchObject({ futureField: 1 });
  });
});
