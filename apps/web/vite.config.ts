import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { compactProtectedIndexHtml } from "./vite-index-html";
import { safeReactHmrPlugin } from "./vite-safe-react-hmr";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const canonicalIndexFilename = path.resolve(dirname, "index.html");
const browserExtensionArchive = path.resolve(
  dirname,
  "../browser-extension/dist/opengeni-browser-extension.tar",
);
const allowedHosts = process.env.OPENGENI_WEB_ALLOWED_HOSTS?.split(",")
  .map((host) => host.trim())
  .filter(Boolean);
export default defineConfig({
  build: {
    // The canonical post-build budget below computes gzip sizes for the exact
    // initial/session graphs and every chunk. Avoid Vite recomputing compressed
    // sizes for hundreds of lazy syntax assets before that bounded gate runs.
    reportCompressedSize: false,
    // Vite's default 500 kB raw threshold misclassifies deliberately lazy
    // syntax/WASM assets. The post-build budget gate measures the recursive
    // initial graph and every chunk by gzip size; 800 kB remains a hard raw cap.
    chunkSizeWarningLimit: 800,
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              // Workspace configs read shared provider metadata at module load.
              // Keep this pure data outside mutually importing settings routes.
              name: "model-provider-metadata",
              test: /apps[\\/]web[\\/]src[\\/]components[\\/]models[\\/]provider-metadata\.ts$/,
              includeDependenciesRecursively: false,
              priority: 22,
            },
            {
              // Session routes register optional peers during module evaluation.
              // Their callbacks are assigned from state objects, not hoisted
              // declarations. Keep this dependency-free state in a leaf chunk
              // so entry-aware merging cannot put it behind the registering
              // route in a circular shared chunk. The terminal/editor/desktop
              // entry points re-export components and must stay outside it.
              name: "workbench-peer-state",
              test: /packages[\\/]react[\\/]src[\\/]lib[\\/]workbench-peers\.ts$/,
              includeDependenciesRecursively: false,
              priority: 22,
            },
            {
              // Registration runs when lazy routes evaluate. Keep the loader's
              // state and registration entry point together, outside route
              // chunks that can import one another before state initializes.
              name: "pierre-diffs-loader",
              test: /packages[\\/]react[\\/]src[\\/](?:diffs\.ts|lib[\\/]pierre-diffs-loader\.ts)$/,
              includeDependenciesRecursively: false,
              priority: 22,
            },
            {
              // Questions and command controls mount only when their session
              // surface is active. Keep their implementations behind those
              // lazy imports instead of recursively merging them into chat.
              name: "session-conditional-panels",
              test: /(?:packages[\\/]react[\\/]src[\\/](?:components[\\/](?:human-input-(?:form|surface)|session-commands(?:-panel)?)\.tsx|hooks[\\/]use-session-background-commands\.ts)$|apps[\\/]web[\\/]src[\\/]components[\\/]session[\\/]commands\.tsx$)/,
              includeDependenciesRecursively: false,
              priority: 21,
            },
            {
              // Account setup is interaction-driven. Do not let shared icons
              // co-locate these forms/controllers with the eager session graph.
              name: "connect-setup",
              test: /(?:packages[\\/]react[\\/]styles[\\/]connect\.css$|packages[\\/]react[\\/]src[\\/](?:connect(?:-accounts|-chooser|-panel|-setup)|hooks[\\/]use-connect|device-authorization|identity-link-accounts|identity-link-consent)\.tsx?$|packages[\\/]connect[\\/]src[\\/](?:index|device|authorization|poll|browser-navigation)\.ts$|apps[\\/]web[\\/]src[\\/](?:components[\\/]capabilities[\\/]native-connect-setup|routes[\\/]identity-link)\.tsx$)/,
              includeDependenciesRecursively: false,
              priority: 21,
            },
            {
              // Inspector changes must not pull account-management forms into
              // the direct-session graph through entry-aware chunk merging.
              name: "model-connection-settings",
              test: /(?:components[\\/](?:codex-source-settings|model-connection-section|subscription-account-row|subscription-connect-action|subscription-device-code-panel)\.tsx$|lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/](?:external-link|route|ticket-check)\.mjs$)/,
              includeDependenciesRecursively: false,
              priority: 20,
            },
            {
              // Zod is a dependency-free runtime shared by the contracts schemas
              // and app modules. Keep it in its own chunk: entry-aware merging
              // can otherwise co-locate app code that reads contracts constants
              // at module scope with Zod, creating a chunk cycle in which that
              // code evaluates before the contracts chunk has initialized.
              name: "zod-runtime",
              test: /(?:node_modules|\.bun)[\\/]zod(?:@|[\\/])/,
              includeDependenciesRecursively: false,
              priority: 22,
            },
            {
              // Keep context and its virtual reader in the lazy debug inspector.
              name: "context-inspector",
              test: /(?:components[\\/]session[\\/](?:model-context-inspector|context-text-reader)\.tsx$|@tanstack[\\+/]virtual-core|@tanstack[\\+/]react-virtual)/,
              includeDependenciesRecursively: false,
              priority: 20,
            },
            {
              // Workspace forms, provider marks, and administration links are
              // shared route primitives. They must not pull the settings
              // implementation into the workspace shell or direct sessions.
              name: "workspace-form-primitives",
              test: /apps[\\/]web[\\/]src[\\/]components[\\/](?:ui[\\/](?:dialog|confirm-dialog|skeleton|textarea)|brand-mark|chatgpt-mark|settings[\\/]organization-workspace-administration)\.tsx$/,
              includeDependenciesRecursively: false,
              priority: 20,
            },
            {
              // The searchable picker mounts this overlay only when opened.
              // Keep Popover itself lazy; shared Radix scopes stay in ui-runtime.
              name: "model-picker-popover",
              test: /@radix-ui[\\/+]react-popover(?:@|[\\/])/,
              includeDependenciesRecursively: false,
              priority: 16,
            },
            {
              // Select, Switch, and ToggleGroup back design-system controls used
              // only by lazy management pages. Keep them out of ui-runtime, which
              // is part of startup; shared Popper/scope modules stay there.
              name: "management-radix-controls",
              test: /(?:node_modules|\.bun)[\\/]@radix-ui(?:\+|[\\/])react-(?:select|switch|toggle|toggle-group)(?:@|[\\/])/,
              includeDependenciesRecursively: false,
              priority: 16,
            },
            {
              // mobile-plus calls lazyComposerPanel at module scope. Keep this
              // eager helper out of reciprocal entry-aware session chunks;
              // optional panel bodies stay behind their dynamic imports.
              name: "composer-menu-runtime",
              test: /apps[\\/]web[\\/]src[\\/]components[\\/]ui[\\/]composer-menu\.tsx$/,
              includeDependenciesRecursively: false,
              priority: 16,
            },
            {
              // Keep Radix, Lucide's eager icon factory, and the two class-name
              // helpers (web `cn` and @opengeni/react `cn` with clsx and
              // tailwind-merge) in one UI runtime. entriesAware route merging
              // can otherwise split Popper scopes, place an icon and its
              // factory across a circular chunk, or fold a tiny universally
              // shared helper into a route-only chunk and drag that route's
              // code into the initial graph. Composer menu factories are also
              // called while lazy routes evaluate; keep their React bindings
              // and preload registry outside those mutually importing chunks.
              // Button and Input (with cva and
              // the three icons Button states use) are startup code too; the
              // lazy settings shell as one more consumer otherwise splits
              // them into an extra startup request.
              name: "ui-runtime",
              test: /(?:(?:node_modules|\.bun)[\\/](?:@radix-ui(?:\+|\/)|radix-ui(?:@|\/)|clsx(?:@|\/)|tailwind-merge(?:@|\/)|class-variance-authority(?:@|\/))|apps[\\/]web[\\/]src[\\/]lib[\\/]utils\.ts$|apps[\\/]web[\\/]src[\\/]components[\\/]ui[\\/](?:button|composer-menu|input)\.tsx$|lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/](?:check|chevron-right|loader-circle)\.mjs$|packages[\\/]react[\\/]src[\\/]lib[\\/]cn\.ts$|[\\/]lucide-react[\\/]dist[\\/]esm[\\/](?:(?:createLucideIcon|Icon|context|defaultAttributes)\.mjs|shared[\\/]))/,
              priority: 15,
            },
            {
              // These tiny, always-loaded navigation and status primitives are
              // one app-shell unit. Keeping them together avoids an extra
              // request without pulling any route implementation into startup.
              // Lucide's legacy BarChart3 export currently resolves to the
              // chart-column module; pin both stems so the Insights glyph never
              // falls into a circular workspace-management route chunk.
              // The Personal badge and scope trigger are shared rail UI, not
              // settings-only code; keep them out of the management chunk.
              // Search intent is shared by App's eager search validator and
              // lazy rail/conversation surfaces. Keep it here so recursive
              // session grouping cannot pull the workbench into startup.
              // App parses organization settings sections and the settings,
              // models, knowledge, access and API-key search params at startup;
              // keep those tiny parsers here instead of a separate startup
              // request.
              name: "app-shell",
              test: /(?:apps[\\/]web[\\/]src[\\/](?:lib[\\/](?:routes|workspace-management-location|identity-link-continuation|session-search-route|organization-admin|organization-route|models-route|knowledge-route|access-route|api-keys-route|developer-route|return-to)\.ts|components[\\/]personal-workspace-badge\.tsx|components[\\/]ui[\\/](?:empty-state|meta-chip|status-dot|scope-switcher-trigger)\.tsx)|lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/](?:arrow-left|bar-chart-3|bot|box|boxes|chart-column|chevron-down|chevron-left|circle-alert|database|key-round|laptop|plug|settings-2|shield-alert|shield-check|sparkles|users|x)\.mjs)$/,
              includeDependenciesRecursively: true,
              priority: 4,
            },
            {
              // The router is startup code that every route reads through a
              // few hooks. Entry-aware splitting otherwise scatters it over
              // four or five startup requests by whichever lazy routes use
              // which hook; keep it one runtime like React itself.
              name: "router-runtime",
              test: /(?:node_modules|\.bun)[\\/](?:@tanstack[\\/](?:react-router|router-core|history|store|react-store)|use-sync-external-store)[\\/]/,
              includeDependenciesRecursively: false,
              priority: 15,
            },
            {
              // The app context, its startup helpers and the shared load-error
              // state are always loaded. Entry-aware splitting otherwise cuts
              // this one startup unit into several requests along whichever
              // lazy routes happen to import part of it (a new import of the
              // error helpers or a toast was enough to add a startup file).
              // The icons are the ones the load-error state and toasts draw.
              // Session creation resolves the agent's capabilities, so their
              // helpers are startup code too.
              name: "startup-context",
              test: /(?:apps[\\/]web[\\/]src[\\/](?:context\.tsx|components[\\/](?:common|secure-context-warning|sign-in-callback-notice|ui[\\/]sonner)\.tsx|lib[\\/](?:agent-capabilities|analytics-consent|analytics-login|api-error|appearance|bootstrap-error|bootstrap-read|github-installation-unlink|managed-auth-form|managed-auth-transition|managed-self-context|model-access|org|organization-invitation-continuation|permissions|personal-github-authority|personal-security-context|session-context|session-create|session-creation-handoff|session-pins|single-flight|use-capability-tool-defaults|workspace-deletion|workspace-navigation-preference|workspace-scope-context|workspace-transition|workspaces)\.tsx?)|(?:node_modules|\.bun)[\\/]sonner(?:@|[\\/]).*|lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/](?:copy|lock|octagon-x|refresh-cw)\.mjs)$/,
              includeDependenciesRecursively: false,
              priority: 5,
            },
            {
              // The SDK's error and wire-type runtime, and the attribution and
              // analytics helpers beside them, load at startup for every route.
              // Entry-aware splitting otherwise cuts this one unit in two as
              // soon as a lazy route imports only part of it (an extra startup
              // request for a few kilobytes). Vite's preload helper joins them
              // for the same reason.
              name: "startup-sdk-runtime",
              test: /(?:packages[\\/]sdk[\\/]src[\\/](?:errors|types|retained-artifacts|interaction)\.ts|packages[\\/]contracts[\\/]src[\\/]browser-storage\.ts|apps[\\/]web[\\/]src[\\/]lib[\\/](?:signup-attribution|analytics-observer)\.ts|vite[\\/]preload-helper\.js)$/,
              includeDependenciesRecursively: false,
              priority: 5,
            },
            {
              // The hierarchy rail is substantial and belongs to the lazy
              // workspace shell. Keep the component itself route-only: a
              // recursive entry-aware group can merge it into the direct
              // session graph when an unrelated lazy route becomes smaller.
              // Its shared helpers remain available for normal consumer-aware
              // splitting without pulling the full rail implementation in.
              name: "session-rail",
              test: /apps[\\/]web[\\/]src[\\/]components[\\/]rail[\\/](?:session-list|switcher-block|workspace-switcher|workspace-name-dialog)\.tsx$/,
              includeDependenciesRecursively: false,
              priority: 3,
            },
            {
              // These artifact kind glyphs are drawn by conversation cards on a
              // direct session load and by the lazy editor. Left to entry-aware
              // grouping they land in the editor chunk, and one icon import drags
              // the whole editor into the direct session graph.
              name: "artifact-glyphs",
              test: /lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/](?:file|image|panels-top-left)\.mjs$/,
              includeDependenciesRecursively: false,
              priority: 3,
            },
            {
              // A few tiny primitives are shared by the initial composer and
              // the active-session route. Pin that boundary so entry-aware
              // merging cannot use an icon or label helper to pull the full
              // session workbench into startup. The personal-workspace badge and
              // session title contract must not carry settings-only dependencies.
              // CalendarClock is also a session header/rail glyph. Keep it
              // here so management revision UI cannot share its route chunk
              // and make management controls static session dependencies.
              // The usage-limit gauge and allowance wording are drawn by the
              // conversation's refusal row and by the lazy usage pages.
              name: "session-shared-primitives",
              test: /(?:packages[\\/]contracts[\\/]src[\\/](?:session-titles|session-final-reply)\.ts|apps[\\/]web[\\/]src[\\/]lib[\\/](?:format|machine-selectability)\.ts|apps[\\/]web[\\/]src[\\/]components[\\/]personal-workspace-badge\.tsx|packages[\\/]react[\\/]src[\\/](?:hooks[\\/]use-machines|workstream-control-event)\.ts|lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/](?:calendar-clock|chevron-up|gauge|git-branch|message-square-text|rotate-ccw|rotate-cw|save|server)\.mjs)$/,
              includeDependenciesRecursively: false,
              priority: 16,
            },
            {
              // App owns composer launch search parsing, while the active
              // session route also consumes it. Keep this tiny entry helper
              // independent so recursive session grouping cannot make the
              // workbench an initial dependency.
              name: "composer-launch",
              test: /apps[\\/]web[\\/]src[\\/]lib[\\/]composer-launch\.ts$/,
              includeDependenciesRecursively: false,
              priority: 17,
            },
            {
              // Keep settings-only implementations in one explicit lazy unit.
              // Recursive consumer-aware grouping can otherwise pair one
              // shared primitive with these routes and make the complete
              // management surface reachable from an active session. The shared
              // settings drawer and runtime controls belong behind this boundary too.
              // The default Sandbox environment row (workspace General only)
              // draws the settings RowSelect; left to entry-aware merging it
              // lands in a chunk the workspace route imports and pulls this
              // whole surface into a sessions load.
              name: "workspace-management-surfaces",
              test: /apps[\\/]web[\\/]src[\\/](?:components[\\/](?:ai-gateway-connection|codex-connection|default-session-model|model-access-policy|permission-picker|supergrok-connection|supergrok-device-poll|transcription-settings|video-generation-settings|workspace-capability-defaults|workspace-runtime-control)\.(?:ts|tsx)|components[\\/]settings[\\/](?:(?:workspace-settings-shell|settings-sidebar|settings-rail|default-sandbox-environment-row)\.tsx|organization-settings-pages\.ts)|routes[\\/](?:workspace-learning-loader\.ts|workspace-members-section\.tsx|workspace-settings\.tsx))$/,
              includeDependenciesRecursively: false,
              priority: 20,
            },
            {
              // The workspace paused banner (rail and settings) and the React
              // provider (workspace routes). Pinned so the settings-only pages
              // pinned above can't reshuffle them into a direct session load.
              name: "workspace-chrome",
              test: /(?:apps[\\/]web[\\/]src[\\/](?:components[\\/]rail[\\/]workspace-paused-banner\.tsx|lib[\\/]workspace-timer\.ts)|packages[\\/]react[\\/]src[\\/]provider\.tsx)$/,
              includeDependenciesRecursively: false,
              priority: 20,
            },
            {
              // The composer's "+" menu primitives are called at module scope
              // (lazyComposerPanel) by pickers on the composer and session
              // graphs. Keep them in a leaf chunk (React, icons and class
              // helpers only) so no chunk cycle can evaluate a caller first.
              name: "composer-menu-primitives",
              test: /apps[\\/]web[\\/]src[\\/]components[\\/]ui[\\/](?:composer-menu\.tsx|menu-styles\.ts)$/,
              includeDependenciesRecursively: false,
              priority: 21,
            },
            {
              // Budget pages, Workspace settings > Usage and the member slider
              // (with its Radix primitive, used nowhere else; it must not join
              // the shared UI runtime). Only reached from lazy settings routes.
              name: "usage-allowances",
              test: /(?:apps[\\/]web[\\/]src[\\/](?:components[\\/]usage[\\/](?!usage-entry\.)[\w-]+\.tsx?|lib[\\/]usage-allowances\.ts)|packages[\\/]react[\\/]src[\\/]components[\\/]usage-member-list\.tsx|@radix-ui(?:\+|[\\/])react-slider(?:@|[\\/]).*)$/,
              includeDependenciesRecursively: false,
              priority: 20,
            },
            {
              // Model, API-key, and managed-access settings pages plus the shared
              // settings frame are reached only from lazy settings routes. Pin
              // them so entry-aware merging cannot co-locate one of them with a
              // session-used helper and make the management surface reachable
              // from a direct session load. The default sandbox environment row is
              // settings-only too; left to entry-aware grouping it can share a
              // chunk with the workspace paused banner and pull this chunk (via
              // its RowSelect) into a direct workspace load. Connection access renders a Models
              // form page, so it lives here, not in model-connection-settings,
              // whose shared icons the eager workspace graph imports.
              // Organization provider connections and Codex subscriptions are imported by the Models
              // pages above and by the lazy organization Models section; outside
              // this group they land in the section's chunk and form a cycle
              // (settings-pages <-> organization-models-section) that leaves
              // React undefined when the section evaluates.
              name: "settings-pages",
              test: /apps[\\/]web[\\/]src[\\/](?:components[\\/](?:connection-access-settings|organization-codex-subscriptions|organization-model-provider-connection|models[\\/][\w-]+|settings[\\/](?:agent-activity|default-sandbox-environment-row|row-select|settings-frame))\.tsx|routes[\\/](?:workspace-api-keys|workspace-managed-access)\.tsx|lib[\\/]api-key-(?:presets|status)\.ts)$/,
              includeDependenciesRecursively: false,
              priority: 20,
            },
            {
              // Design-system primitives used only by settings and other lazy
              // management routes. Keep them in one lazy unit so entry-aware
              // merging cannot fold them into chunks a direct session imports.
              // Diff/revision history imports ErrorMessage; leaving either
              // unpinned co-locates it with shared session glyphs and drags this
              // entire group plus management Radix controls into sessions.
              name: "management-ui-primitives",
              test: /apps[\\/]web[\\/]src[\\/]components[\\/]ui[\\/](?:access-list|choice-cards|collapsible|content-layout|copy-field|destructive-confirm|detail-page|detail-sheet|diff-view|disabled-reason|disclosure|error-message|field|flush-form-page|form-dialog|list-row|page-actions|page-header|relative-time|revision-history|role-select|secret-field|section|segmented-control|select|select-menu|setting-row|settings-nav|sheet|status-badge|switch|usage-meter)\.tsx$/,
              includeDependenciesRecursively: false,
              priority: 19,
            },
            {
              // The Agent learning editor is reached only from lazy surfaces:
              // the schedules route, learning administration, and the mobile
              // composer's on-demand learning sheet. Entry-aware settings
              // grouping otherwise folds it into a shared chunk that a direct
              // session load imports, so pin it to its own lazy unit.
              name: "agent-learning-settings",
              test: /apps[\\/]web[\\/]src[\\/]components[\\/]knowledge[\\/]agent-learning-settings\.tsx$/,
              includeDependenciesRecursively: false,
              priority: 20,
            },
            {
              // The session workbench is the primary interactive route. Keep
              // its static graph route-aware, but coalesce tiny shared groups
              // so a cold navigation does not fan out into dozens of requests.
              // Coalesce the small shared chunks left after explicitly isolating
              // workspace administration and the on-demand model menu. The
              // 512 KiB merge threshold reduces duplicate wrappers and request
              // fan-out; the unchanged post-build graph/chunk budgets still gate it.
              name: "session",
              test: /src[\\/]routes[\\/]session\.tsx$/,
              includeDependenciesRecursively: true,
              entriesAware: true,
              entriesAwareMergeThreshold: 512 * 1024,
              priority: 2,
            },
            {
              // Workspace member administration is opened only from the lazy
              // settings route. Keep its sizeable roster and permission editor
              // graph behind that second boundary so it cannot be folded into
              // startup or a direct session load through shared UI primitives.
              name: "workspace-members",
              test: /src[\\/]routes[\\/]workspace-members-section\.tsx$/,
              includeDependenciesRecursively: true,
              entriesAware: true,
              entriesAwareMergeThreshold: 28 * 1024,
              priority: 4,
            },
            {
              // The settings hub owns several substantial management surfaces.
              // Keep their static graph behind that route so settings-only
              // controls cannot densify an initial or direct-session load. The
              // isolated account-auth route adds another entry-aware boundary;
              // 28 KiB is the highest merge threshold that keeps settings-only
              // sources out of the direct-session graph on Bun 1.4 Linux/x64.
              name: "workspace-settings",
              test: /src[\\/]routes[\\/]workspace-settings\.tsx$/,
              includeDependenciesRecursively: true,
              entriesAware: true,
              entriesAwareMergeThreshold: 28 * 1024,
              priority: 3,
            },
            {
              // Keep the three Office editors, sync stack, Worker bootstrap,
              // and modality runtimes behind their one direct route. Like the
              // session group, entriesAware preserves genuinely shared shell
              // code without folding route-only dependencies into startup.
              name: "editable-artifact",
              test: /src[\\/]routes[\\/]editable-artifact\.tsx$/,
              includeDependenciesRecursively: true,
              entriesAware: true,
              entriesAwareMergeThreshold: 128 * 1024,
              priority: 3,
            },
            {
              // Route simplification can otherwise make entry-aware merging
              // attach the large Office command/query schemas to the live
              // session graph. Keep these editor-only contracts behind the
              // editable-artifact routes that consume them.
              name: "editable-artifact-contracts",
              test: /packages[\\/]contracts[\\/]src[\\/](?:document-artifact-(?:commands|query)|presentation-artifact-(?:commands|query)|spreadsheet-artifact-(?:commands|date|query)|editable-artifact-(?:binary|causal-frontier|codec-registry|committed-transaction|live|serialized-commit|versions)|editable-artifacts)\.ts$/,
              includeDependenciesRecursively: false,
              priority: 5,
            },
            {
              // Skills administration is lazy workspace governance. Pinning
              // its schema prevents a small Agent Knowledge route from
              // re-bucketing that schema into every direct session load.
              name: "preference-registry-contracts",
              test: /packages[\\/]contracts[\\/]src[\\/]preference-registry\.ts$/,
              includeDependenciesRecursively: false,
              priority: 5,
            },
            {
              // Keep schema parsing from being folded into a larger shared
              // startup chunk when a lazy route changes its import boundary.
              name: "schema-runtime",
              test: /(?:node_modules|\.bun)[\\/]zod(?:@|[\\/])/,
              includeDependenciesRecursively: false,
              priority: 4,
            },
          ],
        },
      },
    },
  },
  server: {
    // Loopback unless the local stack deliberately opts in to its network
    // (`OPENGENI_DEV_BIND_HOST=0.0.0.0`, written to .env.runtime by `bun run dev`).
    host: process.env.OPENGENI_DEV_BIND_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1",
    port: 3000,
    // OAuth providers return to the public web origin. Match production's /v1
    // ingress routing so these callbacks reach the API instead of the SPA.
    proxy: {
      "/v1": {
        target:
          process.env.VITE_API_BASE_URL ||
          `http://127.0.0.1:${process.env.OPENGENI_API_PORT || 8000}`,
      },
    },
    ...(allowedHosts?.length ? { allowedHosts } : {}),
  },
  preview: {
    port: 3000,
    ...(allowedHosts?.length ? { allowedHosts } : {}),
  },
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
    },
    dedupe: ["react", "react-dom", "radix-ui"],
  },
  plugins: [
    tanstackRouter({ target: "react", enableRouteGeneration: false }),
    viteReact(),
    tailwindcss(),
    safeReactHmrPlugin(),
    {
      name: "opengeni-browser-extension-archive",
      configureServer(server) {
        server.middlewares.use("/opengeni-browser-extension.tar", async (_request, response) => {
          try {
            const archive = await readFile(browserExtensionArchive);
            response.statusCode = 200;
            response.setHeader("content-type", "application/x-tar");
            response.setHeader(
              "content-disposition",
              'attachment; filename="opengeni-browser-extension.tar"',
            );
            response.setHeader("cache-control", "no-store");
            response.end(archive);
          } catch {
            response.statusCode = 503;
            response.end("OpenGeni Browser extension is not built yet.");
          }
        });
      },
      async generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "opengeni-browser-extension.tar",
          source: await readFile(browserExtensionArchive),
        });
      },
    },
    {
      name: "compact-index-html",
      transformIndexHtml: {
        order: "post",
        // Vite and React inject dev-client scripts at head-prepend even when
        // the source bootstrap appears first. Reorder the final transformed
        // document so setup authority is scrubbed before those subrequests in
        // dev, preview, and production builds.
        handler: (html, context) =>
          compactProtectedIndexHtml(html, {
            filename: context.filename,
            canonicalFilename: canonicalIndexFilename,
          }),
      },
    },
  ],
});
