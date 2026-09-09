import { randomUUID } from "node:crypto";
import { truncateOutput } from "@openai/agents-core/sandbox/internal";
import type { ChannelASession } from "../channel-a";
import { ModalProcessObservationUnavailableError } from "../errors";
import { markTypedExecHandleLoss, parseExecResponseBanner } from "../exec-banner";
import {
  MAX_PROVIDER_COMMAND_HANDLE,
  type ProviderCommandOutput,
  type ProviderCommandPersistence,
  type ProviderCommandSession,
  admittedProviderCommandHandle,
} from "../provider-command-session";
import type { ModalCommandControl, ModalProviderCommand } from "./modal-command-control";

type Entry = {
  command: ModalProviderCommand;
  persistence?: ProviderCommandPersistence;
};

function sameExecution(a: ModalProviderCommand, b: ModalProviderCommand): boolean {
  return (
    a.sandboxId === b.sandboxId &&
    a.taskId === b.taskId &&
    a.execId === b.execId &&
    Boolean(a.pty) === Boolean(b.pty)
  );
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
  const originalWrite = session.writeStdin?.bind(session);
  const cancelLegacyStart = session.cancelPendingExecCommand?.bind(session);
  const pendingStarts = new Set<AbortController>();
  const entries = new Map<number, Entry>();
  // Current SDK setup commands are not retained/admitted commands. Give their
  // live observer handles a disjoint, adapter-local range; never use a missing
  // retained alias as permission to poll an unrelated SDK process with that id.
  const setupHandles = new Map<number, number>();
  let nextSetupHandle = MAX_PROVIDER_COMMAND_HANDLE + 1;
  const receipts = new Map<string, { handle: number; page: ProviderCommandOutput }>();

  const setupPage = (raw: string, handle: number, sdkHandle: number): string => {
    const banner = parseExecResponseBanner(raw);
    if (banner.kind === "exited") {
      setupHandles.delete(handle);
      return raw;
    }
    if (banner.kind !== "running" || banner.sessionId !== sdkHandle)
      throw new ModalProcessObservationUnavailableError(handle);
    // The parser validated the unique status in the metadata header, before
    // command-controlled Output. Replace only that first trusted status line.
    return raw.replace(
      /^Process running with session ID \d+(?=\r?$)/mu,
      `Process running with session ID ${handle}`,
    );
  };

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
    signal?: AbortSignal,
  ): Promise<string> => {
    if (entry.persistence) {
      const retained = await entry.persistence.load();
      if (!retained || !sameExecution(entry.command, retained))
        throw new Error("Original Modal command identity is unavailable");
      entry.command = retained;
    }
    const page = await control.read(entry.command, yieldTimeMs, signal);
    // The receipt is generated here, not parsed from command output. Its only
    // purpose is correlating this return value with a trusted in-memory page.
    return formatPage(handle, page, maxOutputTokens);
  };

  session.execCommand = async (args) => {
    const handle = admittedProviderCommandHandle();
    // Setup/readiness may yield too. Retain only its original local observer,
    // without publishing a durable locator or replaying its command.
    if (handle === undefined) {
      if (!originalExec) throw new Error("Modal command requires mutation admission");
      if (!Number.isSafeInteger(nextSetupHandle)) throw new Error("Modal setup handles exhausted");
      const setupHandle = nextSetupHandle++;
      const raw = await originalExec(args);
      const banner = parseExecResponseBanner(raw);
      if (banner.kind !== "running") return raw;
      setupHandles.set(setupHandle, banner.sessionId);
      return setupPage(raw, setupHandle, banner.sessionId);
    }
    if (entries.has(handle)) throw new Error("Modal command handle is already bound");
    const cancellation = new AbortController();
    pendingStarts.add(cancellation);
    try {
      const entry = { command: await control.start(args, cancellation.signal) };
      entries.set(handle, entry);
      try {
        return await read(
          handle,
          entry,
          args.yieldTimeMs ?? 10000,
          args.maxOutputTokens,
          cancellation.signal,
        );
      } catch {
        // Start succeeded. A failed/cancelled first observation must still
        // publish the known locator for durable retention and exact cleanup.
        return formatPage(handle, {
          command: entry.command,
          chunks: [],
          exitCode: null,
        });
      }
    } finally {
      pendingStarts.delete(cancellation);
    }
  };

  session.cancelPendingExecCommand = async () => {
    for (const start of pendingStarts)
      start.abort(
        new Error("Modal command start observation cancelled; provider outcome is unknown"),
      );
    // SDK-internal foreground commands retain their separate legacy transport
    // cancellation. Neither path closes an already-yielded command's locator.
    await cancelLegacyStart?.();
  };

  session.getProviderCommand = (handle) => {
    const entry = entries.get(handle);
    return entry ? structuredClone(entry.command) : null;
  };
  session.bindProviderCommand = (handle, command, persistence) => {
    if (!Number.isSafeInteger(handle) || handle <= 0 || handle > MAX_PROVIDER_COMMAND_HANDLE)
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
    const sdkHandle = setupHandles.get(args.sessionId);
    if (sdkHandle !== undefined && originalWrite) {
      const raw = await originalWrite({ ...args, sessionId: sdkHandle });
      return setupPage(raw, args.sessionId, sdkHandle);
    }
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
