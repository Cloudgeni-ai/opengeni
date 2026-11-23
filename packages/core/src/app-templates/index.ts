import { AppTemplate, parseAppPackage } from "@opengeni/contracts";

import decisionLog from "./decision-log.app.json";
import feedbackBoard from "./feedback-board.app.json";
import incidentLog from "./incident-log.app.json";
import issueTracker from "./issue-tracker.app.json";

/**
 * Ready-made apps people add in Capabilities (Ready-made) and on the
 * Artifacts page (Apps). Each is a content file: an app package
 * (docs/app-packages.md) with a name, a line about it and its team. Adding
 * one installs the package as a new app and opens it, where it asks to
 * connect any tool it declares. These use only Site Data, so they work
 * right away; tool-backed ones (a GitHub or Linear board) come later.
 */
const APP_TEMPLATE_FILES: readonly unknown[] = [
  issueTracker,
  incidentLog,
  feedbackBoard,
  decisionLog,
];

let parsed: readonly AppTemplate[] | undefined;

/** Every ready-made app, in listing order. A malformed file is skipped. */
export function appTemplates(): readonly AppTemplate[] {
  parsed ??= APP_TEMPLATE_FILES.flatMap((file) => {
    const template = AppTemplate.safeParse(file);
    if (!template.success) {
      console.warn("app template skipped", { issues: template.error.issues.slice(0, 3) });
      return [];
    }
    let problems: unknown[];
    try {
      problems = parseAppPackage(template.data.package).problems;
    } catch (error) {
      problems = [error instanceof Error ? error.message : String(error)];
    }
    if (problems.length > 0) {
      console.warn("app template skipped", { key: template.data.key, problems });
      return [];
    }
    return [template.data];
  });
  return parsed;
}
