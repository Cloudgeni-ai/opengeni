import type { Page, Request, Response } from "playwright";

const PHASE = "slot-revocation-reauthentication";
// Match usePageLiveActivity's hidden-page grace. A shorter disappearance never
// suspends the capability lifecycle and cannot authorize another negotiation.
const HIDDEN_GRACE_MS = 2_000;
const RESUME_REQUEST_WINDOW_MS = 1_000;

export type CapabilityResumeRead = {
  id: string;
  failed: boolean;
  method: string;
  url: string;
  actorEpoch: string | null;
  authorityHash: string | null;
  dispatchPhase: string;
  responsePhase: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: number | null;
};

export type CapabilityResumeEvidence = {
  sameDocument: boolean;
  ambiguousVisibility: boolean;
  pageshows: number[];
  openedAt: number;
  closedAt: number;
  resumes: Array<{ hiddenAt: number; visibleAt: number }>;
  reads: CapabilityResumeRead[];
};

export function consumeCapabilityResumeRead(
  evidence: CapabilityResumeEvidence,
  expected: { url: string; actorEpoch: string; authorityHash: string | null; phase: string },
  consumedRequestIds: Set<string>,
): string | null {
  if (
    !evidence.sameDocument ||
    evidence.ambiguousVisibility ||
    evidence.pageshows.length !== 0 ||
    expected.phase !== PHASE ||
    !expected.authorityHash ||
    !expected.actorEpoch ||
    !Number.isFinite(evidence.openedAt) ||
    !Number.isFinite(evidence.closedAt) ||
    evidence.closedAt < evidence.openedAt ||
    evidence.resumes.length !== 1 ||
    evidence.reads.length !== 3 ||
    new Set(evidence.reads.map((read) => read.id)).size !== 3
  )
    return null;
  const resume = evidence.resumes[0]!;
  if (
    !Number.isFinite(resume.hiddenAt) ||
    !Number.isFinite(resume.visibleAt) ||
    resume.hiddenAt < evidence.openedAt ||
    resume.visibleAt > evidence.closedAt ||
    resume.visibleAt - resume.hiddenAt < HIDDEN_GRACE_MS
  )
    return null;
  if (
    !evidence.reads.every(
      (read) =>
        Boolean(read.id) &&
        !read.failed &&
        !consumedRequestIds.has(read.id) &&
        read.method === "GET" &&
        read.url === expected.url &&
        read.status === 404 &&
        read.actorEpoch === expected.actorEpoch &&
        read.authorityHash === expected.authorityHash &&
        read.dispatchPhase === PHASE &&
        read.responsePhase === PHASE &&
        Number.isFinite(read.startedAt) &&
        read.startedAt >= evidence.openedAt &&
        read.finishedAt !== null &&
        Number.isFinite(read.finishedAt) &&
        read.finishedAt >= read.startedAt &&
        read.finishedAt <= evidence.closedAt,
    )
  )
    return null;
  const afterResume = evidence.reads.filter((read) => read.startedAt >= resume.visibleAt);
  if (
    afterResume.length !== 1 ||
    afterResume[0]!.startedAt - resume.visibleAt > RESUME_REQUEST_WINDOW_MS
  )
    return null;
  const id = afterResume[0]!.id;
  consumedRequestIds.add(id);
  return id;
}

/** Observe only: no routing, request substitution, visibility changes, or retries. */
export async function observeCapabilityResume(
  page: Page,
  input: {
    url: string;
    phase: () => string;
    actorEpochHeader: string;
    hashAuthority: (cookie: string | null) => string | null;
  },
): Promise<{ finish: () => Promise<CapabilityResumeEvidence>; dispose: () => Promise<void> }> {
  const key = `__capabilityResume_${crypto.randomUUID().replaceAll("-", "")}`;
  const reads = new Map<Request, CapabilityResumeRead>();
  const authorities: Promise<void>[] = [];
  const requestListener = (request: Request) => {
    // Include query-bearing and wrong-method requests to the exact path so
    // neither can be mistaken for the expected authenticated GET.
    const url = new URL(request.url());
    if (url.origin + url.pathname !== input.url) return;
    const read: CapabilityResumeRead = {
      id: crypto.randomUUID(),
      failed: false,
      method: request.method(),
      url: request.url(),
      actorEpoch: request.headers()[input.actorEpochHeader] ?? null,
      authorityHash: null,
      dispatchPhase: input.phase(),
      responsePhase: null,
      startedAt: Number.NaN,
      finishedAt: null,
      status: null,
    };
    reads.set(request, read);
    authorities.push(
      request.headerValue("cookie").then(
        (cookie) => {
          read.authorityHash = input.hashAuthority(cookie);
        },
        () => {},
      ),
    );
  };
  const responseListener = (response: Response) => {
    const read = reads.get(response.request());
    if (read) {
      read.status = response.status();
      read.responsePhase = input.phase();
    }
  };
  const finishedListener = (request: Request) => {
    const read = reads.get(request);
    if (read) {
      // Playwright timing is browser-origin Unix milliseconds + relative
      // responseEnd. Compare with browser Date.now, never runner performance.now.
      const timing = request.timing();
      read.startedAt = timing.startTime;
      read.finishedAt = timing.responseEnd < 0 ? null : timing.startTime + timing.responseEnd;
    }
  };
  const failedListener = (request: Request) => {
    const read = reads.get(request);
    if (read) read.failed = true;
  };
  const openedAt = await page.evaluate((key) => {
    const openedAt = Date.now();
    let hiddenAt: number | null = null;
    const resumes: Array<{ hiddenAt: number; visibleAt: number }> = [];
    const pageshows: number[] = [];
    const state = {
      resumes,
      pageshows,
      ambiguousVisibility: document.visibilityState === "hidden",
      stop: () => {
        document.removeEventListener("visibilitychange", observe);
        window.removeEventListener("pageshow", pageshow);
      },
    };
    const observe = () => {
      if (document.visibilityState === "hidden") {
        // Another hidden event resets the product timer; don't infer a
        // suspension by stitching together ambiguous intervals.
        if (hiddenAt !== null) state.ambiguousVisibility = true;
        hiddenAt = Date.now();
      } else if (hiddenAt !== null) {
        resumes.push({ hiddenAt, visibleAt: Date.now() });
        hiddenAt = null;
      }
    };
    const pageshow = () => pageshows.push(Date.now());
    document.addEventListener("visibilitychange", observe);
    window.addEventListener("pageshow", pageshow);
    (window as unknown as Record<string, unknown>)[key] = state;
    return openedAt;
  }, key);
  page.on("request", requestListener);
  page.on("response", responseListener);
  page.on("requestfinished", finishedListener);
  page.on("requestfailed", failedListener);
  const detach = () => {
    page.off("request", requestListener);
    page.off("response", responseListener);
    page.off("requestfinished", finishedListener);
    page.off("requestfailed", failedListener);
  };
  const dispose = async () => {
    detach();
    await page
      .evaluate((key) => {
        const state = (window as unknown as Record<string, { stop: () => void }>)[key];
        state?.stop();
        delete (window as unknown as Record<string, unknown>)[key];
      }, key)
      .catch(() => {});
  };
  return {
    dispose,
    finish: async () => {
      // Headers may settle across a navigation. Resolve them before sealing
      // the document/lifecycle evidence, never after approving its identity.
      await Promise.race([
        Promise.all(authorities),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      const snapshot = await page
        .evaluate((key) => {
          const state = (
            window as unknown as Record<
              string,
              {
                resumes: Array<{ hiddenAt: number; visibleAt: number }>;
                pageshows: number[];
                ambiguousVisibility: boolean;
                stop: () => void;
              }
            >
          )[key];
          state?.stop();
          delete (window as unknown as Record<string, unknown>)[key];
          return {
            sameDocument: Boolean(state),
            ambiguousVisibility: state?.ambiguousVisibility ?? true,
            pageshows: state?.pageshows ?? [],
            resumes: state?.resumes ?? [],
            closedAt: Date.now(),
          };
        }, key)
        .catch(() => ({
          sameDocument: false,
          ambiguousVisibility: true,
          pageshows: [],
          resumes: [],
          closedAt: Number.NaN,
        }));
      // No awaited work after the final browser seal. Later console errors
      // remain in the ordinary strict ledger, not in this earned allowance.
      detach();
      return { ...snapshot, openedAt, reads: [...reads.values()].map((read) => ({ ...read })) };
    },
  };
}
