import { AsyncLocalStorage } from "node:async_hooks";
import { ModalRouterProviderCommand } from "@opengeni/contracts";
import { ProviderCommandStartOutcomeUnknownError } from "../provider-command-session";

// Shared with the repository's SDK patch without importing its optional exports.
// A remote RPC's name/code/details cannot create an own Symbol data property.
// Keep this non-enumerable marker local; never infer dispatch proof from text.
const boundaryBrand = Symbol.for("opengeni.modal.command-start.boundary.v1");
type BoundaryKind = "pre-dispatch-unavailable" | "outcome-unknown";
const invocationBrand = Symbol.for("opengeni.modal.command-start.invocation.v1");
const contextBrand = Symbol.for("opengeni.modal.command-start.context.v1");
const startSignal = new AsyncLocalStorage<AbortSignal>();

export type ModalCommandStartInvocation = Readonly<{
  sandboxId: string;
  taskId: string;
  execId: string;
  /** Authenticated, bounded, read-only observation of these exact IDs. */
  observe: (
    signal?: AbortSignal,
    timeoutMs?: number,
  ) => Promise<{
    code?: number;
    signal?: number;
  }>;
}>;

export function withModalCommandStartSignal<T>(signal: AbortSignal, operation: () => T): T {
  signal.throwIfAborted();
  return startSignal.run(signal, operation);
}

/** Installed before lifecycle setup and shared by SDK hydration replacements.
 * Unpatched published SDK consumers simply ignore this optional own-symbol API. */
export function installModalCommandStartContext(modal: object): void {
  if (Object.getOwnPropertyDescriptor(modal, contextBrand)) return;
  Object.defineProperty(modal, contextBrand, { value: () => startSignal.getStore() });
}

export function modalCommandStartOwnData(value: object, key: PropertyKey): unknown {
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && "value" in property ? property.value : undefined;
}

export function modalCommandStartHasOwnAccessor(value: object, key: PropertyKey): boolean {
  const property = Object.getOwnPropertyDescriptor(value, key);
  return !!property && !("value" in property);
}

/** A wrapper cannot manufacture authority by invoking a getter or copying a
 * name/code/message. Conflicting invocations or an oversized graph fail closed. */
export function getModalCommandStartInvocation(error: unknown): ModalCommandStartInvocation | null {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  const seen = new WeakSet<object>();
  let result: ModalCommandStartInvocation | null = null;
  let inspected = 0;
  while (pending.length) {
    if (++inspected > 64) return null;
    const { value, depth } = pending.shift()!;
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    if (depth > 8) return null;
    seen.add(value);
    try {
      if (["cause", "error", "errors"].some((key) => modalCommandStartHasOwnAccessor(value, key)))
        return null;
      if (hasModalCommandStartBoundary(value, "outcome-unknown")) {
        const descriptor = modalCommandStartOwnData(value, invocationBrand);
        if (!descriptor || typeof descriptor !== "object" || !Object.isFrozen(descriptor))
          return null;
        const sandboxId = modalCommandStartOwnData(descriptor, "sandboxId");
        const taskId = modalCommandStartOwnData(descriptor, "taskId");
        const execId = modalCommandStartOwnData(descriptor, "execId");
        const observe = modalCommandStartOwnData(descriptor, "observe");
        if (
          typeof sandboxId !== "string" ||
          !sandboxId ||
          typeof taskId !== "string" ||
          !taskId ||
          typeof execId !== "string" ||
          !execId ||
          typeof observe !== "function"
        )
          return null;
        if (
          result &&
          (result.sandboxId !== sandboxId || result.taskId !== taskId || result.execId !== execId)
        )
          return null;
        result = descriptor as ModalCommandStartInvocation;
        continue;
      }
      const nested: unknown[] = [
        modalCommandStartOwnData(value, "cause"),
        modalCommandStartOwnData(value, "error"),
      ].filter((child) => child !== undefined);
      const errors = modalCommandStartOwnData(value, "errors");
      if (errors !== undefined) {
        if (!Array.isArray(errors) || errors.length > 32) return null;
        for (let index = 0; index < errors.length; index++) {
          if (modalCommandStartHasOwnAccessor(errors, String(index))) return null;
          nested.push(modalCommandStartOwnData(errors, String(index)));
        }
      }
      if (depth === 8 && nested.length) return null;
      for (const child of nested) pending.push({ value: child, depth: depth + 1 });
    } catch {
      return null;
    }
  }
  return result;
}

/** Convert only a genuine, unambiguous SDK boundary into the existing durable
 * command contract. No supervision receipt or local process handle is invented. */
export function modalCommandStartRetainedError(error: unknown): unknown {
  if (error instanceof ProviderCommandStartOutcomeUnknownError) return error;
  const invocation = getModalCommandStartInvocation(error);
  if (!invocation) return error;
  const cursor = () => ({ byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null });
  const command = ModalRouterProviderCommand.safeParse({
    kind: "modal-router-v1",
    sandboxId: invocation.sandboxId,
    taskId: invocation.taskId,
    execId: invocation.execId,
    streams: { stdout: cursor(), stderr: cursor() },
  });
  return command.success ? new ProviderCommandStartOutcomeUnknownError(command.data, error) : error;
}

export function hasModalCommandStartOutcomeUnknownBoundary(error: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  const seen = new WeakSet<object>();
  for (let inspected = 0; pending.length && inspected < 64; inspected++) {
    const { value, depth } = pending.shift()!;
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (hasModalCommandStartBoundary(value, "outcome-unknown")) return true;
    if (depth >= 8) continue;
    try {
      for (const key of ["cause", "error"]) {
        const nested = modalCommandStartOwnData(value, key);
        if (nested !== undefined) pending.push({ value: nested, depth: depth + 1 });
      }
      const errors = modalCommandStartOwnData(value, "errors");
      if (Array.isArray(errors))
        for (let index = 0; index < Math.min(errors.length, 32); index++)
          pending.push({
            value: modalCommandStartOwnData(errors, String(index)),
            depth: depth + 1,
          });
    } catch {
      // An inaccessible wrapper never grants replay or no-effect authority.
    }
  }
  return false;
}

export function installModalCommandStartRetention(session: object): void {
  // All SDK setup helpers converge below these surfaces. Intercept the shared
  // direct runner too so newly added SDK helpers inherit the durable boundary.
  for (const name of [
    "execCommand",
    "applyManifest",
    "materializeEntry",
    "hydrateWorkspace",
    "persistWorkspace",
    "runDirectCommand",
    "runAsCommandRunner",
  ]) {
    const operation = Reflect.get(session, name);
    if (typeof operation !== "function") continue;
    Reflect.set(session, name, async function (...args: unknown[]) {
      try {
        return await operation.apply(session, args);
      } catch (error) {
        throw modalCommandStartRetainedError(error);
      }
    });
  }
}

export function hasModalCommandStartBoundary(error: unknown, kind: BoundaryKind): boolean {
  if (!error || typeof error !== "object") return false;
  try {
    const property = Object.getOwnPropertyDescriptor(error, boundaryBrand);
    return (
      property?.value === kind && property.writable === false && property.configurable === false
    );
  } catch {
    return false;
  }
}

/** Owned by runtime so published consumers work with the unpatched Modal SDK. */
export class ModalCommandStartOutcomeUnknownError extends Error {
  constructor(
    readonly taskId: string,
    readonly execId: string,
    cause: unknown,
  ) {
    super("Modal command Start outcome unknown; do not replay this invocation", { cause });
    this.name = "CommandStartOutcomeUnknownError";
    Object.defineProperty(this, boundaryBrand, { value: "outcome-unknown" });
  }
}
