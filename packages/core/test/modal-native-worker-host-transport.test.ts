import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { signDelegatedAccessToken, verifyDelegatedAccessToken } from "@opengeni/contracts";
import {
  configuredNativeWorkerHostTransport,
  disposeNativeWorkerHostTransport,
  nativeWorkerHostTransportDescription,
  signNativeWorkerHostTransport,
  verifyNativeWorkerHostTransport,
} from "../src/application/modal-native-worker-host-transport";

const secret = "native-proof-transport-test-root-not-a-deployment-secret";
const now = 10_000;
const body = new TextEncoder().encode("exact private request bytes");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function input(): Parameters<typeof signNativeWorkerHostTransport>[1] {
  return {
    protocol: "opengeni-modal-native-worker-host-proof",
    version: 2,
    principalKind: "worker_host",
    purpose: "original-native-custody-proof",
    action: "declare_preparation",
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
    configurationCaptureRef: { id: id(21), revision: 1 },
    proofGrantRef: { id: id(22), epoch: 1 },
    requestId: id(23),
  };
}

function transport(value = secret) {
  const result = configuredNativeWorkerHostTransport({ delegationSecret: value });
  if (!result) throw new Error("Test transport was unavailable");
  return result;
}

describe("private worker-host proof transport, not custody/effect authority", () => {
  test("requires an explicitly configured deployment delegation secret, never local/test/access-key fallback", () => {
    for (const settings of [
      {},
      { delegationSecret: undefined },
      { delegationSecret: "" },
      { delegationSecret: "   " },
      { environment: "test", accessKey: secret },
      { environment: "local", productAccessMode: "local" },
    ])
      expect(configuredNativeWorkerHostTransport(settings as never)).toBeNull();
    let callbacks = 0;
    const getter = Object.defineProperty({}, "delegationSecret", {
      get() {
        callbacks++;
        return secret;
      },
    });
    expect(configuredNativeWorkerHostTransport(getter as never)).toBeNull();
    expect(
      configuredNativeWorkerHostTransport(
        new Proxy(
          {},
          {
            get() {
              callbacks++;
              return secret;
            },
          },
        ) as never,
      ),
    ).toBeNull();
    expect(callbacks).toBe(0);
  });

  test("separate configured host contexts authenticate exactly the same private request bytes", () => {
    const sender = transport();
    const receiver = transport();
    const envelope = signNativeWorkerHostTransport(sender, input(), body, now);
    expect(envelope.startsWith("ogmnp2_")).toBe(true);
    expect(envelope).not.toContain(secret);
    const proof = verifyNativeWorkerHostTransport(receiver, envelope, body, now);
    expect(proof).not.toBeNull();
    const description = nativeWorkerHostTransportDescription(receiver, proof!);
    expect(description).toEqual({
      ...input(),
      bodySha256: createHash("sha256").update(body).digest("hex"),
      issuedAt: now,
      expiresAt: now + 60,
    });
    expect(Object.keys(sender)).toEqual([]);
    expect(Object.keys(proof!)).toEqual([]);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.hasOwn(description, "authorized")).toBe(false);
    expect(Object.hasOwn(description, "effectPermission")).toBe(false);
    expect(Object.hasOwn(description, "physicalSettled")).toBe(false);
    expect(() => nativeWorkerHostTransportDescription(sender, proof!)).toThrow("unavailable");
    disposeNativeWorkerHostTransport(sender);
    disposeNativeWorkerHostTransport(receiver);
  });

  test("mutated body, wrong root and modified envelope are rejected without retargeting or fallback", () => {
    const sender = transport();
    const receiver = transport();
    const wrong = transport("different-test-root-not-a-deployment-secret");
    const envelope = signNativeWorkerHostTransport(sender, input(), body, now);
    expect(
      verifyNativeWorkerHostTransport(receiver, envelope, new TextEncoder().encode("changed"), now),
    ).toBeNull();
    expect(verifyNativeWorkerHostTransport(wrong, envelope, body, now)).toBeNull();
    const [encoded, signature] = envelope.slice("ogmnp2_".length).split(".");
    const payload = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8"));
    payload.scope.attemptId = id(99);
    const changed = Buffer.from(JSON.stringify(payload)).toString("base64url");
    expect(
      verifyNativeWorkerHostTransport(receiver, `ogmnp2_${changed}.${signature}`, body, now),
    ).toBeNull();
    for (const malformed of [
      "",
      "ogmnp2_",
      `${envelope}.extra`,
      envelope.replace("ogmnp2_", "ogmnp1_"),
      `${envelope}=`,
      "ogmnp2_" + "a".repeat(16_385),
    ])
      expect(verifyNativeWorkerHostTransport(receiver, malformed, body, now)).toBeNull();
  });

  test("short transport expiry is exact and cannot renew or revoke any durable custody grant", () => {
    const sender = transport();
    const receiver = transport();
    const envelope = signNativeWorkerHostTransport(sender, input(), body, now);
    expect(verifyNativeWorkerHostTransport(receiver, envelope, body, now - 1)).toBeNull();
    expect(verifyNativeWorkerHostTransport(receiver, envelope, body, now + 59)).not.toBeNull();
    expect(verifyNativeWorkerHostTransport(receiver, envelope, body, now + 60)).toBeNull();
    const freshEnvelope = signNativeWorkerHostTransport(sender, input(), body, now + 61);
    const proof = verifyNativeWorkerHostTransport(receiver, freshEnvelope, body, now + 61)!;
    expect(nativeWorkerHostTransportDescription(receiver, proof).proofGrantRef).toEqual(
      input().proofGrantRef,
    );
    for (const clock of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])
      expect(verifyNativeWorkerHostTransport(receiver, envelope, body, clock)).toBeNull();
  });

  test("ordinary service/agent tokens cannot enter this purpose and this token cannot enter ordinary delegation", async () => {
    const context = transport();
    const envelope = signNativeWorkerHostTransport(context, input(), body, now);
    expect(await verifyDelegatedAccessToken(secret, envelope, now)).toBeNull();
    for (const principalKind of ["service", "agent_attempt"] as const) {
      const ordinary = await signDelegatedAccessToken(secret, {
        accountId: id(1),
        workspaceId: id(2),
        subjectId: "worker:test",
        permissions: ["workspace:read"],
        principalKind,
        exp: now + 60,
        ...(principalKind === "agent_attempt"
          ? { sessionId: id(3), turnId: id(4), attemptId: id(5), executionGeneration: 2 }
          : {}),
      });
      expect(verifyNativeWorkerHostTransport(context, ordinary, body, now)).toBeNull();
      expect(
        verifyNativeWorkerHostTransport(context, ordinary.replace(/^ogd_/, "ogmnp2_"), body, now),
      ).toBeNull();
    }
  });

  test("no Create/Start/stdin/processCancel/effect/permission variants can be signed in this proof-only lane", () => {
    const context = transport();
    for (const action of ["Create", "Start", "stdin", "processCancel", "reap", "publish"]) {
      expect(() =>
        signNativeWorkerHostTransport(context, { ...input(), action } as never, body, now),
      ).toThrow();
    }
    for (const extra of [
      { authorized: true },
      { permissions: ["sessions:control"] },
      { physicalSettled: true },
      { tokenSecret: "not-retained" },
    ])
      expect(() =>
        signNativeWorkerHostTransport(context, { ...input(), ...extra } as never, body, now),
      ).toThrow();
    expect(() =>
      signNativeWorkerHostTransport(
        context,
        { ...input(), principalKind: "service" } as never,
        body,
        now,
      ),
    ).toThrow();
  });

  test("capture and settlement intents bind the entire same-acquisition correlation, not a timeout boolean", () => {
    const context = transport();
    const { action: _action, ...base } = input();
    const correlation = {
      claimId: id(24),
      nonce: id(25),
      claimRevision: 3,
      recordRevision: 4,
      captureId: id(26),
      acquisitionId: id(27),
    };
    for (const action of [
      "capture_namespace_binding",
      "capture_original_page",
      "reconcile_same_capture",
      "settle_original_acquisition",
    ] as const) {
      const value = { ...base, action, acquisition: correlation };
      const envelope = signNativeWorkerHostTransport(context, value, body, now);
      const proof = verifyNativeWorkerHostTransport(context, envelope, body, now)!;
      expect(nativeWorkerHostTransportDescription(context, proof)).toMatchObject(value);
      for (const field of Object.keys(correlation)) {
        const incomplete = { ...correlation } as Record<string, unknown>;
        delete incomplete[field];
        expect(() =>
          signNativeWorkerHostTransport(
            context,
            { ...value, acquisition: incomplete } as never,
            body,
            now,
          ),
        ).toThrow();
      }
      expect(() =>
        signNativeWorkerHostTransport(
          context,
          { ...value, deadlineElapsed: true } as never,
          body,
          now,
        ),
      ).toThrow();
    }
  });

  test("input/output copies cannot alter an issued request or mint a verified handle", () => {
    const context = transport();
    const source = input();
    const envelope = signNativeWorkerHostTransport(context, source, body, now);
    source.scope.attemptId = id(99);
    const proof = verifyNativeWorkerHostTransport(context, envelope, body, now)!;
    const description = nativeWorkerHostTransportDescription(context, proof);
    expect(description.scope.attemptId).toBe(id(5));
    description.scope.attemptId = id(98);
    expect(nativeWorkerHostTransportDescription(context, proof).scope.attemptId).toBe(id(5));
    for (const copied of [{ ...proof }, structuredClone(proof), Object.create(proof), {}])
      expect(() => nativeWorkerHostTransportDescription(context, copied as never)).toThrow(
        "unavailable",
      );
  });

  test("sampling is private/current-root-only and disposal never exposes or retains a signing key", () => {
    const settings = { delegationSecret: secret };
    const sampled = configuredNativeWorkerHostTransport(settings)!;
    settings.delegationSecret = "changed-after-sampling-test-root";
    const envelope = signNativeWorkerHostTransport(sampled, input(), body, now);
    expect(verifyNativeWorkerHostTransport(transport(), envelope, body, now)).not.toBeNull();
    expect(
      verifyNativeWorkerHostTransport(transport(settings.delegationSecret), envelope, body, now),
    ).toBeNull();
    disposeNativeWorkerHostTransport(sampled);
    expect(() => signNativeWorkerHostTransport(sampled, input(), body, now)).toThrow("unavailable");
    expect(() => verifyNativeWorkerHostTransport(sampled, envelope, body, now)).toThrow(
      "unavailable",
    );
    expect(() =>
      signNativeWorkerHostTransport({ ...transport() } as never, input(), body, now),
    ).toThrow("unavailable");
    disposeNativeWorkerHostTransport(sampled);
  });

  test("rejects effectful getters, Proxies and malformed/overbound bodies without executing callbacks", () => {
    const context = transport();
    let callbacks = 0;
    const getter = input();
    Object.defineProperty(getter, "action", {
      get() {
        callbacks++;
        return "declare_preparation";
      },
      enumerable: true,
    });
    expect(() => signNativeWorkerHostTransport(context, getter, body, now)).toThrow();
    const traps: ProxyHandler<object> = {
      get() {
        callbacks++;
        throw new Error("trap");
      },
      ownKeys() {
        callbacks++;
        throw new Error("trap");
      },
      getPrototypeOf() {
        callbacks++;
        throw new Error("trap");
      },
    };
    expect(() =>
      signNativeWorkerHostTransport(context, new Proxy(input(), traps) as never, body, now),
    ).toThrow();
    const nested = input();
    nested.scope = new Proxy(nested.scope, traps) as never;
    expect(() => signNativeWorkerHostTransport(context, nested, body, now)).toThrow();
    const revoked = Proxy.revocable(input(), traps);
    revoked.revoke();
    expect(() =>
      signNativeWorkerHostTransport(context, revoked.proxy as never, body, now),
    ).toThrow();
    expect(() =>
      signNativeWorkerHostTransport(context, input(), new Proxy(body, traps) as never, now),
    ).toThrow();
    expect(() =>
      signNativeWorkerHostTransport(context, input(), new Uint8Array(4 * 1024 * 1024 + 1), now),
    ).toThrow();
    expect(callbacks).toBe(0);
  });

  test("hashes the exact byte view through native getters without caller callbacks or shared backing", () => {
    const context = transport();
    let callbacks = 0;
    const storage = new Uint8Array([99, ...body, 88]);
    const view = storage.subarray(1, storage.length - 1);
    for (const field of ["byteLength", "byteOffset", "buffer"]) {
      Object.defineProperty(view, field, {
        get() {
          callbacks++;
          throw new Error("body getter must not run");
        },
      });
    }
    const envelope = signNativeWorkerHostTransport(context, input(), view, now);
    expect(verifyNativeWorkerHostTransport(context, envelope, body, now)).not.toBeNull();
    expect(
      verifyNativeWorkerHostTransport(context, envelope, Buffer.from(body), now),
    ).not.toBeNull();
    expect(callbacks).toBe(0);
    const shared = new Uint8Array(new SharedArrayBuffer(body.length));
    shared.set(body);
    expect(() => signNativeWorkerHostTransport(context, input(), shared, now)).toThrow(
      "Unsupported native host transport body",
    );
    expect(verifyNativeWorkerHostTransport(context, envelope, shared, now)).toBeNull();
    const detached = new Uint8Array(body);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expect(() => signNativeWorkerHostTransport(context, input(), detached, now)).toThrow(
      "Unsupported native host transport body",
    );
  });

  test("malformed signing inputs use fixed errors without reflecting caller values or field names", () => {
    const context = transport();
    const marker = "private-caller-value-not-for-error-output";
    for (const value of [
      { ...input(), action: marker },
      { ...input(), [marker]: marker },
      { ...input(), scope: { ...input().scope, attemptId: marker } },
    ]) {
      expect(() => signNativeWorkerHostTransport(context, value as never, body, now)).toThrow(
        /^Unsupported native host transport input$/,
      );
    }
    for (const clock of [Number.NaN, Number.MAX_SAFE_INTEGER, -1]) {
      expect(() => signNativeWorkerHostTransport(context, input(), body, clock)).toThrow(
        /^Unsupported native host transport input$/,
      );
    }
  });
});
