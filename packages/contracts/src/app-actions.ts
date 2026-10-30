import { ACTION_CATALOG } from "./app-action-catalog.gen";
import type { ActionCatalogEntry } from "./app-action-catalog-types";
import {
  presentedAppActionId,
  SESSION_EVENT_PRESENTED_APP_ACTIONS,
  type PresentedAppActionPage,
} from "./session-history";

/* ----------------------------------------------------------------------------
   App actions: every public API action, the same ones the organization MCP
   server and a session's admin_action_* tools run as a person. The API runs
   them; the worker reads this module only to tell a change from a read and to
   word the confirmation the person sees in the chat before a change runs.
   -------------------------------------------------------------------------- */

export type { ActionCatalogEntry };
export { ACTION_CATALOG };

/** The tool that runs an app action in a session; the only one that can change anything. */
export const APP_ACTION_CALL_TOOL_NAME = "admin_action_call" as const;

/**
 * Requests that only read but are sent as POST (a search query or a file path
 * in the body). Read only connections may run them; each route still checks
 * its own read permission.
 */
export const READ_ONLY_POST_ACTIONS: ReadonlySet<string> = new Set([
  "/v1/workspaces/:workspaceId/knowledge/entries/search",
  "/v1/workspaces/:workspaceId/sessions/:sessionId/fs/read",
  "/v1/workspaces/:workspaceId/sessions/:sessionId/git/diff",
  "/v1/workspaces/:workspaceId/integrations/preview",
  "/v1/workspaces/:workspaceId/plugins/preview",
  "/v1/workspaces/:workspaceId/skills/preview",
  "/v1/organizations/:organizationId/external-identities/lookup",
]);

/** An action by its id, or by "METHOD /path". */
export function findAppAction(id: string): ActionCatalogEntry | undefined {
  const trimmed = id.trim();
  return ACTION_CATALOG.find(
    (entry) => entry.id === trimmed || `${entry.method} ${entry.path}` === trimmed,
  );
}

/**
 * Whether running the action can change anything. Only GET, HEAD and the
 * read-only POSTs can't.
 */
export function appActionChangesState(entry: ActionCatalogEntry): boolean {
  return !(
    entry.method === "GET" ||
    entry.method === "HEAD" ||
    READ_ONLY_POST_ACTIONS.has(entry.path)
  );
}

/**
 * Whether an admin_action_call with these arguments needs the person's
 * confirmation when the session lacks full access: true for every change, and
 * for anything that can't be recognised as a read (unknown action, bad input).
 */
export function appActionCallChangesState(args: unknown): boolean {
  const id = callArguments(args)?.id;
  if (typeof id !== "string") return true;
  const entry = findAppAction(id);
  return entry === undefined || appActionChangesState(entry);
}

/**
 * Actions that only open a payment page (Stripe Checkout or the billing
 * portal); the chat shows the page as a button. See
 * {@link appActionNeedsConfirmation} for which of them still ask first.
 */
export const PAYMENT_PAGE_ACTIONS: ReadonlySet<string> = new Set(
  Object.keys(SESSION_EVENT_PRESENTED_APP_ACTIONS),
);

/** The payment page the action opens (see {@link PAYMENT_PAGE_ACTIONS}), if it opens one. */
export function appActionPaymentPage(
  entry: ActionCatalogEntry,
): PresentedAppActionPage | undefined {
  const id = presentedAppActionId(entry.id);
  return id ? SESSION_EVENT_PRESENTED_APP_ACTIONS[id].page : undefined;
}

/**
 * Whether running the action needs the person's confirmation in the chat
 * first, and so can't run where the chat can only read: every change, except
 * opening a checkout page. A checkout charges nothing until the person pays
 * on it, so the page is its own confirmation. A billing portal link is
 * different: whoever holds it can change the payment method or cancel the
 * plan, so it keeps the confirmation.
 */
export function appActionNeedsConfirmation(entry: ActionCatalogEntry): boolean {
  const page = appActionPaymentPage(entry);
  return appActionChangesState(entry) && page !== "credits" && page !== "subscription";
}

/**
 * The same, for an admin_action_call's arguments: also true for anything that
 * can't be recognised (unknown action, bad input).
 */
export function appActionCallNeedsConfirmation(args: unknown): boolean {
  const id = callArguments(args)?.id;
  if (typeof id !== "string") return true;
  const entry = findAppAction(id);
  return entry === undefined || appActionNeedsConfirmation(entry);
}

/**
 * Whether the action can create, show, copy or rotate a key, password, token
 * or other secret, or hand one to the app (its catalog entry lists where).
 */
export function appActionHandlesSecrets(entry: ActionCatalogEntry): boolean {
  return (entry.secretFields?.length ?? 0) > 0;
}

/**
 * Whether this call of the action carries a secret: the action returns or
 * stores one whatever it is given (a response field or a route), or this
 * call's body fills a request field that holds one ("headers" when creating a
 * chat with MCP servers; creating it without them carries none). Without full
 * access the chat route never runs such a call: one click would put a lasting
 * secret into the conversation and the model provider's logs. The person
 * does it in the app instead.
 */
export function appActionCallCarriesSecrets(entry: ActionCatalogEntry, body: unknown): boolean {
  return (entry.secretFields ?? []).some((field) => {
    if (!field.startsWith("request.") && !field.startsWith("request[]")) return true;
    return filledAt(body, field.slice("request".length));
  });
}

/** The same, for an admin_action_call's arguments; an unknown action is not one. */
export function appActionCallHandlesSecrets(args: unknown): boolean {
  const call = callArguments(args);
  const entry = typeof call?.id === "string" ? findAppAction(call.id) : undefined;
  return entry !== undefined && appActionCallCarriesSecrets(entry, call?.body);
}

/**
 * Whether this admin_action_call creates or updates a vault item. Its body is
 * kept in the vault itself, so secret references in it may become values.
 */
export function appActionCallStoresVaultItem(args: unknown): boolean {
  const call = record(args);
  const entry = typeof call?.id === "string" ? findAppAction(call.id) : undefined;
  return (
    entry !== undefined &&
    (entry.secretFields ?? []).some((field) => field.startsWith("route:")) &&
    ((entry.method === "POST" && /\/vaults\/:vaultId\/items$/.test(entry.path)) ||
      (entry.method === "PATCH" && /\/vaults\/:vaultId\/items\/:itemId$/.test(entry.path)))
  );
}

/**
 * Calls `visit` on each filled request field of this admin_action_call's body
 * that its action marks as secret (a provider API key, an MCP server's
 * headers), in catalog order, and returns the arguments with each field
 * replaced by what `visit` returned. Only these fields take a secret from the
 * caller; response and route fields don't. Arguments that are not an object,
 * an unknown action, or a call without such fields come back unchanged.
 */
export function mapAppActionCallSecretInputs(
  args: unknown,
  visit: (value: unknown) => unknown,
): unknown {
  const call = record(args);
  const entry = typeof call?.id === "string" ? findAppAction(call.id) : undefined;
  if (!call || !entry || !Object.hasOwn(call, "body")) return args;
  let body = call.body;
  for (const field of entry.secretFields ?? []) {
    if (!field.startsWith("request.") && !field.startsWith("request[]")) continue;
    body = mapFilledAt(body, field.slice("request".length), visit);
  }
  return body === call.body ? args : { ...call, body };
}

/** The values `mapAppActionCallSecretInputs` visits, in order. */
export function appActionCallSecretInputs(args: unknown): unknown[] {
  const inputs: unknown[] = [];
  mapAppActionCallSecretInputs(args, (value) => {
    inputs.push(value);
    return value;
  });
  return inputs;
}

function mapFilledAt(value: unknown, path: string, visit: (value: unknown) => unknown): unknown {
  if (path === "") return filled(value) ? visit(value) : value;
  if (path.startsWith("[]")) {
    const rest = path.slice(2);
    if (Array.isArray(value)) {
      const next = value.map((item) => mapFilledAt(item, rest, visit));
      return next.every((item, index) => item === value[index]) ? value : next;
    }
    const object = record(value);
    if (!object) return value;
    const next = Object.fromEntries(
      Object.entries(object).map(([key, item]) => [key, mapFilledAt(item, rest, visit)]),
    );
    return Object.keys(object).every((key) => next[key] === object[key]) ? value : next;
  }
  const match = /^\.([^.[]+)/.exec(path);
  const object = record(value);
  if (!match || !object || !Object.hasOwn(object, match[1]!)) return value;
  const key = match[1]!;
  const next = mapFilledAt(object[key], path.slice(match[0].length), visit);
  return next === object[key] ? value : { ...object, [key]: next };
}

/** Whether a body has a non-empty value at a catalog field path such as ".mcpServers[].headers". */
function filledAt(value: unknown, path: string): boolean {
  if (path === "") return filled(value);
  if (path.startsWith("[]")) {
    const items = Array.isArray(value)
      ? value
      : value && typeof value === "object"
        ? Object.values(value)
        : [];
    return items.some((item) => filledAt(item, path.slice(2)));
  }
  const match = /^\.([^.[]+)/.exec(path);
  if (!match) return true;
  const object = record(value);
  return object !== null && filledAt(object[match[1]!], path.slice(match[0].length));
}

function filled(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// Values put into a confirmation's words are checked first, so an argument can
// never write its own question. Anything else falls back to the generic text.
const PLAIN_EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
// A tool's exact name, as integrations name them ("send_message", "gmail.send").
const PLAIN_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * What the server found for an id an app action names, read from its own
 * records when the approval was prepared: never text from the call. The
 * confirmation names it, so the person knows exactly what the change touches.
 */
export type AppActionTarget = {
  /** What it is, in plain lower-case words: "connection", "scheduled task". */
  kind: string;
  /** Its name as the app shows it ("Gmail", "Daily digest"); absent when it wasn't found. */
  name?: string | undefined;
  /** The account or person it belongs to, when that tells it apart ("anna@example.com"). */
  account?: string | undefined;
  /** More facts that tell it apart from similar ones, in display order. */
  facts?: ReadonlyArray<{ label: string; value: string }> | undefined;
};

/** Targets by the path parameter that names them ("connectionId", "workspaceId"). */
export type AppActionTargets = Readonly<Record<string, AppActionTarget>>;

/**
 * The path parameter naming what the action changes: the last one in its
 * route ("/connections/:connectionId" → "connectionId"), or undefined for a
 * route without one.
 */
export function appActionTargetParameter(entry: ActionCatalogEntry): string | undefined {
  return [...entry.path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].at(-1)?.[1];
}

/** The path parameters of an admin_action_call's action, with the values the call gave. */
export function appActionCallPathIds(
  args: unknown,
): { entry: ActionCatalogEntry; ids: Record<string, string> } | undefined {
  const call = callArguments(args);
  const entry = typeof call?.id === "string" ? findAppAction(call.id) : undefined;
  if (!entry) return undefined;
  const path = record(call?.pathParameters);
  const ids: Record<string, string> = {};
  for (const [, name] of entry.path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)) {
    const value = path?.[name!];
    if (typeof value === "string" && value.trim()) ids[name!] = value.trim();
  }
  return { entry, ids };
}

/** A stored name made safe to quote in a question: one line, bounded. */
function plainName(text: string | undefined): string | undefined {
  const line = text
    ?.replace(/[\u0000-\u001f\u007f\u2028\u2029]/gu, " ")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return undefined;
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

/** "Gmail · anna@example.com": a target's name and account, as one quoted label. */
function targetLabel(target: AppActionTarget): string | undefined {
  const name = plainName(target.name);
  if (!name) return undefined;
  const account = plainName(target.account);
  return account && account !== name ? `${name} · ${account}` : name;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The facts a confirmation card lists under its question: what the action
 * changes beyond the name its question already says (or that it couldn't be
 * found), then where it is when that isn't this chat or workspace. Only
 * server-read targets; never the call's text.
 */
export function appActionTargetFacts(
  args: unknown,
  here: { workspaceId: string; sessionId: string },
  targets: AppActionTargets | undefined,
): Array<{ label: string; value: string }> {
  const call = appActionCallPathIds(args);
  if (!call || !targets) return [];
  const parameter = appActionTargetParameter(call.entry);
  // What the question already says isn't said again.
  const title = appActionConfirmationTitle(args, here, targets);
  const said = (text: string | undefined) => {
    const plain = plainName(text);
    return plain !== undefined && title.includes(plain);
  };
  const facts: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: string | undefined) => {
    const text = plainName(value);
    if (text && facts.length < 12)
      facts.push({ label: capitalized(label).slice(0, 64), value: text });
  };
  const primary = parameter ? targets[parameter] : undefined;
  if (primary) {
    if (!primary.name) add(primary.kind, "Not found. It may have been removed already.");
    else {
      if (!said(primary.name)) add(primary.kind, primary.name);
      if (primary.account && !said(primary.account)) add("Account", primary.account);
    }
    for (const fact of primary.facts ?? []) add(fact.label, fact.value);
  }
  for (const [name, target] of Object.entries(targets)) {
    if (name === parameter || !(name in call.ids)) continue;
    if (name === "workspaceId" && call.ids.workspaceId === here.workspaceId) continue;
    if (name === "sessionId" && call.ids.sessionId === here.sessionId) continue;
    const label = targetLabel(target);
    if (!label || !title.includes(label)) add(target.kind, label ?? "Not found");
  }
  return facts;
}

/**
 * The question the person answers before a change runs, in plain words, from
 * the action, its checked arguments and the `targets` the server read for its
 * ids; never text the agent wrote. `here` is the chat asking, so "this chat"
 * and "this workspace" are said only when the call targets exactly them.
 */
export function appActionConfirmationTitle(
  args: unknown,
  here: { workspaceId: string; sessionId: string },
  targets?: AppActionTargets,
): string {
  const call = callArguments(args);
  const entry = typeof call?.id === "string" ? findAppAction(call.id) : undefined;
  if (!entry) return "Make this change in the app?";
  const body = record(call?.body);
  const path = record(call?.pathParameters);
  const targetName = (parameter: string) => plainName(targets?.[parameter]?.name);
  const named = (parameter: string, kind: string, otherwise: string) => {
    const label = targets?.[parameter] ? targetLabel(targets[parameter]!) : undefined;
    return label ? `${kind} “${label}”` : otherwise;
  };
  const workspace =
    path?.workspaceId === here.workspaceId
      ? "this workspace"
      : named("workspaceId", "workspace", "another workspace");
  const chat =
    path?.sessionId === here.sessionId && path?.workspaceId === here.workspaceId
      ? "this chat"
      : named("sessionId", "chat", "another chat");
  switch (entry.id) {
    case "createOrganizationInvitation": {
      const email = typeof body?.email === "string" ? body.email : "";
      const who = PLAIN_EMAIL.test(email) ? email : "someone";
      const role = body?.role ?? "member";
      return role === "member"
        ? `Invite ${who} to your organization?`
        : role === "admin" || role === "owner"
          ? `Invite ${who} to your organization as an ${role}?`
          : `Invite ${who} to your organization?`;
    }
    case "addWorkspaceMember":
      return `Add someone to ${workspace}?`;
    case "updateSessionVisibility":
      return body?.visibility === "workspace"
        ? `Share ${chat} with everyone in the workspace?`
        : body?.visibility === "private"
          ? `Make ${chat} visible only to you?`
          : `Change who can see ${chat}?`;
    case "createSessionShareLink":
      return `Create a link to ${chat}? Anyone with the link can read the conversation up to now.`;
    case "revokeSessionShareLink":
      return `Stop sharing ${chat}? Its link will stop working.`;
    case "updateWorkspaceSettings":
      return `Change ${workspace}'s settings?`;
    case "updateOrganizationModelDefaults":
      return "Change your organization's default models?";
    case "createBillingPortalSession":
    case "createSubscriptionPortalSession":
      return "Open your billing page? It can change your payment method or plan.";
    case "updateConnectorToolPermissions":
      return `${toolApprovalQuestion(body, targetName("capabilityId") ? `${targetName("capabilityId")}'s` : "this integration's")} in ${workspace}?`;
    case "updateSessionMcpToolPermissions":
      return `${toolApprovalQuestion(body, "this MCP server's")} in ${workspace}?`;
    case "updateVideoGenerationPolicy": {
      // The policy is the whole setting: a default model and enabled models
      // turn video on (or change how it's paid for); none turn it off.
      const models = Array.isArray(body?.enabledModelIds) ? body.enabledModelIds : [];
      return typeof body?.defaultModelId === "string" && models.length > 0
        ? `Let every chat in ${workspace} make videos?`
        : `Turn off video for every chat in ${workspace}?`;
    }
    default: {
      // Name what it changes, as the server found it; else where it applies.
      // The card's facts say more about it.
      const parameter = appActionTargetParameter(entry);
      const target = parameter ? targets?.[parameter] : undefined;
      const label = target ? targetLabel(target) : undefined;
      const action = sentence(entry);
      const where =
        typeof path?.sessionId === "string"
          ? ` for ${chat}`
          : typeof path?.workspaceId === "string"
            ? ` in ${workspace}`
            : typeof path?.organizationId === "string"
              ? " in your organization"
              : "";
      // The action is on the chat or workspace itself: "Delete chat “Q3 plan”?"
      const itself = / (session|workspace)$/.exec(action);
      if (itself && parameter === (itself[1] === "session" ? "sessionId" : "workspaceId"))
        return `${action.slice(0, itself.index)} ${itself[1] === "session" ? chat : workspace}?`;
      if (!label || parameter === "workspaceId" || parameter === "sessionId")
        return `${action}${where}?`;
      // Somewhere other than here is named too; here goes without saying.
      const elsewhere =
        typeof path?.workspaceId === "string" && path.workspaceId !== here.workspaceId
          ? ` in ${workspace}`
          : typeof path?.sessionId === "string" && chat !== "this chat"
            ? ` in ${chat}`
            : "";
      if (entry.id === "deleteConnection") {
        const name = plainName(target!.name)!;
        const account = plainName(target!.account);
        return `Remove the ${name} connection${account && account !== name ? ` for ${account}` : ""}${elsewhere}?`;
      }
      return `${action} “${label}”${elsewhere}?`;
    }
  }
}

/**
 * "Let send_message run without asking", from a tool approval change: the
 * tools it names (only plain tool names, at most three, else a count) and the
 * approval it sets, or the default for tools without their own approval.
 */
function toolApprovalQuestion(body: Record<string, unknown> | null, owner: string): string {
  const label = { allow: "Allow", ask: "Ask", block: "Block" } as const;
  const permission = body?.permission;
  const known = permission === "allow" || permission === "ask" || permission === "block";
  if (body?.target === "default") {
    if (known) return `Set ${owner} default tool approval to ${label[permission]}`;
    return permission === null ? `Clear ${owner} default tool approval` : "Change tool approvals";
  }
  const names = Array.isArray(body?.toolNames) ? body.toolNames : [];
  if (body?.target !== "tools" || names.length === 0) return "Change tool approvals";
  const plain =
    names.length <= 3 &&
    names.every((name) => typeof name === "string" && PLAIN_TOOL_NAME.test(name));
  const tools = plain
    ? names.join(names.length === 2 ? " and " : ", ").replace(/, ([^,]*)$/, ", and $1")
    : `${names.length} tool${names.length === 1 ? "" : "s"}`;
  switch (permission) {
    case "allow":
      return `Let ${tools} run without asking`;
    case "ask":
      return `Ask before ${tools} ${names.length === 1 ? "runs" : "run"}`;
    case "block":
      return `Block ${tools}`;
    case null:
      return `Reset ${tools} to the default approval`;
    default:
      return "Change tool approvals";
  }
}

/** "updateWorkspaceSettings" reads "Update workspace settings"; unnamed routes read by their path. */
function sentence(entry: ActionCatalogEntry): string {
  if (/^[a-z][A-Za-z0-9]*$/.test(entry.id)) {
    const words = entry.id
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .replace(
        /\b(api|mcp|sso|url|sql|ip)(s?)\b/g,
        (_, word: string, plural: string) => `${word.toUpperCase()}${plural}`,
      )
      .replace(/\bgit hub\b|\bgithub\b/g, "GitHub");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return `Run ${entry.method} ${entry.path}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A call's arguments, parsed or still as their JSON text. */
function callArguments(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}
