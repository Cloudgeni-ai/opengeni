import { withTraceContext, type Observability, type Span } from "@opengeni/observability";

type SessionStartPhase =
  | "workspace_read"
  | "model_catalog_initial"
  | "default_model"
  | "model_catalog_effective"
  | "capability_settings"
  | "initiator_freeze"
  | "allowance"
  | "shell_insert"
  | "initialize"
  | "event_fanout"
  | "workflow_wake"
  | "session_reload";
export type SessionStartObservability = Pick<Observability, "startSpan">;

/** Content-free child spans around existing work; export is never joined and
 * diagnostic failures cannot alter the lifecycle or its exact error. */
export async function measureSessionStartPhase<T>(
  observability: SessionStartObservability | null | undefined,
  phase: SessionStartPhase,
  work: () => Promise<T>,
): Promise<T> {
  let span: Span | undefined;
  try {
    span = observability?.startSpan(`core.session_start.${phase}`);
  } catch {
    // An unhealthy observer is not session authority.
  }
  const end = (outcome: "completed" | "failed") => {
    try {
      void Promise.resolve(span?.end({ attributes: { outcome } })).catch(() => undefined);
    } catch {
      // Never leak diagnostic errors or user content through an error field.
    }
  };
  try {
    const result = span ? withTraceContext(span, work) : work();
    if (!span) return result;
    return result.then(
      (value) => {
        end("completed");
        return value;
      },
      (error) => {
        end("failed");
        throw error;
      },
    );
  } catch (error) {
    end("failed");
    throw error;
  }
}
