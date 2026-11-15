/**
 * Model levels: a host-defined short list of choices ("Standard", "Thorough")
 * that stands in for the full model picker. Each level maps to one model and
 * one reasoning effort, and may allow Ultrafast. This module is free of any
 * renderer; the web control and the native control both render from it.
 *
 * Levels restrict the picker only. They never change which models the
 * workspace can run, and a chat already on another model keeps it until the
 * person picks a level.
 */
import type { ClientModel, LatencyMode, ReasoningEffort } from "@opengeni/sdk";
import { modelDisplayName } from "@opengeni/sdk/model-display";
import {
  coerceReasoningEffortForModel,
  findPickerRow,
  labelReasoningEffort,
  modelOffersEffortChoice,
  projectClientModelRows,
  runnableLatencyModesForModel,
  type PickerModelRow,
} from "./model-policy";
import { type OpenGeniText } from "./messages/runtime";

type ClientPickerModelRow = PickerModelRow<ClientModel>;

/** One host-defined level. */
export type ModelLevel = {
  /** Stable id, for example "standard". */
  id: string;
  /** What people see, for example "Standard" or "Thorough". */
  label: string;
  /** Catalog model id this level runs. */
  model: string;
  /** Reasoning effort this level runs at. */
  effort: ReasoningEffort;
  /**
   * Offer Ultrafast on this level. It still appears only when the catalog says
   * this model can run Ultrafast, and it always takes a deliberate gesture.
   */
  ultrafast?: boolean | undefined;
};

export type ModelLevelState = {
  level: ModelLevel;
  row: ClientPickerModelRow;
  /** Ultrafast is allowed by the host and runnable for this model. */
  ultrafastAvailable: boolean;
  /** What Ultrafast costs on this level ("8× usage"), or null when unknown or unavailable. */
  ultrafastCost: string | null;
};

export type ModelLevelsView = {
  /** Levels whose model this workspace can run, in host order. */
  levels: ModelLevelState[];
  /** The level the chat is on, or -1 when it runs something else. */
  index: number;
  /** The chat runs Ultrafast on its level. */
  ultrafast: boolean;
  /** The chat's own model and effort, for the state outside the levels. */
  customLabel: string;
  /** What Ultrafast costs on the chat's level, or null. */
  ultrafastCost: string | null;
};

export type ModelLevelsInput = {
  levels: readonly ModelLevel[];
  models?: ClientModel[] | undefined;
  rows?: PickerModelRow[] | undefined;
  model: string;
  effort: ReasoningEffort;
  latencyMode: LatencyMode;
  /** Text shown with a fresh Ultrafast on a ChatGPT/Codex plan; default "8× usage". */
  ultrafastUsageHint?: string | undefined;
};

/**
 * What the level control shows. Returns null when no level can run, so the
 * surface shows the full picker (which explains how to connect a model).
 */
export function modelLevelsView(t: OpenGeniText, input: ModelLevelsInput): ModelLevelsView | null {
  const rows: ClientPickerModelRow[] =
    input.rows !== undefined ? input.rows : projectClientModelRows(t, input.models ?? []);
  const levels: ModelLevelState[] = [];
  for (const level of input.levels) {
    const row = findPickerRow(rows, level.model);
    if (!row?.selectable) continue;
    const ultrafastAvailable =
      level.ultrafast === true && runnableLatencyModesForModel(row.catalog).includes("ultrafast");
    levels.push({
      level,
      row,
      ultrafastAvailable,
      ultrafastCost: ultrafastAvailable ? ultrafastCost(row, input.ultrafastUsageHint) : null,
    });
  }
  if (levels.length === 0) return null;
  const current = findPickerRow(rows, input.model);
  const effort = current
    ? coerceReasoningEffortForModel(current.catalog, input.effort)
    : input.effort;
  const index = levels.findIndex(
    ({ level, row }) =>
      level.model === input.model &&
      coerceReasoningEffortForModel(row.catalog, level.effort) === effort,
  );
  const onLevel = index >= 0 ? levels[index]! : null;
  return {
    levels,
    index,
    ultrafast: onLevel?.ultrafastAvailable === true && input.latencyMode === "ultrafast",
    customLabel: customLabel(t, input, current),
    ultrafastCost: onLevel?.ultrafastCost ?? null,
  };
}

/** "Small · Medium": the chat's own model, short, with its effort when it has one. */
function customLabel(
  t: OpenGeniText,
  input: ModelLevelsInput,
  row: ClientPickerModelRow | null,
): string {
  const name = row ? (row.shortLabel ?? row.label) : modelDisplayName(input.model);
  if (row && !modelOffersEffortChoice(row.catalog)) return name;
  return `${name} · ${labelReasoningEffort(t, input.effort)}`;
}

function ultrafastCost(row: ClientPickerModelRow, usageHint: string | undefined): string | null {
  if (row.billingClass === "codex_subscription") return usageHint ?? "8× usage";
  const bps = row.catalog.capabilities?.latencyModes.find(
    (mode) => mode.id === "ultrafast",
  )?.billingMultiplierBps;
  return bps && bps > 10_000 ? `${bps / 10_000}× rate` : null;
}

export type ModelLevelChoice = {
  model: string;
  effort: ReasoningEffort;
  latencyMode: LatencyMode;
};

/**
 * The policy a level runs. Ultrafast holds only on a level that offers it;
 * every other choice runs at standard speed.
 */
export function modelLevelChoice(
  view: ModelLevelsView,
  index: number,
  ultrafast: boolean,
): ModelLevelChoice | null {
  const state = view.levels[index];
  if (!state) return null;
  return {
    model: state.level.model,
    effort: coerceReasoningEffortForModel(state.row.catalog, state.level.effort),
    latencyMode: ultrafast && state.ultrafastAvailable ? "ultrafast" : "standard",
  };
}
