import { describe, expect, test } from "bun:test";
import { App, Image, SandboxService } from "modal";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { canonicalModalCheckpointProviderBinding } from "@opengeni/contracts";
import {
  compileNativeFreshCreate,
  describeNativeFreshCreate,
  type NativeFreshCreateSpec,
} from "../src/sandbox/providers/modal-native-create-preparation";

function fixture(cpu: number, memoryMiB: number, timeoutSeconds: number): NativeFreshCreateSpec {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const binding = {
    version: 1 as const,
    serverUrl: "https://api.modal.com",
    workspaceName: "original",
    environment: "main",
  };
  return {
    version: 1,
    recipeId: "modal-native-fresh-v1",
    recipeRevision: 1,
    createWorkdir: "/tmp",
    entrypoint: ["sleep", "infinity"],
    origin: {
      version: 1,
      planId: id(8),
      creatorId: id(9),
      accountId: id(1),
      workspaceId: id(2),
      sessionId: id(3),
      turnId: id(4),
      attemptId: id(5),
      executionGeneration: 2,
      triggerEventId: id(6),
      sandboxGroupId: id(7),
      routeKind: "home",
      routeTargetId: null,
      routeEpoch: 0,
      providerBinding: binding,
      providerBindingKey: canonicalModalCheckpointProviderBinding(binding)!.key,
    },
    blueprint: {
      version: 1,
      adapterId: "modal-native-fresh-creator-reservation-v1",
      create: {
        operationId: id(10),
        appId: "ap-known",
        imageId: "im-known",
        cpu,
        memoryMiB,
        timeoutSeconds,
        env: {},
        mounts: [],
      },
      restore: null,
      readiness: {
        operationId: id(11),
        execId: id(12),
        commandArgs: ["/bin/true"],
        workdir: "/tmp",
        env: {},
      },
      publishOperationId: id(13),
      cleanup: { operationId: id(14), requires: "physical-terminal-proof" },
    },
  };
}

describe("pinned SDK normalized create JSON parity (detached, no provider)", () => {
  test.each([
    [0.001, 128, 1],
    [0.25, 512, 300],
    [0.333, 4096, 3600],
    [128, 1_048_576, 86_400],
  ])(
    "matches installed Modal 0.9.0 for cpu=%s memory=%s seconds=%s",
    async (cpu, memoryMiB, timeoutSeconds) => {
      const require = createRequire(import.meta.resolve("modal"));
      expect(require("modal/package.json").version).toBe("0.9.0");
      const spec = fixture(cpu!, memoryMiB!, timeoutSeconds!);
      const compiled = describeNativeFreshCreate(compileNativeFreshCreate(spec));
      expect(
        createHash("sha256")
          .update(readFileSync(new URL(import.meta.resolve("modal"))))
          .digest("hex"),
      ).toBe(compiled.normalization.sdkSourceSha256);
      const requests: unknown[] = [];
      // This test constructs genuine SDK App/Image/SandboxService instances,
      // never a configured ModalClient. Every CP method except the in-memory
      // request recorder throws. A known Image.build is genuinely a no-op.
      const fakeClient = {
        cpClient: new Proxy(
          {},
          {
            get(_target, method) {
              if (method === "sandboxCreate")
                return async (request: unknown) => {
                  requests.push(structuredClone(request));
                  return { sandboxId: "sb-detached-test" };
                };
              return () => {
                throw new Error(`Unexpected detached SDK RPC ${String(method)}`);
              };
            },
          },
        ),
        logger: { debug() {} },
      };
      const app = new App(
        spec.blueprint.create.appId,
        "known",
        spec.origin.providerBinding.environment,
      );
      const image = new Image(fakeClient as never, spec.blueprint.create.imageId, "");
      await new SandboxService(fakeClient as never).create(app, image, {
        command: [...spec.entrypoint],
        workdir: spec.createWorkdir,
        cpu: spec.blueprint.create.cpu,
        memoryMiB: spec.blueprint.create.memoryMiB,
        timeoutMs: spec.blueprint.create.timeoutSeconds * 1000,
        env: {},
      });
      expect(requests.length).toBe(1);
      const request = requests[0] as { definition: Record<string, unknown>; tags: unknown[] };
      // The existing physical boundary adds these atomically AFTER SDK
      // normalization. This parity test performs the same pure injection, not
      // admission, provider I/O, lifecycle callbacks or actual transmission.
      const named = {
        ...request,
        definition: {
          ...request.definition,
          name: `opengeni-create-${spec.blueprint.create.operationId}`,
        },
        tags: [
          {
            tagName: "opengeni_provider_create_operation_id",
            tagValue: spec.blueprint.create.operationId,
          },
        ],
      };
      expect(named).toEqual(compiled.normalizedRequest);
      expect(Reflect.ownKeys(named.definition)).toEqual(
        Reflect.ownKeys(compiled.normalizedRequest.definition),
      );
      expect(JSON.stringify(named)).toBe(compiled.requestJson);
      expect(createHash("sha256").update(JSON.stringify(named)).digest("hex")).toBe(
        compiled.request.sha256,
      );
      expect(Object.hasOwn(named.definition, "idleTimeoutSecs")).toBe(true);
      expect(named.definition.idleTimeoutSecs).toBeUndefined();
    },
  );
});
