import { createHash, randomUUID } from "node:crypto";
import Ajv, {
  _,
  str,
  type CodeKeywordDefinition,
  type KeywordCxt,
  type ValidateFunction,
} from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import {
  TOOL_GATEWAY_CATALOG_VERSION,
  ToolGatewayCallRequest,
  ToolGatewayCatalog,
  ToolGatewayCatalogEntry,
  ToolGatewayResult,
  isToolResultSpilledReceipt,
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
  ToolGatewayCatalogStaleError,
  ToolGatewayInputValidationError,
  ToolGatewayOutputValidationError,
  ToolGatewayPathCollisionError,
  ToolGatewayToolNotFoundError,
} from "./errors";
import { summarizeToolGatewayInputErrors } from "./input-issues";

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
};

type CompiledDefinition = {
  entry: ToolGatewayCatalogEntryValue;
  execute: ToolGatewayDefinition["execute"];
  approvalAuthorityDigest: string | undefined;
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
  execute: () => Promise<ToolGatewayResultValue>;
};

export class PreparedToolGatewayDefinitions {
  readonly entries: readonly ToolGatewayCatalogEntryValue[];

  constructor(private readonly definitions: readonly CompiledDefinition[]) {
    this.entries = definitions.map(({ entry }) => entry);
  }

  create(input: {
    catalogDigest: string;
    authorize?: ToolGatewayAuthorization;
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
  }): ToolGateway {
    return new ToolGateway(
      input.catalogDigest,
      this.definitions,
      input.authorize,
      input.requireApproval,
      input.confirmModelApproval,
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
    if (this.requireApproval?.(definition.entry, caller, context)) {
      throw new ToolGatewayApprovalRequiredError();
    }
    if (!definition.validateInput(request.arguments)) {
      throw inputValidationError(definition, request.arguments);
    }
    if (
      caller.kind === "model" &&
      definition.entry.approval === "human" &&
      !modelApprovalConfirmed
    ) {
      throw new ToolGatewayApprovalRequiredError();
    }
    const call = {
      operationId,
      catalogDigest: request.catalogDigest,
      identity: request.identity,
      arguments: request.arguments,
      caller,
    } satisfies ToolGatewayCall;
    await this.authorize?.({ call, entry: definition.entry });
    if (definition.entry.approval === "human") {
      await definition.preflightCall?.({
        call,
        entry: definition.entry,
        context,
      });
    }
    const lifecycle = await definition.lifecycle?.prepare({
      call,
      entry: definition.entry,
      context,
    });
    return {
      call,
      entry: definition.entry,
      approvalAuthorityDigest:
        definition.approvalAuthorityDigest ??
        digestCanonicalJson({
          version: 1,
          catalogDigest: this.catalogDigest,
          identity: definition.entry.identity,
        }),
      execute: async () => {
        await lifecycle?.begin?.();
        let result: ToolGatewayResultValue;
        try {
          result = ToolGatewayResult.parse(
            await definition.execute(request.arguments, {
              operationId,
              caller,
              ...(context.sourceCallId === undefined ? {} : { sourceCallId: context.sourceCallId }),
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
          await lifecycle?.complete?.({ outcome: "failed", error });
          throw error;
        }
        await lifecycle?.complete?.({ outcome: "completed", result });
        return result;
      },
    };
  }

  async callModel(input: ModelToolGatewayCall): Promise<ToolGatewayResultValue> {
    const definition = this.byModelName.get(input.modelName);
    if (!definition) {
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

export function prepareToolGatewayDefinitions(
  definitions: readonly ToolGatewayDefinition[],
): PreparedToolGatewayDefinitions {
  const paths = allocateToolPaths(definitions);
  const schemaValidators = createSchemaValidators("first_error");
  let diagnosticValidators: SchemaValidators | undefined;
  const compiled = definitions.map((definition, index): CompiledDefinition => {
    const {
      execute,
      approvalAuthorityDigest,
      requiresProviderPreflight: _requiresProviderPreflight,
      preflightCall,
      lifecycle,
      codemodePath: _path,
      ...entryInput
    } = definition;
    if (approvalAuthorityDigest !== undefined && !/^[0-9a-f]{64}$/u.test(approvalAuthorityDigest)) {
      throw new Error("Tool gateway approval authority digest must be lowercase SHA-256 hex");
    }
    const entry = ToolGatewayCatalogEntry.parse({
      ...entryInput,
      codemodePath: paths[index],
    });
    let diagnoseInput: ValidateFunction<unknown> | undefined;
    return {
      entry,
      execute,
      approvalAuthorityDigest,
      preflightCall,
      lifecycle,
      validateInput: compileCatalogSchema(schemaValidators, entry.inputSchema),
      diagnoseInput: () =>
        (diagnoseInput ??= compileCatalogSchema(
          (diagnosticValidators ??= createSchemaValidators("all_errors")),
          entry.inputSchema,
        )),
      validateOutput: entry.outputSchema
        ? compileCatalogSchema(schemaValidators, entry.outputSchema)
        : null,
    };
  });
  return new PreparedToolGatewayDefinitions(compiled);
}

export function createWorkspaceToolGateway(input: {
  accountId: string;
  workspaceId: string;
  generation: number;
  definitions: readonly ToolGatewayDefinition[];
  createdAt?: Date;
  authorize?: ToolGatewayAuthorization;
  requireApproval?: (
    entry: ToolGatewayCatalogEntryValue,
    caller: ToolGatewayCaller,
    context: { transportMeta?: Record<string, unknown> | null },
  ) => boolean;
}): { catalog: ToolGatewayCatalogValue; gateway: ToolGateway } {
  const prepared = prepareToolGatewayDefinitions(input.definitions);
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
      ...(input.requireApproval ? { requireApproval: input.requireApproval } : {}),
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
  try {
    const serialized = JSON.stringify(args);
    if (serialized !== undefined && serialized.length <= TOOL_GATEWAY_INPUT_DIAGNOSTIC_MAX_CHARS) {
      const diagnose = definition.diagnoseInput();
      if (!diagnose(args) && diagnose.errors?.length) errors = diagnose.errors;
    }
  } catch {
    // Diagnostics are best effort; the rejection itself is already decided.
  }
  const { issues, omittedIssueCount } = summarizeToolGatewayInputErrors(errors);
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

function allocateToolPaths(definitions: readonly ToolGatewayDefinition[]): string[][] {
  const requested = definitions.map((definition) =>
    definition.codemodePath?.length
      ? [...definition.codemodePath]
      : [definition.identity.serverId, definition.identity.toolName],
  );
  const bases = requested.map((path) => path.map(safeNamespaceSegment));
  const allocated = bases.map((base, index) => {
    const path = requested[index]!;
    if (path.every((segment, segmentIndex) => segment === base[segmentIndex])) return base;
    const suffix = `_${shortIdentityDigest(definitions[index]!.identity)}`;
    const last = base.at(-1)!;
    return [...base.slice(0, -1), `${last.slice(0, 128 - suffix.length)}${suffix}`];
  });
  assertNoToolPathCollisions(allocated);
  return allocated;
}

type ToolPathNode = {
  children: Map<string, ToolPathNode>;
  leaf: boolean;
};

function assertNoToolPathCollisions(paths: readonly (readonly string[])[]): void {
  const root: ToolPathNode = { children: new Map(), leaf: false };
  const ordered = [...paths].sort(compareToolPaths);
  for (const path of ordered) {
    let node = root;
    for (const [index, segment] of path.entries()) {
      if (node.leaf) throw new ToolGatewayPathCollisionError(path, "extends_leaf");
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map(), leaf: false };
        node.children.set(segment, child);
      }
      node = child;
      if (index === path.length - 1) {
        if (node.leaf || node.children.size > 0) {
          throw new ToolGatewayPathCollisionError(path, "collision");
        }
        node.leaf = true;
      }
    }
  }
}

function compareToolPaths(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const compared = compareCanonicalStrings(left[index]!, right[index]!);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function safeNamespaceSegment(value: string): string {
  let normalized = value.replace(/[^A-Za-z0-9_$]/gu, "_");
  if (!/^[A-Za-z_$]/u.test(normalized)) normalized = `_${normalized}`;
  if (["__proto__", "prototype", "constructor"].includes(normalized)) {
    normalized = `_${normalized}`;
  }
  return normalized.slice(0, 128) || "_";
}

function shortIdentityDigest(identity: ToolGatewayIdentity): string {
  return createHash("sha256").update(identityKey(identity), "utf8").digest("hex").slice(0, 10);
}

function identityKey(identity: ToolGatewayIdentity): string {
  return `${identity.serverId}\u0000${identity.toolName}`;
}

export * from "./catalog";
export * from "./declarations";
export * from "./errors";
export * from "./input-issues";
