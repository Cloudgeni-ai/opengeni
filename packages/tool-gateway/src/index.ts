import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { bindMcpTelemetry, withMcpCallIdentity, measureMcpPhase } from "@opengeni/observability";
import Ajv, {
  _,
  str,
  type CodeKeywordDefinition,
  type KeywordCxt,
  type ValidateFunction,
} from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import { schemaPatternEngine } from "./schema-pattern";
import { repairStringEncodedArguments } from "./string-encoded-arguments";
import {
  ATTEMPT_TOOL_CATALOG_MAX_BYTES,
  ATTEMPT_TOOL_CATALOG_MAX_ENTRIES,
  TOOL_GATEWAY_CATALOG_VERSION,
  ToolGatewayCallRequest,
  ToolGatewayCatalog,
  ToolGatewayCatalogEntry,
  ToolGatewayResult,
  isToolResultSpilledReceipt,
  executableToolSchema,
  type ToolGatewayCaller,
  type ToolGatewayCatalog as ToolGatewayCatalogValue,
  type ToolGatewayCatalogEntry as ToolGatewayCatalogEntryValue,
  type ToolGatewayIdentity,
  type ToolGatewayResult as ToolGatewayResultValue,
} from "@opengeni/contracts";
import {
  assertToolGatewayCatalogSize,
  compareCanonicalStrings,
  digestCanonicalJson,
  digestToolGatewayCatalog,
} from "./catalog";
import {
  ToolGatewayApprovalRequiredError,
  ToolGatewayBlockedError,
  ToolGatewayCatalogStaleError,
  ToolGatewayInputValidationError,
  ToolGatewaySchemaCompilationError,
  ToolGatewayOutputValidationError,
  ToolGatewayToolNotFoundError,
} from "./errors";
import { summarizeToolGatewayInputErrors, type ToolGatewayInputIssueSummary } from "./input-issues";

export type ToolGatewayExecutionContext = {
  operationId: string;
  caller: ToolGatewayCaller;
  /** Trusted in-process SDK correlation; not operation identity or approval authority. */
  sourceCallId?: string;
  /** In-process transport metadata; never part of catalog identity or digest. */
  transportMeta?: Record<string, unknown> | null;
  signal?: AbortSignal;
};

export type ToolGatewayCallContext = Pick<
  ToolGatewayExecutionContext,
  "sourceCallId" | "transportMeta" | "signal"
>;

export type ToolGatewayDefinition = Omit<ToolGatewayCatalogEntryValue, "codemodePath"> & {
  /** Optional human-readable path. Unsafe/colliding segments are normalized. */
  codemodePath?: readonly string[];
  /** Internal authority revision bound into human approval capabilities. */
  approvalAuthorityDigest?: string;
  /** Executable effect/account identity; excludes unrelated revision changes. */
  effectAuthorityDigest?: string;
  /** Connection-backed calls must have a side-effect-free provider preflight before approval. */
  requiresProviderPreflight?: boolean;
  /** In-process provider preflight; never enters the public catalog or its digest. */
  preflightCall?: (input: {
    call: ToolGatewayCall;
    entry: ToolGatewayCatalogEntryValue;
    context: ToolGatewayCallContext;
  }) => Promise<void> | void;
  /** In-process execution lifecycle; never enters the public catalog or its digest. */
  lifecycle?: ToolGatewayCallLifecycle;
  execute: (
    args: Record<string, unknown>,
    context: ToolGatewayExecutionContext,
  ) => Promise<ToolGatewayResultValue> | ToolGatewayResultValue;
};

export type ToolGatewayAuthorization = (input: {
  call: ToolGatewayCall;
  entry: ToolGatewayCatalogEntryValue;
}) => Promise<void> | void;

/** A trusted adapter resolves user preferences after schema and access validation. */
export type ToolGatewayApprovalResolver = (input: {
  call: ToolGatewayCall;
  entry: ToolGatewayCatalogEntryValue;
}) => Promise<"allow" | "ask" | "block"> | "allow" | "ask" | "block";

/**
 * Trusted, in-process argument resolution (for example secret references).
 * Runs inside `execute`, after approval and before the lifecycle crosses the
 * side-effect boundary, on a deep copy of the validated arguments. Only the
 * executor receives the result: approval digests, lifecycle rows, journals and
 * receipts keep the original arguments. Throwing prevents execution.
 */
export type ToolGatewayArgumentResolver = (input: {
  call: ToolGatewayCall;
  entry: ToolGatewayCatalogEntryValue;
  /** Deep copy of `call.arguments`; the resolver may mutate or replace it. */
  arguments: Record<string, unknown>;
  context: ToolGatewayCallContext;
}) => Promise<Record<string, unknown>> | Record<string, unknown>;

export type ToolGatewayCall = {
  operationId: string;
  catalogDigest: string;
  identity: ToolGatewayIdentity;
  arguments: Record<string, unknown>;
  caller: ToolGatewayCaller;
};

export type ToolGatewayCallSettlement =
  | { outcome: "completed"; result: ToolGatewayResultValue }
  | { outcome: "failed"; error: unknown };

export type PreparedToolGatewayCallLifecycle = {
  /** Exact durable review created by a trusted policy adapter. */
  waitingForApproval?: { requestId: string; actionFingerprint: string };
  /** Cross the side-effect boundary immediately before the executor closure. */
  begin?: () => Promise<void> | void;
  /** Settle the side-effect lifecycle after a returned result or thrown failure. */
  complete?: (settlement: ToolGatewayCallSettlement) => Promise<void> | void;
};

export type ToolGatewayCallLifecycle = {
  /** Argument-sensitive preflight. Throwing here guarantees the executor never runs. */
  prepare: (input: {
    call: ToolGatewayCall;
    entry: ToolGatewayCatalogEntryValue;
    context: ToolGatewayCallContext;
  }) => Promise<PreparedToolGatewayCallLifecycle | void> | PreparedToolGatewayCallLifecycle | void;
};

export type ModelToolGatewayCall = {
  operationId?: string;
  /** Exact SDK call id supplied by the host, never inferred from arguments or metadata. */
  sourceCallId?: string;
  modelName: string;
  arguments: Record<string, unknown>;
  subjectId: string;
  transportMeta?: Record<string, unknown> | null;
  signal?: AbortSignal;
  /**
   * The identity the caller advertised under `modelName`. When set, the call
   * runs only if the catalog binds that model name to this exact identity; a
   * name the catalog gave to a different tool is not found, never rerouted.
   */
  expectedIdentity?: ToolGatewayIdentity;
};

type CompiledDefinition = {
  entry: ToolGatewayCatalogEntryValue;
  execute: ToolGatewayDefinition["execute"];
  approvalAuthorityDigest: string | undefined;
  effectAuthorityDigest: string | undefined;
  preflightCall: ToolGatewayDefinition["preflightCall"];
  lifecycle: ToolGatewayCallLifecycle | undefined;
  validateInput: ValidateFunction<unknown>;
  /** Lazily compiled all-errors validator, used only to describe a rejected call. */
  diagnoseInput: () => ValidateFunction<unknown>;
  validateOutput: ValidateFunction<unknown> | null;
};

export type PreparedToolGatewayCall = {
  readonly call: ToolGatewayCall;
  readonly entry: ToolGatewayCatalogEntryValue;
  readonly approvalAuthorityDigest: string;
  /** Effective choice; optional for older adapters constructing this interface. */
  readonly approvalDecision?: "allow" | "ask";
  readonly waitingForApproval?: { requestId: string; actionFingerprint: string };
  readonly effectDigest?: string;
  execute: () => Promise<ToolGatewayResultValue>;
};

export class PreparedToolGatewayDefinitions {
  readonly entries: readonly ToolGatewayCatalogEntryValue[];

  constructor(
    private readonly definitions: readonly CompiledDefinition[],
    /** Tools that were deduplicated, re-pathed or left out while building the catalog. */
    readonly warnings: readonly ToolGatewayCatalogWarning[] = [],
  ) {
    this.entries = definitions.map(({ entry }) => entry);
  }

  create(input: {
    catalogDigest: string;
    authorize?: ToolGatewayAuthorization;
    resolveApproval?: ToolGatewayApprovalResolver;
    requireApproval?: (
      entry: ToolGatewayCatalogEntryValue,
      caller: ToolGatewayCaller,
      context: { transportMeta?: Record<string, unknown> | null },
    ) => boolean;
    confirmModelApproval?: (input: {
      entry: ToolGatewayCatalogEntryValue;
      modelName: string;
      subjectId: string;
    }) => boolean;
    resolveArguments?: ToolGatewayArgumentResolver;
  }): ToolGateway {
    return new ToolGateway(
      input.catalogDigest,
      this.definitions,
      input.authorize,
      input.requireApproval,
      input.confirmModelApproval,
      input.resolveApproval,
      input.resolveArguments,
    );
  }
}

export class ToolGateway {
  private readonly byIdentity = new Map<string, CompiledDefinition>();
  private readonly byModelName = new Map<string, CompiledDefinition>();

  constructor(
    readonly catalogDigest: string,
    definitions: readonly CompiledDefinition[],
    private readonly authorize: ToolGatewayAuthorization | undefined,
    private readonly requireApproval:
      | ((
          entry: ToolGatewayCatalogEntryValue,
          caller: ToolGatewayCaller,
          context: { transportMeta?: Record<string, unknown> | null },
        ) => boolean)
      | undefined,
    private readonly confirmModelApproval:
      | ((input: {
          entry: ToolGatewayCatalogEntryValue;
          modelName: string;
          subjectId: string;
        }) => boolean)
      | undefined,
    private readonly resolveApproval?: ToolGatewayApprovalResolver,
    private readonly resolveArguments?: ToolGatewayArgumentResolver,
  ) {
    for (const definition of definitions) {
      this.byIdentity.set(identityKey(definition.entry.identity), definition);
      this.byModelName.set(definition.entry.modelName, definition);
    }
  }

  async call(
    input: ToolGatewayCall,
    context: ToolGatewayCallContext = {},
  ): Promise<ToolGatewayResultValue> {
    return await (await this.prepareCallWithModelApproval(input, context, false)).execute();
  }

  async prepareCall(
    input: ToolGatewayCall,
    context: ToolGatewayCallContext = {},
  ): Promise<PreparedToolGatewayCall> {
    return await this.prepareCallWithModelApproval(input, context, false);
  }

  private async prepareCallWithModelApproval(
    input: ToolGatewayCall,
    context: ToolGatewayCallContext,
    modelApprovalConfirmed: boolean,
  ): Promise<PreparedToolGatewayCall> {
    return withMcpCallIdentity(context.sourceCallId ?? input.operationId, async () => {
      const prepared = await measureMcpPhase("gateway_policy", () =>
        this.prepareCallCore(input, context, modelApprovalConfirmed),
      );
      return { ...prepared, execute: bindMcpTelemetry(prepared.execute) };
    });
  }

  private async prepareCallCore(
    input: ToolGatewayCall,
    context: ToolGatewayCallContext,
    modelApprovalConfirmed: boolean,
  ): Promise<PreparedToolGatewayCall> {
    const request = ToolGatewayCallRequest.parse({
      operationId: input.operationId,
      catalogDigest: input.catalogDigest,
      identity: input.identity,
      arguments: input.arguments,
    });
    const operationId = request.operationId ?? input.operationId;
    const caller = input.caller;
    if (request.catalogDigest !== this.catalogDigest) {
      throw new ToolGatewayCatalogStaleError();
    }
    const definition = this.byIdentity.get(identityKey(request.identity));
    if (!definition) {
      throw new ToolGatewayToolNotFoundError();
    }
    if (!this.resolveApproval && this.requireApproval?.(definition.entry, caller, context)) {
      throw new ToolGatewayApprovalRequiredError();
    }
    let callArguments = request.arguments;
    if (!definition.validateInput(callArguments)) {
      const repaired = repairableInputSize(callArguments)
        ? repairStringEncodedArguments(callArguments, definition.diagnoseInput())
        : undefined;
      if (!repaired) throw inputValidationError(definition, callArguments);
      // Report what is still wrong after the repair, not what it fixed.
      if (!definition.validateInput(repaired)) throw inputValidationError(definition, repaired);
      callArguments = repaired;
    }
    if (
      caller.kind === "model" &&
      !this.resolveApproval &&
      definition.entry.approval === "human" &&
      !modelApprovalConfirmed
    ) {
      throw new ToolGatewayApprovalRequiredError();
    }
    const call = {
      operationId,
      catalogDigest: request.catalogDigest,
      identity: request.identity,
      arguments: callArguments,
      caller,
    } satisfies ToolGatewayCall;
    await measureMcpPhase("provider_authorization", () =>
      this.authorize?.({ call, entry: definition.entry }),
    );
    const approvalDecision = this.resolveApproval
      ? await this.resolveApproval({ call, entry: definition.entry })
      : definition.entry.approval === "human"
        ? "ask"
        : "allow";
    if (approvalDecision === "block") throw new ToolGatewayBlockedError();
    if (
      this.resolveApproval &&
      approvalDecision === "ask" &&
      (caller.kind === "model"
        ? !modelApprovalConfirmed
        : context.transportMeta?.approvalConfirmed !== true)
    ) {
      throw new ToolGatewayApprovalRequiredError();
    }
    if (approvalDecision === "ask") {
      await measureMcpPhase("preflight", () =>
        definition.preflightCall?.({
          call,
          entry: definition.entry,
          context,
        }),
      );
    }
    const lifecycle = await measureMcpPhase("lifecycle_prepare", () =>
      definition.lifecycle?.prepare({
        call,
        entry: definition.entry,
        context,
      }),
    );
    return {
      call,
      entry: definition.entry,
      approvalDecision,
      ...(lifecycle?.waitingForApproval
        ? { waitingForApproval: lifecycle.waitingForApproval }
        : {}),
      effectDigest: this.effectDigest(request.identity),
      approvalAuthorityDigest:
        definition.approvalAuthorityDigest ??
        digestCanonicalJson({
          version: 1,
          catalogDigest: this.catalogDigest,
          identity: definition.entry.identity,
        }),
      execute: async () =>
        measureMcpPhase(
          "execution",
          async () => {
            if (lifecycle?.waitingForApproval) throw new ToolGatewayApprovalRequiredError();
            // Resolution failures behave like a refused begin: nothing crossed
            // the side-effect boundary, so no lifecycle settlement is recorded.
            const executeArguments = this.resolveArguments
              ? await this.resolveArguments({
                  call,
                  entry: definition.entry,
                  arguments: structuredClone(callArguments),
                  context,
                })
              : callArguments;
            await measureMcpPhase("lifecycle_begin", () => lifecycle?.begin?.());
            let result: ToolGatewayResultValue;
            try {
              result = ToolGatewayResult.parse(
                await definition.execute(executeArguments, {
                  operationId,
                  caller,
                  ...(context.sourceCallId === undefined
                    ? {}
                    : { sourceCallId: context.sourceCallId }),
                  ...(context.transportMeta === undefined
                    ? {}
                    : { transportMeta: context.transportMeta }),
                  ...(context.signal === undefined ? {} : { signal: context.signal }),
                }),
              );
              if (!result.isError && definition.validateOutput) {
                const outputMatchesSchema =
                  result.structuredContent !== undefined &&
                  definition.validateOutput(result.structuredContent);
                if (!outputMatchesSchema && !isToolResultSpilledReceipt(result.structuredContent)) {
                  throw new ToolGatewayOutputValidationError();
                }
              }
            } catch (error) {
              await measureMcpPhase("lifecycle_complete", () =>
                lifecycle?.complete?.({ outcome: "failed", error }),
              );
              throw error;
            }
            await measureMcpPhase("lifecycle_complete", () =>
              lifecycle?.complete?.({ outcome: "completed", result }),
            );
            return result;
          },
          (result) => (result.isError ? "rejected" : "completed"),
        ),
    };
  }

  /** Binds continuation to one executable operation, independent of unrelated catalog changes. */
  effectDigest(identity: ToolGatewayIdentity): string {
    const definition = this.byIdentity.get(identityKey(identity));
    if (!definition) throw new ToolGatewayToolNotFoundError();
    const { entry } = definition;
    return digestCanonicalJson({
      version: 1,
      identity: entry.identity,
      source: entry.source,
      inputSchema: executableToolSchema(entry.inputSchema),
      outputSchema: executableToolSchema(entry.outputSchema ?? null),
      readOnly: entry.annotations?.readOnlyHint ?? null,
      destructive: entry.annotations?.destructiveHint ?? null,
      idempotent: entry.annotations?.idempotentHint ?? null,
      authority: definition.effectAuthorityDigest ?? definition.approvalAuthorityDigest ?? null,
    });
  }

  async callModel(input: ModelToolGatewayCall): Promise<ToolGatewayResultValue> {
    const definition = this.byModelName.get(input.modelName);
    if (!definition) {
      throw new ToolGatewayToolNotFoundError();
    }
    if (
      input.expectedIdentity !== undefined &&
      identityKey(input.expectedIdentity) !== identityKey(definition.entry.identity)
    ) {
      // Two tools claimed this model name and the catalog kept the other one.
      throw new ToolGatewayToolNotFoundError();
    }
    const call = {
      operationId: input.operationId ?? randomUUID(),
      catalogDigest: this.catalogDigest,
      identity: definition.entry.identity,
      arguments: input.arguments,
      caller: { kind: "model" as const, subjectId: input.subjectId },
    };
    const context = {
      ...(input.sourceCallId === undefined ? {} : { sourceCallId: input.sourceCallId }),
      ...(input.transportMeta === undefined ? {} : { transportMeta: input.transportMeta }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    const modelApprovalConfirmed =
      definition.entry.approval === "human" &&
      this.confirmModelApproval?.({
        entry: definition.entry,
        modelName: input.modelName,
        subjectId: input.subjectId,
      }) === true;
    return await (
      await this.prepareCallWithModelApproval(call, context, modelApprovalConfirmed)
    ).execute();
  }
}

/**
 * One tool the catalog builder could not take as given. A catalog is built for
 * every turn attempt, so one bad tool from one connector must never fail it:
 * the tool is deduplicated, given a disambiguated path, or left out, and the
 * builder reports it here instead of throwing.
 */
export type ToolGatewayCatalogWarning = {
  code:
    | "duplicate_identity"
    | "conflicting_identity"
    | "duplicate_model_name"
    | "path_disambiguated"
    | "path_unavailable"
    | "invalid_definition"
    | "catalog_entry_limit"
    | "catalog_byte_limit";
  serverId: string;
  toolName: string;
  modelName: string;
  /** The path the tool would have had. */
  path?: string;
  /** The path it was given instead, for `path_disambiguated`. */
  resolvedPath?: string;
  /** Short value-free reason, for `invalid_definition`. */
  reason?: string;
};

export type PrepareToolGatewayDefinitionsOptions = {
  /** Receives the builder's warnings; defaults to one structured `console.warn` per build. */
  onWarnings?: (warnings: readonly ToolGatewayCatalogWarning[]) => void;
};

const TOOL_GATEWAY_LOGGED_WARNINGS_MAX = 32;

function logToolGatewayCatalogWarnings(warnings: readonly ToolGatewayCatalogWarning[]): void {
  console.warn("[tool-gateway] tool catalog built without some tools as listed", {
    event: "tool_catalog_degraded",
    count: warnings.length,
    warnings: warnings.slice(0, TOOL_GATEWAY_LOGGED_WARNINGS_MAX),
  });
}

type AdmittedDefinition = {
  definition: ToolGatewayDefinition;
  entry: ToolGatewayCatalogEntryValue;
};

/**
 * Admit each definition on its own. Exact repeats of one identity collapse to
 * the first; a different tool claiming an identity or model name already taken
 * is left out, because either name routes to exactly one executor and must
 * never silently reach another tool. A definition the catalog contract rejects
 * makes only that tool unavailable.
 */
function admitToolGatewayDefinitions(
  definitions: readonly ToolGatewayDefinition[],
  warnings: ToolGatewayCatalogWarning[],
): AdmittedDefinition[] {
  const parsed: (AdmittedDefinition & { key: string; content: string })[] = [];
  const contentsByIdentity = new Map<string, Set<string>>();
  for (const definition of definitions) {
    const about = warningSubject(definition);
    let entry: ToolGatewayCatalogEntryValue;
    let content: string;
    try {
      if (
        definition.approvalAuthorityDigest !== undefined &&
        !/^[0-9a-f]{64}$/u.test(definition.approvalAuthorityDigest)
      ) {
        throw new Error("approval authority digest must be lowercase SHA-256 hex");
      }
      if (
        definition.effectAuthorityDigest !== undefined &&
        !/^[0-9a-f]{64}$/u.test(definition.effectAuthorityDigest)
      ) {
        throw new Error("effect authority digest must be lowercase SHA-256 hex");
      }
      const {
        execute: _execute,
        approvalAuthorityDigest: _approvalAuthorityDigest,
        effectAuthorityDigest: _effectAuthorityDigest,
        requiresProviderPreflight: _requiresProviderPreflight,
        preflightCall: _preflightCall,
        lifecycle: _lifecycle,
        codemodePath: _path,
        ...entryInput
      } = definition;
      // Validate with the tool's own projected path; the final path may differ.
      entry = ToolGatewayCatalogEntry.parse({
        ...entryInput,
        codemodePath: projectToolGatewayPath(definition),
      });
      content = digestCanonicalJson({
        entry,
        approvalAuthorityDigest: definition.approvalAuthorityDigest ?? null,
        effectAuthorityDigest: definition.effectAuthorityDigest ?? null,
      });
    } catch (error) {
      warnings.push({
        ...about,
        code: "invalid_definition",
        reason: invalidDefinitionReason(error),
      });
      continue;
    }
    const key = identityKey(entry.identity);
    parsed.push({ definition, entry, key, content });
    const contents = contentsByIdentity.get(key) ?? new Set<string>();
    contents.add(content);
    contentsByIdentity.set(key, contents);
  }
  const admitted: AdmittedDefinition[] = [];
  const admittedIdentities = new Set<string>();
  const modelNames = new Set<string>();
  for (const { definition, entry, key } of parsed) {
    const about = warningSubject(definition);
    if (contentsByIdentity.get(key)!.size > 1) {
      // Different definitions claim one identity. Identity is the routing key
      // for every caller, so no choice between them is safe: leave all out.
      warnings.push({ ...about, code: "conflicting_identity" });
      continue;
    }
    if (admittedIdentities.has(key)) {
      warnings.push({ ...about, code: "duplicate_identity" });
      continue;
    }
    if (modelNames.has(entry.modelName)) {
      // Callers that advertise this name pass the identity they advertised
      // (`expectedIdentity`), so the later tool's calls are refused, not rerouted.
      warnings.push({ ...about, code: "duplicate_model_name" });
      continue;
    }
    admittedIdentities.add(key);
    modelNames.add(entry.modelName);
    admitted.push({ definition, entry });
  }
  return admitted;
}

function warningSubject(
  definition: ToolGatewayDefinition,
): Pick<ToolGatewayCatalogWarning, "serverId" | "toolName" | "modelName"> {
  const identity = (definition as { identity?: Partial<ToolGatewayIdentity> }).identity;
  return {
    serverId: boundedWarningText(identity?.serverId),
    toolName: boundedWarningText(identity?.toolName),
    modelName: boundedWarningText((definition as { modelName?: unknown }).modelName),
  };
}

function boundedWarningText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 256) : "";
}

/** Value-free: names the failing fields, never their contents. */
function invalidDefinitionReason(error: unknown): string {
  const issues = (error as { issues?: unknown }).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const fields = [
      ...new Set(
        issues.map((issue) =>
          Array.isArray((issue as { path?: unknown }).path)
            ? (issue as { path: unknown[] }).path.map(String).join(".") || "(root)"
            : "(root)",
        ),
      ),
    ];
    return `invalid fields: ${fields.slice(0, 8).join(", ")}`.slice(0, 256);
  }
  return error instanceof Error ? error.message.slice(0, 256) : "invalid definition";
}

/** Room left in the catalog byte limit for its scope fields and digest. */
const TOOL_GATEWAY_CATALOG_ENVELOPE_RESERVE_BYTES = 64 * 1024;

/**
 * Keep the catalog inside its entry and byte limits by leaving tools out
 * instead of failing the build. Built-in tools are kept before connector
 * (`mcp`, `codex_apps`) tools; within each group, tools keep listing order and
 * the later ones are left out first.
 */
function fitToolGatewayCatalogLimits<T extends AdmittedDefinition & { path: string[] }>(
  candidates: readonly T[],
  warnings: ToolGatewayCatalogWarning[],
  limits: { maxEntries: number; maxBytes: number } = {
    maxEntries: ATTEMPT_TOOL_CATALOG_MAX_ENTRIES,
    maxBytes: ATTEMPT_TOOL_CATALOG_MAX_BYTES - TOOL_GATEWAY_CATALOG_ENVELOPE_RESERVE_BYTES,
  },
): T[] {
  const isConnector = (candidate: T) =>
    candidate.entry.source === "mcp" || candidate.entry.source === "codex_apps";
  const order = [
    ...candidates.filter((candidate) => !isConnector(candidate)),
    ...candidates.filter(isConnector),
  ];
  const kept = new Set<T>();
  let bytes = 2;
  for (const candidate of order) {
    const size = Buffer.byteLength(
      JSON.stringify({ ...candidate.entry, codemodePath: candidate.path }),
      "utf8",
    );
    const added = size + (kept.size > 0 ? 1 : 0);
    if (kept.size + 1 > limits.maxEntries) {
      warnings.push({ ...warningSubject(candidate.definition), code: "catalog_entry_limit" });
    } else if (bytes + added > limits.maxBytes) {
      warnings.push({ ...warningSubject(candidate.definition), code: "catalog_byte_limit" });
    } else {
      kept.add(candidate);
      bytes += added;
    }
  }
  return candidates.filter((candidate) => kept.has(candidate));
}

export function prepareToolGatewayDefinitions(
  definitions: readonly ToolGatewayDefinition[],
  options: PrepareToolGatewayDefinitionsOptions = {},
): PreparedToolGatewayDefinitions {
  const warnings: ToolGatewayCatalogWarning[] = [];
  const admittedDefinitions = admitToolGatewayDefinitions(definitions, warnings);
  const paths = allocateToolPaths(admittedDefinitions, warnings);
  const admitted = fitToolGatewayCatalogLimits(
    admittedDefinitions.flatMap((candidate, index) => {
      const path = paths[index];
      return path ? [{ ...candidate, path }] : [];
    }),
    warnings,
  );
  if (warnings.length > 0) {
    (options.onWarnings ?? logToolGatewayCatalogWarnings)(warnings);
  }
  let schemaValidators: SchemaValidators | undefined;
  let diagnosticValidators: SchemaValidators | undefined;
  const compiled = admitted.map(
    ({ definition, entry: admittedEntry, path }): CompiledDefinition => {
      const { execute, approvalAuthorityDigest, effectAuthorityDigest, preflightCall, lifecycle } =
        definition;
      const entry: ToolGatewayCatalogEntryValue = { ...admittedEntry, codemodePath: path };
      // Compilation used to snapshot these at preparation. Keep that boundary
      // even though the compiler is now reached only by a call to this tool.
      const inputSchema = structuredClone(entry.inputSchema);
      const outputSchema = entry.outputSchema ? structuredClone(entry.outputSchema) : null;
      let validators:
        | {
            input: ValidateFunction<unknown>;
            output: ValidateFunction<unknown> | null;
          }
        | undefined;
      let compilationFailure: ToolGatewaySchemaCompilationError | undefined;
      const compile = () => {
        if (validators) return validators;
        if (compilationFailure) throw compilationFailure;
        try {
          const compiler = (schemaValidators ??= createSchemaValidators("first_error"));
          // Compile both before argument admission, authorization or execution.
          // A broken output schema must never fail after a side effect has run.
          validators = {
            input: compileCatalogSchema(compiler, inputSchema),
            output: outputSchema ? compileCatalogSchema(compiler, outputSchema) : null,
          };
          return validators;
        } catch (error) {
          compilationFailure = new ToolGatewaySchemaCompilationError(error);
          throw compilationFailure;
        }
      };
      let diagnoseInput: ValidateFunction<unknown> | undefined;
      return {
        entry,
        execute,
        approvalAuthorityDigest,
        effectAuthorityDigest,
        preflightCall,
        lifecycle,
        get validateInput() {
          return compile().input;
        },
        diagnoseInput: () =>
          (diagnoseInput ??= compileCatalogSchema(
            (diagnosticValidators ??= createSchemaValidators("all_errors")),
            inputSchema,
          )),
        get validateOutput() {
          return compile().output;
        },
      };
    },
  );
  return new PreparedToolGatewayDefinitions(compiled, warnings);
}

export function createWorkspaceToolGateway(input: {
  accountId: string;
  workspaceId: string;
  generation: number;
  definitions: readonly ToolGatewayDefinition[];
  createdAt?: Date;
  authorize?: ToolGatewayAuthorization;
  resolveApproval?: ToolGatewayApprovalResolver;
  requireApproval?: (
    entry: ToolGatewayCatalogEntryValue,
    caller: ToolGatewayCaller,
    context: { transportMeta?: Record<string, unknown> | null },
  ) => boolean;
  resolveArguments?: ToolGatewayArgumentResolver;
  onWarnings?: PrepareToolGatewayDefinitionsOptions["onWarnings"];
}): { catalog: ToolGatewayCatalogValue; gateway: ToolGateway } {
  const prepared = prepareToolGatewayDefinitions(
    input.definitions,
    input.onWarnings ? { onWarnings: input.onWarnings } : {},
  );
  const unsigned = {
    version: TOOL_GATEWAY_CATALOG_VERSION,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    generation: input.generation,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    entries: [...prepared.entries],
  };
  const catalog = ToolGatewayCatalog.parse({
    ...unsigned,
    digest: digestToolGatewayCatalog(unsigned),
  });
  assertToolGatewayCatalogSize(catalog);
  return {
    catalog,
    gateway: prepared.create({
      catalogDigest: catalog.digest,
      ...(input.authorize ? { authorize: input.authorize } : {}),
      ...(input.resolveApproval ? { resolveApproval: input.resolveApproval } : {}),
      ...(input.requireApproval ? { requireApproval: input.requireApproval } : {}),
      ...(input.resolveArguments ? { resolveArguments: input.resolveArguments } : {}),
    }),
  };
}

type SchemaCompiler = { compile(schema: object): ValidateFunction<unknown> };

type SchemaValidatorMode = "first_error" | "all_errors";

type SchemaValidators = {
  mode: SchemaValidatorMode;
  draft7: SchemaCompiler;
  draft2019: SchemaCompiler;
  draft2020: SchemaCompiler;
};

const COMPILED_CATALOG_SCHEMA_CACHE_MAX_ENTRIES = 512;
const compiledCatalogSchemaCache = new Map<string, ValidateFunction<unknown>>();

/**
 * Serialized-size ceiling for the all-errors diagnostic pass. The accept/reject
 * decision always uses the first-error validator, which stops at the first
 * failure so a schema's own bounds (for example `maxLength` ahead of `pattern`)
 * keep limiting validation cost. The diagnostic pass runs only after a
 * rejection and only on arguments this small; larger ones report the first
 * problem alone. Its `pattern` keeps the `maxLength` guard (see
 * `maxLengthGuardedPattern`).
 */
export const TOOL_GATEWAY_INPUT_DIAGNOSTIC_MAX_CHARS = 64 * 1024;

function createSchemaValidators(mode: SchemaValidatorMode): SchemaValidators {
  const options = {
    allErrors: mode === "all_errors",
    coerceTypes: false,
    strict: false,
    useDefaults: false,
    validateFormats: false,
    // Remote schemas: a pattern invalid in Unicode mode must not fail the catalog.
    code: { regExp: schemaPatternEngine },
  } as const;
  const validators = {
    draft7: new Ajv(options),
    draft2019: new Ajv2019(options),
    draft2020: new Ajv2020(options),
  };
  if (mode === "all_errors") {
    for (const ajv of Object.values(validators)) {
      ajv.removeKeyword("pattern").addKeyword(maxLengthGuardedPattern);
    }
  }
  return { mode, ...validators };
}

function repairableInputSize(args: Record<string, unknown>): boolean {
  try {
    const serialized = JSON.stringify(args);
    return serialized !== undefined && serialized.length <= TOOL_GATEWAY_INPUT_DIAGNOSTIC_MAX_CHARS;
  } catch {
    return false;
  }
}

function codePointLength(value: string): number {
  let length = 0;
  for (const _codePoint of value) length += 1;
  return length;
}

/**
 * `pattern` for the all-errors diagnostic validators. The first-error validator
 * checks `maxLength` before `pattern` and stops there, so a schema's
 * `maxLength` bounds how long a string its (possibly backtracking-heavy)
 * pattern ever sees. With `allErrors` the built-in keyword would still run the
 * pattern on the over-long string. This version skips the pattern exactly when
 * the sibling `maxLength` already fails, so every subschema's validity is
 * unchanged and the diagnostic pass never runs a pattern on a string the
 * accept/reject validator would not have. Error shape matches the built-in.
 */
const maxLengthGuardedPattern: CodeKeywordDefinition = {
  keyword: "pattern",
  type: "string",
  schemaType: "string",
  error: {
    message: ({ schemaCode }) => str`must match pattern "${schemaCode}"`,
    params: ({ schemaCode }) => _`{pattern: ${schemaCode}}`,
  },
  code(cxt: KeywordCxt) {
    const { gen, data, schema, parentSchema, it } = cxt;
    const flags = it.opts.unicodeRegExp ? "u" : "";
    const regExp = gen.scopeValue("pattern", {
      key: `${schema}/${flags}`,
      ref: it.opts.code.regExp(schema as string, flags),
    });
    const maxLength: unknown = parentSchema.maxLength;
    if (typeof maxLength !== "number") {
      cxt.fail(_`!${regExp}.test(${data})`);
      return;
    }
    const length =
      it.opts.unicode === false
        ? _`${data}.length`
        : _`${gen.scopeValue("func", { ref: codePointLength })}(${data})`;
    cxt.fail(_`${length} <= ${maxLength} && !${regExp}.test(${data})`);
  },
};

/**
 * Describe why the first-error validator rejected `args`: every problem (capped)
 * when the arguments are small enough for the diagnostic pass, else the first.
 * Never includes argument values.
 */
function inputValidationError(
  definition: CompiledDefinition,
  args: Record<string, unknown>,
): ToolGatewayInputValidationError {
  let errors = definition.validateInput.errors;
  let diagnosticInput:
    | { schema: Record<string, unknown>; arguments: Record<string, unknown> }
    | undefined;
  try {
    const serialized = JSON.stringify(args);
    if (serialized !== undefined && serialized.length <= TOOL_GATEWAY_INPUT_DIAGNOSTIC_MAX_CHARS) {
      diagnosticInput = { schema: definition.entry.inputSchema, arguments: args };
      const diagnose = definition.diagnoseInput();
      if (!diagnose(args) && diagnose.errors?.length) errors = diagnose.errors;
    }
  } catch {
    // Diagnostics are best effort; the rejection itself is already decided.
  }
  const { issues, omittedIssueCount } = summarizeToolGatewayInputErrors(errors, diagnosticInput);
  return new ToolGatewayInputValidationError(issues, omittedIssueCount);
}

function compileCatalogSchema(
  validators: SchemaValidators,
  schema: ToolGatewayCatalogEntryValue["inputSchema"],
): ValidateFunction<unknown> {
  const dialect = typeof schema.$schema === "string" ? schema.$schema : "";
  const family = dialect.includes("2020-12")
    ? "2020-12"
    : dialect.includes("2019-09")
      ? "2019-09"
      : "draft7";
  const cacheKey = `${validators.mode}:${family}:${digestCanonicalJson(schema)}`;
  const cached = compiledCatalogSchemaCache.get(cacheKey);
  if (cached) {
    compiledCatalogSchemaCache.delete(cacheKey);
    compiledCatalogSchemaCache.set(cacheKey, cached);
    return cached;
  }
  const compiled =
    family === "2020-12"
      ? validators.draft2020.compile(schema)
      : family === "2019-09"
        ? validators.draft2019.compile(schema)
        : validators.draft7.compile(schema);
  while (compiledCatalogSchemaCache.size >= COMPILED_CATALOG_SCHEMA_CACHE_MAX_ENTRIES) {
    const oldest = compiledCatalogSchemaCache.keys().next().value;
    if (oldest === undefined) break;
    compiledCatalogSchemaCache.delete(oldest);
  }
  compiledCatalogSchemaCache.set(cacheKey, compiled);
  return compiled;
}

let argumentValidators: SchemaValidators | undefined;
let argumentDiagnosticValidators: SchemaValidators | undefined;

/**
 * Check arguments against a remote server's input schema (for example an MCP
 * event type's `inputSchema`) with the validators tool calls use. Returns the
 * problems as value-free sentences, or none when the arguments fit. A schema
 * that cannot be compiled is not enforced here: the server still validates
 * its own input.
 */
export function inputSchemaArgumentIssues(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): ToolGatewayInputIssueSummary {
  const fits = { issues: [], omittedIssueCount: 0 };
  let validate: ValidateFunction<unknown>;
  try {
    validate = compileCatalogSchema(
      (argumentValidators ??= createSchemaValidators("first_error")),
      schema as ToolGatewayCatalogEntryValue["inputSchema"],
    );
  } catch {
    return fits;
  }
  if (validate(args)) return fits;
  let errors = validate.errors;
  if (repairableInputSize(args)) {
    try {
      const diagnose = compileCatalogSchema(
        (argumentDiagnosticValidators ??= createSchemaValidators("all_errors")),
        schema as ToolGatewayCatalogEntryValue["inputSchema"],
      );
      diagnose(args);
      errors = diagnose.errors ?? errors;
    } catch {
      // The first-error result already decided the rejection.
    }
  }
  return summarizeToolGatewayInputErrors(errors, { schema, arguments: args });
}

/**
 * Give every admitted tool a unique Codemode path. Paths are convenience only
 * (calls are routed by identity), so a collision never fails the catalog: the
 * later tool in a canonical order gets a path disambiguated by its own identity
 * digest, and is left out only when no candidate path is free. The order is by
 * projected path and identity, so the result does not depend on listing order.
 */
function allocateToolPaths(
  admitted: readonly AdmittedDefinition[],
  warnings: ToolGatewayCatalogWarning[],
): (string[] | null)[] {
  const projected = admitted.map(({ entry }) => entry.codemodePath);
  const order = admitted
    .map((_candidate, index) => index)
    .sort(
      (left, right) =>
        compareToolPaths(projected[left]!, projected[right]!) ||
        compareCanonicalStrings(
          identityKey(admitted[left]!.entry.identity),
          identityKey(admitted[right]!.entry.identity),
        ),
    );
  const root: ToolPathNode = { children: new Map(), leaf: false };
  const allocated: (string[] | null)[] = admitted.map(() => null);
  for (const index of order) {
    const { entry } = admitted[index]!;
    const base = projected[index]!;
    const candidates = toolPathCandidates(base, entry.identity);
    const path = candidates.find((candidate) => claimToolPath(root, candidate));
    const subject = {
      serverId: entry.identity.serverId,
      toolName: entry.identity.toolName,
      modelName: entry.modelName,
      path: boundedWarningText(base.join(".")),
    };
    if (!path) {
      warnings.push({ ...subject, code: "path_unavailable" });
      continue;
    }
    if (path !== candidates[0]) {
      warnings.push({
        ...subject,
        code: "path_disambiguated",
        resolvedPath: boundedWarningText(path.join(".")),
      });
    }
    allocated[index] = path;
  }
  return allocated;
}

/** The projected path, then its leaf with an identity suffix, then a flattened leaf. */
function toolPathCandidates(base: readonly string[], identity: ToolGatewayIdentity): string[][] {
  const digest = identityDigest(identity);
  const withSuffix = (segment: string, length: number): string => {
    const suffix = `_${digest.slice(0, length)}`;
    return `${segment.slice(0, 128 - suffix.length)}${suffix}`;
  };
  const last = base.at(-1)!;
  const suffixedLast = last.endsWith(`_${digest.slice(0, 10)}`)
    ? withSuffix(last, 16)
    : withSuffix(last, 10);
  // A path under an existing tool leaf can only move up beside it.
  const flattened = [base[0]!, withSuffix(base.slice(1).join("_"), 16)];
  return [[...base], [...base.slice(0, -1), suffixedLast], flattened];
}

/** Claim `path` as a leaf when nothing occupies it; leaves the trie untouched otherwise. */
function claimToolPath(root: ToolPathNode, path: readonly string[]): boolean {
  let probe: ToolPathNode | undefined = root;
  for (const segment of path) {
    if (probe.leaf) return false;
    probe = probe.children.get(segment);
    if (!probe) break;
  }
  if (probe && (probe.leaf || probe.children.size > 0)) return false;
  let node = root;
  for (const segment of path) {
    let child = node.children.get(segment);
    if (!child) {
      child = { children: new Map(), leaf: false };
      node.children.set(segment, child);
    }
    node = child;
  }
  node.leaf = true;
  return true;
}

/** Shared forward projection; never reverse-parse a namespace as authority. */
export function projectToolGatewayPath(
  definition: Pick<ToolGatewayDefinition, "identity" | "codemodePath">,
): string[] {
  const path = definition.codemodePath?.length
    ? [...definition.codemodePath]
    : [definition.identity.serverId, definition.identity.toolName];
  const base = path.map(safeNamespaceSegment);
  if (path.every((segment, segmentIndex) => segment === base[segmentIndex])) return base;
  const suffix = `_${shortIdentityDigest(definition.identity)}`;
  const last = base.at(-1)!;
  return [...base.slice(0, -1), `${last.slice(0, 128 - suffix.length)}${suffix}`];
}

type ToolPathNode = {
  children: Map<string, ToolPathNode>;
  leaf: boolean;
};

function compareToolPaths(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const compared = compareCanonicalStrings(left[index]!, right[index]!);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

export function safeNamespaceSegment(value: string): string {
  let normalized = value.replace(/[^A-Za-z0-9_$]/gu, "_");
  if (!/^[A-Za-z_$]/u.test(normalized)) normalized = `_${normalized}`;
  if (["__proto__", "prototype", "constructor"].includes(normalized)) {
    normalized = `_${normalized}`;
  }
  return normalized.slice(0, 128) || "_";
}

function shortIdentityDigest(identity: ToolGatewayIdentity): string {
  return identityDigest(identity).slice(0, 10);
}

function identityDigest(identity: ToolGatewayIdentity): string {
  return createHash("sha256").update(identityKey(identity), "utf8").digest("hex");
}

function identityKey(identity: ToolGatewayIdentity): string {
  return `${identity.serverId}\u0000${identity.toolName}`;
}

export * from "./catalog";
export * from "./declarations";
export * from "./errors";
export * from "./input-issues";
