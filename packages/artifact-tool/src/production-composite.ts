import type { WorkbookChange } from "./spreadsheet";
import type {
  NativeArtifactSession,
  NativeDocumentSession,
  NativePresentationSession,
  NativeSpreadsheetSession,
} from "./native";

const ROOT_KEY = "$root";
const PROXY_METADATA = new WeakMap<object, ProxyMetadata>();

export type CompositeModality = "spreadsheet" | "document" | "presentation";

export type CompositeReconciliation = Readonly<{
  session: NativeArtifactSession;
  data?: unknown;
}>;

export type CompositeReconciler<Root extends object> = (root: Root) => CompositeReconciliation;

export type CompositePropertyRead = Readonly<{
  handled: boolean;
  value?: unknown;
}>;

type Locator<Root extends object> = Readonly<{
  key: string;
  resolve(root: Root): unknown;
}>;

type ProxyMetadata = Readonly<{
  state: CompositeArtifactState<object>;
  locator: Locator<object>;
}>;

export type CompositeMutation = Readonly<{
  member: PropertyKey;
  owner: unknown;
  arguments?: readonly unknown[];
}>;

export type PreparedCompositeMutation = Readonly<{
  /** Applies one already-prevalidated mutation to the retained native session. */
  commit(result: unknown): boolean;
}>;

export type CompositeMutationPreparer<Root extends object> = (
  mutation: CompositeMutation,
  state: CompositeArtifactState<Root>,
) => PreparedCompositeMutation | null;

const QUERY_METHODS = new Set<PropertyKey>([
  "allStoryBlocks",
  "arrayBuffer",
  "at",
  "entries",
  "every",
  "export",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "forBlock",
  "forEach",
  "getActiveWorksheet",
  "getCell",
  "getItem",
  "getItemAt",
  "getRange",
  "getRangeByIndexes",
  "getUsedRange",
  "help",
  "includes",
  "indexOf",
  "inspect",
  "inspectRecord",
  "join",
  "keys",
  "lastIndexOf",
  "layoutSnapshot",
  "map",
  "ownsObject",
  "reduce",
  "reduceRight",
  "render",
  "resolve",
  "resize",
  "serialize",
  "slice",
  "some",
  "summary",
  "text",
  "toJSON",
  "toLocaleString",
  "toProto",
  "toString",
  "trace",
  "values",
]);

const ARRAY_CALLBACK_METHODS = new Set<PropertyKey>([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
]);

const ARRAY_MUTATION_METHODS = new Set<PropertyKey>([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);

/**
 * Owns one host projection and one exact native session. Public objects are
 * location proxies, not aliases to a particular projection instance. Rare
 * reconciliation mutations can therefore replace the host graph atomically;
 * hot mutations retain both the host graph and native session.
 */
export class CompositeArtifactState<Root extends object> {
  readonly modality: CompositeModality;
  readonly namespace: bigint;

  #root: Root;
  #native: NativeArtifactSession;
  #nativeData: unknown;
  #revision: number;
  readonly #disposedError: Error;
  #disposed = false;
  #mutationDepth = 0;
  #asyncMutation = false;
  readonly #reconcileProjection: CompositeReconciler<Root>;
  readonly #prepareMutation: CompositeMutationPreparer<Root> | undefined;
  readonly #proxies = new Map<string, object>();
  readonly #functions = new Map<string, (...args: unknown[]) => unknown>();
  readonly #changeListeners = new Set<(change: WorkbookChange) => void>();
  readonly #installProjection:
    | ((root: Root, state: CompositeArtifactState<Root>) => void)
    | undefined;
  readonly #readProperty:
    | ((
        owner: unknown,
        member: PropertyKey,
        state: CompositeArtifactState<Root>,
      ) => CompositePropertyRead)
    | undefined;
  readonly #captureAuxiliary: ((root: Root) => unknown) | undefined;
  readonly #restoreAuxiliary: ((root: Root, value: unknown) => void) | undefined;

  constructor(
    input: Readonly<{
      modality: CompositeModality;
      namespace: bigint;
      root: Root;
      reconciliation: CompositeReconciliation;
      reconcile: CompositeReconciler<Root>;
      prepareMutation?: CompositeMutationPreparer<Root>;
      installProjection?: (root: Root, state: CompositeArtifactState<Root>) => void;
      readProperty?: (
        owner: unknown,
        member: PropertyKey,
        state: CompositeArtifactState<Root>,
      ) => CompositePropertyRead;
      captureAuxiliary?: (root: Root) => unknown;
      restoreAuxiliary?: (root: Root, value: unknown) => void;
    }>,
  ) {
    this.modality = input.modality;
    this.namespace = input.namespace;
    this.#root = input.root;
    this.#native = input.reconciliation.session;
    this.#nativeData = input.reconciliation.data;
    this.#revision = safeRevision(this.#native.revision());
    this.#reconcileProjection = input.reconcile;
    this.#prepareMutation = input.prepareMutation;
    this.#installProjection = input.installProjection;
    this.#readProperty = input.readProperty;
    this.#captureAuxiliary = input.captureAuxiliary;
    this.#restoreAuxiliary = input.restoreAuxiliary;
    this.#disposedError = new Error(`${input.modality} artifact is disposed`);
    this.#installProjection?.(this.#root, this);
  }

  get root(): Root {
    this.assertUsable();
    return this.#root;
  }

  get native(): NativeArtifactSession {
    this.assertUsable();
    return this.#native;
  }

  get nativeData(): unknown {
    this.assertUsable();
    return this.#nativeData;
  }

  /** Monotonic facade revision across retained and rare replacement sessions. */
  get revision(): number {
    this.assertUsable();
    return this.#revision;
  }

  /** True only inside one explicit/public mutation transaction. */
  get inMutation(): boolean {
    return this.#mutationDepth > 0;
  }

  proxy(): Root {
    return this.wrap(rootLocator()) as Root;
  }

  rawRoot(): Root {
    this.assertUsable();
    return this.#root;
  }

  assertUsable(): void {
    if (this.#disposed) throw this.#disposedError;
    if (this.#asyncMutation && this.#mutationDepth === 0) {
      throw new Error(`${this.modality} artifact mutation is still in progress`);
    }
  }

  onWorkbookChange(listener: (change: WorkbookChange) => void): () => void {
    this.assertUsable();
    if (this.modality !== "spreadsheet") {
      throw new Error("Workbook change listeners are only available for spreadsheets");
    }
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#native.dispose();
    this.#changeListeners.clear();
    this.#proxies.clear();
    this.#functions.clear();
    this.#disposed = true;
  }

  mutate<Result>(operation: () => Result, hint: CompositeMutation): Result {
    this.assertUsable();
    if (this.#mutationDepth > 0) return operation();

    const prepared = this.#prepareMutation?.(hint, this) ?? null;
    const acceptedRoot = prepared ? null : cloneProjectionGraph(this.#root);
    const acceptedAuxiliary = prepared ? undefined : this.#captureAuxiliary?.(this.#root);
    this.#mutationDepth = 1;
    let result: Result;
    try {
      result = operation();
    } catch (cause) {
      if (acceptedRoot) this.#restoreProjection(acceptedRoot, acceptedAuxiliary);
      this.#mutationDepth = 0;
      throw cause;
    }

    if (isPromiseLike(result)) {
      this.#asyncMutation = true;
      return result.then(
        (value) => {
          try {
            this.#acceptProjection(hint, prepared, value);
            return value;
          } catch (cause) {
            if (acceptedRoot) this.#restoreProjection(acceptedRoot, acceptedAuxiliary);
            else this.#poisonAfterIncrementalFailure();
            throw cause;
          } finally {
            this.#mutationDepth = 0;
            this.#asyncMutation = false;
          }
        },
        (cause) => {
          if (acceptedRoot) this.#restoreProjection(acceptedRoot, acceptedAuxiliary);
          this.#mutationDepth = 0;
          this.#asyncMutation = false;
          throw cause;
        },
      ) as Result;
    }

    try {
      this.#acceptProjection(hint, prepared, result);
      return result;
    } catch (cause) {
      if (acceptedRoot) this.#restoreProjection(acceptedRoot, acceptedAuxiliary);
      else this.#poisonAfterIncrementalFailure();
      throw cause;
    } finally {
      this.#mutationDepth = 0;
    }
  }

  wrap(locator: Locator<Root>): unknown {
    this.assertUsable();
    const existing = this.#proxies.get(locator.key);
    if (existing) return existing;
    const current = locator.resolve(this.#root);
    if (!isProxyCandidate(current)) return current;

    const target: object = Array.isArray(current) ? [] : {};
    const proxy = new Proxy(target, this.#handler(locator));
    this.#proxies.set(locator.key, proxy);
    PROXY_METADATA.set(proxy, {
      state: this as unknown as CompositeArtifactState<object>,
      locator: locator as unknown as Locator<object>,
    });
    return proxy;
  }

  #handler(locator: Locator<Root>): ProxyHandler<object> {
    return {
      get: (_target, member) => {
        this.assertUsable();
        const owner = locator.resolve(this.#root);
        if (!isObject(owner)) return undefined;

        if (locator.key === ROOT_KEY) {
          if (member === "batch") {
            return this.#rootFunction("batch", (callback: unknown) => {
              if (typeof callback !== "function") {
                throw new TypeError("Artifact batch callback must be a function");
              }
              return this.mutate(() => callback(this.proxy()), {
                member: "batch",
                owner: this.#root,
                arguments: [callback],
              });
            });
          }
          if (member === "dispose") return this.#rootFunction("dispose", () => this.dispose());
          if (member === "onChange" && this.modality === "spreadsheet") {
            return this.#rootFunction("onChange", (listener: unknown) => {
              if (typeof listener !== "function")
                throw new TypeError("Workbook listener must be a function");
              return this.onWorkbookChange(listener as (change: WorkbookChange) => void);
            });
          }
          if (member === "recalculate" && this.modality === "spreadsheet") {
            return this.#rootFunction("recalculate", () => undefined);
          }
          if (
            member === "revision" &&
            (this.modality === "spreadsheet" || this.modality === "document")
          ) {
            return this.#revision;
          }
        }

        if (Array.isArray(owner) && member === Symbol.iterator) {
          return this.#arrayIterator(locator, owner);
        }

        const projected = this.#readProperty?.(owner, member, this);
        const value =
          projected?.handled === true ? projected.value : Reflect.get(owner, member, owner);
        if (typeof value === "function") {
          const functionKey = `${locator.key}.${propertyKey(member)}`;
          const cached = this.#functions.get(functionKey);
          if (cached) return cached;
          const wrapped = (...args: unknown[]): unknown => {
            this.assertUsable();
            const currentOwner = locator.resolve(this.#root);
            if (!isObject(currentOwner)) throw new Error("Artifact object no longer exists");
            const currentMethod = Reflect.get(currentOwner, member, currentOwner);
            if (typeof currentMethod !== "function")
              throw new TypeError(`${String(member)} is not callable`);
            const invocationArgs =
              Array.isArray(currentOwner) && ARRAY_CALLBACK_METHODS.has(member)
                ? this.#arrayCallbackArguments(locator, args)
                : args.map(unwrapArtifactValue);
            const invoke = () => currentMethod.apply(currentOwner, invocationArgs);
            const mutates = Array.isArray(currentOwner)
              ? ARRAY_MUTATION_METHODS.has(member)
              : !QUERY_METHODS.has(member);
            const result = mutates
              ? this.mutate(invoke, { member, owner: currentOwner, arguments: invocationArgs })
              : invoke();
            return this.#wrapReturn(locator, member, result);
          };
          this.#functions.set(functionKey, wrapped);
          return wrapped;
        }
        return this.#wrapProperty(locator, member, value);
      },
      set: (_target, member, value) => {
        this.assertUsable();
        const owner = locator.resolve(this.#root);
        if (!isObject(owner)) throw new Error("Artifact object no longer exists");
        return this.mutate(() => Reflect.set(owner, member, unwrapArtifactValue(value), owner), {
          member,
          owner,
          arguments: [unwrapArtifactValue(value)],
        });
      },
      deleteProperty: (_target, member) => {
        this.assertUsable();
        const owner = locator.resolve(this.#root);
        if (!isObject(owner)) throw new Error("Artifact object no longer exists");
        return this.mutate(() => Reflect.deleteProperty(owner, member), {
          member,
          owner,
          arguments: [],
        });
      },
      has: (_target, member) => {
        const owner = locator.resolve(this.#root);
        return isObject(owner) && member in owner;
      },
      getPrototypeOf: () => {
        const owner = locator.resolve(this.#root);
        return isObject(owner) ? Object.getPrototypeOf(owner) : null;
      },
      ownKeys: (target) => {
        const owner = locator.resolve(this.#root);
        const keys = isObject(owner) ? Reflect.ownKeys(owner) : [];
        if (Array.isArray(target) && !keys.includes("length")) keys.push("length");
        return keys;
      },
      getOwnPropertyDescriptor: (target, member) => {
        if (Array.isArray(target) && member === "length") {
          return Reflect.getOwnPropertyDescriptor(target, "length");
        }
        const owner = locator.resolve(this.#root);
        const descriptor = isObject(owner)
          ? Reflect.getOwnPropertyDescriptor(owner, member)
          : undefined;
        return descriptor ? { ...descriptor, configurable: true } : undefined;
      },
    };
  }

  #acceptProjection(
    hint: CompositeMutation,
    prepared: PreparedCompositeMutation | null,
    result: unknown,
  ): void {
    if (prepared) {
      const changed = prepared.commit(result);
      if (changed) {
        this.#revision = Math.max(this.#revision + 1, safeRevision(this.#native.revision()));
        this.#emitWorkbookChange(hint);
      }
      return;
    }
    const accepted = this.#reconcileProjection(this.#root);
    const previous = this.#native;
    this.#native = accepted.session;
    this.#nativeData = accepted.data;
    this.#revision = Math.max(this.#revision + 1, safeRevision(this.#native.revision()));
    try {
      previous.dispose();
    } catch {
      // The new session is already authoritative. Disposal is idempotent and
      // cannot be allowed to roll a successful atomic projection swap back.
    }
    this.#emitWorkbookChange(hint);
  }

  #poisonAfterIncrementalFailure(): void {
    try {
      this.#native.dispose();
    } finally {
      this.#disposed = true;
      this.#changeListeners.clear();
    }
  }

  #restoreProjection(root: Root, auxiliary: unknown): void {
    this.#root = root;
    this.#installProjection?.(this.#root, this);
    this.#restoreAuxiliary?.(this.#root, auxiliary);
  }

  #emitWorkbookChange(hint: CompositeMutation): void {
    if (this.modality !== "spreadsheet" || this.#changeListeners.size === 0) return;
    const root = this.#root as unknown as {
      worksheets?: { items?: ReadonlyArray<{ id?: string }> };
    };
    const owner = hint.owner as { id?: unknown; worksheet?: { id?: unknown } };
    const ownerSheet =
      typeof owner?.id === "string" && owner.id.startsWith("ws/")
        ? owner.id
        : typeof owner?.worksheet?.id === "string"
          ? owner.worksheet.id
          : null;
    const sheetIds = ownerSheet
      ? [ownerSheet]
      : (root.worksheets?.items ?? [])
          .map((sheet) => sheet.id)
          .filter((id): id is string => typeof id === "string");
    const member = String(hint.member).toLowerCase();
    const reason: WorkbookChange["reason"] =
      member.includes("format") || member.includes("style")
        ? "format"
        : member.includes("comment") || member.includes("reply")
          ? "comment"
          : member.includes("width") || member.includes("height")
            ? "dimension"
            : member.includes("chart") ||
                member.includes("image") ||
                member.includes("shape") ||
                member.includes("sparkline")
              ? "drawing"
              : member.includes("sheet") || member === "add" || member === "name"
                ? "structure"
                : "content";
    const change: WorkbookChange = Object.freeze({
      revision: this.#revision,
      sheetIds: Object.freeze([...new Set(sheetIds)].sort()),
      reason,
    });
    for (const listener of this.#changeListeners) listener(change);
  }

  #rootFunction(
    name: string,
    implementation: (...args: unknown[]) => unknown,
  ): (...args: unknown[]) => unknown {
    const key = `${ROOT_KEY}.${name}`;
    const existing = this.#functions.get(key);
    if (existing) return existing;
    this.#functions.set(key, implementation);
    return implementation;
  }

  #wrapProperty(parent: Locator<Root>, member: PropertyKey, value: unknown): unknown {
    if (!isProxyCandidate(value)) return value;
    const stable = this.#stableLocator(value);
    return this.wrap(stable ?? propertyLocator(parent, member));
  }

  #wrapReturn(parent: Locator<Root>, member: PropertyKey, value: unknown): unknown {
    if (isPromiseLike(value)) {
      return value.then((resolved) => this.#wrapReturn(parent, member, resolved));
    }
    if (!isProxyCandidate(value)) return value;
    const stable = this.#stableLocator(value);
    if (stable) return this.wrap(stable);
    if (isRangeLike(value)) return this.wrap(rangeLocator(value));
    // Arrays and plain records returned by inspection/serialization are owned
    // copies, not live graph nodes. Only property traversal creates a locator
    // for such values.
    return value;
  }

  #stableLocator(value: object): Locator<Root> | null {
    const id = Reflect.get(value, "id");
    if (typeof id !== "string") return null;
    const root = this.#root as unknown as { resolve?: (id: string) => unknown };
    if (typeof root.resolve !== "function") return null;
    try {
      if (root.resolve(id) !== value) return null;
    } catch {
      return null;
    }
    return {
      key: `id:${id}`,
      resolve: (candidateRoot) => {
        const resolve = (candidateRoot as unknown as { resolve?: (objectId: string) => unknown })
          .resolve;
        if (typeof resolve !== "function") throw new Error(`Artifact cannot resolve ${id}`);
        return resolve.call(candidateRoot, id);
      },
    };
  }

  #arrayIterator(locator: Locator<Root>, owner: unknown[]): () => IterableIterator<unknown> {
    const current = () => locator.resolve(this.#root);
    const wrap = (index: number, value: unknown) =>
      this.#wrapProperty(locator, String(index), value);
    return function* iterator(): IterableIterator<unknown> {
      for (let index = 0; index < owner.length; index += 1) {
        const currentArray = current();
        if (!Array.isArray(currentArray) || index >= currentArray.length) return;
        yield wrap(index, currentArray[index]);
      }
    };
  }

  #arrayCallbackArguments(locator: Locator<Root>, args: readonly unknown[]): unknown[] {
    if (typeof args[0] !== "function") return args.map(unwrapArtifactValue);
    const callback = args[0] as (...callbackArgs: unknown[]) => unknown;
    const thisArg = args[1];
    const wrapChild = (index: number, value: unknown) =>
      this.#wrapProperty(locator, String(index), value);
    const wrappedArray = () => this.wrap(locator);
    const wrappedCallback = function (this: unknown, value: unknown, index: unknown) {
      const child = typeof index === "number" ? wrapChild(index, value) : value;
      return callback.call(thisArg ?? this, child, index, wrappedArray());
    };
    return [wrappedCallback, thisArg];
  }
}

export function stateOf(value: unknown): CompositeArtifactState<object> | null {
  if (!isObject(value)) return null;
  return PROXY_METADATA.get(value)?.state ?? null;
}

export function requireCompositeState(
  value: unknown,
  modality?: CompositeModality,
): CompositeArtifactState<object> {
  const state = stateOf(value);
  if (!state) throw new TypeError("Expected an artifact created by the production facade");
  state.assertUsable();
  if (modality && state.modality !== modality) {
    throw new TypeError(`Expected a ${modality} artifact`);
  }
  return state;
}

export function unwrapArtifactValue(value: unknown): unknown {
  if (!isObject(value)) return value;
  const metadata = PROXY_METADATA.get(value);
  if (metadata) return metadata.locator.resolve(metadata.state.rawRoot());
  if (Array.isArray(value)) return value.map(unwrapArtifactValue);
  if (!isPlainObject(value)) return value;
  const output: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(value))
    output[key] = unwrapArtifactValue(Reflect.get(value, key));
  return output;
}

export function nativeSessionOf(
  state: CompositeArtifactState<object>,
): NativeSpreadsheetSession | NativeDocumentSession | NativePresentationSession {
  return state.native;
}

function rootLocator<Root extends object>(): Locator<Root> {
  return { key: ROOT_KEY, resolve: (root) => root };
}

function propertyLocator<Root extends object>(
  parent: Locator<Root>,
  member: PropertyKey,
): Locator<Root> {
  return {
    key: `${parent.key}.${propertyKey(member)}`,
    resolve(root) {
      const owner = parent.resolve(root);
      if (!isObject(owner)) throw new Error("Artifact parent object no longer exists");
      return Reflect.get(owner, member, owner);
    },
  };
}

function rangeLocator<Root extends object>(range: object): Locator<Root> {
  const worksheet = Reflect.get(range, "worksheet") as { id?: unknown };
  const address = Reflect.get(range, "address") as {
    row?: unknown;
    col?: unknown;
    rowCount?: unknown;
    colCount?: unknown;
  };
  if (
    typeof worksheet?.id !== "string" ||
    !Number.isInteger(address?.row) ||
    !Number.isInteger(address?.col) ||
    !Number.isInteger(address?.rowCount) ||
    !Number.isInteger(address?.colCount)
  ) {
    throw new Error("Cannot locate spreadsheet range");
  }
  const row = address.row as number;
  const col = address.col as number;
  const rowCount = address.rowCount as number;
  const colCount = address.colCount as number;
  const sheetId = worksheet.id;
  return {
    key: `range:${sheetId}:${row}:${col}:${rowCount}:${colCount}`,
    resolve(root) {
      const workbook = root as unknown as { resolve?: (id: string) => unknown };
      const sheet = workbook.resolve?.(sheetId) as {
        getRangeByIndexes?: (row: number, col: number, rows: number, columns: number) => unknown;
      };
      if (!sheet || typeof sheet.getRangeByIndexes !== "function") {
        throw new Error(`Worksheet no longer exists: ${sheetId}`);
      }
      return sheet.getRangeByIndexes(row, col, rowCount, colCount);
    },
  };
}

function isRangeLike(value: object): boolean {
  const address = Reflect.get(value, "address");
  const worksheet = Reflect.get(value, "worksheet");
  return (
    isObject(address) && isObject(worksheet) && typeof Reflect.get(worksheet, "id") === "string"
  );
}

function isProxyCandidate(value: unknown): value is object {
  if (!isObject(value)) return false;
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof Blob ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof Promise ||
    Object.isFrozen(value)
  ) {
    return false;
  }
  return true;
}

function cloneProjectionGraph<Root extends object>(root: Root): Root {
  return cloneGraph(root, new Map()) as Root;
}

function cloneGraph(value: unknown, seen: Map<object, unknown>): unknown {
  if (!isObject(value) || typeof value === "function") return value;
  const known = seen.get(value);
  if (known !== undefined) return known;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      return new DataView(
        value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
      );
    }
    const constructor = value.constructor as new (input: ArrayLike<number>) => ArrayBufferView;
    return new constructor(value as unknown as ArrayLike<number>);
  }
  if (value instanceof Blob) return value.slice(0, value.size, value.type);
  if (value instanceof Map) {
    const output = new Map();
    seen.set(value, output);
    for (const [key, entry] of value) output.set(cloneGraph(key, seen), cloneGraph(entry, seen));
    return output;
  }
  if (value instanceof Set) {
    const output = new Set();
    seen.set(value, output);
    for (const entry of value) output.add(cloneGraph(entry, seen));
    return output;
  }
  if (value instanceof WeakMap || value instanceof WeakSet || value instanceof Promise)
    return value;

  const output: object = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  seen.set(value, output);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ("value" in descriptor) descriptor.value = cloneGraph(descriptor.value, seen);
    Reflect.defineProperty(output, key, descriptor);
  }
  if (Object.isFrozen(value)) Object.freeze(output);
  else if (Object.isSealed(value)) Object.seal(output);
  else if (!Object.isExtensible(value)) Object.preventExtensions(output);
  return output;
}

function safeRevision(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Native artifact revision exceeds the JavaScript safe-integer range");
  }
  return Number(value);
}

function propertyKey(value: PropertyKey): string {
  return typeof value === "symbol" ? `symbol:${value.description ?? ""}` : String(value);
}

function isPromiseLike<Result>(value: Result): value is Result & Promise<Awaited<Result>> {
  return isObject(value) && typeof Reflect.get(value, "then") === "function";
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
