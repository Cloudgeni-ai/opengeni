import { OpenGeniApiError, type OpenGeniClient } from "@opengeni/sdk";
import { Directory, File, Paths } from "expo-file-system";
import { useCallback, useSyncExternalStore } from "react";
import {
  createFeedbackOutbox,
  type FeedbackOutboxStorage,
  type FeedbackSendFailure,
} from "./outbox-core";

// Unsent reports live in the app's documents, one folder per account. They
// normally leave within seconds; a folder only grows while the server is unreachable.
function accountDirectory(accountId: string): Directory {
  return new Directory(Paths.document, "opengeni-feedback-outbox", encodeURIComponent(accountId));
}

const fileStorage: FeedbackOutboxStorage = {
  async list(accountId) {
    const directory = accountDirectory(accountId);
    if (!directory.exists) return [];
    return directory
      .list()
      .map((entry) => entry.name)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5));
  },
  async read(accountId, id) {
    const file = new File(accountDirectory(accountId), `${id}.json`);
    return file.exists ? await file.text() : null;
  },
  async write(accountId, id, value) {
    const directory = accountDirectory(accountId);
    if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
    // Write beside the target, then move it over, so a crash never leaves half a report.
    const temporary = new File(directory, `${id}.tmp`);
    if (temporary.exists) temporary.delete();
    temporary.create();
    temporary.write(value);
    temporary.moveSync(new File(directory, `${id}.json`), { overwrite: true });
  },
  async remove(accountId, id) {
    const file = new File(accountDirectory(accountId), `${id}.json`);
    if (file.exists) file.delete();
  },
};

/** Statuses the same report can never get past: invalid, not allowed, gone or a clashing key. */
const PERMANENT_STATUSES = new Set([400, 403, 404, 409, 413, 422]);

export function classifyFeedbackFailure(error: unknown): FeedbackSendFailure {
  return error instanceof OpenGeniApiError && PERMANENT_STATUSES.has(error.status)
    ? "rejected"
    : "retry";
}

let sender: { accountId: string; client: OpenGeniClient } | null = null;

/** The signed-in account's client; reports only go out under the account that wrote them. */
export function bindFeedbackSender(next: { accountId: string; client: OpenGeniClient } | null) {
  sender = next;
}

export const feedbackOutbox = createFeedbackOutbox({
  storage: fileStorage,
  async send(accountId, report) {
    if (!sender || sender.accountId !== accountId) throw new Error("That account is not in use");
    await sender.client.createFeedback(report.workspaceId, report.request);
  },
  classify: classifyFeedbackFailure,
});

/** Reports this account has written that have not reached the server yet. */
export function useFeedbackPending(accountId: string | null): number {
  const read = useCallback(() => feedbackOutbox.pending(accountId), [accountId]);
  return useSyncExternalStore(feedbackOutbox.subscribe, read, read);
}

/** One image's bytes for the report, or null when it is unreadable. */
export async function readFeedbackImage(uri: string): Promise<string | null> {
  try {
    return await new File(uri).base64();
  } catch {
    return null;
  }
}
