/**
 * Gateway argument resolution for secret references (design §10.4, §10B.2).
 *
 * `literal` sources (remote MCP servers, Codex apps and a short list of
 * Opengeni tools that hand a credential to something that runs) receive the
 * values in place of each reference. Every other Opengeni tool is a
 * `handoff` tool: it stores text or forwards it to other work, so it receives
 * reference text and never a value. Tools with their own delivery boundary
 * (interaction tools and run_on), and secret tools whose arguments name
 * references, receive the arguments unchanged. The resolver only ever sees a
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
import {
  APP_ACTION_CALL_TOOL_NAME,
  appActionCallSecretInputs,
  appActionCallStoresVaultItem,
  mapAppActionCallSecretInputs,
} from "@opengeni/contracts/app-actions";
import type { ToolGatewayArgumentResolver } from "@opengeni/tool-gateway";

/**
 * - `literal`: references resolve to values for the executing call.
 * - `handoff`: nothing resolves and nothing fails; escapes are removed, so the
 *   tool always receives plain reference text (`secretfile` included). The
 *   work that later receives the text resolves it at its own execution
 *   boundary, under its own vault policy.
 * - `preserve`: arguments pass unchanged, escapes included, to a tool that
 *   delivers at its own boundary.
 */
export type SecretArgumentMode = "literal" | "handoff" | "preserve";

/**
 * The only Opengeni tools that receive values. Each one hands the value to
 * something that runs or to a credential slot, never to text that another
 * session, a schedule, a goal, a note, Knowledge or an artifact keeps. Every
 * other Opengeni tool, including tools added later, is a hand-off tool.
 * Return true when this call needs values.
 */
const FIRST_PARTY_LITERAL_SECRET_TOOLS: Readonly<Record<string, (args: unknown) => boolean>> = {
  // Runs the given code once in the person's open Excel workbook, like a shell
  // command: a key the code uses (for example in a fetch) must be the value.
  excel_run: () => true,
  // Runs an app API action as the person. Only a call that fills a request
  // field the action catalog marks as a credential (a vault provider's API
  // key, an MCP server's headers) needs the value, and only in that field
  // (see `literalSecretScope`); the app keeps it in its encrypted credential
  // store. Creating or updating a vault item keeps its body in the vault. Every
  // other action call (creating a chat, a schedule, a Knowledge entry, or
  // invoking another tool) keeps reference text like any other hand-off tool.
  [APP_ACTION_CALL_TOOL_NAME]: (args) =>
    appActionCallStoresVaultItem(args) || appActionCallSecretInputs(args).length > 0,
};

/**
 * A reference resolves where something executes. Connectors and Codex apps
 * get values. Opengeni's own tools are hand-off tools by default and get
 * reference text, unless listed in `FIRST_PARTY_LITERAL_SECRET_TOOLS`. Tools
 * with their own delivery boundary keep references AND escapes intact until
 * that boundary: interaction tools resolve at API dispatch; run_on resolves
 * exec/write at the target (exec uses the same secret carry as
 * exec_command). Opengeni's secret tools name references rather than use
 * them. `args` lets a listed tool decide per call.
 */
export function secretArgumentMode(
  entry: Pick<ToolGatewayCatalogEntry, "source" | "identity">,
  args?: unknown,
): SecretArgumentMode {
  switch (entry.source) {
    case "interaction":
      return "preserve";
    case "mcp":
    case "codex_apps":
      return "literal";
    // Opengeni's file and docs tools only read; they hand off like any other
    // first-party tool.
    case "files":
    case "docs":
      return "handoff";
    case "opengeni": {
      const toolName = entry.identity.toolName;
      if (toolName === "run_on" || toolName.startsWith("secret_")) return "preserve";
      const literal = Object.hasOwn(FIRST_PARTY_LITERAL_SECRET_TOOLS, toolName)
        ? FIRST_PARTY_LITERAL_SECRET_TOOLS[toolName]
        : undefined;
      try {
        if (literal?.(args)) return "literal";
      } catch {
        // An unreadable call keeps reference text: nothing is lost.
      }
      return "handoff";
    }
    default: {
      // A new source must choose its mode here; until then it hands off.
      const unhandled: never = entry.source;
      void unhandled;
      return "handoff";
    }
  }
}

/**
 * What a literal call resolves: `target` holds the references that become
 * values, and `assemble` builds the executed arguments from the resolved
 * target. Usually the whole call; an admin_action_call that fills a
 * credential field resolves only that field and hands off the rest of its
 * body, so a chat message or a nested tool call next to it keeps reference
 * text.
 */
export type LiteralSecretScope = {
  target: unknown;
  assemble: (resolved: unknown) => unknown;
};

export function literalSecretScope(
  entry: Pick<ToolGatewayCatalogEntry, "source" | "identity">,
  args: unknown,
): LiteralSecretScope {
  const whole: LiteralSecretScope = { target: args, assemble: (resolved) => resolved };
  if (entry.source !== "opengeni" || entry.identity.toolName !== APP_ACTION_CALL_TOOL_NAME) {
    return whole;
  }
  try {
    if (appActionCallStoresVaultItem(args)) return whole;
    const inputs = appActionCallSecretInputs(args);
    return {
      target: inputs,
      assemble: (resolved) => {
        const values = Array.isArray(resolved) ? resolved : [];
        let index = 0;
        return mapAppActionCallSecretInputs(handOffSecretArguments(args), (value) =>
          index < values.length ? values[index++] : value,
        );
      },
    };
  } catch {
    // An unreadable call resolves nothing and keeps reference text.
    return { target: [], assemble: () => handOffSecretArguments(args) };
  }
}

/**
 * Hand-off arguments: escapes are removed, and every reference, `secretfile`
 * reference and malformed candidate stays exactly as written. Never throws.
 */
export function handOffSecretArguments<T>(args: T): T {
  if (!hasMarker(args)) return args;
  return replaceReferencesDeep(args, (reference) => reference.raw);
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
  modeFor?: (entry: ToolGatewayCatalogEntry, args: unknown) => SecretArgumentMode;
}): ToolGatewayArgumentResolver | undefined {
  const resolver = input.resolver;
  if (!resolver?.enabled) return undefined;
  const modeFor = input.modeFor ?? ((entry, args) => secretArgumentMode(entry, args));
  return async ({ call, entry, arguments: args, context }) => {
    if (!hasMarker(args)) return args;
    const mode = modeFor(entry, args);
    if (mode === "handoff") return handOffSecretArguments(args);
    if (mode !== "literal") return args;
    const scope = literalSecretScope(entry, args);
    const resolved = await resolveLiteral({
      resolver,
      surface: input.surface,
      args: scope.target,
      call,
      entry,
      context,
    });
    return scope.assemble(resolved) as typeof args;
  };
}

type ArgumentResolverInput = Parameters<ToolGatewayArgumentResolver>[0];

/** Literal resolution of `args`: every reference becomes its value, or the call fails. */
async function resolveLiteral({
  resolver,
  surface,
  args,
  call,
  entry,
  context,
}: {
  resolver: SecretResolver;
  surface: SecretUseSurface | undefined;
  args: unknown;
  call: ArgumentResolverInput["call"];
  entry: ArgumentResolverInput["entry"];
  context: ArgumentResolverInput["context"];
}): Promise<unknown> {
  if (!hasMarker(args)) return args;
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
    surface: surface ?? (call.caller.kind === "codemode" ? "codemode" : "mcp"),
    toolName: entry.modelName,
    operationId: call.operationId,
    ...(context.sourceCallId === undefined ? {} : { sourceCallId: context.sourceCallId }),
    // The connector the value goes to, for a person approving the use.
    ...(entry.codemodePath.length > 1
      ? { destination: entry.codemodePath.slice(0, -1).join(".") }
      : {}),
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
}
