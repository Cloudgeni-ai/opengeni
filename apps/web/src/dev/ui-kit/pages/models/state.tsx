import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import {
  KIT_NOW,
  codexOrganizationAccounts,
  codexProvider,
  codexWorkspaceAccounts,
  defaultModel,
  gatewayProviders,
  modelCatalog,
  organization,
  workspaces,
  you,
  type ModelAccount,
  type UsageLimitReset,
  type UsageWindow,
} from "../../fixtures";

/* ----------------------------------------------------------------------------
   Everything the Models page preview can change, in one place. It is local to
   the preview (per pane) and starts from the shared fixtures, so every page
   and sheet shows the same accounts. Nothing touches the network.
   -------------------------------------------------------------------------- */

export type Scope = "workspace" | "organization";
export type Viewer = "org_admin" | "workspace_admin";
export type PageLoad = "ready" | "loading" | "error";
export type Rotation = "spread" | "primary";
export type Source = "organization" | "workspace";
/** Today's four-option "Subscription source" select (question 13, answered no). */
export type LegacySource = "automatic" | "organization" | "workspace" | "disabled";
export type GatewayId = "vercel" | "openrouter";

/** The pending product questions for this page, with the alternative answer to preview. */
export interface Questions {
  /** Q11: remove the links to organization settings. */
  q11: "remove" | "keep";
  /** Q12: one row per account and one sheet, or expand in place. */
  q12: "page" | "inline";
  /** Q13: "Organization | This workspace", or the four-option select. */
  q13: "segmented" | "select";
  /** Q14: "Spread work | Primary only" and a Primary chip, or radio + Auto-rotate. */
  q14: "modes" | "legacy";
  /** Q15: per-account model lists only at organization scope, or everywhere. */
  q15: "org_only" | "everywhere";
}

export interface Scenario {
  scope: Scope;
  viewer: Viewer;
  /** Acme Robotics has assigned a Codex account to Design preview. */
  orgAssigned: boolean;
  load: PageLoad;
}

export interface Availability {
  allShared: boolean;
  /** Workspace ids, used when `allShared` is off. */
  workspaces: string[];
  personal: boolean;
}

export interface CodexAccount {
  id: string;
  name: string;
  plan: string;
  scope: Scope;
  isPrimary: boolean;
  useForNewWork: boolean;
  needsReconnect: boolean;
  usage: UsageWindow[];
  resets: UsageLimitReset[];
  checkedAt: Date;
  codexApps: boolean;
  /** "all", or the model ids this account may serve. */
  modelsServed: "all" | string[];
  connectedBy: string;
  connectedOn: string;
  accountId: string;
  availability?: Availability;
}

export interface GatewayState {
  id: GatewayId;
  name: string;
  description: string;
  /** The short line on its row: rows are one line, so it has to fit a phone. */
  summary: string;
  connected: boolean;
  keyHint?: string;
  customModels: string[];
  connectedOn?: string;
  modelsServed: "all" | string[];
}

export interface ModelsData {
  workspaceAccounts: CodexAccount[];
  orgAccounts: CodexAccount[];
  codexEnabled: boolean;
  source: Source;
  legacySource: LegacySource;
  rotation: Rotation;
  orgRotation: Rotation;
  gateways: Record<Scope, Record<GatewayId, GatewayState>>;
  defaultModelId: string;
  /** "all", or the model ids new work may use. */
  allowedModels: "all" | string[];
}

const MINUTE = 60_000;

function fromFixture(
  account: ModelAccount,
  extra: Pick<CodexAccount, "checkedAt" | "connectedBy" | "connectedOn" | "accountId"> &
    Partial<CodexAccount>,
): CodexAccount {
  return {
    id: account.id,
    name: account.name,
    plan: account.plan,
    scope: account.source === "organization" ? "organization" : "workspace",
    isPrimary: account.isPrimary,
    useForNewWork: account.useForNewWork,
    needsReconnect: account.state === "needs_reconnect",
    usage: account.usage,
    resets: account.resets,
    codexApps: account.codexApps,
    modelsServed: "all",
    ...extra,
  };
}

const GATEWAY_SUMMARY: Record<GatewayId, string> = {
  vercel: "Billed to your Vercel account.",
  openrouter: "Billed to your OpenRouter account.",
};

function gatewayFromFixture(id: GatewayId, connected?: boolean): GatewayState {
  const fixture = gatewayProviders.find((provider) => provider.id === id)!;
  const isConnected = connected ?? fixture.connected;
  return {
    id,
    name: fixture.name,
    description: fixture.description,
    summary: GATEWAY_SUMMARY[id],
    connected: isConnected,
    keyHint: isConnected ? fixture.keyHint?.replace(/[^0-9a-z]/gi, "") : undefined,
    customModels: isConnected ? fixture.customModels : [],
    connectedOn: isConnected ? "2 Sep 2026" : undefined,
    modelsServed: "all",
  };
}

export function initialModelsData(): ModelsData {
  const [ops, research] = codexWorkspaceAccounts as [ModelAccount, ModelAccount];
  const platform = codexOrganizationAccounts[0]!;
  return {
    workspaceAccounts: [
      fromFixture(ops, {
        checkedAt: KIT_NOW,
        connectedBy: you.name,
        connectedOn: "14 Mar 2026",
        accountId: "chatgpt-acct-7f3a91c2",
      }),
      fromFixture(research, {
        checkedAt: new Date(KIT_NOW.getTime() - 4 * MINUTE),
        connectedBy: "Maria Chen",
        connectedOn: "2 Jun 2026",
        accountId: "chatgpt-acct-1b84e0d5",
      }),
    ],
    orgAccounts: [
      fromFixture(platform, {
        checkedAt: new Date(KIT_NOW.getTime() - 12 * MINUTE),
        connectedBy: you.name,
        connectedOn: "2 Feb 2026",
        accountId: "chatgpt-acct-c90d2e7a",
        isPrimary: true,
        availability: {
          allShared: true,
          workspaces: workspaces.map((each) => each.id),
          personal: true,
        },
      }),
    ],
    codexEnabled: true,
    source: codexProvider.source,
    legacySource: "automatic",
    rotation: codexProvider.rotation,
    orgRotation: "spread",
    gateways: {
      workspace: {
        vercel: gatewayFromFixture("vercel"),
        openrouter: gatewayFromFixture("openrouter"),
      },
      organization: {
        vercel: gatewayFromFixture("vercel", false),
        openrouter: gatewayFromFixture("openrouter", false),
      },
    },
    defaultModelId: defaultModel.id,
    allowedModels: "all",
  };
}

export const DEFAULT_QUESTIONS: Questions = {
  q11: "remove",
  q12: "page",
  q13: "segmented",
  q14: "modes",
  q15: "org_only",
};

export const DEFAULT_SCENARIO: Scenario = {
  scope: "workspace",
  viewer: "org_admin",
  orgAssigned: true,
  load: "ready",
};

/* ----------------------------------------------------------------------------
   Derived facts.
   -------------------------------------------------------------------------- */

/** Which Codex pool new work in Design preview uses right now. */
export function effectiveSource(
  data: ModelsData,
  questions: Questions,
  scenario: Scenario,
): Source {
  if (!scenario.orgAssigned) return "workspace";
  // Decided 28 Sep: no source control. Automatic unless a saved choice says otherwise;
  // workspace accounts win as soon as one is connected. (Q13's select writes the same field.)
  void questions;
  if (data.legacySource === "organization") return "organization";
  if (data.legacySource === "workspace") return "workspace";
  return data.workspaceAccounts.length > 0 ? "workspace" : "organization";
}

/** Codex is on for this workspace (the legacy select can also turn it off). */
export function codexOn(data: ModelsData, questions: Questions): boolean {
  return questions.q13 === "select" ? data.legacySource !== "disabled" : data.codexEnabled;
}

export interface ModelChoice {
  id: string;
  label: string;
  payer: string;
  /** Omitted when the group already says it all (custom model IDs). */
  description?: string;
  group: string;
  available: boolean;
  unavailableReason?: string;
}

/** Every model new work could use, grouped by who pays, with what can run right now. */
export function modelChoices(
  data: ModelsData,
  questions: Questions,
  scenario: Scenario,
): ModelChoice[] {
  const on = codexOn(data, questions);
  const source = effectiveSource(data, questions, scenario);
  const pool = source === "organization" ? data.orgAccounts : data.workspaceAccounts;
  const codexReady = on && pool.some((account) => account.useForNewWork && !account.needsReconnect);
  const codexReason = !on
    ? "Codex is off in this workspace. Turn it on in Model accounts."
    : "No Codex account is in use. Connect one or turn one back on.";
  const choices: ModelChoice[] = modelCatalog
    .filter((model) => model.payer === "Codex plan")
    .map((model) => ({
      id: model.id,
      label: model.label,
      payer: model.payer,
      description: model.description,
      group: "Codex plan",
      available: codexReady,
      unavailableReason: codexReady ? undefined : codexReason,
    }));
  const openrouter = data.gateways.workspace.openrouter;
  if (openrouter.connected) {
    for (const slug of openrouter.customModels) {
      choices.push({
        id: `openrouter:${slug}`,
        label: slug,
        payer: "OpenRouter",
        group: "OpenRouter",
        available: true,
      });
    }
  }
  const vercel = data.gateways.workspace.vercel;
  if (vercel.connected) {
    choices.push({
      id: "vercel:anthropic/claude-sonnet-4.5",
      label: "Claude Sonnet 4.5",
      payer: "AI Gateway",
      description: "Billed to your Vercel account.",
      group: "AI Gateway",
      available: true,
    });
  }
  for (const model of modelCatalog.filter((each) => each.payer === "OpenGeni credits")) {
    choices.push({
      id: model.id,
      label: model.label,
      payer: model.payer,
      description: model.description,
      group: "OpenGeni credits",
      available: model.available,
      unavailableReason: model.unavailableReason,
    });
  }
  return choices;
}

export function modelLabel(choices: ModelChoice[], id: string): string {
  const choice = choices.find((each) => each.id === id);
  return choice ? `${choice.label} · ${choice.payer}` : id;
}

export function allowedSummary(allowed: "all" | string[]): string {
  if (allowed === "all") return "All models from connected accounts";
  return allowed.length === 1 ? "1 model" : `${allowed.length} models`;
}

export function servedSummary(served: "all" | string[]): string {
  if (served === "all") return "All models";
  return served.length === 1 ? "1 model" : `${served.length} models`;
}

/** "All workspaces + Personal", or mid-sentence "all workspaces + Personal". */
export function availabilitySummary(
  availability: Availability | undefined,
  midSentence = false,
): string {
  if (!availability) return "";
  const shared = availability.allShared
    ? midSentence
      ? "all workspaces"
      : "All workspaces"
    : availability.workspaces.length === 0
      ? "No shared workspaces"
      : availability.workspaces.length === 1
        ? (workspaces.find((each) => each.id === availability.workspaces[0])?.name ?? "1 workspace")
        : `${availability.workspaces.length} workspaces`;
  return availability.personal ? `${shared} + Personal` : shared;
}

export function resetsLabel(count: number): string | null {
  if (count === 0) return null;
  return count === 1 ? "1 usage limit reset" : `${count} usage limit resets`;
}

export const ORG_NAME = organization.name;

/** "Its account stays connected.", "Both accounts stay connected.", "All 3 accounts ...". */
export function accountsStayConnected(count: number): string {
  if (count === 0) return "No accounts are connected yet.";
  if (count === 1) return "Its account stays connected.";
  if (count === 2) return "Both accounts stay connected.";
  return `All ${count} accounts stay connected.`;
}

/* ----------------------------------------------------------------------------
   What is open: the account detail, a dialog, a full-page form.
   -------------------------------------------------------------------------- */

export type DetailTarget =
  | { kind: "codex"; scope: Scope; id: string }
  | { kind: "gateway"; scope: Scope; id: GatewayId };

export type AllowedTarget = { kind: "workspace" } | { kind: "account"; scope: Scope; id: string };

export type DialogState =
  | { kind: "connect"; scope: Scope; provider?: "codex" | GatewayId }
  | { kind: "rename"; scope: Scope; id: string }
  | { kind: "redeem"; scope: Scope; id: string }
  | { kind: "disconnect"; target: DetailTarget }
  | { kind: "turn-off-codex" }
  | { kind: "replace-key"; scope: Scope; id: GatewayId }
  | { kind: "add-model"; scope: Scope; id: GatewayId };

export function sameTarget(a: DetailTarget | null, b: DetailTarget): boolean {
  return Boolean(a && a.kind === b.kind && a.scope === b.scope && a.id === b.id);
}

/* ----------------------------------------------------------------------------
   Context.
   -------------------------------------------------------------------------- */

interface ModelsContextValue {
  data: ModelsData;
  setData: (update: (data: ModelsData) => ModelsData) => void;
  questions: Questions;
  setQuestions: (update: Partial<Questions>) => void;
  scenario: Scenario;
  setScenario: (update: Partial<Scenario>) => void;
  detail: DetailTarget | null;
  openDetail: (target: DetailTarget | null) => void;
  dialog: DialogState | null;
  openDialog: (dialog: DialogState | null) => void;
  /** The "Allowed models" form, when it is open (a page, or inline). */
  allowed: AllowedTarget | null;
  openAllowed: (target: AllowedTarget | null) => void;
  reset: () => void;
}

const ModelsContext = createContext<ModelsContextValue | null>(null);

export function ModelsProvider({
  initialQuestions,
  children,
}: {
  initialQuestions?: Partial<Questions>;
  children: ReactNode;
}) {
  const [data, setDataState] = useState<ModelsData>(initialModelsData);
  const [questions, setQuestionsState] = useState<Questions>({
    ...DEFAULT_QUESTIONS,
    ...initialQuestions,
  });
  const [scenario, setScenarioState] = useState<Scenario>(DEFAULT_SCENARIO);
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [allowed, setAllowed] = useState<AllowedTarget | null>(null);

  const setData = useCallback((update: (value: ModelsData) => ModelsData) => {
    setDataState(update);
  }, []);
  const setQuestions = useCallback((update: Partial<Questions>) => {
    setQuestionsState((value) => ({ ...value, ...update }));
  }, []);
  const setScenario = useCallback((update: Partial<Scenario>) => {
    setScenarioState((value) => ({ ...value, ...update }));
    if (update.scope) {
      setDetail(null);
      setAllowed(null);
    }
  }, []);
  const reset = useCallback(() => {
    setDataState(initialModelsData());
    setDetail(null);
    setDialog(null);
    setAllowed(null);
  }, []);

  const value = useMemo<ModelsContextValue>(
    () => ({
      data,
      setData,
      questions,
      setQuestions,
      scenario,
      setScenario,
      detail,
      openDetail: setDetail,
      dialog,
      openDialog: setDialog,
      allowed,
      openAllowed: setAllowed,
      reset,
    }),
    [allowed, data, detail, dialog, questions, reset, scenario, setData, setQuestions, setScenario],
  );
  return <ModelsContext.Provider value={value}>{children}</ModelsContext.Provider>;
}

export function useModels(): ModelsContextValue {
  const value = useContext(ModelsContext);
  if (!value) throw new Error("useModels must be used inside <ModelsProvider>.");
  return value;
}

/* ----------------------------------------------------------------------------
   Updates.
   -------------------------------------------------------------------------- */

export function accountsOf(data: ModelsData, scope: Scope): CodexAccount[] {
  return scope === "organization" ? data.orgAccounts : data.workspaceAccounts;
}

export function findAccount(data: ModelsData, scope: Scope, id: string): CodexAccount | undefined {
  return accountsOf(data, scope).find((account) => account.id === id);
}

export function updateAccount(
  data: ModelsData,
  scope: Scope,
  id: string,
  patch: Partial<CodexAccount> | ((account: CodexAccount) => Partial<CodexAccount>),
): ModelsData {
  const apply = (accounts: CodexAccount[]) =>
    accounts.map((account) =>
      account.id === id
        ? { ...account, ...(typeof patch === "function" ? patch(account) : patch) }
        : account,
    );
  return scope === "organization"
    ? { ...data, orgAccounts: apply(data.orgAccounts) }
    : { ...data, workspaceAccounts: apply(data.workspaceAccounts) };
}

/** Makes one account primary and clears the others in the same pool. */
export function makePrimary(data: ModelsData, scope: Scope, id: string): ModelsData {
  const apply = (accounts: CodexAccount[]) =>
    accounts.map((account) => ({ ...account, isPrimary: account.id === id }));
  return scope === "organization"
    ? { ...data, orgAccounts: apply(data.orgAccounts) }
    : { ...data, workspaceAccounts: apply(data.workspaceAccounts) };
}

/** Removes an account; if it was primary, the next account in use becomes primary. */
export function removeAccount(data: ModelsData, scope: Scope, id: string): ModelsData {
  const apply = (accounts: CodexAccount[]) => {
    const removed = accounts.find((account) => account.id === id);
    const rest = accounts.filter((account) => account.id !== id);
    if (removed?.isPrimary && rest.length > 0) {
      const next = rest.find((account) => account.useForNewWork) ?? rest[0]!;
      return rest.map((account) => ({ ...account, isPrimary: account.id === next.id }));
    }
    return rest;
  };
  return scope === "organization"
    ? { ...data, orgAccounts: apply(data.orgAccounts) }
    : { ...data, workspaceAccounts: apply(data.workspaceAccounts) };
}

export function updateGateway(
  data: ModelsData,
  scope: Scope,
  id: GatewayId,
  patch: Partial<GatewayState>,
): ModelsData {
  return {
    ...data,
    gateways: {
      ...data.gateways,
      [scope]: { ...data.gateways[scope], [id]: { ...data.gateways[scope][id], ...patch } },
    },
  };
}

/** A promise that settles after `ms`, so saves read as saves. */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
