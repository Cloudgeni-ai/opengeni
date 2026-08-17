#!/usr/bin/env bun

import { createHash } from "node:crypto";

import { getSettings, type Settings } from "@opengeni/config";
import { bootstrapWorkspace, createDb, createRig, getRig } from "@opengeni/db";
import {
  deleteModalCheckpointSnapshot,
  resolveModalCheckpointProviderBinding,
} from "@opengeni/runtime/sandbox";
import { startTestServices } from "@opengeni/testing";
import { createRigVerificationActivities } from "../apps/worker/src/activities/rig-verification";
import type { ActivityServices } from "../apps/worker/src/activities/types";

const setupChars = 131_072;
const checkCounts = integerListArgument("--check-counts", [0, 10]);
const services = await startTestServices({ temporal: false, objectStorage: false });
const configured = getSettings();
const settings: Settings = {
  ...configured,
  databaseUrl: services.databaseUrl,
  sandboxBackend: "modal",
  modalAppName: process.env.OPENGENI_MODAL_SMOKE_APP ?? "opengeni-rig-first-use-perf-lab",
  modalImageRef: process.env.OPENGENI_MODAL_SMOKE_IMAGE ?? "python:3.12-slim",
  modalImageId: undefined,
  modalWorkspacePersistence: "snapshot_directory",
  modalTimeoutSeconds: 900,
  modalIdleTimeoutSeconds: 300,
  rigSetupTimeoutMs: 180_000,
  rigVerificationLeaseOwnershipEnabled: true,
};
const dbClient = createDb(services.databaseUrl);
const results = [];

try {
  await services.migrate();
  const identity = await bootstrapWorkspace(dbClient.db, {
    accountExternalSource: "bench:rig-first-use-modal",
    accountExternalId: crypto.randomUUID(),
    accountName: "Rig first-use Modal benchmark",
    workspaceExternalSource: "bench:rig-first-use-modal",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Rig first-use Modal benchmark",
    subjectId: `bench:rig-first-use-modal:${crypto.randomUUID()}`,
  });
  const grant = identity.workspaceGrants[0]!;
  const verifier = createRigVerificationActivities(
    async () =>
      ({
        settings,
        db: dbClient.db,
      }) as ActivityServices,
  );

  for (const [caseIndex, checkCount] of checkCounts.entries()) {
    const exactTail = "界".repeat(130_000);
    const exactTailBytes = Buffer.byteLength(exactTail);
    const exactTailSha256 = createHash("sha256").update(exactTail).digest("hex");
    const setupPrefix = [
      "set -eu",
      `actual_tail_sha256="$(tail -c ${exactTailBytes} "$0" | sha256sum | awk '{print $1}')"`,
      `[ "$actual_tail_sha256" = '${exactTailSha256}' ]`,
      "printf ready > /workspace/rig-ready",
      "#",
    ].join("\n");
    const fillerChars = setupChars - setupPrefix.length - exactTail.length;
    if (fillerChars < 0) throw new Error("maximum rig setup proof exceeds the schema limit");
    const setupScript = `${setupPrefix}${"#".repeat(fillerChars)}${exactTail}`;
    const rig = await createRig(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: `maximum-first-use-${checkCount}-checks-${caseIndex}`,
      createdBy: `user:${grant.subjectId}`,
      initialVersion: {
        image: settings.modalImageRef ?? null,
        setupScript,
        checks: Array.from({ length: checkCount }, (_, index) => ({
          name: `check-${String(index).padStart(3, "0")}`,
          command: "test -f /workspace/rig-ready",
        })),
        credentialHooks: [],
        defaultVariableSetIds: [],
        changelog: "Maximum first-use benchmark",
        createdBy: `user:${grant.subjectId}`,
      },
    });
    if (!rig.activeVersion) throw new Error("benchmark rig has no active version");
    const startedAt = performance.now();
    const verification = await verifier.verifyRigVersion({
      workspaceId: grant.workspaceId,
      versionId: rig.activeVersion.id,
    });
    const wallMs = performance.now() - startedAt;
    const stored = await getRig(dbClient.db, grant.workspaceId, rig.id);
    const image = stored?.activeVersion?.providerImages.modal;
    if (!verification.passed || image?.status !== "ready" || !image.imageId) {
      throw new Error(
        `rig first-use verification did not publish a ready image: ${JSON.stringify(verification)}`,
      );
    }
    results.push({
      checkCount,
      setupChars: setupScript.length,
      setupBytes: Buffer.byteLength(setupScript),
      setupSha256: createHash("sha256").update(setupScript).digest("hex"),
      exactTailBytes,
      exactTailSha256,
      wallMs,
      checkResults: verification.checkResults.length,
      providerImageStatus: image.status,
      coldBootValidated: image.coldBootValidation?.version === 1,
      providerBuildMs:
        image.finishedAt === null
          ? null
          : Date.parse(image.finishedAt) - Date.parse(image.startedAt),
      imageId: image.imageId,
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        modelCalls: 0,
        invariant:
          "The exact maximum setup and every declared check pass before a provider image becomes ready; the image also passes an independent cold boot.",
        results,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  try {
    const binding = await resolveModalCheckpointProviderBinding(settings);
    for (const result of results) {
      await deleteModalCheckpointSnapshot(settings, binding.key, result.imageId).catch(
        () => "not_found" as const,
      );
    }
  } finally {
    await dbClient.close();
    await services.down();
  }
}

process.exit(0);

function integerListArgument(name: string, fallback: number[]): number[] {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const parsed = (process.argv[index + 1] ?? "")
    .split(",")
    .map((value) => Number.parseInt(value, 10));
  if (
    parsed.length === 0 ||
    parsed.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 100)
  ) {
    throw new Error(`${name} must contain comma-separated integers from 0 through 100`);
  }
  return parsed;
}
