/**
 * Gateway argument resolution for secret references (dossier §10.4, §10B.2).
 *
 * `literal` sources (remote MCP servers and Codex apps) receive the values in
 * place of each `{{secret:…}}`; `preserve` sources (interaction tools, which
 * the API resolves, and first-party OpenGeni tools, which store references
 * verbatim) receive the arguments unchanged. The resolver only ever sees a
 * deep copy, so persisted arguments keep their references.
 */
import {
  collectInvalidReferencesDeep,
  collectReferencesDeep,
  containsSecretReference,
  referenceKey,
  replaceReferencesDeep,
  secretValueAtDispatch,
  SecretReferenceError,
  type SecretResolver,
  type SecretUseSurface,
  type ToolGatewayCatalogEntry,
} from "@opengeni/contracts";
import type { ToolGatewayArgumentResolver } from "@opengeni/tool-gateway";

export type SecretArgumentMode = "literal" | "preserve";

/** Remote tools take values; OpenGeni's own tools and interaction tools keep references. */
export function secretArgumentMode(source: ToolGatewayCatalogEntry["source"]): SecretArgumentMode {
  return source === "mcp" || source === "codex_apps" ? "literal" : "preserve";
}

function hasMarker(value: unknown): boolean {
  if (typeof value === "string") return containsSecretReference(value);
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasMarker);
  return Object.values(value as Record<string, unknown>).some(hasMarker);
}

/**
 * Builds the gateway hook. Returns undefined when there is no resolver or the
 * `secrets` capability is off: references then pass through literally (Q-35).
 */
export function createSecretArgumentResolver(input: {
  resolver: SecretResolver | null | undefined;
  /** Defaults to `codemode` for Codemode callers and `mcp` otherwise. */
  surface?: SecretUseSurface;
  modeFor?: (entry: ToolGatewayCatalogEntry) => SecretArgumentMode;
}): ToolGatewayArgumentResolver | undefined {
  const resolver = input.resolver;
  if (!resolver?.enabled) return undefined;
  const modeFor = input.modeFor ?? ((entry) => secretArgumentMode(entry.source));
  return async ({ call, entry, arguments: args, context }) => {
    if (modeFor(entry) !== "literal" || !hasMarker(args)) return args;
    const invalid = collectInvalidReferencesDeep(args);
    if (invalid.length > 0) {
      throw new SecretReferenceError(
        invalid.map((token) => ({
          raw: token.raw,
          code: "invalid_reference",
          message: token.reason,
        })),
      );
    }
    const references = collectReferencesDeep(args);
    const files = references.filter((reference) => reference.kind === "secretfile");
    if (files.length > 0) {
      throw new SecretReferenceError(
        files.map((reference) => ({
          raw: reference.raw,
          code: "secretfile_not_allowed",
          message:
            "{{secretfile:…}} names a file path and works only in shell commands; use {{secret:…}} in tool arguments",
        })),
      );
    }
    if (references.length === 0) {
      // Only escaped references: unescape them for the tool.
      return replaceReferencesDeep(args, (reference) => reference.raw);
    }
    const resolved = await resolver.resolve(references, {
      surface: input.surface ?? (call.caller.kind === "codemode" ? "codemode" : "mcp"),
      toolName: entry.modelName,
      operationId: call.operationId,
      ...(context.sourceCallId === undefined ? {} : { sourceCallId: context.sourceCallId }),
    });
    const values = new Map<string, string>();
    const binary: string[] = [];
    for (const [key, value] of resolved) {
      const material = await secretValueAtDispatch(value);
      if (typeof material === "string") values.set(key, material);
      else binary.push(value.reference.raw);
    }
    if (binary.length > 0) {
      throw new SecretReferenceError(
        binary.map((raw) => ({
          raw,
          code: "binary_value",
          message: "this field holds a file; tool arguments take text values only",
        })),
      );
    }
    return replaceReferencesDeep(args, (reference) => {
      const value = values.get(referenceKey(reference));
      if (value === undefined) {
        throw new SecretReferenceError([
          { raw: reference.raw, code: "not_found", message: "the reference did not resolve" },
        ]);
      }
      return value;
    });
  };
}
