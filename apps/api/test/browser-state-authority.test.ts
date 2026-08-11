import { describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  browserStateArtifactAad,
  browserStateManifestDigest,
  browserStateObjectKey,
  deriveBrowserStateDataKey,
  unwrapBrowserStateDataKey,
  wrapBrowserStateDataKey,
} from "../src/browser-state-authority";

describe("browser state cryptographic authority", () => {
  test("derives exact retry authority and context-separates every operation", () => {
    const root = randomBytes(32);
    const scope = operationScope();
    const first = deriveBrowserStateDataKey(root, scope);
    const replay = deriveBrowserStateDataKey(root, scope);
    const other = deriveBrowserStateDataKey(root, {
      ...scope,
      operationId: randomUUID(),
    });
    expect(first).toEqual(replay);
    expect(first).not.toEqual(other);
    expect(first.byteLength).toBe(32);
    expect(browserStateArtifactAad(scope)).toEqual(browserStateArtifactAad(scope));
    expect(browserStateArtifactAad(scope)).not.toEqual(
      browserStateArtifactAad({
        ...scope,
        objectKey: `${scope.objectKey}.other`,
      }),
    );
  });

  test("wraps one data key against exact artifact authority", () => {
    const root = randomBytes(32);
    const key = randomBytes(32);
    const scope = artifactScope();
    const wrapped = wrapBrowserStateDataKey(root, key, scope);
    expect(wrapped).not.toContain(key.toString("base64"));
    expect(unwrapBrowserStateDataKey(root, wrapped, scope)).toEqual(key);
    expect(() =>
      unwrapBrowserStateDataKey(root, wrapped, {
        ...scope,
        artifactDigest: "f".repeat(64),
      }),
    ).toThrow("decryption failed");
    expect(() => unwrapBrowserStateDataKey(randomBytes(32), wrapped, scope)).toThrow(
      "decryption failed",
    );
  });

  test("uses stable manifest digests and scoped immutable object keys", () => {
    expect(browserStateManifestDigest({ z: 1, a: { y: true, x: [2, 1] } })).toBe(
      browserStateManifestDigest({ a: { x: [2, 1], y: true }, z: 1 }),
    );
    const workspaceId = randomUUID();
    const operationId = randomUUID();
    expect(browserStateObjectKey(workspaceId, operationId)).toBe(
      `workspaces/${workspaceId}/browser-state/revisions/${operationId}/chromium-profile.ogbs`,
    );
  });
});

function operationScope() {
  const workspaceId = randomUUID();
  const operationId = randomUUID();
  return {
    accountId: randomUUID(),
    workspaceId,
    browserSessionId: randomUUID(),
    operationId,
    objectKey: browserStateObjectKey(workspaceId, operationId),
  };
}

function artifactScope() {
  const workspaceId = randomUUID();
  const operationId = randomUUID();
  return {
    accountId: randomUUID(),
    workspaceId,
    objectKey: browserStateObjectKey(workspaceId, operationId),
    artifactDigest: "a".repeat(64),
    contentDigest: "b".repeat(64),
  };
}
