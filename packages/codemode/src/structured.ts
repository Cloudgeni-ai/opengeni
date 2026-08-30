import type { AttemptToolResult } from "@opengeni/contracts";
import { canonicalToolResultError, inspectCanonicalToolResult } from "@opengeni/tool-runtime";
import type { CodemodeCallOptions, CodemodeClient } from "./index";
import { environmentCodemodeClient, type CodemodeClientProvider } from "./environment";

export class CodemodeToolExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(readonly result: AttemptToolResult) {
    const error = canonicalToolResultError(result, "Codemode tool failed");
    super(error.message);
    this.name = "CodemodeToolExecutionError";
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

export function codemodeClientProvider(
  client: CodemodeClient | CodemodeClientProvider = () => environmentCodemodeClient(),
): CodemodeClientProvider {
  return typeof client === "function" ? client : () => client;
}

export async function callStructured<T>(
  client: CodemodeClientProvider,
  path: readonly string[],
  args: Record<string, unknown>,
  options: CodemodeCallOptions,
): Promise<T> {
  const result = await (await client()).callPath(path, args, options);
  const inspection = inspectCanonicalToolResult(result, {
    expectsStructured: true,
    errorFallbackMessage: "Codemode tool failed",
  });
  if (inspection.kind === "error") throw new CodemodeToolExecutionError(inspection.result);
  if (inspection.kind === "missing_structured") {
    throw new Error(`Codemode tool ${path.join(".")} returned no structured content`);
  }
  if (inspection.kind !== "structured") {
    throw new Error(`Codemode tool ${path.join(".")} returned no structured content`);
  }
  return inspection.value as T;
}
