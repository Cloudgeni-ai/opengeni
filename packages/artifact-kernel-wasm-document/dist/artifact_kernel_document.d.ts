/* tslint:disable */
/* eslint-disable */

/**
 * Stateful WebAssembly structured-document kernel handle.
 */
export class ArtifactDocumentSession {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Applies one complete transaction and returns an OGADR001 receipt.
     */
    applyCommands(command_envelope: Uint8Array): Uint8Array;
    /**
     * Releases the in-memory document state.
     */
    close(): void;
    /**
     * Creates an empty in-memory document from a canonical namespace envelope.
     */
    static create(namespace_envelope: Uint8Array): ArtifactDocumentSession;
    /**
     * Idempotent explicit-resource-management alias for close.
     */
    dispose(): void;
    /**
     * Creates an independent in-memory branch.
     */
    fork(): ArtifactDocumentSession;
    /**
     * Reports whether document state has been released.
     */
    isClosed(): boolean;
    /**
     * Opens one validated canonical OGADOC01 snapshot.
     */
    static open(snapshot: Uint8Array): ArtifactDocumentSession;
    /**
     * Executes one bounded document projection query.
     */
    query(query_envelope: Uint8Array): Uint8Array;
    /**
     * Returns the current document revision as a JavaScript bigint.
     */
    revision(): bigint;
    /**
     * Serializes the exact canonical document snapshot.
     */
    snapshot(): Uint8Array;
    /**
     * Returns SHA-256 of the exact canonical snapshot.
     */
    stateHash(): string;
}

/**
 * Atomically applies one OGADC001 command envelope to an OGADOC01 snapshot.
 */
export function applyDocumentCommands(snapshot: Uint8Array, command_envelope: Uint8Array): Uint8Array;

/**
 * Returns the canonical encoded build-identity envelope.
 *
 * The identity lets loaders fail closed when the operation protocol, snapshot
 * schema, or kernel implementation is incompatible.
 */
export function buildIdentity(): Uint8Array;

/**
 * Strictly validates and re-encodes one canonical OGADOC01 snapshot.
 */
export function canonicalizeDocumentSnapshot(snapshot: Uint8Array): Uint8Array;

/**
 * Returns the canonical encoded capability envelope.
 *
 * JavaScript receives a fresh `Uint8Array`; callers may mutate it without
 * affecting subsequent calls.
 */
export function capabilities(): Uint8Array;

/**
 * Creates an empty document from a canonical namespace envelope.
 */
export function createDocument(namespace_envelope: Uint8Array): Uint8Array;

/**
 * Executes one bounded OGADQ001 document projection query.
 */
export function queryDocument(snapshot: Uint8Array, query_envelope: Uint8Array): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_artifactdocumentsession_free: (a: number, b: number) => void;
    readonly applyDocumentCommands: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly artifactdocumentsession_applyCommands: (a: number, b: number, c: number, d: number) => void;
    readonly artifactdocumentsession_close: (a: number) => void;
    readonly artifactdocumentsession_create: (a: number, b: number, c: number) => void;
    readonly artifactdocumentsession_fork: (a: number, b: number) => void;
    readonly artifactdocumentsession_isClosed: (a: number) => number;
    readonly artifactdocumentsession_open: (a: number, b: number, c: number) => void;
    readonly artifactdocumentsession_query: (a: number, b: number, c: number, d: number) => void;
    readonly artifactdocumentsession_revision: (a: number, b: number) => void;
    readonly artifactdocumentsession_snapshot: (a: number, b: number) => void;
    readonly artifactdocumentsession_stateHash: (a: number, b: number) => void;
    readonly buildIdentity: (a: number) => void;
    readonly canonicalizeDocumentSnapshot: (a: number, b: number, c: number) => void;
    readonly capabilities: (a: number) => void;
    readonly createDocument: (a: number, b: number, c: number) => void;
    readonly queryDocument: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly artifactdocumentsession_dispose: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
