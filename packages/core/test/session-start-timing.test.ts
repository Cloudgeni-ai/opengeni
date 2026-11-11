import { expect, test } from "bun:test";
import { currentTraceContext, withTraceContext, type Span } from "@opengeni/observability";
import { measureSessionStartPhase } from "../src/domain/session-start-timing";

const parent = { traceId: "1".repeat(32), spanId: "2".repeat(16) };

function observer(end: Span["end"] = () => undefined) {
  const names: string[] = [];
  const span: Span = { ...parent, spanId: "3".repeat(16), end };
  return {
    span,
    names,
    startSpan(name: string) {
      names.push(name);
      return span;
    },
  };
}

test("held work stays held; child context and completed outcome contain no content", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const endings: Parameters<Span["end"]>[0][] = [];
  const o = observer((input) => {
    endings.push(input);
  });
  const value = { privateContent: "not telemetry" };
  let completed = false;
  const running = withTraceContext(parent, () =>
    measureSessionStartPhase(o, "initialize", async () => {
      expect(currentTraceContext()).toEqual({ traceId: o.span.traceId, spanId: o.span.spanId });
      await held;
      expect(currentTraceContext()?.spanId).toBe(o.span.spanId);
      return value;
    }),
  ).then((result) => {
    completed = true;
    return result;
  });
  try {
    expect(o.names).toEqual(["core.session_start.initialize"]);
    expect(endings).toEqual([]);
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(currentTraceContext()).toBeUndefined();
  } finally {
    release();
  }
  expect(await running).toBe(value);
  expect(endings).toEqual([{ attributes: { outcome: "completed" } }]);
  expect(JSON.stringify(endings)).not.toContain("privateContent");
});

test("sync and async work failures retain exact identity without exporting the error", async () => {
  const failure = new Error("private failure text");
  const endings: Parameters<Span["end"]>[0][] = [];
  const o = observer((input) => {
    endings.push(input);
  });
  for (const work of [
    () => {
      throw failure;
    },
    async () => {
      throw failure;
    },
  ]) {
    try {
      await measureSessionStartPhase(o, "event_fanout", work);
    } catch (error) {
      expect(error).toBe(failure);
    }
  }
  expect(endings).toEqual([
    { attributes: { outcome: "failed" } },
    { attributes: { outcome: "failed" } },
  ]);
  expect(JSON.stringify(endings)).not.toContain("private failure");
});

test("missing or failed observer preserves existing parent context and dependency", async () => {
  const failure = new Error("observer unavailable");
  const broken = {
    startSpan: () => {
      throw failure;
    },
  };
  const value = {};
  for (const o of [undefined, null, broken]) {
    expect(
      await withTraceContext(parent, () =>
        measureSessionStartPhase(o, "session_reload", async () => {
          expect(currentTraceContext()).toEqual(parent);
          return value;
        }),
      ),
    ).toBe(value);
  }
});

test("export failures and never-settling exporter promises are not lifecycle joins", async () => {
  const failure = new Error("original dependency");
  for (const end of [
    () => {
      throw new Error("exporter");
    },
    async () => {
      throw new Error("async exporter");
    },
    () => new Promise<void>(() => undefined),
  ]) {
    const o = observer(end);
    expect(await measureSessionStartPhase(o, "workflow_wake", async () => "accepted")).toBe(
      "accepted",
    );
    await expect(
      measureSessionStartPhase(o, "workflow_wake", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  }
});

test("interleaved phase scopes never inherit each other's child context", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = observer();
  const fast = observer();
  fast.span.spanId = "4".repeat(16);
  const running = measureSessionStartPhase(slow, "event_fanout", async () => {
    await held;
    return currentTraceContext()?.spanId;
  });
  try {
    expect(
      await measureSessionStartPhase(
        fast,
        "workflow_wake",
        async () => currentTraceContext()?.spanId,
      ),
    ).toBe(fast.span.spanId);
    expect(currentTraceContext()).toBeUndefined();
  } finally {
    release();
  }
  expect(await running).toBe(slow.span.spanId);
});
