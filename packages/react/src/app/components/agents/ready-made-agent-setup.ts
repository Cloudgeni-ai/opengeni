/**
 * What a ready-made agent's preview and list row say about it, from its
 * template's setup (ReadyMadeSetup in @opengeni/contracts): what it does and
 * won't do without asking, what it needs (Required or Optional), and at most
 * one agent it works well with. A template without setup (an older server)
 * needs nothing listed. Pure.
 */
import type { AgentTemplate } from "@opengeni/contracts";

export interface ReadyMadeNeed {
  key: string;
  label: string;
  required: boolean;
  /** One quiet line: what it uses it for. */
  detail?: string | null | undefined;
}

export interface ReadyMadeSetupWords {
  does: string[];
  wontDoWithoutAsking: string[];
  needs: ReadyMadeNeed[];
  /** The name of at most one agent it works well with; never required. */
  worksWellWith: string | null;
}

export function readyMadeAgentSetup(
  template: AgentTemplate,
  /** The name of another ready-made agent, by its key. */
  nameOf: (key: string) => string | null = () => null,
): ReadyMadeSetupWords {
  const setup = template.setup ?? null;
  const needs: ReadyMadeNeed[] = (setup?.connections ?? []).map((connection) => ({
    key: connection.provider,
    label: connection.name,
    required: connection.required,
    detail: connection.why,
  }));
  if (setup?.repository) {
    needs.push({
      key: "repository",
      label: "A repository",
      required: setup.repository === "required",
      detail: "Chosen when you turn it on",
    });
  }
  const partner = setup?.worksWellWith ?? null;
  return {
    does: template.description ? [template.description] : [],
    wontDoWithoutAsking: [...(setup?.wontDoWithoutAsking ?? [])],
    needs,
    worksWellWith: partner ? (nameOf(partner) ?? null) : null,
  };
}
