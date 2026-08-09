import type { TerminalCapability } from "@opengeni/sdk";

/** Whether an explicit viewer grant can upgrade this cell to a real PTY.
 * Keep acquisition feasibility separate from the current transport: a cold
 * real-PTY backend reports sse-events until the just-in-time grant warms it. */
export function terminalCanAcquirePty(cell: TerminalCapability | null | undefined): boolean {
  if (!cell?.ptyCapable) return false;
  if (cell.transport === "pty-ws") return true;
  return cell.reason === "lease_cold" || cell.reason === "not_provisioned";
}
