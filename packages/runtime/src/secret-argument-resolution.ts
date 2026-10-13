/**
 * Gateway argument resolution for secret references (design §10.4, §10B.2).
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

/**
 * One rule for every tool: a reference is used where it is written, and an
 * escaped reference passes on as the literal reference. Two kinds keep their
 * arguments unchanged: interaction tools, which the API resolves at dispatch
 * so their journals keep references, and OpenGeni's secret tools, whose
 * arguments name references rather than use them.
 */
export function secretArgumentMode(
  entry: Pick<ToolGatewayCatalogEntry, "source" | "identity">,
): SecretArgumentMode {
  if (entry.source === "interaction") return "preserve";
  if (entry.source === "opengeni" && entry.identity.toolName.startsWith("secret_")) {
    return "preserve";
  }
  return "literal";
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
  const modeFor = input.modeFor ?? ((entry) => secretArgumentMode(entry));
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
