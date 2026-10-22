import type { Page, Route } from "playwright";

/** Preserve Chromium request headers before a deliberate document-replacement race. */
export async function observeChromiumNeutralSessionSetRequestAuthority(
  page: Page,
  origin: string,
): Promise<() => Promise<void>> {
  // This is a Chromium observation seam, not a portable cookie-access API.
  // Other engines keep their ordinary request lifecycle and the same strict
  // failure/quiescence ledger; missing authority must still fail closed.
  if (page.context().browser()?.browserType().name() !== "chromium") return async () => {};
  const matches = (url: URL) => url.origin === origin && url.pathname === "/v1/auth/session-set";
  // Chromium normally attaches full headers only once response metadata arrives.
  // A destroyed document can leave neither that metadata nor a terminal event.
  // Native pass-through interception supplies the actual request's headers at
  // dispatch; never substitute the context's later cookie or infer authority.
  const forward = (route: Route) => route.continue();
  await page.route(matches, forward);
  return () => page.unroute(matches, forward);
}

/**
 * Which main-frame document issued each request.
 *
 * Replacing a document (a reload or any other navigation) takes down every
 * request it still has in flight, and browsers report that differently:
 * Chromium reports nothing at all (the cancellation never reaches DevTools,
 * so Playwright emits neither `requestfinished` nor `requestfailed`), while
 * WebKit and Firefox report a cancellation, WebKit already when the replacing
 * navigation starts. A ledger that waits for every request to end therefore
 * closes a replaced document's requests itself and accepts their cancellation.
 *
 * A new document commits when the main frame navigates to the URL of the
 * pending document request after that request received its response; any
 * other main-frame navigation (history API) keeps the same document.
 */
export class DocumentRequestLedger {
  #document = 0;
  #navigations = 0;
  #pending: { request: object; url: string; responded: boolean } | null = null;
  readonly #issuedBy = new WeakMap<object, number>();
  readonly #navigationOrder = new WeakMap<object, number>();

  /** Record a request; `documentRequestUrl` is set for a main-frame document request. */
  request(request: object, documentRequestUrl: string | null): void {
    if (documentRequestUrl === null) {
      this.#issuedBy.set(request, this.#document);
      return;
    }
    this.#navigations += 1;
    this.#navigationOrder.set(request, this.#navigations);
    this.#pending = { request, url: withoutFragment(documentRequestUrl), responded: false };
  }

  response(request: object): void {
    if (this.#pending?.request === request) this.#pending.responded = true;
  }

  failed(request: object): void {
    if (this.#pending?.request === request) this.#pending = null;
  }

  /** The main frame navigated to `url`; true when that committed a new document. */
  mainFrameNavigated(url: string): boolean {
    const pending = this.#pending;
    if (!pending?.responded || pending.url !== withoutFragment(url)) return false;
    this.#pending = null;
    this.#document += 1;
    return true;
  }

  /**
   * Whether `request` can no longer reach any document: its document has been
   * replaced, or it is a document request a later navigation superseded.
   */
  replaced(request: object): boolean {
    const order = this.#navigationOrder.get(request);
    if (order !== undefined) return order < this.#navigations;
    const issuedBy = this.#issuedBy.get(request);
    return issuedBy !== undefined && issuedBy < this.#document;
  }

  /** Whether a pending document navigation is replacing the document that issued `request`. */
  replacing(request: object): boolean {
    return this.#pending !== null && this.#issuedBy.get(request) === this.#document;
  }
}

/**
 * Whether a navigation replacing its document took down `request`, which the
 * browser reported as cancelled. WebKit (always) and Firefox (usually) report
 * that cancellation before Playwright delivers the replacing navigation's
 * document request, both for a superseded document request and for the
 * outgoing document's in-flight reads. Usually one protocol round trip
 * delivers that navigation, but Firefox reports network events from its parent
 * process, which a round trip to the page does not order. So keep making round
 * trips until the navigation arrives or `evidenceWindowMs` passes; a
 * cancellation no navigation explains within that window stays unexplained.
 */
export async function cancelledWithReplacedDocument(
  ledger: DocumentRequestLedger,
  request: object,
  replacedOrReplacingBeforeFailure: boolean,
  nextProtocolRoundTrip: () => Promise<unknown>,
  evidenceWindowMs = 2_000,
): Promise<boolean> {
  if (replacedOrReplacingBeforeFailure || ledger.replaced(request)) return true;
  const deadline = performance.now() + evidenceWindowMs;
  for (;;) {
    await nextProtocolRoundTrip().catch(() => undefined);
    if (ledger.replaced(request) || ledger.replacing(request)) return true;
    if (performance.now() >= deadline) return false;
    await Bun.sleep(10);
  }
}

/** A browser's own cancellation of a request, as opposed to a transport or server failure. */
export function isBrowserCancellation(failure: string): boolean {
  return /^(?:(?:net::)?ERR_ABORTED|NS_BINDING_ABORTED|NS_ERROR_ABORT|Load request cancelled|(?:request (?:was )?)?(?:cancelled|canceled))$/iu.test(
    failure.trim(),
  );
}

function withoutFragment(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.href;
}
