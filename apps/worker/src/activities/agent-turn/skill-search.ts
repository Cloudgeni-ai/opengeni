import type { AttemptToolDefinition } from "@opengeni/codemode";
import { PublicSkillSearchError, type PublicSkillSearchClient } from "@opengeni/core";
import { listSkillLibraryEntries } from "@opengeni/runtime/skill-library";

export type WorkspaceSkillSearchEntry = Readonly<{
  id: string;
  name: string;
  description: string;
  revisionId?: string;
  scopeVersion?: number;
  installationVersion?: number;
}>;

export function createSkillSearchAttemptToolDefinition(input: {
  authorize: () => Promise<void>;
  listWorkspace: () => Promise<readonly WorkspaceSkillSearchEntry[]>;
  publicSearch: PublicSkillSearchClient;
}): AttemptToolDefinition {
  return {
    identity: { serverId: "opengeni", toolName: "skill_search" },
    modelName: "skill_search",
    codemodePath: ["opengeni", "skill_search"],
    title: "Search Skills",
    description:
      "Find installed workspace Skills or available curated and public Skills. Returns identifiers and install sources, not file contents. Search never installs or starts a sandbox. Scope defaults to all; use installed to avoid external search.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 2, maxLength: 200 },
        scope: { type: "string", enum: ["installed", "catalog", "all"] },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: {
      title: "Search Skills",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    source: "opengeni",
    approval: "none",
    execute: async (args) => {
      await input.authorize();
      const query = String(args.query).trim();
      const scope = args.scope ?? "all";
      const limit = typeof args.limit === "number" ? args.limit : 20;
      const searchText = query.toLowerCase();
      const matches = (entry: { name: string; description: string }) =>
        `${entry.name}\n${entry.description}`.toLowerCase().includes(searchText);
      const installed = scope === "catalog" ? [] : await input.listWorkspace();
      const workspaceHits = installed
        .filter(matches)
        .slice(0, limit)
        .map((entry) => ({
          ...entry,
          source: "workspace" as const,
          installed: true,
        }));
      const libraryHits =
        scope === "installed"
          ? []
          : listSkillLibraryEntries()
              .filter(matches)
              .slice(0, limit)
              .map((entry) => ({
                id: `library:${entry.id}`,
                name: entry.name,
                description: entry.description,
                source: "library" as const,
                libraryId: entry.id,
              }));
      let publicResult: Awaited<ReturnType<PublicSkillSearchClient["search"]>> | null = null;
      let publicError: {
        source: "skills_sh";
        code: string;
        retryAfterSeconds: number | null;
      } | null = null;
      if (scope !== "installed") {
        try {
          publicResult = await input.publicSearch.search({ query, limit });
        } catch (error) {
          if (!(error instanceof PublicSkillSearchError)) throw error;
          publicError = {
            source: "skills_sh",
            code: error.code,
            retryAfterSeconds: error.retryAfterSeconds,
          };
        }
      }
      const output = {
        workspace: workspaceHits,
        library: libraryHits,
        public: publicResult?.items.map((entry) => ({ ...entry })) ?? [],
        // A provider outage is not an empty search. Keep local results useful
        // and expose partial failure explicitly, without leaking network details.
        partial: publicError !== null,
        errors: publicError ? [publicError] : [],
      };
      return {
        isError: false,
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  };
}
