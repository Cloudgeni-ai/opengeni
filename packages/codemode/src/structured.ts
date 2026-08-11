import type { AttemptToolResult } from "@opengeni/contracts";
import type { CodemodeCallOptions, CodemodeClient } from "./index";
import { environmentCodemodeClient, type CodemodeClientProvider } from "./environment";

export class CodemodeToolExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(readonly result: AttemptToolResult) {
    const error = toolError(result);
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
  if (result.isError) throw new CodemodeToolExecutionError(result);
  if (!result.structuredContent) {
    throw new Error(`Codemode tool ${path.join(".")} returned no structured content`);
  }
  return result.structuredContent as T;
}

function toolError(result: AttemptToolResult): {
  code: string;
  message: string;
  retryable: boolean;
} {
  const structured = result.structuredContent as
    | { error?: { code?: unknown; message?: unknown; retryable?: unknown } }
    | undefined;
  const error = structured?.error;
  return {
    code: typeof error?.code === "string" ? error.code : "tool_error",
    message: typeof error?.message === "string" ? error.message : "Codemode tool failed",
    retryable: error?.retryable === true,
  };
}
