// Console wording for usage allowance remedies. Dependency-free so the session
// route can name who fixes a refusal without pulling in budget code.
/**
 * Who can fix what, in this console's roles: organization owners hold the
 * budget authority; workspace admins set member limits.
 */
export const CONSOLE_ALLOWANCE_LABELS = {
  memberRemedy: "A workspace admin can raise your limit.",
  workspaceRemedy: "An organization owner can raise the workspace budget.",
} as const;

/** The same remedies for the conversation, where the limit may be someone else's. */
export const CONSOLE_TIMELINE_ALLOWANCE_LABELS = {
  memberRemedy: "A workspace admin can raise this limit.",
  workspaceRemedy: "An organization owner can raise the workspace budget.",
} as const;
