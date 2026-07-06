import type { CapabilityCatalogItem, CapabilityKind, CapabilitySource, ConnectionMetadata, CreateCapabilityInput } from "@/types";

export type CapabilityFilter = "all" | CapabilityKind;

// Human copy for every taxonomy value that used to leak enum slugs into the UI
// (doctrine: no internal taxonomy in user-facing labels). Codes appear at most
// as fallbacks for values we don't recognize.

/** Singular human label for a capability kind ("MCP server", "API"…). */
export function capabilityKindLabel(kind: CapabilityKind): string {
  switch (kind) {
    case "pack": return "Pack";
    case "mcp": return "MCP server";
    case "api": return "API";
    case "skill": return "Skill";
    case "plugin": return "Plugin";
    default: return kind;
  }
}

/** Human label for where a catalog item came from. */
export function capabilitySourceLabel(source: CapabilitySource | string): string {
  switch (source) {
    case "built_in": return "Built in";
    case "configured": return "Configured";
    case "public_registry":
    case "registry": return "Public registry";
    case "manual": return "Added";
    default: return String(source).replaceAll("_", " ");
  }
}

export type CapabilityFormState = {
  kind: Exclude<CapabilityKind, "pack">;
  name: string;
  description: string;
  category: string;
  tags: string;
  endpointUrl: string;
  homepageUrl: string;
  installUrl: string;
  enableAfterAdd: boolean;
};

export function emptyCapabilityForm(): CapabilityFormState {
  return {
    kind: "mcp",
    name: "",
    description: "",
    category: "custom",
    tags: "",
    endpointUrl: "",
    homepageUrl: "",
    installUrl: "",
    enableAfterAdd: true,
  };
}

export function filterCapabilityCatalogItems(items: CapabilityCatalogItem[], filter: CapabilityFilter, query: string): CapabilityCatalogItem[] {
  const normalized = query.trim().toLowerCase();
  return items.filter((item) => {
    if (filter !== "all" && item.kind !== filter) {
      return false;
    }
    if (!normalized) {
      return true;
    }
    return [
      item.name,
      item.description,
      item.kind,
      item.source,
      item.category,
      item.endpointUrl,
      item.homepageUrl,
      item.installUrl,
      ...item.tags,
      JSON.stringify(item.metadata),
    ].filter(Boolean).join(" ").toLowerCase().includes(normalized);
  });
}

export function capabilityErrorToast(error: unknown, fallbackTitle: string): { title: string; description: string } {
  const description = cleanApiErrorMessage(error instanceof Error ? error.message : String(error));
  // The raw "requires credentials; pass them in the enable request 'headers'
  // field" 422 is an API-only contract detail — never surface it verbatim. The
  // UI collects credentials in the connect sheet before enabling, so this only
  // fires as a fallback; translate it to plain language.
  if (isMissingCredentialsError(error)) {
    return { title: "Credentials needed", description: "This integration needs to be connected before it can be enabled." };
  }
  if (/^MCP capability ".+" could not be enabled because OpenGeni could not initialize /.test(description)) {
    return { title: "Connection failed", description };
  }
  return { title: fallbackTitle, description };
}

/**
 * The enable-path 422 raised when a credentialed MCP is enabled without a
 * connection ref or headers. The connect sheet catches this to route the user
 * into the credential form instead of showing the raw API string.
 */
export function isMissingCredentialsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /requires credentials/i.test(message) && /headers|credential|connection/i.test(message);
}

export function cleanApiErrorMessage(message: string): string {
  return message.replace(/^API\s+\d+:\s*/i, "").trim();
}

// --- Connect plan ----------------------------------------------------------------------------
// How a catalog item becomes usable, derived entirely from the catalog fields.
// Only MCP servers carry credentials; every other kind just tracks/enables.

export type RequiredHeaderField = {
  /** The wire header name the broker injects (e.g. "X-API-Key"). */
  name: string;
  /** Human label for the input — never the word "headers". */
  label: string;
};

export type CapabilityConnectPlan =
  | { mode: "enable" }
  | { mode: "oauth"; providerDomain: string; mcpUrl: string | null }
  | { mode: "api_key"; providerDomain: string; fields: RequiredHeaderField[] };

export function capabilityConnectPlan(item: CapabilityCatalogItem): CapabilityConnectPlan {
  // Non-runtime kinds and MCPs with no auth just enable/track directly.
  if (item.kind !== "mcp") {
    return { mode: "enable" };
  }
  const providerDomain = item.providerDomain ?? domainFromUrl(item.mcpUrl ?? item.endpointUrl) ?? "";
  if (item.authKind === "oauth2") {
    return { mode: "oauth", providerDomain, mcpUrl: item.mcpUrl ?? item.endpointUrl };
  }
  const requiredHeaders = stringArray((item.metadata as Record<string, unknown>).requiredHeaders);
  if (requiredHeaders.length > 0) {
    return { mode: "api_key", providerDomain, fields: requiredHeaders.map(headerField) };
  }
  return { mode: "enable" };
}

/** Short auth hint for a tile ("OAuth" / "API key"), or null when none applies. */
export function capabilityAuthHint(item: CapabilityCatalogItem): string | null {
  const plan = capabilityConnectPlan(item);
  if (plan.mode === "oauth") return "OAuth";
  if (plan.mode === "api_key") return "API key";
  return null;
}

function headerField(name: string): RequiredHeaderField {
  return { name, label: headerFieldLabel(name) };
}

const headerLabelAcronyms = new Set(["API", "URL", "JWT", "SSO", "OTP", "PAT"]);

function headerFieldLabel(name: string): string {
  if (/api[\s_-]?key/i.test(name) || /^authorization$/i.test(name)) {
    return "API key";
  }
  const cleaned = name.replace(/^x-/i, "").replaceAll(/[-_]+/g, " ").trim();
  // Sentence-case all-caps words so DD-APPLICATION-KEY reads "DD Application
  // Key"; two-letter vendor prefixes and real acronyms keep their caps.
  const titled = cleaned
    .split(/\s+/)
    .map((word) => (word === word.toUpperCase() && word.length > 2 && !headerLabelAcronyms.has(word)
      ? word[0] + word.slice(1).toLowerCase()
      : word.replace(/^\w/, (character) => character.toUpperCase())))
    .join(" ");
  return titled || "Credential";
}

export function domainFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * The workspace-shared connection backing a capability, matched by provider
 * domain. Used to surface connection health ("Connected" / "Needs attention")
 * on enabled items. subjectId === null is the workspace-shared connection the
 * enable path requires.
 */
export function connectionForCapability(item: CapabilityCatalogItem, connections: ConnectionMetadata[]): ConnectionMetadata | null {
  const plan = capabilityConnectPlan(item);
  const providerDomain = plan.mode === "enable" ? item.providerDomain : plan.providerDomain;
  if (!providerDomain) return null;
  return connections.find((connection) => connection.subjectId === null && connection.providerDomain === providerDomain) ?? null;
}

/** First one or two initials for the logo monogram fallback. */
export function capabilityMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

export type PackConnectorSummary = {
  id: string;
  name: string;
  authModel: string | null;
  providers: string[];
  scopes: string[];
  required: boolean;
};

export type PackKnowledgeSummary = {
  id: string;
  name: string;
  description: string | null;
};

export type PackScheduledTaskTemplateSummary = {
  id: string;
  name: string;
  scheduleSummary: string;
};

export type PackContentsSummary = {
  hasContents: boolean;
  mcpServerIds: string[];
  firstPartyMcpTools: string[];
  skills: string[];
  connectors: PackConnectorSummary[];
  knowledge: PackKnowledgeSummary[];
  scheduledTaskTemplates: PackScheduledTaskTemplateSummary[];
};

export function summarizePackContents(item: CapabilityCatalogItem): PackContentsSummary | null {
  if (item.kind !== "pack") {
    return null;
  }
  const metadata = item.metadata;
  const mcpServerIds = uniqueStrings(item.tools.filter((tool) => tool.kind === "mcp").map((tool) => tool.id));
  const firstPartyMcpTools = uniqueStrings(stringArray(metadata.firstPartyMcpTools));
  const skills = uniqueStrings([
    stringValue(metadata.skill),
    ...stringArray(metadata.skills),
  ]);
  const connectors = recordArray(metadata.connectors).map((connector) => ({
    id: stringValue(connector.id) ?? stringValue(connector.name) ?? "connector",
    name: stringValue(connector.name) ?? stringValue(connector.id) ?? "Connector",
    authModel: stringValue(connector.authModel),
    providers: stringArray(connector.providers),
    scopes: stringArray(connector.scopes),
    required: connector.required === true,
  }));
  const knowledge = recordArray(metadata.knowledge).map((entry) => ({
    id: stringValue(entry.id) ?? stringValue(entry.name) ?? "knowledge",
    name: stringValue(entry.name) ?? stringValue(entry.id) ?? "Knowledge",
    description: stringValue(entry.description),
  }));
  const scheduledTaskTemplates = recordArray(metadata.scheduledTaskTemplates).map((template) => ({
    id: stringValue(template.id) ?? stringValue(template.name) ?? "schedule",
    name: stringValue(template.name) ?? stringValue(template.id) ?? "Scheduled task",
    scheduleSummary: scheduleSummaryForMetadata(template.defaultSchedule),
  }));
  return {
    hasContents: mcpServerIds.length > 0
      || firstPartyMcpTools.length > 0
      || skills.length > 0
      || connectors.length > 0
      || knowledge.length > 0
      || scheduledTaskTemplates.length > 0,
    mcpServerIds,
    firstPartyMcpTools,
    skills,
    connectors,
    knowledge,
    scheduledTaskTemplates,
  };
}

export function scheduleSummaryForMetadata(value: unknown): string {
  const schedule = recordValue(value);
  if (!schedule) {
    return "Custom schedule";
  }
  const type = stringValue(schedule.type);
  if (type === "calendar") {
    const hour = numberValue(schedule.hour);
    const minute = numberValue(schedule.minute);
    const timeZone = stringValue(schedule.timeZone) ?? "UTC";
    if (hour !== null && minute !== null) {
      return `Calendar at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${timeZone}`;
    }
    return `Calendar schedule in ${timeZone}`;
  }
  if (type === "interval") {
    const everySeconds = numberValue(schedule.everySeconds);
    return everySeconds ? `Every ${everySeconds} seconds` : "Interval schedule";
  }
  if (type === "once") {
    return stringValue(schedule.runAt) ? `Once at ${stringValue(schedule.runAt)}` : "One-time schedule";
  }
  return type ? `${type} schedule` : "Custom schedule";
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordValue).filter((entry): entry is Record<string, unknown> => Boolean(entry)) : [];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringValue).filter((entry): entry is string => Boolean(entry)) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function capabilityCounts(items: CapabilityCatalogItem[]): Record<CapabilityFilter, number> {
  return {
    all: items.length,
    pack: items.filter((item) => item.kind === "pack").length,
    mcp: items.filter((item) => item.kind === "mcp").length,
    api: items.filter((item) => item.kind === "api").length,
    skill: items.filter((item) => item.kind === "skill").length,
    plugin: items.filter((item) => item.kind === "plugin").length,
  };
}

export function capabilityFilterLabel(kind: CapabilityFilter): string {
  switch (kind) {
    case "all": return "All";
    case "pack": return "Packs";
    case "mcp": return "MCP servers";
    case "api": return "APIs";
    case "skill": return "Skills";
    case "plugin": return "Plugins";
    default: return kind;
  }
}

export function createInputFromCatalogItem(item: CapabilityCatalogItem): CreateCapabilityInput {
  return {
    id: item.id,
    kind: item.kind as Exclude<CapabilityKind, "pack">,
    source: item.source,
    name: item.name,
    ...(item.description ? { description: item.description } : {}),
    category: item.category,
    tags: item.tags,
    ...(item.homepageUrl ? { homepageUrl: item.homepageUrl } : {}),
    ...(item.endpointUrl ? { endpointUrl: item.endpointUrl } : {}),
    ...(item.installUrl ? { installUrl: item.installUrl } : {}),
    ...(item.authModel ? { authModel: item.authModel } : {}),
    metadata: item.metadata,
  };
}

/**
 * Kind-aware validation for the "Add custom" dialog. Only MCP servers need an
 * endpoint URL — that field is hidden for every other kind (the user's explicit
 * complaint was being asked for an endpoint when tracking a skill).
 */
export function capabilityFormError(form: CapabilityFormState): string | null {
  if (!form.name.trim()) {
    return "Give it a name.";
  }
  if (form.kind === "mcp") {
    const url = form.endpointUrl.trim();
    if (!url) {
      return "Enter the MCP server URL.";
    }
    if (!isLikelyUrl(url)) {
      return "Enter a valid URL, including https://.";
    }
  }
  return null;
}

function isLikelyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function capabilityInputFromForm(form: CapabilityFormState): CreateCapabilityInput | null {
  const name = form.name.trim();
  if (!name) {
    return null;
  }
  return {
    kind: form.kind,
    source: "manual",
    name,
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    category: form.category.trim() || "custom",
    tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    ...(form.endpointUrl.trim() ? { endpointUrl: form.endpointUrl.trim() } : {}),
    ...(form.homepageUrl.trim() ? { homepageUrl: form.homepageUrl.trim() } : {}),
    ...(form.installUrl.trim() ? { installUrl: form.installUrl.trim() } : {}),
  };
}
