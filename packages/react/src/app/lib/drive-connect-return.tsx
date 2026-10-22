import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

export const DRIVE_MCP_URL = "https://drivemcp.googleapis.com/mcp/v1";
export const DRIVE_CONNECT_RETURN_PARAM = "drive_connect_return";
const storageKey = (workspaceId: string) => `opengeni.drive-connect.v1:${workspaceId}`;
type Receipt = { nonce: string; attemptId: string; connectionWorkspaceId: string; itemId: string };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

/** Browser state is only a locator. Completion and the account come from Connect. */
export async function beginDriveConnect(input: {
  client: Pick<OpenGeniBrowserClient, "beginConnect" | "connectTransport">;
  workspaceId: string;
  connectionWorkspaceId?: string;
  itemId: string;
  reconnectAccountId?: string;
  returnUrl: string;
  storage: Storage;
}): Promise<string> {
  const nonce = crypto.randomUUID();
  const returnUrl = new URL(input.returnUrl);
  returnUrl.searchParams.set(DRIVE_CONNECT_RETURN_PARAM, nonce);
  const connectionWorkspaceId = input.connectionWorkspaceId ?? input.workspaceId;
  const created = await input.client.beginConnect(connectionWorkspaceId, {
    providerId: "google-drive",
    ownership: "personal",
    returnUrl: returnUrl.toString(),
    idempotencyKey: crypto.randomUUID(),
    ...(input.reconnectAccountId ? { reconnectAccountId: input.reconnectAccountId } : {}),
  });
  if (created.state !== "credential_input")
    throw new Error("Google Drive setup did not start. Try again.");
  const attempt = await input.client.connectTransport().advance(connectionWorkspaceId, created.id, {
    expectedRevision: created.revision,
    idempotencyKey: crypto.randomUUID(),
    action: { type: "credentials", values: {} },
  });
  if (attempt.nextAction.type !== "authorize")
    throw new Error(attempt.error?.message ?? "Google Drive did not return an authorization link.");
  input.storage.setItem(
    storageKey(input.workspaceId),
    JSON.stringify({
      nonce,
      attemptId: attempt.id,
      connectionWorkspaceId,
      itemId: input.itemId,
    } satisfies Receipt),
  );
  return attempt.nextAction.url;
}

export async function resolveDriveConnectReturn(input: {
  client: Pick<OpenGeniBrowserClient, "connectTransport">;
  workspaceId: string;
  nonce: string;
  storage: Storage;
}): Promise<{ itemId: string; connectionId: string }> {
  const key = storageKey(input.workspaceId);
  const raw = input.storage.getItem(key);
  let receipt: Receipt;
  try {
    receipt = JSON.parse(raw ?? "null");
    if (
      !receipt ||
      receipt.nonce !== input.nonce ||
      ![receipt.attemptId, receipt.connectionWorkspaceId, receipt.itemId].every(
        (value) => typeof value === "string" && value.length > 0 && value.length <= 4096,
      )
    )
      throw new Error();
  } catch {
    throw new Error(
      "The Google Drive setup return could not be matched. Open Drive to check your connection.",
    );
  }
  const attempt = await input.client
    .connectTransport()
    .get(receipt.connectionWorkspaceId, receipt.attemptId);
  if (
    attempt.id !== receipt.attemptId ||
    attempt.providerId !== "google-drive" ||
    attempt.ownership !== "personal"
  ) {
    throw new Error("The Google Drive setup account changed. Open Drive to try again.");
  }
  if (["failed", "expired", "cancelled"].includes(attempt.state)) {
    input.storage.removeItem(key);
    throw new Error(
      attempt.error?.message ??
        "Google Drive connection was not completed. Open Drive to try again.",
    );
  }
  if (
    attempt.state !== "complete" ||
    !attempt.credentialsCommitted ||
    attempt.account?.providerId !== "google-drive" ||
    attempt.account.ownership !== "personal" ||
    !attempt.account.id
  ) {
    throw new Error("Google Drive setup is still incomplete. Reload to check it again.");
  }
  return { itemId: receipt.itemId, connectionId: attempt.account.id };
}

/** Clear only after the UI has finished enabling; never consume a newer attempt. */
export function completeDriveConnectReturn(
  workspaceId: string,
  nonce: string,
  storage: Storage,
): void {
  const key = storageKey(workspaceId);
  try {
    if (JSON.parse(storage.getItem(key) ?? "null")?.nonce === nonce) storage.removeItem(key);
  } catch {
    /* An absent or replaced browser locator grants no authority. */
  }
}
