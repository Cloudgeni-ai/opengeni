import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { BROWSER_PROFILE_ARTIFACT_FORMAT } from "@opengeni/contracts";

const ROOT_KEY_BYTES = 32;
const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_PREFIX = "ogbk1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type BrowserStateOperationScope = {
  accountId: string;
  workspaceId: string;
  browserSessionId: string;
  operationId: string;
  objectKey: string;
};

export type BrowserStateArtifactScope = {
  accountId: string;
  workspaceId: string;
  objectKey: string;
  artifactDigest: string;
  contentDigest: string;
};

/** Deterministic only within one idempotent publication operation. This lets a
 * control-plane retry present browserd with exactly the same secret authority
 * without storing a plaintext key or placing it in an operation row. */
export function deriveBrowserStateDataKey(
  rootKey: Uint8Array,
  scopeInput: BrowserStateOperationScope,
): Buffer {
  const scope = operationScope(scopeInput);
  return createHmac("sha256", root(rootKey))
    .update("opengeni.browser-state.data-key.v1\0", "utf8")
    .update(canonicalJson(scope), "utf8")
    .digest();
}

/** Associated data for the encrypted profile object. It is reproducible from
 * durable non-secret artifact authority during restore. */
export function browserStateArtifactAad(
  scopeInput: Pick<BrowserStateArtifactScope, "accountId" | "workspaceId" | "objectKey">,
): Buffer {
  const scope = baseArtifactScope(scopeInput);
  return Buffer.from(`opengeni.browser-state.artifact-aad.v1\0${canonicalJson(scope)}`, "utf8");
}

/** Wrap a 32-byte artifact data key under the operator-held root key. The
 * ciphertext is bound to workspace, object, and both integrity digests. */
export function wrapBrowserStateDataKey(
  rootKey: Uint8Array,
  dataKeyInput: Uint8Array,
  scopeInput: BrowserStateArtifactScope,
): string {
  const dataKey = exactKey(dataKeyInput, "browser state data key");
  const scope = artifactScope(scopeInput);
  const iv = randomBytes(IV_BYTES);
  const wrappingKey = browserStateWrappingKey(rootKey, scope);
  try {
    const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
    cipher.setAAD(wrapAad(scope));
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    const payload = Buffer.concat([ciphertext, cipher.getAuthTag()]);
    return `${WRAPPED_PREFIX}:${iv.toString("base64")}:${payload.toString("base64")}`;
  } finally {
    wrappingKey.fill(0);
  }
}

export function unwrapBrowserStateDataKey(
  rootKey: Uint8Array,
  wrapped: string,
  scopeInput: BrowserStateArtifactScope,
): Buffer {
  const scope = artifactScope(scopeInput);
  const parts = wrapped.split(":");
  if (parts.length !== 3 || parts[0] !== WRAPPED_PREFIX) {
    throw new Error("browser state data-key envelope is unsupported");
  }
  const iv = canonicalBase64(parts[1]!, IV_BYTES, "browser state data-key envelope");
  const payload = canonicalBase64(
    parts[2]!,
    DATA_KEY_BYTES + TAG_BYTES,
    "browser state data-key envelope",
  );
  const ciphertext = payload.subarray(0, DATA_KEY_BYTES);
  const tag = payload.subarray(DATA_KEY_BYTES);
  const wrappingKey = browserStateWrappingKey(rootKey, scope);
  try {
    const decipher = createDecipheriv("aes-256-gcm", wrappingKey, iv);
    decipher.setAAD(wrapAad(scope));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("browser state data-key decryption failed");
  } finally {
    wrappingKey.fill(0);
  }
}

export function browserStateObjectKey(workspaceIdInput: string, operationIdInput: string): string {
  const workspaceId = uuid(workspaceIdInput, "workspace id");
  const operationId = uuid(operationIdInput, "browser state operation id");
  return `workspaces/${workspaceId}/browser-state/revisions/${operationId}/chromium-profile.ogbs`;
}

export function browserStateManifestDigest(manifest: unknown): string {
  return createHash("sha256").update(canonicalJson(manifest), "utf8").digest("hex");
}

function operationScope(input: BrowserStateOperationScope) {
  const base = baseArtifactScope(input);
  return {
    ...base,
    browserSessionId: uuid(input.browserSessionId, "browser session id"),
    operationId: uuid(input.operationId, "browser state operation id"),
  };
}

function artifactScope(input: BrowserStateArtifactScope) {
  return {
    ...baseArtifactScope(input),
    artifactDigest: sha256(input.artifactDigest, "browser state artifact digest"),
    contentDigest: sha256(input.contentDigest, "browser state content digest"),
  };
}

function baseArtifactScope(
  input: Pick<BrowserStateArtifactScope, "accountId" | "workspaceId" | "objectKey">,
) {
  const workspaceId = uuid(input.workspaceId, "workspace id");
  const objectKey = browserStateObjectKeyValue(input.objectKey, workspaceId);
  return {
    version: 1,
    accountId: uuid(input.accountId, "account id"),
    workspaceId,
    objectKey,
    format: BROWSER_PROFILE_ARTIFACT_FORMAT,
  };
}

function wrapAad(scope: ReturnType<typeof artifactScope>): Buffer {
  return Buffer.from(`opengeni.browser-state.data-key-wrap.v1\0${canonicalJson(scope)}`, "utf8");
}

function browserStateWrappingKey(
  rootKey: Uint8Array,
  scope: ReturnType<typeof artifactScope>,
): Buffer {
  return createHmac("sha256", root(rootKey))
    .update("opengeni.browser-state.wrapping-key.v1\0", "utf8")
    .update(canonicalJson(scope), "utf8")
    .digest();
}

function browserStateObjectKeyValue(value: string, workspaceId: string): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > 2_048 ||
    !new RegExp(
      `^workspaces/${workspaceId}/browser-state/[A-Za-z0-9._=-]+(?:/[A-Za-z0-9._=-]+)*$`,
      "u",
    ).test(value)
  ) {
    throw new Error("browser state object key is invalid");
  }
  return value;
}

function root(value: Uint8Array): Buffer {
  return exactKey(value, "browser state root key");
}

function exactKey(value: Uint8Array, label: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== ROOT_KEY_BYTES) {
    throw new Error(`${label} must be exactly ${ROOT_KEY_BYTES} bytes`);
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function uuid(value: string, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
  return value.toLowerCase();
}

function sha256(value: string, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function canonicalBase64(value: string, length: number, label: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error(`${label} is unsupported`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== length || decoded.toString("base64") !== value) {
    decoded.fill(0);
    throw new Error(`${label} is unsupported`);
  }
  return decoded;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      if (input[key] === undefined) {
        throw new Error("canonical JSON cannot contain undefined");
      }
      output[key] = canonicalValue(input[key]);
    }
    return output;
  }
  throw new Error("value cannot be represented as canonical JSON");
}
