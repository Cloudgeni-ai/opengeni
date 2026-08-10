/* tslint:disable */
/* eslint-disable */

/**
 * Stateful WebAssembly presentation-kernel handle.
 */
export class ArtifactPresentationSession {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Applies one complete command transaction and returns its OGAPR001 receipt.
     */
    applyCommands(command_envelope: Uint8Array): Uint8Array;
    /**
     * Releases the in-memory presentation state.
     */
    close(): void;
    /**
     * Creates an empty in-memory presentation from a canonical namespace envelope.
     */
    static create(namespace_envelope: Uint8Array): ArtifactPresentationSession;
    /**
     * Idempotent explicit-resource-management alias for close.
     */
    dispose(): void;
    /**
     * Creates an independent in-memory presentation branch.
     */
    fork(): ArtifactPresentationSession;
    /**
     * Reports whether presentation state has been released.
     */
    isClosed(): boolean;
    /**
     * Opens one validated canonical OGAPRS01 snapshot.
     */
    static open(snapshot: Uint8Array): ArtifactPresentationSession;
    /**
     * Executes one bounded presentation projection query.
     */
    query(query_envelope: Uint8Array): Uint8Array;
    /**
     * Returns the current presentation revision as a JavaScript bigint.
     */
    revision(): bigint;
    /**
     * Serializes the exact canonical presentation snapshot.
     */
    snapshot(): Uint8Array;
    /**
     * Returns SHA-256 of the exact canonical snapshot.
     */
    stateHash(): string;
}

/**
 * Atomically applies one OGAPC001 command envelope to an OGAPRS01 snapshot.
 */
export function applyPresentationCommands(snapshot: Uint8Array, command_envelope: Uint8Array): Uint8Array;

/**
 * Returns the canonical encoded build-identity envelope.
 *
 * The identity lets loaders fail closed when the operation protocol, snapshot
 * schema, or kernel implementation is incompatible.
 */
export function buildIdentity(): Uint8Array;

/**
 * Strictly validates and re-encodes one canonical OGAPRS01 snapshot.
 */
export function canonicalizePresentationSnapshot(snapshot: Uint8Array): Uint8Array;

/**
 * Returns the canonical encoded capability envelope.
 *
 * JavaScript receives a fresh `Uint8Array`; callers may mutate it without
 * affecting subsequent calls.
 */
export function capabilities(): Uint8Array;

/**
 * Creates an empty presentation from a canonical namespace envelope.
 */
export function createPresentation(namespace_envelope: Uint8Array): Uint8Array;

/**
 * Executes one bounded OGAPQ001 presentation projection query.
 */
export function queryPresentation(snapshot: Uint8Array, query_envelope: Uint8Array): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_artifactpresentationsession_free: (a: number, b: number) => void;
    readonly applyPresentationCommands: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly artifactpresentationsession_applyCommands: (a: number, b: number, c: number, d: number) => void;
    readonly artifactpresentationsession_close: (a: number) => void;
    readonly artifactpresentationsession_create: (a: number, b: number, c: number) => void;
    readonly artifactpresentationsession_fork: (a: number, b: number) => void;
    readonly artifactpresentationsession_isClosed: (a: number) => number;
    readonly artifactpresentationsession_open: (a: number, b: number, c: number) => void;
    readonly artifactpresentationsession_query: (a: number, b: number, c: number, d: number) => void;
    readonly artifactpresentationsession_revision: (a: number, b: number) => void;
    readonly artifactpresentationsession_snapshot: (a: number, b: number) => void;
    readonly artifactpresentationsession_stateHash: (a: number, b: number) => void;
    readonly buildIdentity: (a: number) => void;
    readonly canonicalizePresentationSnapshot: (a: number, b: number, c: number) => void;
    readonly capabilities: (a: number) => void;
    readonly createPresentation: (a: number, b: number, c: number) => void;
    readonly queryPresentation: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly artifactpresentationsession_dispose: (a: number) => void;
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
