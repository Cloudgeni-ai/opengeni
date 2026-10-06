import { isDeepStrictEqual } from "node:util";
import {
  SandboxV2CredentialGenerationDefinition,
  type RunCredentialsResolution,
} from "@opengeni/contracts";
import {
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  SandboxV2CredentialGenerationError,
  type SandboxJournalControlAuthority,
  type RetainedSandboxV2CredentialGeneration,
} from "@opengeni/db";
import { normalizeRunCredentialsResolution } from "@opengeni/runtime/sandbox";

const MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024;
function fail(): never {
  throw new SandboxV2CredentialGenerationError();
}
function canonicalResolution(
  input: RunCredentialsResolution,
  authority: SandboxJournalControlAuthority,
): RunCredentialsResolution {
  try {
    const material = normalizeRunCredentialsResolution(input, authority);
    const scope = {
      accountId: authority.accountId,
      workspaceId: authority.workspaceId,
      sessionId: authority.sessionId,
    };
    if (!material) return { ...scope, status: "not_applicable" };
    if (input.status === "auth_needed")
      return { ...scope, status: "auth_needed", authNeeded: material.authNeeded };
    return {
      ...scope,
      status: "ok",
      environment: material.environment,
      files: material.files,
      fileEnvironment: material.fileEnvironment,
      expiresAt: material.expiresAt?.toISOString() ?? null,
      authNeeded: material.authNeeded,
      ...(material.mcp ? { mcp: material.mcp } : {}),
    };
  } catch {
    // Untrusted broker validation details must never become a public error or
    // durable log. Preserve the fixed class, without plaintext/ciphertext cause.
    fail();
  }
}

export type RetainedSandboxV2CredentialOwnerOptions = {
  encryptionKey: Uint8Array;
  authorize: () => Promise<void>;
  resolve: () => Promise<RunCredentialsResolution>;
  signal?: AbortSignal;
  persistence: {
    load: (
      definition: SandboxV2CredentialGenerationDefinition,
    ) => Promise<RetainedSandboxV2CredentialGeneration | null>;
    retain: (
      definition: SandboxV2CredentialGenerationDefinition,
      sealed: RetainedSandboxV2CredentialGeneration,
    ) => Promise<RetainedSandboxV2CredentialGeneration>;
    metadata: (
      definition: SandboxV2CredentialGenerationDefinition,
    ) => Promise<{ expiresAt: Date | null } | null>;
  };
};

/** Shared sealing/recovery only. The installed owner's persistence must check
 * its real authority; this helper grants no scope, launch, renewal or erasure.
 * Attempt generations preserve their existing authenticated version-1 body. */
export function createRetainedSandboxV2CredentialGenerationOwner(
  authority: SandboxJournalControlAuthority & { jobId?: string },
  input: SandboxV2CredentialGenerationDefinition,
  options: RetainedSandboxV2CredentialOwnerOptions,
) {
  const context = structuredClone(authority);
  const parsed = SandboxV2CredentialGenerationDefinition.safeParse(structuredClone(input));
  if (
    !parsed.success ||
    !(options.encryptionKey instanceof Uint8Array) ||
    options.encryptionKey.length !== 32 ||
    typeof options.authorize !== "function" ||
    typeof options.resolve !== "function"
  )
    fail();
  const definition = parsed.data;
  const key = Uint8Array.from(options.encryptionKey);
  const authorize = options.authorize;
  const resolve = options.resolve;
  const signal = options.signal;
  const persistence = { ...options.persistence };
  let inFlight: Promise<RunCredentialsResolution> | null = null;

  const restore = (sealed: RetainedSandboxV2CredentialGeneration): RunCredentialsResolution => {
    try {
      const plaintext = decryptEnvironmentValue(key, sealed.ciphertext);
      if (Buffer.byteLength(plaintext, "utf8") > MAX_PLAINTEXT_BYTES) fail();
      const body = JSON.parse(plaintext);
      if (
        !body ||
        body.version !== 1 ||
        !isDeepStrictEqual(body.authority, context) ||
        !isDeepStrictEqual(body.definition, definition) ||
        Object.keys(body).sort().join(",") !== "authority,definition,resolution,version"
      )
        fail();
      const resolution = canonicalResolution(body.resolution, context);
      const expiry = resolution.status === "ok" ? (resolution.expiresAt ?? null) : null;
      if (expiry !== (sealed.expiresAt?.toISOString() ?? null)) fail();
      return resolution;
    } catch {
      fail();
    }
  };
  const recover = async (): Promise<RunCredentialsResolution> => {
    signal?.throwIfAborted();
    await authorize();
    signal?.throwIfAborted();
    let original = await persistence.load(definition);
    if (!original) {
      let candidate: RunCredentialsResolution;
      try {
        candidate = await resolve();
      } catch {
        signal?.throwIfAborted();
        fail();
      }
      const resolution = canonicalResolution(structuredClone(candidate), context);
      signal?.throwIfAborted();
      await authorize();
      signal?.throwIfAborted();
      const plaintext = JSON.stringify({ version: 1, authority: context, definition, resolution });
      if (Buffer.byteLength(plaintext, "utf8") > MAX_PLAINTEXT_BYTES) fail();
      original = await persistence.retain(definition, {
        ciphertext: encryptEnvironmentValue(key, plaintext),
        expiresAt:
          resolution.status === "ok" && resolution.expiresAt
            ? new Date(resolution.expiresAt)
            : null,
      });
    }
    // Broker/DB latency may have changed either grant. Only the original is
    // eligible; reloading under the canonical fence licenses no new material.
    await authorize();
    signal?.throwIfAborted();
    const current = await persistence.metadata(definition);
    if (!current || current.expiresAt?.getTime() !== original.expiresAt?.getTime()) fail();
    return restore(original);
  };
  return {
    generationId: definition.generationId,
    authorizeGeneration: async (generationId = definition.generationId): Promise<void> => {
      if (generationId !== definition.generationId) fail();
      signal?.throwIfAborted();
      await authorize();
      signal?.throwIfAborted();
      const current = await persistence.metadata(definition);
      if (current?.expiresAt && current.expiresAt.getTime() <= Date.now()) fail();
      signal?.throwIfAborted();
    },
    resolveGeneration: async (
      generationId = definition.generationId,
    ): Promise<RunCredentialsResolution> => {
      if (generationId !== definition.generationId) fail();
      if (!inFlight) {
        const operation = recover();
        inFlight = operation;
        void operation
          .finally(() => {
            if (inFlight === operation) inFlight = null;
          })
          .catch(() => undefined);
      }
      return structuredClone(await inFlight);
    },
  };
}
