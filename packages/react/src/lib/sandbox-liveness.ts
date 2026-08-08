/**
 * A sandbox is available for new I/O only after a holder has observed `warm`.
 *
 * `draining` means the holder count is zero and teardown owns the provider
 * instance. The provider may disappear before the durable lease reaches `cold`,
 * so treating `draining` as live races capture/termination. Explicit user intent
 * reacquires a holder; only its subsequent `warm` state re-enables live I/O.
 */
export function sandboxAcceptsLiveIo(liveness: string | null | undefined): boolean {
  return liveness === "warm";
}
