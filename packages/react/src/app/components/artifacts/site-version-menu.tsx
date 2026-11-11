import type { WorkspaceArtifactDetailResponse, WorkspaceArtifactVersion } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import { ChevronDownIcon, HistoryIcon, Undo2Icon } from "lucide-react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuMeta,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import { RelativeTime } from "../../../ui/relative-time";
import { userErrorText } from "../../../ui/api-error";
import { useAppContext } from "../../app-context";
import { Link } from "../../lib/navigation";
import { toast } from "../../lib/toast";
import { invalidateArtifactCatalog } from "../../lib/use-artifact-catalog";
import { cn } from "../../lib/utils";

/** Versions listed in the menu; the Site's details list every one. */
const LISTED_VERSIONS = 8;

/**
 * The version Undo goes back to: the one live before the change that made
 * the current version live (a publish or a restore), else the revision
 * before it. Null when there is nothing to go back to.
 */
export function siteUndoTarget(
  detail: Pick<WorkspaceArtifactDetailResponse, "artifact" | "versions" | "events">,
): WorkspaceArtifactVersion | null {
  return siteUndo(detail)?.version ?? null;
}

/**
 * Undo's target and what it undoes: a publish, or a restore (so undoing an
 * Undo, which goes forward again).
 */
function siteUndo(
  detail: Pick<WorkspaceArtifactDetailResponse, "artifact" | "versions" | "events">,
): { version: WorkspaceArtifactVersion; undoes: "change" | "restore" } | null {
  const current = detail.artifact.currentVersion;
  if (!current) return null;
  const change = detail.events
    .filter(
      (event) =>
        (event.type === "published" || event.type === "rolled_back") &&
        event.toVersionId === current.id &&
        event.fromVersionId !== null &&
        event.fromVersionId !== current.id,
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const before = change && detail.versions.find((version) => version.id === change.fromVersionId);
  if (before)
    return { version: before, undoes: change.type === "rolled_back" ? "restore" : "change" };
  const previous = detail.versions
    .filter((version) => version.revision < current.revision)
    .sort((a, b) => b.revision - a.revision)[0];
  return previous ? { version: previous, undoes: "change" } : null;
}

/**
 * The Site header's version chip: the version that is live, its recent
 * history, one-click Undo and Restore for anyone who may publish the Site.
 * Restoring moves the Site to an earlier version, which goes live at once,
 * like a publish; nothing is lost and Undo comes back.
 */
export function SiteVersionMenu({
  workspaceId,
  siteId,
  detail,
  canPublish,
  onRestored,
}: {
  workspaceId: string;
  siteId: string;
  detail: WorkspaceArtifactDetailResponse;
  canPublish: boolean;
  /** After a restore (or a refused one), so the view reads the Site again. */
  onRestored: () => void;
}) {
  const { client, authSession } = useAppContext();
  const [busy, setBusy] = useState<string | null>(null);
  const current = detail.artifact.currentVersion;
  if (!current) return null;
  const editable = canPublish && detail.artifact.status === "active";
  const undo = editable ? siteUndo(detail) : null;
  const versions = [...detail.versions]
    .sort((a, b) => b.revision - a.revision)
    .slice(0, LISTED_VERSIONS);
  const restore = async (version: WorkspaceArtifactVersion, how: "undo" | "restore") => {
    if (busy || version.id === current.id) return;
    setBusy(version.id);
    try {
      await client.rollbackWorkspaceArtifact(workspaceId, siteId, {
        versionId: version.id,
        expectedCurrentVersionId: current.id,
        reason: `${how === "undo" ? "Undone" : "Restored"} from the Site view by ${authSession?.user?.name ?? "a workspace member"}`,
        idempotencyKey: crypto.randomUUID(),
      });
      invalidateArtifactCatalog(client, workspaceId);
      toast.success(`Version ${version.revision} is live again`);
    } catch (error) {
      if (error instanceof OpenGeniApiError && error.status === 409)
        toast.error("The Site changed meanwhile", { description: "Showing its latest version." });
      else toast.error("Couldn't restore that version", { description: userErrorText(error) });
    } finally {
      setBusy(null);
      onRestored();
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          // The name starts with what the chip shows, for voice control.
          aria-label={
            busy
              ? "Restoring…"
              : `v${current.revision}, version history${editable ? " and undo" : ""}`
          }
          aria-busy={busy !== null || undefined}
          data-site-version-chip=""
          className={cn(
            "inline-flex h-5 shrink-0 items-center gap-0.5 rounded-md border border-border/80 px-1.5 text-2xs font-normal text-fg-muted",
            "hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
            "pointer-coarse:h-8 pointer-coarse:px-2",
          )}
        >
          {busy ? "Restoring…" : `v${current.revision}`}
          <ChevronDownIcon aria-hidden="true" className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {undo ? (
          <>
            <DropdownMenuItem
              disabled={busy !== null}
              onSelect={() => void restore(undo.version, "undo")}
            >
              <Undo2Icon aria-hidden="true" />
              {undo.undoes === "restore" ? "Undo restore" : "Undo last change"}
              <DropdownMenuMeta>v{undo.version.revision}</DropdownMenuMeta>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuLabel>{editable ? "Restore a version" : "Versions"}</DropdownMenuLabel>
        {versions.map((version) => {
          const live = version.id === current.id;
          return (
            <DropdownMenuItem
              key={version.id}
              disabled={!editable || live || busy !== null}
              onSelect={() => void restore(version, "restore")}
              aria-current={live || undefined}
            >
              <span className="min-w-0 flex-1 truncate">Version {version.revision}</span>
              <DropdownMenuMeta>
                <RelativeTime date={version.createdAt} tooltip={false} focusable={false} />
              </DropdownMenuMeta>
              <DropdownMenuCheck checked={live} />
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            to="/workspaces/$workspaceId/artifacts/$artifactId"
            params={{ workspaceId, artifactId: siteId }}
            search={{ tab: "versions" }}
          >
            <HistoryIcon aria-hidden="true" />
            All versions
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
