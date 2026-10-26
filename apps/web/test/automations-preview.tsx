// The real Automations and Event sources pages over deterministic data. Open
// test/automations-preview.html?path=/workspaces/<id>/automations (any of the
// pages' own paths) and `&theme=dark` for the dark theme. The embeddable
// Automations panel is at /workspaces/<id>/panel, in a dialog-sized frame;
// `?chat=1` scopes it to a chat and `?builtin=1` offers the built-in
// templates and this workspace's events.
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { OpenGeniProvider, useOpenGeniText } from "@opengeni/react";
import { AutomationsPanel, builtinAutomationTemplates } from "@opengeni/react/automations";
import { Toaster } from "@opengeni/react/app/components/toaster";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import {
  AutomationDetailRoute,
  AutomationFormRoute,
  AutomationTemplatesRoute,
  AutomationsRoute,
  EventSourceDetailRoute,
  EventSourceNewRoute,
  EventSourcesRoute,
} from "../src/routes/automations";
import {
  chatSessionId,
  previewClient,
  projectId,
  projectsServer,
  workspaceId as previewWorkspaceId,
} from "./automations-preview-context";
import "../src/styles.css";

const query = new URLSearchParams(location.search);
const theme = query.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.ogTheme = theme;

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const root = createRootRoute({
  component: () => (
    <OpenGeniProvider client={previewClient as never} workspaceId={previewWorkspaceId}>
      <TooltipProvider>
        <main className="min-h-dvh min-w-0 bg-bg text-fg">
          <Toaster theme={theme} />
          <Outlet />
        </main>
      </TooltipProvider>
    </OpenGeniProvider>
  ),
});
const list = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/automations",
  validateSearch: (search: Record<string, unknown>) => ({ taskId: text(search.taskId) }),
  component: function List() {
    const { workspaceId } = list.useParams();
    const { taskId } = list.useSearch();
    return <AutomationsRoute workspaceId={workspaceId} focusTaskId={taskId} />;
  },
});
const create = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/automations/new",
  validateSearch: (search: Record<string, unknown>) => ({
    template: text(search.template),
    from: text(search.from),
    source: text(search.source),
  }),
  component: function Create() {
    const { workspaceId } = create.useParams();
    const { template, from, source } = create.useSearch();
    return (
      <AutomationFormRoute
        workspaceId={workspaceId}
        mode={{ kind: "create", template, from, eventSourceId: source }}
      />
    );
  },
});
const templatesList = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/automations/templates",
  component: function Templates() {
    return <AutomationTemplatesRoute workspaceId={templatesList.useParams().workspaceId} />;
  },
});
const sourcesList = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/automations/sources",
  component: function Sources() {
    return <EventSourcesRoute workspaceId={sourcesList.useParams().workspaceId} />;
  },
});
const sourceNew = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/automations/sources/new",
  validateSearch: (search: Record<string, unknown>) => ({ kind: text(search.kind) }),
  component: function SourceNew() {
    return (
      <EventSourceNewRoute
        workspaceId={sourceNew.useParams().workspaceId}
        kind={sourceNew.useSearch().kind}
      />
    );
  },
});
const sourceDetail = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/automations/sources/$sourceId",
  component: function SourceDetail() {
    const { workspaceId, sourceId } = sourceDetail.useParams();
    return <EventSourceDetailRoute workspaceId={workspaceId} sourceId={sourceId} />;
  },
});
const detail = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/automations/$automationId",
  component: function Detail() {
    const { workspaceId, automationId } = detail.useParams();
    return <AutomationDetailRoute workspaceId={workspaceId} scheduleId={automationId} />;
  },
});
const edit = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/automations/$automationId/edit",
  component: function Edit() {
    const { workspaceId, automationId } = edit.useParams();
    return (
      <AutomationFormRoute
        workspaceId={workspaceId}
        mode={{ kind: "edit", scheduleId: automationId }}
      />
    );
  },
});
const panel = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/panel",
  validateSearch: (search: Record<string, unknown>) => ({
    chat: Boolean(search.chat),
    builtin: Boolean(search.builtin),
  }),
  component: function Panel() {
    const t = useOpenGeniText();
    const { workspaceId } = panel.useParams();
    const { chat: inChat, builtin } = panel.useSearch();
    return (
      <div className="flex min-h-dvh justify-center p-4 sm:p-10">
        <div
          role="dialog"
          aria-label="Automations"
          className="h-fit w-full max-w-[560px] rounded-xl border border-border bg-surface p-5 shadow-lg sm:p-6"
        >
          <AutomationsPanel
            client={previewClient as never}
            workspaceId={workspaceId}
            sessionId={inChat ? chatSessionId : undefined}
            eventServers={[projectsServer]}
            argumentDefaults={{ projectId }}
            templates={builtin ? builtinAutomationTemplates(t) : undefined}
            workspaceEvents={builtin}
            onOpenSession={() => undefined}
          />
        </div>
      </div>
    );
  },
});

const router = createRouter({
  routeTree: root.addChildren([
    list,
    create,
    templatesList,
    sourcesList,
    sourceNew,
    sourceDetail,
    detail,
    edit,
    panel,
  ]),
  history: createMemoryHistory({
    initialEntries: [query.get("path") ?? `/workspaces/${previewWorkspaceId}/automations`],
  }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
