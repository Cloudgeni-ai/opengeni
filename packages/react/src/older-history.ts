/**
 * Await-compatible older-history result with a causal commit receipt.
 *
 * `committed` flips synchronously before the accepted older window is exposed
 * to React. Forward this exact object through component wrappers; replacing it
 * with `void` or a plain promise drops the pagination direction receipt.
 */
export type OlderHistoryLoadReceipt = Promise<boolean> & {
  readonly committed: boolean;
};

/** Public callback contract shared by useSessionEvents and MessageTimeline. */
export type OlderHistoryLoader = () => OlderHistoryLoadReceipt;

type MutableOlderHistoryLoadReceipt = Promise<boolean> & {
  committed: boolean;
};

type OlderHistoryReceiptCapture = (receipt: OlderHistoryLoadReceipt) => void;

let activeReceiptCapture: OlderHistoryReceiptCapture | undefined;

/** Bind a receipt before a synchronous forwarding stack can publish state. */
export function invokeOlderHistoryLoaderWithReceiptCapture(
  load: OlderHistoryLoader,
  capture: OlderHistoryReceiptCapture,
): unknown {
  activeReceiptCapture = capture;
  try {
    return load();
  } finally {
    activeReceiptCapture = undefined;
  }
}

/**
 * Build an await-compatible older-history receipt for custom timeline hosts.
 * Call `markCommitted` immediately before publishing an accepted older window.
 */
export function createOlderHistoryLoadReceipt(
  load: (markCommitted: () => void) => boolean | Promise<boolean>,
): OlderHistoryLoadReceipt {
  let resolveResult!: (value: boolean | PromiseLike<boolean>) => void;
  let rejectResult!: (reason?: unknown) => void;
  const result = new Promise<boolean>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  }) as MutableOlderHistoryLoadReceipt;
  result.committed = false;
  activeReceiptCapture?.(result);
  try {
    const loaded = load(() => {
      result.committed = true;
    });
    Promise.resolve(loaded).then(resolveResult, rejectResult);
  } catch (error) {
    rejectResult(error);
  }
  return result;
}
