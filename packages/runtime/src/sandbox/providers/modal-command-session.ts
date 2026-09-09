import { randomUUID } from "node:crypto";
import { truncateOutput } from "@openai/agents-core/sandbox/internal";
import type { ChannelASession } from "../channel-a";
import { markTypedExecHandleLoss } from "../exec-banner";
import { ModalProcessObservationUnavailableError } from "../errors";
import {
  admittedProviderCommandHandle,
  type ProviderCommandOutput,
  type ProviderCommandPersistence,
  type ProviderCommandSession,
} from "../provider-command-session";
import { ModalCommandControl, type ModalProviderCommand } from "./modal-command-control";

type Entry = {
  command: ModalProviderCommand;
  persistence?: ProviderCommandPersistence;
};

function sameExecution(a: ModalProviderCommand, b: ModalProviderCommand): boolean {
  return a.sandboxId === b.sandboxId && a.taskId === b.taskId && a.execId === b.execId;
}

/** Bridges the SDK's numeric/banner surface to provider-owned execution
 * locators. The local maps are only caches: a fresh adapter can adopt the same
 * handle from protected persistence and replay any unacknowledged page. */
export function installModalCommandSession(
  session: ProviderCommandSession & {
    execCommand?: ChannelASession["execCommand"];
    writeStdin?: ChannelASession["writeStdin"];
  },
  control: ModalCommandControl,
): void {
  markTypedExecHandleLoss(session);
  const originalExec = session.execCommand?.bind(session);
  const entries = new Map<number, Entry>();
  const receipts = new Map<string, { handle: number; page: ProviderCommandOutput }>();

  const formatPage = (
    handle: number,
    page: ProviderCommandOutput,
    maxOutputTokens?: number,
  ): string => {
    const result = [
      `Provider output receipt: ${randomUUID()}`,
      page.exitCode === null
        ? `Process running with session ID ${handle}`
        : `Process exited with code ${page.exitCode}`,
      "Output:",
      truncateOutput(page.chunks.map((chunk) => chunk.text).join(""), maxOutputTokens).text,
    ].join("\n");
    if (page.exitCode === null || entries.get(handle)?.persistence) {
      receipts.set(result, { handle, page });
    } else {
      entries.delete(handle);
    }
    return result;
  };
  const read = async (
    handle: number,
    entry: Entry,
    yieldTimeMs: number,
    maxOutputTokens?: number,
  ): Promise<string> => {
    if (entry.persistence) {
      const retained = await entry.persistence.load();
      if (!retained || !sameExecution(entry.command, retained))
        throw new Error("Original Modal command identity is unavailable");
      entry.command = retained;
    }
    const page = await control.read(entry.command, yieldTimeMs);
    // The receipt is generated here, not parsed from command output. Its only
    // purpose is correlating this return value with a trusted in-memory page.
    return formatPage(handle, page, maxOutputTokens);
  };

  session.execCommand = async (args) => {
    const handle = admittedProviderCommandHandle();
    // SDK-internal setup/readiness commands have no mutation admission. They
    // retain their existing foreground path and never publish durable handles.
    if (handle === undefined) {
      if (!originalExec) throw new Error("Modal command requires mutation admission");
      return originalExec(args);
    }
    if (entries.has(handle)) throw new Error("Modal command handle is already bound");
    const entry = { command: await control.start(args) };
    entries.set(handle, entry);
    try {
      return await read(handle, entry, args.yieldTimeMs ?? 10000, args.maxOutputTokens);
    } catch {
      // Start succeeded. A failed first observation must still publish the
      // known locator for retention, never lose it or replay the command.
      return formatPage(handle, { command: entry.command, chunks: [], exitCode: null });
    }
  };

  session.getProviderCommand = (handle) => {
    const entry = entries.get(handle);
    return entry ? structuredClone(entry.command) : null;
  };
  session.bindProviderCommand = (handle, command, persistence) => {
    if (!Number.isSafeInteger(handle) || handle <= 0)
      throw new Error("Invalid retained Modal command handle");
    const existing = entries.get(handle);
    if (existing && !sameExecution(existing.command, command))
      throw new Error("Modal command handle cannot be rebound to another execution");
    entries.set(handle, { command: structuredClone(command), persistence });
  };
  session.getProviderCommandOutput = (result) =>
    typeof result === "string" ? (receipts.get(result)?.page ?? null) : null;
  session.acknowledgeCommandOutput = async (result) => {
    const receipt = receipts.get(result);
    if (!receipt) return;
    const entry = entries.get(receipt.handle);
    if (!entry?.persistence)
      throw new Error("Modal output cannot advance before durable command retention");
    const saved = await entry.persistence.acknowledge(receipt.page.command);
    if (!sameExecution(entry.command, saved))
      throw new Error("Modal output acknowledgment changed execution identity");
    entry.command = saved;
    receipts.delete(result);
  };
  session.writeStdin = async (args) => {
    const entry = entries.get(args.sessionId);
    if (!entry?.persistence)
      throw new ModalProcessObservationUnavailableError(args.sessionId, {
        reason: "missing_handle",
      });
    if (args.chars) {
      const retained = await entry.persistence.load();
      if (!retained || !sameExecution(entry.command, retained))
        throw new Error("Original Modal command identity is unavailable");
      const index = await entry.persistence.reserveInput();
      await control.write(retained, args.chars, index);
    }
    return read(args.sessionId, entry, args.yieldTimeMs ?? 250, args.maxOutputTokens);
  };
}
