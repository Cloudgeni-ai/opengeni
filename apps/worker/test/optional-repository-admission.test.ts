import { expect, test } from "bun:test";
import type { ResourceRef } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import {
  dropUnavailableOptionalRepositories,
  type DropUnavailableOptionalRepositoriesInput,
} from "../src/activities/agent-turn/optional-repositories";
import { waitForTurnOperation } from "../src/activities/agent-turn/sandbox-provision";

const repository = (id: number, mount = `repo-${id}`): ResourceRef =>
  ({
    kind: "repository",
    uri: `https://github.com/example/repo-${id}.git`,
    ref: "main",
    mountPath: mount,
    provider: "github",
    githubInstallationId: 77,
    githubRepositoryId: id,
    optional: true,
  }) as ResourceRef;
function input(resources: ResourceRef[]): DropUnavailableOptionalRepositoriesInput {
  return {
    db: {} as Database,
    settings: testSettings(),
    workspaceId: "ws",
    activeSandboxBackend: "docker",
    hostMintsGitCredentials: false,
    turnResources: resources,
    runtimeResources: resources,
    publish: async () => {},
    warn: () => {},
    isAllowlisted: async () => true,
    findInaccessible: async () => [],
  };
}

test("duplicate repository identities share authority checks without removing mount selections", async () => {
  const resources = [repository(1, "first"), repository(1, "second")];
  const options = input(resources);
  let reads = 0;
  const probes: number[][] = [];
  options.isAllowlisted = async () => {
    reads++;
    return true;
  };
  options.findInaccessible = async (_installation, ids) => {
    probes.push(ids);
    return [];
  };
  const result = await dropUnavailableOptionalRepositories(options);
  expect(result.turnResources).toEqual(resources);
  expect(reads).toBe(1);
  expect(probes).toEqual([[1]]);
});

test("cancellation prevents admission of provider checks after a pending authority read", async () => {
  const controller = new AbortController();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const options = input([repository(1)]);
  let probes = 0;
  options.isAllowlisted = async () => {
    await pending;
    return true;
  };
  options.findInaccessible = async () => {
    probes++;
    return [];
  };
  // Keep the actual caller's cancellation wrapper: logical cancellation must
  // also stop the physical preflight from admitting a later provider request.
  const cancellable: typeof options & { signal: AbortSignal } = {
    ...options,
    signal: controller.signal,
  };
  const physical = dropUnavailableOptionalRepositories(cancellable);
  const logical = waitForTurnOperation(physical, controller.signal, undefined);
  controller.abort("turn paused");
  await expect(logical).rejects.toThrow();
  release();
  await physical.catch(() => undefined);
  expect(probes).toBe(0);
});

test("large optional selection does not eagerly queue every authority lookup", async () => {
  const options = input(Array.from({ length: 128 }, (_, i) => repository(i + 1)));
  let active = 0,
    peak = 0;
  options.isAllowlisted = async () => {
    peak = Math.max(peak, ++active);
    await Bun.sleep(1);
    active--;
    return true;
  };
  const result = await dropUnavailableOptionalRepositories(options);
  expect(result.turnResources).toHaveLength(128);
  expect(active).toBe(0);
  expect(peak).toBeLessThanOrEqual(8);
});

test("128 repositories on one installation require one production batch decision", async () => {
  const options = input(Array.from({ length: 128 }, (_, i) => repository(i + 1)));
  delete options.isAllowlisted;
  let batches = 0;
  options.allowedRepositoryIds = async (_installation, ids) => {
    batches++;
    return ids;
  };
  const result = await dropUnavailableOptionalRepositories(options);
  expect(result.turnResources).toHaveLength(128);
  expect(batches).toBe(1);
});

test("one installation uses one batch while preserving partial and duplicate mount decisions", async () => {
  const resources = [repository(1, "first"), repository(2), repository(1, "second")];
  const options = input(resources);
  delete options.isAllowlisted;
  const batches: number[][] = [];
  options.allowedRepositoryIds = async (_installation, ids) => {
    batches.push(ids);
    return [1];
  };
  const result = await dropUnavailableOptionalRepositories(options);
  expect(batches).toEqual([[1, 2]]);
  expect(result.turnResources).toEqual([resources[0]!, resources[2]!]);
});
