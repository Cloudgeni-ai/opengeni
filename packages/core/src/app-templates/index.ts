import { AppTemplate, parseAppPackage } from "@opengeni/contracts";

import decisionLog from "./decision-log.app.json";

/**
 * Ready-made apps people add from the gallery. Each is a content file: an app
 * package (docs/app-packages.md) with a name, a line about it and its team.
 * Adding one installs the package as a new app.
 */
const APP_TEMPLATE_FILES: readonly unknown[] = [decisionLog];

let parsed: readonly AppTemplate[] | undefined;

/** Every ready-made app, in gallery order. A malformed file is skipped. */
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
