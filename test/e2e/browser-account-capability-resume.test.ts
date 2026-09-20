import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import type { Page } from "playwright";
import {
  consumeCapabilityResumeRead,
  observeCapabilityResume,
  type CapabilityResumeEvidence,
} from "./browser-account-capability-resume";

const expected = {
  url: "https://example.test/v1/workspaces/workspace/sessions/session/stream-capabilities",
  actorEpoch: "actor-2",
  authorityHash: "current-authority",
  phase: "slot-revocation-reauthentication",
};
function permitsCapabilityResumeRead(
  input: CapabilityResumeEvidence,
  expectedInput: Parameters<typeof consumeCapabilityResumeRead>[1] = expected,
) {
  return consumeCapabilityResumeRead(input, expectedInput, new Set()) !== null;
}
function evidence(): CapabilityResumeEvidence {
  return {
    sameDocument: true,
    ambiguousVisibility: false,
    pageshows: [],
    openedAt: 100,
    closedAt: 4_000,
    resumes: [{ hiddenAt: 500, visibleAt: 2_600 }],
    reads: [200, 300, 2_641].map((startedAt) => ({
      id: `request-${startedAt}`,
      failed: false,
      method: "GET",
      url: expected.url,
      actorEpoch: expected.actorEpoch,
      authorityHash: expected.authorityHash,
      dispatchPhase: expected.phase,
      responsePhase: expected.phase,
      startedAt,
      finishedAt: startedAt + 10,
      status: 404,
    })),
  };
}

test("one bounded resumed negotiation explains exactly one extra denied read", () => {
  expect(permitsCapabilityResumeRead(evidence(), expected)).toBe(true);
});

test("the matched request is single-use and pageshow timer resets fail closed", () => {
  const consumed = new Set<string>();
  expect(consumeCapabilityResumeRead(evidence(), expected, consumed)).toBe("request-2641");
  expect(consumeCapabilityResumeRead(evidence(), expected, consumed)).toBeNull();
  const reset = evidence();
  reset.pageshows.push(1_000);
  expect(permitsCapabilityResumeRead(reset)).toBe(false);
  const ambiguous = evidence();
  ambiguous.ambiguousVisibility = true;
  expect(permitsCapabilityResumeRead(ambiguous)).toBe(false);
  const failed = evidence();
  failed.reads[2]!.failed = true;
  expect(permitsCapabilityResumeRead(failed)).toBe(false);
  const inverted = evidence();
  inverted.closedAt = inverted.openedAt - 1;
  expect(permitsCapabilityResumeRead(inverted)).toBe(false);
  const nullBoth = evidence();
  for (const read of nullBoth.reads) read.authorityHash = null;
  expect(
    consumeCapabilityResumeRead(nullBoth, { ...expected, authorityHash: null }, new Set()),
  ).toBeNull();
});

test("extra read without an observed resume remains forbidden", () => {
  const input = evidence();
  input.resumes = [];
  expect(permitsCapabilityResumeRead(input, expected)).toBe(false);
});

test("document changes, short grace, duplicate resumes and stale windows fail closed", () => {
  for (const mutate of [
    (e: CapabilityResumeEvidence) => {
      e.sameDocument = false;
    },
    (e: CapabilityResumeEvidence) => {
      e.resumes[0]!.hiddenAt = 601;
    },
    (e: CapabilityResumeEvidence) => {
      e.resumes.push({ ...e.resumes[0]! });
    },
    (e: CapabilityResumeEvidence) => {
      e.resumes[0]!.hiddenAt = 99;
    },
    (e: CapabilityResumeEvidence) => {
      e.closedAt = 2_599;
    },
    (e: CapabilityResumeEvidence) => {
      e.closedAt = Number.NaN;
    },
    (e: CapabilityResumeEvidence) => {
      e.openedAt = Number.NaN;
    },
    (e: CapabilityResumeEvidence) => {
      e.resumes[0]!.visibleAt = Number.NaN;
    },
    (e: CapabilityResumeEvidence) => {
      e.reads[2]!.startedAt = 3_601;
      e.reads[2]!.finishedAt = 3_610;
    },
  ]) {
    const input = evidence();
    mutate(input);
    expect(permitsCapabilityResumeRead(input, expected)).toBe(false);
  }
});

test("denied reads retain exact path, phase, actor, authority and successful terminal fences", () => {
  for (const patch of [
    { method: "POST" },
    { url: `${expected.url}?unexpected=1` },
    { url: expected.url.replace("/workspace/", "/other/") },
    { url: expected.url.replace("/session/", "/other/") },
    { status: 403 },
    { status: 200 },
    { status: null },
    { actorEpoch: "old-actor" },
    { actorEpoch: null },
    { authorityHash: "old-authority" },
    { authorityHash: null },
    { dispatchPhase: "cross-slot-deep-link" },
    { responsePhase: "logout-one" },
    { responsePhase: null },
    { startedAt: 99 },
    { startedAt: Number.NaN },
    { finishedAt: null },
    { finishedAt: 4_001 },
    { finishedAt: 1 },
  ]) {
    const input = evidence();
    Object.assign(input.reads[2]!, patch);
    expect(permitsCapabilityResumeRead(input, expected)).toBe(false);
  }
  expect(permitsCapabilityResumeRead(evidence(), { ...expected, authorityHash: null })).toBe(false);
  expect(permitsCapabilityResumeRead(evidence(), { ...expected, phase: "logout-one" })).toBe(false);
});

test("a resume cannot excuse a request loop, two resumed reads, or incomplete baseline reads", () => {
  const extra = evidence();
  extra.reads.push({ ...extra.reads[2]!, id: "fourth-read" });
  expect(permitsCapabilityResumeRead(extra, expected)).toBe(false);
  const twoResumed = evidence();
  twoResumed.reads[1] = { ...twoResumed.reads[2]!, id: "second-resumed-read" };
  expect(permitsCapabilityResumeRead(twoResumed, expected)).toBe(false);
  const missing = evidence();
  missing.reads.shift();
  expect(permitsCapabilityResumeRead(missing, expected)).toBe(false);
  const noResumed = evidence();
  noResumed.reads[2]!.startedAt = 400;
  expect(permitsCapabilityResumeRead(noResumed, expected)).toBe(false);
});

test("observer seals document identity after delayed authority reads, failing closed on navigation", async () => {
  for (const outcome of ["intact", "replaced", "evaluation-error"] as const) {
    let now = 100;
    let rejectEvaluation = false;
    const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const realm = {
      document,
      window: Object.assign(new EventTarget(), {}),
      Date: { now: () => now },
    };
    const page = Object.assign(new EventEmitter(), {
      evaluate: async (fn: Function, argument: unknown) => {
        if (rejectEvaluation) throw new Error("document replaced during evaluation");
        return runInNewContext(`(${fn.toString()})(argument)`, { ...realm, argument });
      },
    });
    const observer = await observeCapabilityResume(page as unknown as Page, {
      url: expected.url,
      phase: () => expected.phase,
      actorEpochHeader: "actor",
      hashAuthority: (cookie) => cookie,
    });
    let resolveHeaders!: (value: string) => void;
    const delayedHeaders = new Promise<string>((resolve) => {
      resolveHeaders = resolve;
    });
    const read = (startedAt: number, headers: Promise<string>) => {
      const request = {
        url: () => expected.url,
        method: () => "GET",
        headers: () => ({ actor: expected.actorEpoch }),
        headerValue: () => headers,
        timing: () => ({ startTime: startedAt, responseEnd: 10 }),
      };
      page.emit("request", request);
      page.emit("response", { request: () => request, status: () => 404 });
      page.emit("requestfinished", request);
    };
    read(200, Promise.resolve(expected.authorityHash));
    read(300, Promise.resolve(expected.authorityHash));
    now = 500;
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    now = 2_600;
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    read(2_641, delayedHeaders);
    now = 4_000;
    const finishing = observer.finish();
    // This yields through the old implementation's premature snapshot and
    // guarantees replacement occurs while the request-header read is pending.
    await Promise.resolve();
    if (outcome === "replaced") realm.window = new EventTarget();
    if (outcome === "evaluation-error") rejectEvaluation = true;
    resolveHeaders(expected.authorityHash);
    const captured = await finishing;
    expect(captured.sameDocument).toBe(outcome === "intact");
    expect(consumeCapabilityResumeRead(captured, expected, new Set()) !== null).toBe(
      outcome === "intact",
    );
    expect(page.listenerCount("request")).toBe(0);
    expect(page.listenerCount("requestfinished")).toBe(0);
    expect(page.listenerCount("requestfailed")).toBe(0);
  }
});
