import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalModalCheckpointProviderBinding } from "@opengeni/contracts";
import {
  compileNativeFreshCreate,
  describeNativeFreshCreate,
  type NativeFreshCreateSpec,
} from "../src/sandbox/providers/modal-native-create-preparation";

function fixture(): NativeFreshCreateSpec {
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
        cpu: 0.25,
        memoryMiB: 512,
        timeoutSeconds: 300,
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

describe("pure native fresh-create compilation (no authority)", () => {
  test("synchronously retains complete origin, explicit recipe and exact JSON correlation", () => {
    const spec = fixture();
    const handle = compileNativeFreshCreate(spec);
    expect(handle).not.toBeInstanceOf(Promise);
    const compiled = describeNativeFreshCreate(handle);
    expect(compiled.spec).toEqual(spec);
    expect(compiled.spec).not.toBe(spec);
    expect(compiled.request.encoding).toBe("modal-create-json-v1");
    expect(compiled.request.sha256).toBe(
      createHash("sha256").update(compiled.requestJson).digest("hex"),
    );
    expect(compiled.request.byteLength).toBe(Buffer.byteLength(compiled.requestJson));
    expect(compiled.normalizedRequest.definition.resources.milliCpu).toBe(250);
    expect(compiled.normalizedRequest.definition.resources.gpuConfig).toEqual({
      type: 0,
      count: 0,
      gpuType: "",
    });
    expect(compiled.normalizedRequest.definition.name).toBe(
      `opengeni-create-${spec.blueprint.create.operationId}`,
    );
    expect(compiled.normalizedRequest.tags).toEqual([
      {
        tagName: "opengeni_provider_create_operation_id",
        tagValue: spec.blueprint.create.operationId,
      },
    ]);
    expect(Object.hasOwn(compiled.normalizedRequest.definition, "idleTimeoutSecs")).toBe(true);
    expect(compiled.normalizedRequest.definition.idleTimeoutSecs).toBeUndefined();
    expect(compiled.normalization.idleTimeout).toBe("unset");
    expect(compiled.normalizedRequest.definition.entrypointArgs).toEqual(["sleep", "infinity"]);
    expect(compiled.normalizedRequest.definition.workdir).toBe("/tmp");
  });

  test("input and output mutation cannot change a prepared compilation", () => {
    const input = fixture();
    const handle = compileNativeFreshCreate(input);
    const before = describeNativeFreshCreate(handle);
    input.blueprint.create.cpu = 2;
    input.origin.providerBinding.workspaceName = "successor";
    expect(describeNativeFreshCreate(handle)).toBe(before);
    expect(before.spec.blueprint.create.cpu).toBe(0.25);
    expect(before.spec.origin.providerBinding.workspaceName).toBe("original");
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.spec.origin.providerBinding)).toBe(true);
    expect(Object.isFrozen(before.normalizedRequest.definition.resources)).toBe(true);
    expect(() => {
      (before.normalizedRequest.definition as { workdir: string }).workdir = "/workspace";
    }).toThrow();
  });

  test("copied, inherited, foreign and primitive handles are not compiler issuance", () => {
    const handle = compileNativeFreshCreate(fixture());
    for (const fake of [
      { ...handle },
      structuredClone(handle),
      Object.create(handle),
      {},
      null,
      "saved",
    ])
      expect(() => describeNativeFreshCreate(fake as never)).toThrow(
        "Unknown native fresh-create preparation",
      );
  });

  test("identical data compiles deterministically without inventing any IDs", () => {
    const a = describeNativeFreshCreate(compileNativeFreshCreate(fixture()));
    const b = describeNativeFreshCreate(compileNativeFreshCreate(fixture()));
    expect(a).toEqual(b);
    expect(a.spec.origin.planId).toBe(fixture().origin.planId);
    expect(a.requestJson).not.toContain("token");
    expect(Reflect.ownKeys(compileNativeFreshCreate(fixture()))).toEqual([]);
  });

  test.each([0.0001, 0.0011, 0, -0, -1, 128.001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unrepresentable/unsupported cpu %s without clamping",
    (cpu) => {
      const spec = fixture();
      spec.blueprint.create.cpu = cpu;
      expect(() => compileNativeFreshCreate(spec)).toThrow(
        "Unsupported native fresh-create specification",
      );
    },
  );
  test.each([0.001, 0.333, 1, 128])("accepts losslessly representable cpu %s", (cpu) => {
    const spec = fixture();
    spec.blueprint.create.cpu = cpu;
    const compiled = describeNativeFreshCreate(compileNativeFreshCreate(spec));
    expect(compiled.normalizedRequest.definition.resources.milliCpu / 1000).toBe(cpu);
  });

  test("every predeclared operation ID must be distinct", () => {
    const mutations: Array<(spec: NativeFreshCreateSpec) => void> = [
      (s) => {
        s.origin.creatorId = s.origin.planId;
      },
      (s) => {
        s.origin.creatorId = s.origin.attemptId;
      },
      (s) => {
        s.blueprint.create.operationId = s.origin.planId;
      },
      (s) => {
        s.blueprint.readiness.operationId = s.blueprint.create.operationId;
      },
      (s) => {
        s.blueprint.readiness.execId = s.blueprint.readiness.operationId;
      },
      (s) => {
        s.blueprint.publishOperationId = s.blueprint.readiness.execId;
      },
      (s) => {
        s.blueprint.cleanup.operationId = s.blueprint.publishOperationId;
      },
    ];
    for (const mutate of mutations) {
      const spec = fixture();
      mutate(spec);
      expect(() => compileNativeFreshCreate(spec)).toThrow();
    }
  });

  test("rejects incomplete origin, namespace mismatch, secret URL and implicit create defaults", () => {
    for (const mutate of [
      (s: NativeFreshCreateSpec) => {
        delete (s.origin as Partial<NativeFreshCreateSpec["origin"]>).triggerEventId;
      },
      (s: NativeFreshCreateSpec) => {
        s.origin.providerBindingKey = "copied-selector";
      },
      (s: NativeFreshCreateSpec) => {
        s.origin.providerBinding.serverUrl = "https://secret:password@api.modal.com";
      },
      (s: NativeFreshCreateSpec) => {
        delete (s as Partial<NativeFreshCreateSpec>).createWorkdir;
      },
      (s: NativeFreshCreateSpec) => {
        s.createWorkdir = "/workspace" as never;
      },
      (s: NativeFreshCreateSpec) => {
        s.entrypoint = [] as never;
      },
    ]) {
      const spec = fixture();
      mutate(spec);
      expect(() => compileNativeFreshCreate(spec)).toThrow();
    }
  });

  test("rejects preparation effects, provider settings and extra keys at every level", () => {
    const extras: Array<(s: NativeFreshCreateSpec) => void> = [
      (s) => {
        Object.assign(s, { credentials: "must-not-retain" });
      },
      (s) => {
        Object.assign(s.origin, { leaseId: "fabricated-bound-ref" });
      },
      (s) => {
        Object.assign(s.blueprint.create, { regions: [] });
      },
      (s) => {
        Object.assign(s.blueprint.create.env, { SECRET: "must-not-retain" });
      },
      (s) => {
        s.blueprint.create.mounts.push({} as never);
      },
      (s) => {
        s.blueprint.restore = {} as never;
      },
      (s) => {
        Object.assign(s.blueprint.readiness, { pty: true });
      },
    ];
    for (const mutate of extras) {
      const spec = fixture();
      mutate(spec);
      expect(() => compileNativeFreshCreate(spec)).toThrow(
        "Unsupported native fresh-create specification",
      );
    }
  });

  test.each([
    "https://api.modal.com/?token=secret",
    "https://api.modal.com/#secret",
    "file:///tmp/profile",
  ])("rejects secret-bearing or non-service namespace URL %s", (serverUrl) => {
    const spec = fixture();
    spec.origin.providerBinding.serverUrl = serverUrl;
    spec.origin.providerBindingKey = canonicalModalCheckpointProviderBinding(
      spec.origin.providerBinding,
    )!.key;
    expect(() => compileNativeFreshCreate(spec)).toThrow(
      "Unsupported native fresh-create specification",
    );
  });

  test("accessors, hidden/symbol keys, class prototypes, cycles and callbacks are refused", () => {
    let getters = 0;
    const accessor = fixture();
    Object.defineProperty(accessor.blueprint.create, "cpu", {
      enumerable: true,
      get() {
        getters++;
        return 1;
      },
    });
    expect(() => compileNativeFreshCreate(accessor)).toThrow();
    expect(getters).toBe(0);
    const hidden = fixture();
    Object.defineProperty(hidden, "secret", { value: "hidden" });
    const symbol = fixture();
    Object.assign(symbol, { [Symbol("hidden")]: true });
    const classed = fixture();
    Object.setPrototypeOf(classed.origin, { inherited: true });
    const cycle = fixture();
    Object.assign(cycle, { cycle });
    const callback = fixture();
    Object.assign(callback, {
      callback: () => {
        throw new Error("must not call");
      },
    });
    for (const spec of [hidden, symbol, classed, cycle, callback])
      expect(() => compileNativeFreshCreate(spec)).toThrow();
  });

  test("source has no SDK/config/DB/network or ID-generation integration", () => {
    const source = readFileSync(
      new URL("../src/sandbox/providers/modal-native-create-preparation.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/from ["'](?:modal|@opengeni\/(?:db|config))["']/u);
    expect(source).not.toMatch(
      /\b(?:fetch|randomUUID|getSettings|createModalClient|sandboxCreate)\s*\(/u,
    );
    expect(source).not.toMatch(/process\.env/u);
  });
});
