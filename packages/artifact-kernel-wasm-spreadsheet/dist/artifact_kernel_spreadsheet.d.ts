/* tslint:disable */
/* eslint-disable */

/**
 * Stateful authoritative collaboration/CRDT kernel handle.
 */
export class ArtifactCollaborationSession {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Replays one whole canonical committed transaction atomically.
     */
    applyCommitted(operation_envelope: Uint8Array): void;
    /**
     * Authors and applies one canonical OGATX001 transaction.
     */
    authorTransaction(intent_bytes: Uint8Array, resolved_base: Uint8Array): Uint8Array;
    /**
     * Releases the in-memory collaboration state.
     */
    close(): void;
    /**
     * Creates an empty CRDT workbook from a canonical namespace envelope.
     */
    static create(namespace_envelope: Uint8Array): ArtifactCollaborationSession;
    /**
     * Idempotent lifecycle alias for `close()`.
     */
    dispose(): void;
    /**
     * Creates an independent in-memory collaboration branch.
     */
    fork(): ArtifactCollaborationSession;
    /**
     * Returns the canonical OGACF001 causal frontier.
     */
    frontier(): Uint8Array;
    /**
     * Reports whether the collaboration state has been released.
     */
    isClosed(): boolean;
    /**
     * Opens one canonical OGACRD01 full-state snapshot.
     */
    static open(snapshot: Uint8Array): ArtifactCollaborationSession;
    /**
     * Executes one bounded viewport or workbook-metadata projection.
     */
    query(query_envelope: Uint8Array): Uint8Array;
    /**
     * Returns the materialized workbook revision as a JavaScript `bigint`.
     */
    revision(): bigint;
    /**
     * Returns the full canonical OGACRD01 snapshot.
     */
    snapshot(): Uint8Array;
    /**
     * Returns SHA-256 of the exact canonical OGACRD01 snapshot.
     */
    stateHash(): string;
}

/**
 * Returns the canonical encoded build-identity envelope.
 *
 * The identity lets loaders fail closed when the operation protocol, snapshot
 * schema, or kernel implementation is incompatible.
 */
export function buildIdentity(): Uint8Array;

/**
 * Strictly validates and re-encodes a full OGACRD01 collaboration snapshot.
 */
export function canonicalizeCollaborationSnapshot(snapshot: Uint8Array): Uint8Array;

/**
 * Returns the canonical encoded capability envelope.
 *
 * JavaScript receives a fresh `Uint8Array`; callers may mutate it without
 * affecting subsequent calls.
 */
export function capabilities(): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_artifactcollaborationsession_free: (a: number, b: number) => void;
    readonly artifactcollaborationsession_applyCommitted: (a: number, b: number, c: number, d: number) => void;
    readonly artifactcollaborationsession_authorTransaction: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly artifactcollaborationsession_close: (a: number) => void;
    readonly artifactcollaborationsession_create: (a: number, b: number, c: number) => void;
    readonly artifactcollaborationsession_fork: (a: number, b: number) => void;
    readonly artifactcollaborationsession_frontier: (a: number, b: number) => void;
    readonly artifactcollaborationsession_isClosed: (a: number) => number;
    readonly artifactcollaborationsession_open: (a: number, b: number, c: number) => void;
    readonly artifactcollaborationsession_query: (a: number, b: number, c: number, d: number) => void;
    readonly artifactcollaborationsession_revision: (a: number, b: number) => void;
    readonly artifactcollaborationsession_snapshot: (a: number, b: number) => void;
    readonly artifactcollaborationsession_stateHash: (a: number, b: number) => void;
    readonly buildIdentity: (a: number) => void;
    readonly canonicalizeCollaborationSnapshot: (a: number, b: number, c: number) => void;
    readonly capabilities: (a: number) => void;
    readonly artifactcollaborationsession_dispose: (a: number) => void;
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
