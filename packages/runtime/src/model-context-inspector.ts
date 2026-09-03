import type { ModelRequest, RunContext, SerializedTool, Tool } from "@openai/agents";
import type {
  ModelContextInstructionLayer,
  ModelContextInstructionLayerId,
  ModelContextSkill,
  ModelContextSnapshot,
  ModelContextTool,
} from "@opengeni/contracts";
import { MODEL_CONTEXT_SNAPSHOT_VERSION } from "@opengeni/contracts";
import { estimateSerializedValueTokens, estimateTextTokens } from "./context-compaction";
import { lazyToolRuntimeForAgent } from "./lazy-tool-transport";
import type { EffectiveSkillSelection } from "./runtime-skills";

export type PersistentAgentInstructionLayerDraft = {
  id: ModelContextInstructionLayerId;
  title: string;
  content: string;
};

export type PersistentAgentInstructionInspection = {
  layers: readonly PersistentAgentInstructionLayerDraft[];
  composed: string;
};

const LAYER_TITLES: Record<ModelContextInstructionLayerId, string> = {
  operational_contract: "Operational contract",
  persona_and_core: "Persona and CORE",
  workspace_governance: "Workspace governance",
  session_instructions: "Session instructions",
  workspace_memory: "Workspace memory",
  codemode: "Codemode",
  git_bindings: "Git credential bindings",
  genesis_title: "Missing-title directive",
  sdk_capability_instructions: "SDK capability instructions",
  sandbox_preamble: "Sandbox runtime preamble",
  sandbox_filesystem: "Sandbox filesystem",
  sent_system_instructions: "Sent system instructions",
};

export function joinPersistentAgentInstructionLayers(
  layers: readonly PersistentAgentInstructionLayerDraft[],
): string {
  if (layers.length === 0) return "";
  let composed = layers[0]!.content;
  for (let index = 1; index < layers.length; index += 1) {
    const previous = layers[index - 1]!;
    const current = layers[index]!;
    const separator =
      previous.id === "operational_contract" && current.id === "persona_and_core" ? "\n\n" : " ";
    composed = `${composed}${separator}${current.content}`;
  }
  return composed;
}

export function countedInstructionLayer(
  draft: PersistentAgentInstructionLayerDraft,
): ModelContextInstructionLayer {
  return {
    id: draft.id,
    title: draft.title,
    content: draft.content,
    utf8Bytes: Buffer.byteLength(draft.content, "utf8"),
    estimatedTokens: estimateTextTokens(draft.content),
  };
}

export function splitCapturedInstructions(input: {
  persistentLayers: readonly PersistentAgentInstructionLayerDraft[];
  capturedInstructions: string;
  genesisTitleDirective: string;
}): ModelContextInstructionLayer[] {
  const persistent = input.persistentLayers
    .filter((layer) => layer.content.trim().length > 0)
    .map(countedInstructionLayer);
  const composed = joinPersistentAgentInstructionLayers(input.persistentLayers);
  return splitRawSystemInstructions(
    input.capturedInstructions,
    persistent,
    composed,
    input.genesisTitleDirective,
  );
}

const AGENT_INSTRUCTIONS_HEADING = "# Agent instructions\n\n";
const CAPABILITY_INSTRUCTIONS_HEADING = "# Sandbox capability instructions\n\n";
const FILESYSTEM_HEADING = "# Filesystem\n";

const SDK_SECTION_HEADINGS = [
  "# Agent instructions\n",
  "# Sandbox capability instructions\n",
  "# Sandbox remote mount policy\n",
  "# Filesystem\n",
] as const;

function nextSdkSectionIndex(text: string): number {
  let found = -1;
  for (const heading of SDK_SECTION_HEADINGS) {
    const index = text.indexOf(`\n${heading}`);
    if (index >= 0 && (found < 0 || index < found)) found = index;
  }
  return found;
}

function splitRawSystemInstructions(
  captured: string,
  persistent: ModelContextInstructionLayer[],
  composed: string,
  genesisTitleDirective: string,
): ModelContextInstructionLayer[] {
  let text = captured;
  const layers: ModelContextInstructionLayer[] = [];
  let genesis = genesisTitleDirective;
  if (genesis && (text === ` ${genesis}` || text.endsWith(` ${genesis}`))) {
    text = text === ` ${genesis}` ? "" : text.slice(0, text.length - genesis.length - 1);
  } else {
    genesis = "";
  }

  const agentHeadingAt = text.indexOf(AGENT_INSTRUCTIONS_HEADING);
  if (agentHeadingAt >= 0) {
    const preamble = text.slice(0, agentHeadingAt).trimEnd();
    if (preamble) {
      layers.push(
        countedInstructionLayer({
          id: "sandbox_preamble",
          title: LAYER_TITLES.sandbox_preamble,
          content: preamble,
        }),
      );
    }
    const afterHeading = text.slice(agentHeadingAt + AGENT_INSTRUCTIONS_HEADING.length);
    const nextHeading = nextSdkSectionIndex(afterHeading);
    const agentBody = (
      nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading
    ).trimEnd();
    const rest = nextHeading >= 0 ? afterHeading.slice(nextHeading).replace(/^\n/, "") : "";
    if (composed && (agentBody === composed || agentBody.startsWith(composed))) {
      layers.push(...persistent);
      const leftover = agentBody === composed ? "" : agentBody.slice(composed.length).trim();
      if (leftover) {
        layers.push(
          countedInstructionLayer({
            id: "sdk_capability_instructions",
            title: LAYER_TITLES.sdk_capability_instructions,
            content: leftover,
          }),
        );
      }
    } else if (agentBody) {
      layers.push(
        countedInstructionLayer({
          id: "persona_and_core",
          title: "Agent instructions",
          content: agentBody,
        }),
      );
    }
    text = rest;
  } else if (composed && text.startsWith(composed)) {
    layers.push(...persistent);
    text = text.slice(composed.length);
  } else if (text.trim()) {
    layers.push(
      countedInstructionLayer({
        id: "sent_system_instructions",
        title: LAYER_TITLES.sent_system_instructions,
        content: text,
      }),
    );
    text = "";
  }

  const capabilityAt = text.indexOf(CAPABILITY_INSTRUCTIONS_HEADING);
  if (capabilityAt >= 0) {
    const before = text.slice(0, capabilityAt).trim();
    if (before) {
      layers.push(
        countedInstructionLayer({
          id: "sdk_capability_instructions",
          title: LAYER_TITLES.sdk_capability_instructions,
          content: before,
        }),
      );
    }
    const after = text.slice(capabilityAt + CAPABILITY_INSTRUCTIONS_HEADING.length);
    const nextHeading = nextSdkSectionIndex(after);
    const body = (nextHeading >= 0 ? after.slice(0, nextHeading) : after).trimEnd();
    if (body) {
      layers.push(
        countedInstructionLayer({
          id: "sdk_capability_instructions",
          title: LAYER_TITLES.sdk_capability_instructions,
          content: body,
        }),
      );
    }
    text = nextHeading >= 0 ? after.slice(nextHeading).replace(/^\n/, "") : "";
  }

  const filesystemAt = text.indexOf(FILESYSTEM_HEADING);
  if (filesystemAt >= 0) {
    const before = text.slice(0, filesystemAt).trim();
    if (before) {
      layers.push(
        countedInstructionLayer({
          id: "sdk_capability_instructions",
          title: LAYER_TITLES.sdk_capability_instructions,
          content: before,
        }),
      );
    }
    layers.push(
      countedInstructionLayer({
        id: "sandbox_filesystem",
        title: LAYER_TITLES.sandbox_filesystem,
        content: text.slice(filesystemAt).trimEnd(),
      }),
    );
    text = "";
  }

  if (text.trim()) {
    layers.push(
      countedInstructionLayer({
        id: "sdk_capability_instructions",
        title: LAYER_TITLES.sdk_capability_instructions,
        content: text.trim(),
      }),
    );
  }
  if (genesis) {
    layers.push(
      countedInstructionLayer({
        id: "genesis_title",
        title: LAYER_TITLES.genesis_title,
        content: genesis,
      }),
    );
  }
  return layers.length > 0
    ? layers
    : [
        countedInstructionLayer({
          id: "sent_system_instructions",
          title: LAYER_TITLES.sent_system_instructions,
          content: captured,
        }),
      ];
}

function countedTool(input: {
  name: string;
  type: string;
  visibility: ModelContextTool["visibility"];
  description?: string;
  namespace?: string;
  schema?: unknown;
}): ModelContextTool {
  const schema = input.schema;
  const utf8Bytes = Buffer.byteLength(
    JSON.stringify({
      name: input.name,
      type: input.type,
      description: input.description,
      namespace: input.namespace,
      schema,
    }),
    "utf8",
  );
  return {
    name: input.name,
    type: input.type,
    visibility: input.visibility,
    ...(input.description ? { description: input.description } : {}),
    ...(input.namespace ? { namespace: input.namespace } : {}),
    ...(schema !== undefined ? { schema } : {}),
    utf8Bytes,
    estimatedTokens: estimateSerializedValueTokens({
      name: input.name,
      type: input.type,
      description: input.description,
      namespace: input.namespace,
      schema,
    }),
  };
}

function serializedToolToModelContextTool(
  tool: SerializedTool,
  visibility: ModelContextTool["visibility"],
): ModelContextTool {
  const record = tool as SerializedTool & {
    name?: string;
    description?: string;
    namespace?: string;
    parameters?: unknown;
    providerData?: unknown;
  };
  const schema =
    record.parameters !== undefined
      ? record.parameters
      : record.providerData !== undefined
        ? record.providerData
        : undefined;
  return countedTool({
    name: typeof record.name === "string" && record.name.length > 0 ? record.name : tool.type,
    type: tool.type,
    visibility,
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    ...(typeof record.namespace === "string" ? { namespace: record.namespace } : {}),
    ...(schema !== undefined ? { schema } : {}),
  });
}

export function skillsFromSelections(
  selections: readonly EffectiveSkillSelection[],
): ModelContextSkill[] {
  return selections.map((selection) => ({
    kind: selection.source === "native_tool" ? "native_tool_skill" : "runtime_skill",
    name: selection.name,
    description: selection.reason,
    source: selection.source,
  }));
}

export function skillsFromGovernanceLayer(content: string): ModelContextSkill[] {
  const skills: ModelContextSkill[] = [];
  const marker = "Skill descriptors (full instructions are on-demand):\n";
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf(marker, cursor);
    if (start < 0) break;
    const jsonStart = start + marker.length;
    if (content[jsonStart] !== "[") {
      cursor = jsonStart;
      continue;
    }
    let depth = 0;
    let end = jsonStart;
    for (; end < content.length; end += 1) {
      const char = content[end];
      if (char === "[") depth += 1;
      else if (char === "]") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    try {
      const parsed = JSON.parse(content.slice(jsonStart, end)) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (!entry || typeof entry !== "object") continue;
          const record = entry as Record<string, unknown>;
          const name =
            typeof record.title === "string"
              ? record.title
              : typeof record.stableKey === "string"
                ? record.stableKey
                : null;
          const description = typeof record.description === "string" ? record.description : "";
          if (!name) continue;
          skills.push({
            kind: "preference_descriptor",
            name,
            description,
            source: typeof record.scope === "string" ? record.scope : undefined,
          });
        }
      }
    } catch {
      // Governance JSON is exact prompt text; a parse failure just omits the
      // structured skill list while the raw layer remains visible.
    }
    cursor = end;
  }
  return skills;
}

export async function buildModelContextSnapshot(input: {
  agent: { getAllTools: (runContext: RunContext) => Promise<Tool[]> };
  capturedInstructions: string;
  persistentLayers: readonly PersistentAgentInstructionLayerDraft[];
  genesisTitleDirective: string;
  requestIndex: number;
  serializeVisibleTools: (agent: {
    getAllTools: (runContext: RunContext) => Promise<Tool[]>;
  }) => Promise<SerializedTool[]>;
  skillSelections: readonly EffectiveSkillSelection[];
  now?: Date;
}): Promise<ModelContextSnapshot> {
  const layers = splitCapturedInstructions({
    persistentLayers: input.persistentLayers,
    capturedInstructions: input.capturedInstructions,
    genesisTitleDirective: input.genesisTitleDirective,
  });
  const visibleTools = await input.serializeVisibleTools(input.agent);
  const visibleNames = new Set(
    visibleTools.map((tool) => {
      const name = (tool as { name?: string }).name;
      return typeof name === "string" ? name : "";
    }),
  );
  const tools: ModelContextTool[] = visibleTools.map((tool) =>
    serializedToolToModelContextTool(tool, "eager"),
  );
  const runtime = lazyToolRuntimeForAgent(input.agent);
  for (const searchable of runtime?.inspectSearchableTools() ?? []) {
    if (visibleNames.has(searchable.name)) continue;
    tools.push(
      countedTool({
        name: searchable.name,
        type: "function",
        visibility: "searchable",
        description: searchable.description,
        schema: searchable.parameters,
      }),
    );
  }
  const governance = layers.find((layer) => layer.id === "workspace_governance")?.content ?? "";
  const skills = [
    ...skillsFromGovernanceLayer(governance),
    ...skillsFromSelections(input.skillSelections),
  ];
  const instructionsTokens = estimateTextTokens(input.capturedInstructions);
  const toolsTokens = tools.reduce((total, tool) => total + tool.estimatedTokens, 0);
  return {
    version: MODEL_CONTEXT_SNAPSHOT_VERSION,
    capturedAt: (input.now ?? new Date()).toISOString(),
    source: "model_request",
    requestIndex: input.requestIndex,
    instructions: input.capturedInstructions,
    layers,
    tools,
    skills,
    tokens: {
      instructions: instructionsTokens,
      tools: toolsTokens,
      prefix: instructionsTokens + toolsTokens,
    },
  };
}

export function createModelVisibleContextCaptureFilter(input: {
  persistentLayers: readonly PersistentAgentInstructionLayerDraft[];
  genesisTitleDirective: string;
  serializeVisibleTools: (agent: {
    getAllTools: (runContext: RunContext) => Promise<Tool[]>;
  }) => Promise<SerializedTool[]>;
  skillSelectionsFor: (agent: object) => readonly EffectiveSkillSelection[];
  onCapture: (snapshot: ModelContextSnapshot) => void | Promise<void>;
}): import("@openai/agents").CallModelInputFilter {
  let requestIndex = 0;
  return async ({ modelData, agent }) => {
    requestIndex += 1;
    const instructions = typeof modelData.instructions === "string" ? modelData.instructions : "";
    try {
      const snapshot = await buildModelContextSnapshot({
        agent,
        capturedInstructions: instructions,
        persistentLayers: input.persistentLayers,
        genesisTitleDirective: input.genesisTitleDirective,
        requestIndex,
        serializeVisibleTools: input.serializeVisibleTools,
        skillSelections: input.skillSelectionsFor(agent),
      });
      await input.onCapture(snapshot);
    } catch {
      // Capture is observational. A failure must never change model execution.
    }
    return modelData;
  };
}

export function buildModelContextSnapshotFromRequest(input: {
  request: ModelRequest;
  agent: object;
  persistentLayers: readonly PersistentAgentInstructionLayerDraft[];
  genesisTitleDirective: string;
  requestIndex: number;
  skillSelections: readonly EffectiveSkillSelection[];
  now?: Date;
}): ModelContextSnapshot {
  const capturedInstructions =
    typeof input.request.systemInstructions === "string" ? input.request.systemInstructions : "";
  const layers = splitCapturedInstructions({
    persistentLayers: input.persistentLayers,
    capturedInstructions,
    genesisTitleDirective: input.genesisTitleDirective,
  });
  const visibleTools = Array.isArray(input.request.tools) ? input.request.tools : [];
  const visibleNames = new Set(
    visibleTools.map((tool) => {
      const name = (tool as { name?: string }).name;
      return typeof name === "string" ? name : "";
    }),
  );
  const tools: ModelContextTool[] = visibleTools.map((tool) =>
    serializedToolToModelContextTool(tool, "eager"),
  );
  const runtime = lazyToolRuntimeForAgent(input.agent);
  for (const searchable of runtime?.inspectSearchableTools() ?? []) {
    if (visibleNames.has(searchable.name)) continue;
    tools.push(
      countedTool({
        name: searchable.name,
        type: "function",
        visibility: "searchable",
        description: searchable.description,
        schema: searchable.parameters,
      }),
    );
  }
  const governance = layers.find((layer) => layer.id === "workspace_governance")?.content ?? "";
  const skills = [
    ...skillsFromGovernanceLayer(governance),
    ...skillsFromSelections(input.skillSelections),
  ];
  const instructionsTokens = estimateTextTokens(capturedInstructions);
  const toolsTokens = tools.reduce((total, tool) => total + tool.estimatedTokens, 0);
  return {
    version: MODEL_CONTEXT_SNAPSHOT_VERSION,
    capturedAt: (input.now ?? new Date()).toISOString(),
    source: "model_request",
    requestIndex: input.requestIndex,
    instructions: capturedInstructions,
    layers,
    tools,
    skills,
    tokens: {
      instructions: instructionsTokens,
      tools: toolsTokens,
      prefix: instructionsTokens + toolsTokens,
    },
  };
}
