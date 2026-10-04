/**
 * Agent learning as part of "what the agent can do". Skills and Knowledge are
 * each one choice, Off / Read / Read and write, made of two stored settings:
 * the capability (which tools the agent gets) and the Agent learning mode
 * (whether its saves apply right away, wait for review, or are refused).
 * Showing them together means the two can never disagree on screen: write
 * tools with learning Off read as "Read", and choosing "Read and write" turns
 * learning back on.
 */
import { DEFAULT_AGENT_LEARNING } from "@opengeni/contracts";
import type {
  AgentLearningCategory,
  AgentLearningContext,
  AgentLearningMode,
  AgentLearningSettingsRecord,
} from "@opengeni/sdk";
import { useCallback, useEffect, useState } from "react";

import { useAppContext } from "@/context";

export type LearningModes = Record<AgentLearningCategory, AgentLearningMode>;

export const LEARNING_CATEGORIES: readonly AgentLearningCategory[] = [
  "knowledge",
  "instructions",
  "skills",
];

export type AccessLevel = "off" | "read" | "write";

export const ACCESS_OPTIONS: readonly { value: AccessLevel; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read" },
  { value: "write", label: "Read and write" },
];

/** The learning settings a picker shows and edits beside Skills and Knowledge. */
export interface CapabilityLearning {
  modes: LearningModes;
  onChange: (modes: LearningModes) => void;
}

export function learningModesEqual(a: LearningModes, b: LearningModes): boolean {
  return LEARNING_CATEGORIES.every((category) => a[category] === b[category]);
}

/** Skills: write tools whose saves are all refused are, in effect, read only. */
export function skillsAccess(skills: false | "read" | "manage", modes: LearningModes): AccessLevel {
  if (skills === false) return "off";
  return skills === "manage" && modes.skills !== "off" ? "write" : "read";
}

/** Knowledge: on, with neither knowledge nor instruction saves allowed, is read only. */
export function knowledgeAccess(knowledge: boolean, modes: LearningModes): AccessLevel {
  if (!knowledge) return "off";
  return modes.knowledge === "off" && modes.instructions === "off" ? "read" : "write";
}

/** Learning after choosing Read and write: anything that was Off gets its default back. */
export function enableWrites(
  modes: LearningModes,
  categories: readonly AgentLearningCategory[],
): LearningModes {
  const next = { ...modes };
  for (const category of categories) {
    if (next[category] === "off") {
      next[category] =
        DEFAULT_AGENT_LEARNING[category] === "off"
          ? "review_first"
          : DEFAULT_AGENT_LEARNING[category];
    }
  }
  return next;
}

/** Learning after choosing Read: the agent may look but saves nothing. */
export function disableWrites(
  modes: LearningModes,
  categories: readonly AgentLearningCategory[],
): LearningModes {
  const next = { ...modes };
  for (const category of categories) next[category] = "off";
  return next;
}

function effectiveModes(
  record: AgentLearningSettingsRecord | null,
  defaults: AgentLearningSettingsRecord | null,
): LearningModes {
  return Object.fromEntries(
    LEARNING_CATEGORIES.map((category) => [
      category,
      record?.settings[category] ??
        defaults?.settings[category] ??
        DEFAULT_AGENT_LEARNING[category],
    ]),
  ) as LearningModes;
}

export interface LearningSettingsState {
  /** What applies: a chat's own choice, else the default. Null while loading. */
  modes: LearningModes | null;
  error: unknown;
  /**
   * Saves only what changed. For a chat, a changed category becomes this
   * chat's own choice; for defaults, the whole record is written.
   */
  save: (next: LearningModes) => Promise<void>;
}

/** Agent learning for one scope (shared chats or private chats), or one chat in it. */
export function useLearningSettings(props: {
  workspaceId: string;
  scope: "workspace" | "personal";
  source?: AgentLearningContext | undefined;
  enabled?: boolean;
}): LearningSettingsState {
  const { client } = useAppContext();
  const [record, setRecord] = useState<AgentLearningSettingsRecord | null>(null);
  const [defaults, setDefaults] = useState<AgentLearningSettingsRecord | null>(null);
  const [error, setError] = useState<unknown>(null);
  const sourceKind = props.source?.kind;
  const sourceId = props.source?.id;
  const enabled = props.enabled !== false;
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setRecord(null);
    setDefaults(null);
    setError(null);
    const source = sourceKind && sourceId ? { kind: sourceKind, id: sourceId } : undefined;
    void Promise.all([
      client.getAgentLearningSettings(props.workspaceId, props.scope, source),
      source ? client.getAgentLearningSettings(props.workspaceId, props.scope) : null,
    ])
      .then(([value, base]) => {
        if (!current) return;
        setRecord(value);
        setDefaults(base ?? value);
      })
      .catch((reason: unknown) => {
        if (current) setError(reason);
      });
    return () => {
      current = false;
    };
  }, [client, props.workspaceId, props.scope, sourceKind, sourceId, enabled]);

  const save = useCallback(
    async (next: LearningModes) => {
      if (!record) throw new Error("Agent learning hasn't loaded yet. Try again.");
      const before = effectiveModes(record, defaults);
      const changed = LEARNING_CATEGORIES.filter((category) => next[category] !== before[category]);
      if (changed.length === 0) return;
      const source = sourceKind && sourceId ? { kind: sourceKind, id: sourceId } : undefined;
      const saved = await client.saveAgentLearningSettings(props.workspaceId, {
        scope: props.scope,
        ...(source ? { source } : {}),
        operationId: crypto.randomUUID(),
        expectedVersion: record.version,
        settings: source
          ? Object.fromEntries(changed.map((category) => [category, next[category]]))
          : { ...record.settings, ...next },
      });
      setRecord(saved);
      if (!source) setDefaults(saved);
    },
    [client, record, defaults, props.workspaceId, props.scope, sourceKind, sourceId],
  );

  return { modes: record ? effectiveModes(record, defaults) : null, error, save };
}
