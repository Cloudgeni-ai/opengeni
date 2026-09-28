import { Link, useRouterState } from "@tanstack/react-router";
import { MoreHorizontalIcon, SendIcon, SlidersHorizontalIcon, SquarePenIcon } from "lucide-react";
import { useState } from "react";

import { useKnowledgeReviewIndicator } from "./use-knowledge-review-indicator";
import { ForYouLink, ForYouRailLink, useForYouNeedsCount } from "@/components/rail/for-you-link";
import { useRail } from "@/components/rail/rail-context";
import { NewSessionLink } from "@/components/rail/session-list";
import { WorkspaceConfigGlyph, WorkspaceConfigLink } from "@/components/rail/workspace-config-link";
import {
  isConfigItemActive,
  primaryWorkspaceItemsFor,
  type WorkspaceConfigItem,
} from "@/components/rail/workspace-nav-data";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CheckboxField } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import { NEW_SESSION_SHORTCUT, shortcutLabel } from "@/lib/keyboard-shortcuts";
import {
  DEFAULT_RAIL_DESTINATIONS,
  useRailDestinations,
  type RailDestinationId,
} from "@/lib/rail-destinations";
import { workspacePriorityPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * Every workspace destination: the phone's Workspace screen, where there is
 * room for the whole list. The desktop rail uses `PrimaryNav`, which is brief.
 */
export function WorkspaceShortcutLinks({
  className,
  pending,
}: {
  className?: string;
  pending?: boolean;
}) {
  const rail = useRail();
  const fetchedPending = useKnowledgeReviewIndicator(rail.workspaceId, pending === undefined);
  const pendingKnowledge = pending ?? fetchedPending;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const items = usePrimaryWorkspaceItems(rail.workspaceId);

  return (
    <div className={cn("grid gap-0.5", className)}>
      <ForYouLink embedded />
      {items.map((item) => (
        <WorkspaceConfigLink
          key={item.to}
          item={item}
          needsReview={item.id === "knowledge" && pendingKnowledge}
          workspaceId={rail.workspaceId}
          variant="rail"
          collapsed={rail.collapsed}
          active={isConfigItemActive(pathname, rail.workspaceId, item.to)}
          onNavigate={() => rail.setDrawerOpen(false)}
        />
      ))}
    </div>
  );
}

function usePrimaryWorkspaceItems(workspaceId: string) {
  const context = useAppContext();
  return primaryWorkspaceItemsFor(
    hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin"),
  );
}

/** Primary product navigation: New session, the chosen destinations, More and Settings. */
export function PrimaryNav() {
  const rail = useRail();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const newSessionActive = pathname === `/workspaces/${rail.workspaceId}/sessions`;

  return (
    <div className={cn("mt-2 grid gap-0.5 px-2", rail.collapsed && "justify-center")}>
      <NewSessionLink
        aria-label={`New session · ${shortcutLabel(NEW_SESSION_SHORTCUT)}`}
        className={cn(
          "group relative flex h-8 items-center rounded-md text-sm font-medium text-fg-muted outline-none transition-colors pointer-coarse:h-10",
          "hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/50",
          newSessionActive && "bg-surface-2 text-fg",
          rail.collapsed ? "w-8 justify-center pointer-coarse:w-10" : "gap-2.5 px-2.5",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand transition-opacity",
            newSessionActive ? "opacity-100" : "opacity-0",
          )}
        />
        <SquarePenIcon className="size-4 shrink-0" />
        {rail.collapsed ? null : <span className="min-w-0 truncate">New session</span>}
      </NewSessionLink>

      {/* Phones list every destination on their own Workspace screen. */}
      {rail.isMobile ? null : <RailDestinations />}
    </div>
  );
}

function RailDestinations() {
  const rail = useRail();
  const context = useAppContext();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const pendingKnowledge = useKnowledgeReviewIndicator(rail.workspaceId);
  const needsYou = useForYouNeedsCount(rail.workspaceId);
  const items = usePrimaryWorkspaceItems(rail.workspaceId);
  const [chosen, setChosen] = useRailDestinations(context.accessContext.subjectId);
  const [customizing, setCustomizing] = useState(false);

  const settings = items.find((item) => item.id === "settings");
  const destinations = items.filter(
    (item): item is WorkspaceConfigItem & { id: RailDestinationId } => item.id !== "settings",
  );
  const shows = (id: RailDestinationId) => chosen.includes(id);
  const hidden = destinations.filter((item) => !shows(item.id));
  const forYouActive = pathname === workspacePriorityPath(rail.workspaceId);
  const activeHidden =
    hidden.find((item) => isConfigItemActive(pathname, rail.workspaceId, item.to))?.label ??
    (!shows("for-you") && forYouActive ? "For you" : undefined);

  const navigate = () => rail.setDrawerOpen(false);
  const configLink = (item: WorkspaceConfigItem) => (
    <WorkspaceConfigLink
      key={item.to}
      item={item}
      needsReview={item.id === "knowledge" && pendingKnowledge}
      workspaceId={rail.workspaceId}
      variant="rail"
      collapsed={rail.collapsed}
      active={isConfigItemActive(pathname, rail.workspaceId, item.to)}
      onNavigate={navigate}
    />
  );

  return (
    <>
      {shows("for-you") ? <ForYouRailLink embedded needsYou={needsYou} /> : null}
      {destinations.filter((item) => shows(item.id)).map(configLink)}
      <RailMoreMenu
        workspaceId={rail.workspaceId}
        collapsed={rail.collapsed}
        forYou={shows("for-you") ? null : { needsYou, active: forYouActive }}
        hidden={hidden}
        pathname={pathname}
        knowledgeNeedsReview={pendingKnowledge && !shows("knowledge")}
        activeHidden={activeHidden}
        onNavigate={navigate}
        onCustomize={() => setCustomizing(true)}
      />
      {settings ? configLink(settings) : null}
      <CustomizeRailDialog
        open={customizing}
        onOpenChange={setCustomizing}
        destinations={destinations}
        chosen={chosen}
        onSave={setChosen}
      />
    </>
  );
}

function moreLabel(props: {
  activeHidden?: string;
  needsYou: number;
  knowledgeNeedsReview: boolean;
}): string {
  return [
    "More",
    props.activeHidden ? `current section ${props.activeHidden}` : null,
    props.needsYou > 0 ? `${props.needsYou} need you` : null,
    props.knowledgeNeedsReview ? "Knowledge needs review" : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function RailMoreMenu(props: {
  workspaceId: string;
  collapsed: boolean;
  /** Set while For you is hidden from the rail. */
  forYou: { needsYou: number; active: boolean } | null;
  hidden: WorkspaceConfigItem[];
  pathname: string;
  knowledgeNeedsReview: boolean;
  activeHidden?: string;
  onNavigate: () => void;
  onCustomize: () => void;
}) {
  const { collapsed, forYou, activeHidden, knowledgeNeedsReview } = props;
  const needsYou = forYou?.needsYou ?? 0;
  const active = Boolean(activeHidden);
  const label = moreLabel({ activeHidden, needsYou, knowledgeNeedsReview });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-rail-more=""
          data-active={active ? "true" : undefined}
          aria-label={label}
          title={collapsed ? "More" : undefined}
          className={cn(
            "group relative flex h-8 items-center rounded-md text-sm font-medium text-fg-muted outline-none transition-colors pointer-coarse:h-10",
            "hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-surface-2 data-[state=open]:text-fg",
            "data-[active=true]:bg-surface-2 data-[active=true]:text-fg",
            collapsed ? "w-8 justify-center pointer-coarse:w-10" : "gap-2.5 px-2.5",
          )}
        >
          <span
            aria-hidden="true"
            className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand opacity-0 transition-opacity group-data-[active=true]:opacity-100"
          />
          <MoreHorizontalIcon className="size-4 shrink-0" />
          {collapsed ? null : <span className="min-w-0 flex-1 truncate text-left">More</span>}
          {needsYou > 0 && !collapsed ? (
            <span
              data-rail-more-count=""
              className="ml-auto font-mono text-2xs tabular-nums text-fg-subtle"
            >
              {needsYou}
            </span>
          ) : null}
          {knowledgeNeedsReview || (collapsed && needsYou > 0) ? (
            <span
              aria-hidden="true"
              data-rail-more-dot=""
              className={cn(
                "shrink-0 rounded-full",
                knowledgeNeedsReview ? "bg-amber-500" : "bg-brand",
                collapsed
                  ? "absolute right-1 top-1 size-2 ring-2 ring-surface"
                  : cn("size-2", needsYou > 0 ? "ml-1.5" : "ml-auto"),
              )}
            />
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side={collapsed ? "right" : "bottom"}
        className="w-[min(15rem,calc(100vw-1rem))]"
      >
        {forYou ? (
          <DropdownMenuItem asChild className="min-h-8 pointer-coarse:min-h-11">
            <Link
              to="/workspaces/$workspaceId/priority"
              params={{ workspaceId: props.workspaceId }}
              data-active={forYou.active ? "true" : undefined}
              onClick={props.onNavigate}
            >
              <SendIcon className="size-4" />
              <span className="min-w-0 flex-1 truncate">For you</span>
              {needsYou > 0 ? (
                <span className="font-mono text-2xs tabular-nums text-fg-subtle">{needsYou}</span>
              ) : null}
            </Link>
          </DropdownMenuItem>
        ) : null}
        {props.hidden.map((item) => {
          const review = item.id === "knowledge" && knowledgeNeedsReview;
          return (
            <DropdownMenuItem key={item.to} asChild className="min-h-8 pointer-coarse:min-h-11">
              <Link
                to={item.to}
                params={{ workspaceId: props.workspaceId }}
                search={review ? { review: true } : {}}
                data-active={
                  isConfigItemActive(props.pathname, props.workspaceId, item.to)
                    ? "true"
                    : undefined
                }
                aria-label={review ? `${item.label}, needs review` : undefined}
                onClick={props.onNavigate}
              >
                <WorkspaceConfigGlyph icon={item.icon} className="size-4" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {review ? (
                  <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-amber-500" />
                ) : null}
              </Link>
            </DropdownMenuItem>
          );
        })}
        {forYou || props.hidden.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          className="min-h-8 pointer-coarse:min-h-11"
          onSelect={() => props.onCustomize()}
        >
          <SlidersHorizontalIcon className="size-4" />
          Customize rail
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const DESTINATION_LABELS: Record<RailDestinationId, string> = {
  "for-you": "For you",
  agents: "Agents",
  schedules: "Schedules",
  artifacts: "Artifacts",
  knowledge: "Knowledge",
  capabilities: "Capabilities",
  insights: "Insights",
};

function CustomizeRailDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  destinations: (WorkspaceConfigItem & { id: RailDestinationId })[];
  chosen: RailDestinationId[];
  onSave: (next: RailDestinationId[]) => void;
}) {
  const [draft, setDraft] = useState<RailDestinationId[]>(props.chosen);
  const [wasOpen, setWasOpen] = useState(props.open);
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    if (props.open) setDraft(props.chosen);
  }
  const options: RailDestinationId[] = ["for-you", ...props.destinations.map((item) => item.id)];
  const toggle = (id: RailDestinationId, checked: boolean) =>
    setDraft((current) =>
      checked ? [...current, id] : current.filter((candidate) => candidate !== id),
    );
  const isDefault =
    draft.length === DEFAULT_RAIL_DESTINATIONS.length &&
    DEFAULT_RAIL_DESTINATIONS.every((id) => draft.includes(id));

  return (
    <FormDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      size="sm"
      title="Customize rail"
      description="Pick what shows in the rail. Everything else stays under More."
      submitLabel="Save"
      onSubmit={() => props.onSave(draft)}
      footerStart={
        isDefault ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2.5 text-fg-muted"
            onClick={() => setDraft([...DEFAULT_RAIL_DESTINATIONS])}
          >
            Reset
          </Button>
        )
      }
    >
      <div role="group" aria-label="Destinations" className="grid gap-3">
        {options.map((id) => (
          <CheckboxField
            key={id}
            name={`rail-${id}`}
            label={DESTINATION_LABELS[id]}
            checked={draft.includes(id)}
            onCheckedChange={(checked) => toggle(id, checked)}
          />
        ))}
      </div>
    </FormDialog>
  );
}
