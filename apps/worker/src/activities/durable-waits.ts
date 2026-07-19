import { AskUserRequest } from "@opengeni/contracts";

export type AskUserApprovalBoundary = {
  approvalId: string;
  request: AskUserRequest;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("ask_user interruption carried malformed JSON arguments");
  }
}

/** Parse the one SDK approval interruption owned by structured ask_user. */
export function askUserBoundaryFromApprovals(approvals: unknown[]): AskUserApprovalBoundary | null {
  const matches: AskUserApprovalBoundary[] = [];
  for (const value of approvals) {
    const approval = record(value);
    const raw = record(approval?.raw);
    const rawItem = record(approval?.rawItem) ?? record(raw?.rawItem);
    const toolName =
      approval?.toolName ?? approval?.name ?? rawItem?.name ?? raw?.toolName ?? raw?.name;
    if (toolName !== "ask_user" && toolName !== "opengeni__ask_user") continue;

    const approvalId =
      approval?.id ??
      approval?.approvalId ??
      rawItem?.callId ??
      rawItem?.id ??
      raw?.approvalId ??
      raw?.id;
    if (typeof approvalId !== "string" || approvalId.length === 0) {
      throw new Error("ask_user interruption is missing its SDK approval id");
    }
    const request = AskUserRequest.parse(
      parseArguments(
        approval?.arguments ?? rawItem?.arguments ?? raw?.arguments ?? raw?.input ?? null,
      ),
    );
    matches.push({ approvalId, request });
  }
  if (matches.length > 1) {
    throw new Error("A turn may not suspend on more than one ask_user action at once");
  }
  return matches[0] ?? null;
}
