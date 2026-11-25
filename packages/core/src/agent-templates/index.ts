import { AgentTemplate } from "@opengeni/contracts";

import bugFixer from "./bug-fixer.agent.json";
import cveScanner from "./cve-scanner.agent.json";
import dependencyUpdater from "./dependency-updater.agent.json";
import incidentResponder from "./incident-responder.agent.json";
import prReviewer from "./pr-reviewer.agent.json";
import productAnalyst from "./product-analyst.agent.json";
import triage from "./triage.agent.json";

/**
 * Ready-made agents people add from the "Add an agent" gallery
 * (docs/agents.md). Each is a content file, not code: general instructions
 * for any software team, suggested Can use rules, and suggested triggers
 * that stay off until the person picks a repository or source and saves.
 * They name each other ("Bug fixer", "PR reviewer") to delegate by name.
 * A new one is a new file here; no product code knows any of them.
 */
const AGENT_TEMPLATE_FILES: readonly unknown[] = [
  triage,
  bugFixer,
  prReviewer,
  cveScanner,
  incidentResponder,
  dependencyUpdater,
  productAnalyst,
];

let parsed: readonly AgentTemplate[] | undefined;

/** Every ready-made agent, in gallery order. A malformed file is skipped. */
export function agentTemplates(): readonly AgentTemplate[] {
  parsed ??= AGENT_TEMPLATE_FILES.flatMap((file) => {
    const template = AgentTemplate.safeParse(file);
    if (!template.success) {
      console.warn("agent template skipped", { issues: template.error.issues.slice(0, 3) });
      return [];
    }
    return [template.data];
  });
  return parsed;
}

export function agentTemplateByKey(key: string): AgentTemplate | undefined {
  return agentTemplates().find((template) => template.key === key);
}
