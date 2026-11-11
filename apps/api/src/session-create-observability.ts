import { withTraceContext, type Observability, type Span } from "@opengeni/observability";

type SessionCreatePhase =
  | "authorization"
  | "body_read"
  | "site_origin"
  | "core_create"
  | "response_projection";

/** Content-free child boundaries within the existing HTTP request span. */
export async function measureSessionCreatePhase<T>(
  observability: Pick<Observability, "startSpan"> | null | undefined,
  phase: SessionCreatePhase,
  work: () => Promise<T>,
): Promise<T> {
  let span: Span | undefined;
  try {
    span = observability?.startSpan(`api.session_create.${phase}`);
  } catch {
    // Diagnostics cannot replace authenticated request authority.
  }
  const end = (outcome: "completed" | "failed") => {
    try {
      void Promise.resolve(span?.end({ attributes: { outcome } })).catch(() => undefined);
    } catch {
      // Do not export errors, request content, or credentials.
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
