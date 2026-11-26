import { z } from "zod";
import { ReadyMadeTeam } from "./agents";
import { defineSchema } from "./define-schema";

/**
 * Sample records the Apps page's preview shows before anything is installed,
 * per collection. Only the preview reads them; installing never adds them.
 * `{{today}}` or `{{today-N}}` in a string value is that day's date (YYYY-MM-DD).
 */
export const AppTemplatePreview = /* @__PURE__ */ defineSchema(() =>
  z.object({
    records: z.record(
      z.string().min(1).max(64),
      z.array(z.record(z.string(), z.unknown())).max(20),
    ),
  }),
);
export type AppTemplatePreview = z.output<typeof AppTemplatePreview>;

/**
 * A ready-made app people add on the Apps page: an app package file
 * (docs/app-packages.md) with a name, a line about it, the team it is for and
 * sample records for its preview. Content, not code. Adding it installs the
 * package as a new app.
 */
export const AppTemplate = /* @__PURE__ */ defineSchema(() =>
  z.object({
    key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    team: ReadyMadeTeam.nullable().default(null),
    /** The package file's JSON, installed as is. */
    package: z.record(z.string(), z.unknown()),
    preview: AppTemplatePreview.nullable().default(null),
  }),
);
export type AppTemplate = z.output<typeof AppTemplate>;

export const ListAppTemplatesResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ templates: z.array(AppTemplate) }),
);
export type ListAppTemplatesResponse = z.output<typeof ListAppTemplatesResponse>;
