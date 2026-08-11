import type {
  CapabilityCatalogItem,
  CapabilityInstallation,
  ConnectionMetadata,
  PluginComponentPreview,
  PluginInstallationSummary,
  PluginPreview,
  SkillImportPreview,
} from "@/types";

export type SourceImportKind = "skill" | "plugin";
export type SourceImportIntent = "create" | "update";
export type SourceImportPhase = "source" | "previewing" | "review" | "installing";

export type InstalledSourceSkill = {
  item: CapabilityCatalogItem;
  installation: CapabilityInstallation;
  sourceUrl: string;
  sourceCommit: string;
  contentSha256: string;
};

export type SourceImportState = {
  open: boolean;
  kind: SourceImportKind;
  intent: SourceImportIntent;
  phase: SourceImportPhase;
  url: string;
  skillPreview: SkillImportPreview | null;
  pluginPreview: PluginPreview | null;
  pluginBindings: Record<string, string>;
  bindingsDirty: boolean;
  editingSkill: InstalledSourceSkill | null;
  editingPlugin: PluginInstallationSummary | null;
  operationId: string;
  error: string | null;
};

export type SourceImportAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "new"; kind?: SourceImportKind; operationId: string }
  | { type: "edit_skill"; skill: InstalledSourceSkill; operationId: string }
  | {
      type: "edit_plugin";
      plugin: PluginInstallationSummary;
      operationId: string;
    }
  | { type: "kind"; kind: SourceImportKind }
  | { type: "url"; url: string }
  | { type: "phase"; phase: SourceImportPhase; error?: string | null }
  | { type: "skill_preview"; preview: SkillImportPreview }
  | { type: "plugin_preview"; preview: PluginPreview }
  | { type: "plugin_binding"; componentKey: string; connectionId: string }
  | { type: "error"; message: string }
  | { type: "reset" };

export function initialSourceImportState(): SourceImportState {
  return {
    open: false,
    kind: "skill",
    intent: "create",
    phase: "source",
    url: "",
    skillPreview: null,
    pluginPreview: null,
    pluginBindings: {},
    bindingsDirty: false,
    editingSkill: null,
    editingPlugin: null,
    operationId: "",
    error: null,
  };
}

export function sourceImportReducer(
  state: SourceImportState,
  action: SourceImportAction,
): SourceImportState {
  switch (action.type) {
    case "open":
      return { ...state, open: true };
    case "close":
      return { ...state, open: false };
    case "new":
      return {
        ...initialSourceImportState(),
        open: true,
        kind: action.kind ?? "skill",
        operationId: action.operationId,
      };
    case "edit_skill":
      return {
        ...initialSourceImportState(),
        open: true,
        kind: "skill",
        intent: "update",
        url: action.skill.sourceUrl,
        editingSkill: action.skill,
        operationId: action.operationId,
      };
    case "edit_plugin":
      return {
        ...initialSourceImportState(),
        open: true,
        kind: "plugin",
        intent: "update",
        url: action.plugin.sourceUrl ?? "",
        editingPlugin: action.plugin,
        operationId: action.operationId,
      };
    case "kind":
      return {
        ...state,
        kind: action.kind,
        phase: "source",
        skillPreview: null,
        pluginPreview: null,
        pluginBindings: {},
        bindingsDirty: false,
        editingSkill: null,
        editingPlugin: null,
        error: null,
      };
    case "url":
      return { ...state, url: action.url };
    case "phase":
      return {
        ...state,
        phase: action.phase,
        ...(action.phase === "previewing"
          ? { skillPreview: null, pluginPreview: null, bindingsDirty: false }
          : {}),
        error: action.error === undefined ? state.error : action.error,
      };
    case "skill_preview":
      return {
        ...state,
        phase: "review",
        skillPreview: action.preview,
        pluginPreview: null,
        error: null,
      };
    case "plugin_preview":
      return {
        ...state,
        phase: "review",
        skillPreview: null,
        pluginPreview: action.preview,
        bindingsDirty: false,
        error: null,
      };
    case "plugin_binding":
      return {
        ...state,
        pluginBindings: {
          ...state.pluginBindings,
          [action.componentKey]: action.connectionId,
        },
        bindingsDirty: true,
      };
    case "error":
      return { ...state, phase: "source", error: action.message };
    case "reset":
      return initialSourceImportState();
  }
}

export function workspaceImportedSkills(
  items: readonly CapabilityCatalogItem[],
  installations: readonly CapabilityInstallation[],
): InstalledSourceSkill[] {
  const installationByCapabilityId = new Map(
    installations.map((installation) => [installation.capabilityId, installation]),
  );
  return items.flatMap((item) => {
    if (!isWorkspaceImportedSkill(item)) return [];
    const installation = installationByCapabilityId.get(item.id);
    const sourceUrl = stringValue(item.metadata.sourceUrl) ?? item.installUrl;
    const sourceCommit = stringValue(item.metadata.sourceCommit);
    const contentSha256 = stringValue(item.metadata.contentSha256);
    if (
      !installation ||
      installation.status !== "active" ||
      !sourceUrl ||
      !sourceCommit ||
      !contentSha256
    ) {
      return [];
    }
    return [{ item, installation, sourceUrl, sourceCommit, contentSha256 }];
  });
}

export function isWorkspaceImportedSkill(item: CapabilityCatalogItem): boolean {
  return (
    item.kind === "skill" &&
    item.source === "manual" &&
    item.metadata.platformVersion === 2 &&
    item.metadata.provenance === "workspace_import"
  );
}

export function pluginComponentConnections(
  connections: readonly ConnectionMetadata[] | null,
  component: PluginComponentPreview,
): ConnectionMetadata[] {
  if (!connections || !component.connectionRequired) return [];
  const providerDomain = stringValue(component.facts.providerDomain)?.toLowerCase();
  if (!providerDomain) return [];
  return connections.filter(
    (connection) =>
      connection.status === "active" && connection.providerDomain.toLowerCase() === providerDomain,
  );
}

export function pluginBindingsRequest(
  bindings: Readonly<Record<string, string>>,
): Record<string, { connectionId: string }> {
  return Object.fromEntries(
    Object.entries(bindings).flatMap(([key, connectionId]) =>
      connectionId ? [[key, { connectionId }]] : [],
    ),
  );
}

export function sourceImportValidationError(state: SourceImportState): string | null {
  if (!state.url.trim()) return "Paste a GitHub, skills.sh, or Plugin manifest URL.";
  if (state.kind === "skill") {
    if (!state.skillPreview) return "Preview the Skill before installing.";
    if (state.skillPreview.installed && state.skillPreview.installationVersion === null) {
      return "Refresh the installed Skill version before updating.";
    }
    return null;
  }
  if (!state.pluginPreview) return "Preview the Plugin before installing.";
  if (
    state.editingPlugin &&
    state.pluginPreview.manifest.pluginKey !== state.editingPlugin.pluginKey
  ) {
    return "This source now declares a different Plugin identity. Install it as a new Plugin instead.";
  }
  const missing = state.pluginPreview.components.filter(
    (component) => component.connectionRequired && !state.pluginBindings[component.key],
  );
  if (missing.length > 0) {
    return `Choose an exact Connection for ${missing.map((component) => component.name).join(", ")}.`;
  }
  if (state.bindingsDirty) return "Recheck the Plugin with the selected Connections.";
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
