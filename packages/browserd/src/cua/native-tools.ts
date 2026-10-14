import {
  CUA_DESKTOP_TOOLS,
  CUA_LINUX_DESKTOP_TOOLS,
  ComputerNativeResult,
  type ComputerNativeCallRequest,
} from "@opengeni/contracts";
import { ComputerBackendError } from "../computer-backend";
import type { CuaDesktopRuntime } from "./wire";

/** Per-worker immutable inventory; do not start a desktop during agent preparation. */
export class CuaNativeTools {
  private catalog: Promise<Map<string, Record<string, unknown>>> | undefined;
  constructor(
    private readonly runtime: CuaDesktopRuntime,
    private readonly session: string,
    private readonly platform: "macos" | "windows" | "linux" = "macos",
  ) {}

  async validate(request: ComputerNativeCallRequest): Promise<void> {
    const definitions = this.platform === "linux" ? CUA_LINUX_DESKTOP_TOOLS : CUA_DESKTOP_TOOLS;
    const definition = definitions.find((tool) => tool.name === request.tool);
    if (!definition || !this.runtime.listToolsJson)
      throw new ComputerBackendError(
        "unsupported",
        "This CUA desktop tool is unavailable",
        false,
        false,
      );
    // Every batch step inherits this controller's private session. No caller may
    // select another session, including through a nested action/observation.
    const rejectSession = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Object.hasOwn(value, "session"))
        throw new ComputerBackendError(
          "invalid_action",
          "CUA session is owned by ComputerSession",
          false,
          false,
        );
      for (const child of Object.values(value)) rejectSession(child);
    };
    rejectSession(request.arguments);
    this.catalog ??= this.runtime.listToolsJson().then((raw) => {
      const inventory = JSON.parse(raw) as {
        tools: Array<Record<string, unknown> & { name: string }>;
      };
      return new Map(inventory.tools.map((tool) => [tool.name, tool]));
    });
    const actual = (await this.catalog).get(request.tool);
    if (
      !actual ||
      canonical(actual.inputSchema) !== canonical(definition.inputSchema) ||
      canonical(actual.outputSchema) !== canonical(definition.outputSchema)
    )
      throw new ComputerBackendError(
        "unsupported",
        "CUA tool schema differs from this release; update the matching runtime",
        false,
        false,
      );
  }

  async call(request: ComputerNativeCallRequest) {
    await this.validate(request);
    const sdk = await this.runtime.callTool(
      request.tool,
      JSON.stringify({ ...request.arguments, session: this.session }),
    );
    // Preserve MCP content exactly. SDK convenience fields are lossy projections.
    const result = ComputerNativeResult.shape.result.parse(JSON.parse(sdk.rawJson));
    const data = result.structuredContent as Record<string, unknown> | undefined;
    const effect = data?.effect ?? sdk.action?.effect;
    const refused = effect === "refused" || data?.status === "refused";
    const uncertain =
      effect === "partial" || effect === "suspected_noop" || (sdk.isError && !refused);
    const outcome = refused
      ? ("failed" as const)
      : uncertain
        ? ("outcome_unknown" as const)
        : ("completed" as const);
    return {
      result,
      outcome,
      error:
        outcome === "completed"
          ? null
          : {
              code: refused ? ("invalid_action" as const) : ("driver_failed" as const),
              message: refused
                ? "CUA refused the operation; see its original result"
                : "CUA did not confirm the full operation; see its original result",
              retryable: false,
            },
    };
  }
}

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
