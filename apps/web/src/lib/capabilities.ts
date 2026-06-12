import type { CapabilityCatalogItem, CapabilityKind, CreateCapabilityInput } from "@/types";

export type CapabilityFilter = "all" | CapabilityKind;

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
  if (/^MCP capability ".+" could not be enabled because OpenGeni could not initialize /.test(description)) {
    return { title: "MCP connection failed", description };
  }
  return { title: fallbackTitle, description };
}

export function cleanApiErrorMessage(message: string): string {
  return message.replace(/^API\s+\d+:\s*/i, "").trim();
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
  return kind === "all" ? "All" : kind === "mcp" ? "MCPs" : `${kind[0]!.toUpperCase()}${kind.slice(1)}s`;
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
