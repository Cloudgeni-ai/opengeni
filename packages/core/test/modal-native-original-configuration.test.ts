import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rootCertificates } from "node:tls";
import { MODAL_NATIVE_PREPARATION_RECIPE_V2 } from "@opengeni/contracts/modal-native-proof-v2";
import {
  currentNativeOriginalConfigurationMatches,
  disposeNativeOriginalConfigurationSample,
  nativeOriginalConfigurationSnapshot,
  privateNativeOriginalConfigurationDraft,
  sampleNativeOriginalConfiguration,
} from "../src/application/modal-native-original-configuration";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const settings = () => ({
  modalTokenId: "synthetic-id",
  modalTokenSecret: "synthetic-secret",
  modalEnvironment: "main",
  environmentsEncryptionKey: Buffer.alloc(32, 0x42).toString("base64"),
});
function declaration() {
  return {
    version: 2,
    scope: {
      version: 2,
      declarationId: id(20),
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
    },
    blueprint: {
      version: 1,
      adapterId: "modal-native-fresh-creator-reservation-v1",
      create: {
        operationId: id(10),
        appId: "ap-known",
        imageId: "im-known",
        cpu: 0.333,
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
    preparationRecipe: structuredClone(MODAL_NATIVE_PREPARATION_RECIPE_V2),
    configurationCaptureRef: { id: id(21), revision: 1 },
    proofGrantRef: { id: id(22), epoch: 1 },
    providerRecoveryCount: 5,
    namespaceState: "unbound",
  };
}
const bytes = (value = declaration()) => Buffer.from(JSON.stringify(value));

describe("unused private native configuration sample, never a custody grant", () => {
  test("the protected read-policy source pin matches the actual unchanged native transport", async () => {
    const source = Buffer.from(
      await Bun.file(
        new URL("../../runtime/src/sandbox/providers/modal-original-read-wire.ts", import.meta.url),
      ).arrayBuffer(),
    );
    const gitBlob = createHash("sha1")
      .update(`blob ${source.length}\0`)
      .update(source)
      .digest("hex");
    const sample = sampleNativeOriginalConfiguration(settings(), bytes())!;
    expect(privateNativeOriginalConfigurationDraft(sample)!.description.profile.sourceGitBlob).toBe(
      gitBlob,
    );
    disposeNativeOriginalConfigurationSample(sample);
  });

  test("pins the actual direct-read profile and exact declaration without SDK/profile lookup", () => {
    const body = bytes();
    const sample = sampleNativeOriginalConfiguration(settings(), body)!;
    const draft = privateNativeOriginalConfigurationDraft(sample)!;
    expect(draft.equality.length).toBe(32);
    expect(draft.description.declarationJson).toBe(body.toString());
    expect(draft.description.declarationSha256).toBe(
      createHash("sha256").update(body).digest("hex"),
    );
    expect(draft.description.profile.serverUrl).toBe("https://api.modal.com:443");
    expect(draft.description.profile.sourceGitBlob).toBe(
      "7599f5b80cf111a25f78f427cfb2616d7e24b36c",
    );
    expect(draft.description.profile.environmentTransmittedByCpReads).toBe(false);
    expect(draft.description.profile.tlsRootsSha256).toBe(
      createHash("sha256").update(rootCertificates.join("\n")).digest("hex"),
    );
    expect(draft.description.profile.retries).toBe(0);
    expect(draft.description.profile.nativeChainDeadlineMs).toBe(30_000);
    expect(draft.description.profile.methods).toEqual([
      "AuthTokenGet",
      "WorkspaceNameLookup",
      "TaskGetCommandRouterAccess",
    ]);
    expect(JSON.parse(draft.description.declarationJson).providerRecoveryCount).toBe(5);
    expect(JSON.parse(draft.description.declarationJson).namespaceState).toBe("unbound");
    expect(JSON.stringify(sample)).toBe("{}");
    expect(JSON.stringify(draft.description)).not.toContain(settings().modalTokenSecret);
    expect(JSON.stringify(draft.description)).not.toContain(settings().environmentsEncryptionKey);
    disposeNativeOriginalConfigurationSample(sample);
  });

  test.each(["modalTokenId", "modalTokenSecret", "modalEnvironment", "environmentsEncryptionKey"])(
    "requires explicit own %s; never ambient/profile/access-key fallback",
    (key) => {
      const input: Record<string, unknown> = {
        ...settings(),
        accessKey: "not-a-root",
        profile: "not-a-source",
      };
      delete input[key];
      expect(sampleNativeOriginalConfiguration(input, bytes())).toBeNull();
      input[key] = undefined;
      expect(sampleNativeOriginalConfiguration(input, bytes())).toBeNull();
    },
  );

  test.each(["modalTokenId", "modalTokenSecret", "modalEnvironment", "environmentsEncryptionKey"])(
    "changed current %s cannot reconstruct the original sample",
    (key) => {
      const input = settings();
      const sample = sampleNativeOriginalConfiguration(input, bytes())!;
      expect(currentNativeOriginalConfigurationMatches(sample, input)).toBe(true);
      const changed = {
        ...input,
        [key]:
          key === "environmentsEncryptionKey"
            ? Buffer.alloc(32, 0x43).toString("base64")
            : input[key as keyof typeof input] + "changed",
      };
      expect(currentNativeOriginalConfigurationMatches(sample, changed)).toBe(false);
      disposeNativeOriginalConfigurationSample(sample);
    },
  );

  test("preserves exact pair and explicit empty environment, without trimming or inventing main", () => {
    const input = {
      ...settings(),
      modalTokenId: " id ",
      modalTokenSecret: " secret ",
      modalEnvironment: "",
    };
    const sample = sampleNativeOriginalConfiguration(input, bytes())!;
    expect(nativeOriginalConfigurationSnapshot(sample)).toEqual({
      serverUrl: "https://api.modal.com:443",
      tokenId: " id ",
      tokenSecret: " secret ",
      environment: "",
    });
    expect(
      currentNativeOriginalConfigurationMatches(sample, { ...input, modalTokenId: "id" }),
    ).toBe(false);
    expect(
      currentNativeOriginalConfigurationMatches(sample, { ...input, modalEnvironment: "main" }),
    ).toBe(false);
    disposeNativeOriginalConfigurationSample(sample);
  });

  test("binds scope/config/grant/known-ID correlation, full recipe and exact original JSON bytes", () => {
    const original = declaration();
    const sample = sampleNativeOriginalConfiguration(settings(), bytes(original))!;
    const baseline = privateNativeOriginalConfigurationDraft(sample)!.equality;
    const variants = [
      { ...original, scope: { ...original.scope, turnId: id(30) } },
      {
        ...original,
        configurationCaptureRef: { ...original.configurationCaptureRef, revision: 2 },
      },
      { ...original, proofGrantRef: { ...original.proofGrantRef, epoch: 2 } },
      {
        ...original,
        blueprint: {
          ...original.blueprint,
          create: { ...original.blueprint.create, imageId: "im-other" },
        },
      },
    ];
    for (const value of variants) {
      const other = sampleNativeOriginalConfiguration(settings(), bytes(value))!;
      expect(privateNativeOriginalConfigurationDraft(other)!.equality).not.toEqual(baseline);
      disposeNativeOriginalConfigurationSample(other);
    }
    const other = sampleNativeOriginalConfiguration(
      settings(),
      Buffer.from(JSON.stringify(original, null, 2)),
    )!;
    expect(privateNativeOriginalConfigurationDraft(other)!.equality).not.toEqual(baseline);
    disposeNativeOriginalConfigurationSample(other);
    expect(
      sampleNativeOriginalConfiguration(
        settings(),
        bytes({
          ...original,
          preparationRecipe: { ...original.preparationRecipe, createWorkdir: "/other" },
        } as typeof original),
      ),
    ).toBeNull();
    disposeNativeOriginalConfigurationSample(sample);
  });

  test("returned copies, input mutations and forged handles cannot alter the original sample", () => {
    const body = bytes();
    const input = settings();
    const sample = sampleNativeOriginalConfiguration(input, body)!;
    const first = privateNativeOriginalConfigurationDraft(sample)!;
    const originalJson = first.description.declarationJson;
    body.fill(0);
    input.modalTokenId = "changed";
    first.equality.fill(0);
    first.description.configurationCaptureRef.revision = 9;
    expect(privateNativeOriginalConfigurationDraft(sample)!.description.declarationJson).toBe(
      originalJson,
    );
    expect(
      privateNativeOriginalConfigurationDraft(sample)!.description.configurationCaptureRef.revision,
    ).toBe(1);
    expect(nativeOriginalConfigurationSnapshot(sample)!.tokenId).toBe("synthetic-id");
    expect(currentNativeOriginalConfigurationMatches(sample, settings())).toBe(true);
    expect(privateNativeOriginalConfigurationDraft({ ...sample })).toBeNull();
    expect(nativeOriginalConfigurationSnapshot({ ...sample })).toBeNull();
    disposeNativeOriginalConfigurationSample(sample);
    expect(privateNativeOriginalConfigurationDraft(sample)).toBeNull();
    expect(nativeOriginalConfigurationSnapshot(sample)).toBeNull();
    expect(currentNativeOriginalConfigurationMatches(sample, settings())).toBe(false);
    disposeNativeOriginalConfigurationSample(sample);
  });

  test("refuses malformed key/pair/UTF8/declaration data without leaking values or validator details", () => {
    expect(
      sampleNativeOriginalConfiguration({ ...settings(), modalTokenId: "" }, bytes()),
    ).toBeNull();
    expect(
      sampleNativeOriginalConfiguration({ ...settings(), modalTokenSecret: "\nsecret" }, bytes()),
    ).toBeNull();
    expect(
      sampleNativeOriginalConfiguration(
        { ...settings(), environmentsEncryptionKey: Buffer.alloc(31).toString("base64") },
        bytes(),
      ),
    ).toBeNull();
    expect(
      sampleNativeOriginalConfiguration(
        {
          ...settings(),
          environmentsEncryptionKey: settings().environmentsEncryptionKey.slice(0, -1),
        },
        bytes(),
      ),
    ).toBeNull();
    expect(sampleNativeOriginalConfiguration(settings(), Buffer.from([0xff]))).toBeNull();
    expect(
      sampleNativeOriginalConfiguration(
        {
          ...settings(),
          // Same-length Base64 with noncanonical trailing pad bits must not
          // create a second spelling of an otherwise supported root.
          environmentsEncryptionKey: settings().environmentsEncryptionKey.slice(0, -2) + "J=",
        },
        bytes(),
      ),
    ).toBeNull();
    expect(sampleNativeOriginalConfiguration(settings(), Buffer.from("null"))).toBeNull();
    expect(sampleNativeOriginalConfiguration(settings(), Buffer.from("{}"))).toBeNull();
    expect(
      sampleNativeOriginalConfiguration(settings(), Buffer.alloc(4 * 1024 * 1024 + 1)),
    ).toBeNull();
  });

  test("rejects accessors/Proxies/shared bytes without executing traps; snapshots exact native view", () => {
    let traps = 0;
    const input = settings();
    Object.defineProperty(input, "modalTokenSecret", {
      get: () => {
        traps++;
        return "secret";
      },
    });
    expect(sampleNativeOriginalConfiguration(input, bytes())).toBeNull();
    const proxy = new Proxy(settings(), {
      getPrototypeOf: () => {
        traps++;
        throw new Error("trap");
      },
    });
    expect(sampleNativeOriginalConfiguration(proxy, bytes())).toBeNull();
    const proxyBody = new Proxy(bytes(), {
      get: () => {
        traps++;
        throw new Error("trap");
      },
    });
    expect(sampleNativeOriginalConfiguration(settings(), proxyBody)).toBeNull();
    expect(
      sampleNativeOriginalConfiguration(settings(), new Uint8Array(new SharedArrayBuffer(100))),
    ).toBeNull();
    const content = bytes();
    const wrapped = Buffer.concat([Buffer.from("prefix"), content, Buffer.from("suffix")]);
    const view = new Uint8Array(wrapped.buffer, wrapped.byteOffset + 6, content.length);
    Object.defineProperty(view, "byteLength", {
      get: () => {
        traps++;
        throw new Error("trap");
      },
    });
    const sample = sampleNativeOriginalConfiguration(settings(), view)!;
    expect(privateNativeOriginalConfigurationDraft(sample)!.description.declarationJson).toBe(
      content.toString(),
    );
    disposeNativeOriginalConfigurationSample(sample);
    expect(traps).toBe(0);
  });
});
