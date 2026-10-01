// Shared with the repository's SDK patch without importing its optional exports.
// A remote RPC's name/code/details cannot create an own Symbol data property.
// Keep this non-enumerable marker local; never infer dispatch proof from text.
const boundaryBrand = Symbol.for("opengeni.modal.command-start.boundary.v1");
type BoundaryKind = "pre-dispatch-unavailable" | "outcome-unknown";

export function hasModalCommandStartBoundary(error: unknown, kind: BoundaryKind): boolean {
  if (!error || typeof error !== "object") return false;
  try {
    return Object.getOwnPropertyDescriptor(error, boundaryBrand)?.value === kind;
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
