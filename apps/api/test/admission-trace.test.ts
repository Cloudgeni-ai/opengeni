import { expect, test } from "bun:test";
import {
  createObservability,
  withTraceContext,
  linkCurrentSpanToAdmission,
  admissionTraceContext,
} from "@opengeni/observability";
import { recordAcceptedApiAdmission } from "../src/admission-trace";

test("committed API admission and a separately scoped worker attempt share an explicit causal link", async () => {
  const exported: any[] = [];
  const settings = {
    serviceName: "test",
    environment: "test",
    observabilityStructuredLogs: false,
    observabilityMetricsEnabled: false,
    observabilityOtlpEndpoint: "http://collector",
    observabilityOtlpHeaders: "",
  };
  const exporter = async (_url: string, body: unknown) => {
    exported.push(body);
  };
  const api = createObservability(settings, { component: "api", exporter });
  const worker = createObservability(settings, { component: "worker", exporter });
  const accepted = { id: "84f6c938-01e3-4b46-b86d-8a242ae596ce" };
  const request = api.startSpan("HTTP POST /sessions/:id/events");
  withTraceContext(request, () => {
    recordAcceptedApiAdmission(api, { accepted, replay: false });
    recordAcceptedApiAdmission(api, { accepted, replay: true });
  });
  const attempt = worker.startSpan("worker.run_agent_segment", {}, { parent: null });
  withTraceContext(attempt, () => {
    linkCurrentSpanToAdmission(accepted.id);
    linkCurrentSpanToAdmission(accepted.id); // duplicate links are collapsed
    worker.startSpan("worker.model.call").end();
  });
  attempt.end();
  request.end();
  await Promise.all([api.flush(), worker.flush()]);
  const spans = exported.flatMap((body) =>
    body.resourceSpans.flatMap((r: any) => r.scopeSpans[0].spans),
  );
  const anchors = spans.filter((s) => s.name === "api.turn.admitted");
  expect(anchors).toHaveLength(1);
  expect(anchors[0].links).toEqual([{ traceId: request.traceId, spanId: request.spanId }]);
  expect(spans.find((s) => s.spanId === attempt.spanId).links).toEqual([
    { traceId: anchors[0].traceId, spanId: anchors[0].spanId },
  ]);
  expect(spans.find((s) => s.name === "worker.model.call").parentSpanId).toBe(attempt.spanId);
  expect(anchors[0].traceId).not.toBe(request.traceId);
  expect(JSON.stringify(exported)).not.toContain(accepted.id);
});

test("admission observers cannot fail committed HTTP responses", () => {
  expect(() =>
    recordAcceptedApiAdmission(
      {
        recordAdmissionTrace: () => {
          throw new Error("observer");
        },
      } as any,
      { accepted: { id: "x" }, replay: false },
    ),
  ).not.toThrow();
});

test("invalid or absent durable admission identities never mint links", () => {
  expect(admissionTraceContext("")).toBeUndefined();
  expect(admissionTraceContext("uncommitted-client-key")).toBeUndefined();
  const eventId = "84f6c938-01e3-4b46-b86d-8a242ae596ce";
  expect(admissionTraceContext(eventId)).toEqual(admissionTraceContext(eventId.toUpperCase()));
});

test("admission rejection before commit does not invoke the observer", async () => {
  let observed = 0;
  const submit = async () => {
    const result = await Promise.reject(new Error("rollback"));
    recordAcceptedApiAdmission(
      {
        recordAdmissionTrace: () => {
          observed++;
        },
      } as any,
      result,
    );
  };
  await expect(submit()).rejects.toThrow("rollback");
  expect(observed).toBe(0);
});
