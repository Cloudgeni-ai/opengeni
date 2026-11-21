import { z } from "zod";
import { GalleryTeam } from "./agents";
import { defineSchema } from "./define-schema";

/**
 * A ready-made app people can add from the gallery: an app package file
 * (docs/app-packages.md) with a name, a line about it and the team it is for.
 * Content, not code. Adding it installs the package as a new app.
 */
export const AppTemplate = /* @__PURE__ */ defineSchema(() =>
  z.object({
    key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    team: GalleryTeam.nullable().default(null),
    /** The package file's JSON, installed as is. */
    package: z.record(z.string(), z.unknown()),
  }),
);
export type AppTemplate = z.output<typeof AppTemplate>;

export const ListAppTemplatesResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ templates: z.array(AppTemplate) }),
);
export type ListAppTemplatesResponse = z.output<typeof ListAppTemplatesResponse>;
