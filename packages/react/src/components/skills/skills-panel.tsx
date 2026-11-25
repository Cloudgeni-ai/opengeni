/**
 * A workspace's Skills page for any host: the list, one Skill's page with its
 * folder editor (SKILL.md and supporting text files), save and remove, an
 * optional version history with restore, and upload of a SKILL.md, a folder
 * or a .zip (picked or dropped). The host hands it a client (its own
 * OpenGeniClient, or anything with the same Skill methods), which scopes it
 * lists and writes, and who may change what. Reading needs only the list and
 * read methods; people who can't manage a scope see its Skills read-only.
 *
 * A Skill's page replaces the list in place. A host with its own URL or page
 * area passes `slot`: the open page key follows the host's navigation (Back,
 * Forward, shared links) and, with a `target`, the page renders there.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  FileArchiveIcon,
  FolderUpIcon,
  GraduationCapIcon,
  PlusIcon,
  UploadIcon,
} from "lucide-react";
import type {
  OpenGeniClient,
  PreferenceRegistryRevisionSummary,
  RemoveWorkspaceSkillRequest,
  SkillRecord,
  SkillScope,
  SkillSummary,
} from "@opengeni/sdk";
import { parseSkillFrontmatter } from "@opengeni/contracts";

import {
  humanizeName,
  isGeneratedSkillKey,
  skillShortDescription,
} from "../../app/lib/skill-names";
import { ConnectionInstalled } from "../../connection-installed";
import { Button } from "../../ui/button";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { DetailPage } from "../../ui/detail-page";
import { DetailSkeleton } from "../../ui/detail-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { EmptyState } from "../../ui/empty-state";
import { ErrorMessage } from "../../ui/error-message";
import { LogoTile } from "../../ui/logo-tile";
import { StandaloneOverlayRoot } from "../../ui/portal-container";
import { Skeleton } from "../../ui/skeleton";
import {
  apiErrorDetails,
  isApiError,
  isPermissionDenied,
  serverRefusalText,
  userErrorText,
  userErrorTextWithoutReference,
} from "../../ui/api-error";
import { cn } from "../../lib/cn";
import { SkillPage, skillStatus } from "./skill-page";
import {
  filesFromDrop,
  readSkillUpload,
  skillFilesProblem,
  type SkillUpload,
  type UploadedFile,
} from "./skill-upload";
import "../../../styles/connect.css";

/** The Skill methods the page uses. History, approval and scope moves are optional. */
export type SkillsClient = Pick<
  OpenGeniClient,
  "listWorkspaceSkills" | "readWorkspaceSkill" | "saveWorkspaceSkill" | "removeWorkspaceSkill"
> &
  Partial<
    Pick<
      OpenGeniClient,
      | "getPreferenceRegistry"
      | "restoreWorkspaceSkill"
      | "approveWorkspaceSkill"
      | "changePreferenceRegistryScope"
    >
  >;

/**
 * The host's navigation for an open Skill. `openKey` is "skill:<id>" (or
 * "skill:new" for an unsaved one) while a Skill is open, null on the list.
 * With a `target` (even while it is still null) the page renders into it;
 * without one it replaces the list in place.
 */
export type SkillsPageSlot = {
  openKey: string | null;
  open: (key: string, options?: { replace?: boolean }) => void;
  close: (options?: { replace?: boolean }) => void;
  target?: HTMLElement | null | undefined;
};

/** Whose Skills the list shows, for a host that offers the choice. */
export type SkillOwnerFilter = "all" | "mine" | "workspace" | "organization";

const SKILL_SCOPE_LABEL: Record<SkillScope, string> = {
  workspace: "Workspace",
  organization: "Organization",
  user: "Yours",
};

export const SKILL_OWNER_FILTER_OPTIONS: ReadonlyArray<{
  value: SkillOwnerFilter;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "mine", label: SKILL_SCOPE_LABEL.user },
  { value: "workspace", label: SKILL_SCOPE_LABEL.workspace },
  { value: "organization", label: SKILL_SCOPE_LABEL.organization },
];

/** The server-side list filter for a choice; the list is paged, so the server filters. */
export function skillOwnerListFilter(owner: SkillOwnerFilter): { scope?: SkillScope } {
  if (owner === "mine") return { scope: "user" };
  if (owner === "workspace" || owner === "organization") return { scope: owner };
  return {};
}

const ALL_SCOPES: readonly SkillScope[] = ["user", "workspace", "organization"];
/** Where a new or uploaded Skill goes: the first of these the person can manage. */
const NEW_SKILL_SCOPES: readonly SkillScope[] = ["workspace", "organization"];
const NEW_SKILL_TEMPLATE = "---\nname: my-skill\ndescription: When to use this Skill\n---\n\n";

/** Imperative handle for hosts: open a Skill, or merge facts they changed elsewhere. */
export type SkillsPanelController = {
  open: (skillId: string) => void;
  update: (skillId: string, patch: Partial<SkillSummary>) => void;
};

export interface SkillsPanelProps {
  client: SkillsClient;
  workspaceId: string;
  /** Whether this person may create, edit and remove Skills of a scope. */
  canManage: (scope: SkillScope) => boolean;
  /** The scopes listed and offered. Default all three. */
  scopes?: readonly SkillScope[] | undefined;
  /** Show versions and restore. Default: whenever the client can read them. */
  history?: boolean | undefined;
  /** Offer upload (SKILL.md, folder or .zip, picked or dropped). Default true. */
  upload?: boolean | undefined;
  /** The list heading. Default "Skills"; null when the host supplies its own. */
  title?: string | null | undefined;
  /** One plain sentence under the title. */
  description?: ReactNode | undefined;
  /** Replaces the default heading row; it must render `action` and keep `headingRef`. */
  renderHeader?:
    | ((header: {
        title: string;
        action: ReactNode;
        headingRef: Ref<HTMLHeadingElement>;
        hidden: boolean;
      }) => ReactNode)
    | undefined;
  /** Extra ways to add a Skill (DropdownMenuItem elements), listed under upload. */
  addMenuItems?: ReactNode | undefined;
  /** What an empty list says. */
  emptyText?: string | undefined;
  /**
   * `details.code` values of refusals the host's relay words for people, such
   * as a name its own built-in Skills already use. The page shows that
   * sentence instead of generic advice.
   */
  refusalCodes?: readonly string[] | undefined;
  /** Heading above the rows, with their count. Default none: the page title names them. */
  listTitle?: string | null | undefined;
  /** Filters the loaded list by name. */
  query?: string | undefined;
  owner?: SkillOwnerFilter | undefined;
  /** Also list organization Skills that don't work in this workspace. */
  showUnavailable?: boolean | undefined;
  /** Bump to reload the list (after an install elsewhere). */
  refreshRevision?: number | undefined;
  onSkillsChange?: ((skills: SkillSummary[]) => void) | undefined;
  onRemoved?: (() => void) | undefined;
  controllerRef?: RefObject<SkillsPanelController | null> | undefined;
  slot?: SkillsPageSlot | null | undefined;
  /** The back link on a Skill's page. Default "Skills". */
  backLabel?: string | undefined;
  /** Where an organization Skill works ("All workspaces"), and opening its editor. */
  reach?:
    | {
        summary: (skill: SkillRecord) => string | undefined;
        onChange?: ((skill: SkillRecord) => void) | undefined;
      }
    | undefined;
  /** Rendered after the panel, for host dialogs tied to the open Skill. */
  children?: ((open: SkillRecord | null) => ReactNode) | undefined;
  className?: string | undefined;
}

/** What failed, and the error behind it: the UI shows advice, never the raw API string. */
type SkillsFailure = { title: string; cause: unknown };

function hasFiles(transfer: DataTransfer | null): boolean {
  return Boolean(transfer && [...transfer.types].includes("Files"));
}

function skillName(skill: Pick<SkillSummary, "title" | "stableKey">): string {
  return humanizeName(skill.title || (isGeneratedSkillKey(skill.stableKey) ? "" : skill.stableKey));
}

function uploadNotice(upload: SkillUpload, replacing: boolean): string {
  const lead = replacing
    ? "The uploaded files replace this skill's files. Check them, then save."
    : `Uploaded ${upload.files.length} ${upload.files.length === 1 ? "file" : "files"}. Check them, then save.`;
  if (!upload.skipped.length) return lead;
  const shown = upload.skipped.slice(0, 3).join(", ");
  const more = upload.skipped.length > 3 ? ` and ${upload.skipped.length - 3} more` : "";
  return `${lead} Left out: ${shown}${more}.`;
}

export function SkillsPanel({
  client,
  workspaceId,
  canManage: canManageScope,
  scopes = ALL_SCOPES,
  history: historyProp,
  upload: uploadEnabled = true,
  title = "Skills",
  description,
  renderHeader,
  addMenuItems,
  emptyText,
  refusalCodes,
  listTitle = null,
  query = "",
  owner = "all",
  showUnavailable = false,
  refreshRevision = 0,
  onSkillsChange,
  onRemoved,
  controllerRef,
  slot = null,
  backLabel = "Skills",
  reach,
  children,
  className,
}: SkillsPanelProps) {
  const canManage = useCallback(
    (scope: SkillScope) => scopes.includes(scope) && canManageScope(scope),
    [scopes, canManageScope],
  );
  const withHistory = historyProp ?? Boolean(client.getPreferenceRegistry);
  const newScope = NEW_SKILL_SCOPES.find(canManage) ?? null;
  const errorText = (cause: unknown) =>
    (refusalCodes && serverRefusalText(cause, refusalCodes)) ?? userErrorText(cause);
  const listFilter = useMemo((): { scope?: SkillScope } => {
    const filter = skillOwnerListFilter(owner);
    const only = scopes.length === 1 ? scopes[0] : undefined;
    return !filter.scope && only ? { scope: only } : filter;
  }, [owner, scopes]);
  // The refresh below reads the current filter without re-running on a filter change.
  const listFilterRef = useRef(listFilter);
  listFilterRef.current = listFilter;
  const openerRef = useRef<HTMLElement | null>(null);
  const removalTriggerRef = useRef<HTMLElement | null>(null);
  const newSkillRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  // The panel's own root: its menus and dialogs carry its theme when it stands alone in a host page.
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [record, setRecord] = useState<SkillRecord | null>(null);
  const [files, setFiles] = useState<SkillRecord["files"]>([]);
  const [path, setPath] = useState("SKILL.md");
  const [newPath, setNewPath] = useState("");
  const [history, setHistory] = useState<PreferenceRegistryRevisionSummary[]>([]);
  const [error, setError] = useState<SkillsFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [removal, setRemoval] = useState<{
    skill: SkillRecord;
    request: RemoveWorkspaceSkillRequest;
  } | null>(null);
  const [removalError, setRemovalError] = useState<string | null>(null);
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null);
  // The id of a skill created or uploaded on this page and not saved yet.
  const [draftId, setDraftId] = useState<string | null>(null);
  // An uploaded draft has unsaved work from the start; a blank new one doesn't.
  const [draftUploaded, setDraftUploaded] = useState(false);
  // The skill a page open is loading, so the URL sync does not load it twice.
  const openingRef = useRef<string | null>(null);
  const dragDepth = useRef(0);
  const generation = useRef(0);
  const inventoryGeneration = useRef(0);
  const dirty = Boolean(
    record &&
    ((record.id === draftId && draftUploaded) ||
      files.length !== record.files.length ||
      files.some(
        (file, index) =>
          file.path !== record.files[index]?.path || file.content !== record.files[index]?.content,
      )),
  );
  const visible = useCallback(
    (skill: SkillSummary) =>
      scopes.includes(skill.scope) &&
      (skill.availableHere !== false || showUnavailable) &&
      (!listFilter.scope || skill.scope === listFilter.scope),
    [scopes, showUnavailable, listFilter],
  );

  useEffect(() => {
    generation.current++;
    openingRef.current = null;
    const current = ++inventoryGeneration.current;
    setLoading(true);
    setBusy(false);
    setRecord(null);
    setHistory([]);
    setNotice(null);
    setDiscardAction(null);
    setRemoval(null);
    setRemovalError(null);
    setSkills([]);
    setNextCursor(null);
    setError(null);
    void client
      .listWorkspaceSkills(workspaceId, listFilter)
      .then((result) => {
        if (inventoryGeneration.current === current) {
          setLoading(false);
          setSkills(result.skills);
          setNextCursor(result.nextCursor ?? null);
        }
      })
      .catch((reason) => {
        if (inventoryGeneration.current === current)
          setError({ title: "Couldn't load skills", cause: reason });
      })
      .finally(() => {
        if (inventoryGeneration.current === current) setLoading(false);
      });
    return () => {
      // Invalidate every request started since this effect, not only its initial list.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      inventoryGeneration.current++;
    };
  }, [client, workspaceId, reload, listFilter]);

  useEffect(() => {
    onSkillsChange?.(skills.filter(visible));
  }, [skills, onSkillsChange, visible]);
  useEffect(() => {
    if (!refreshRevision) return;
    let live = true;
    const current = ++inventoryGeneration.current;
    void client
      .listWorkspaceSkills(workspaceId, listFilterRef.current)
      .then((result) => {
        if (live && current === inventoryGeneration.current) {
          setLoading(false);
          setSkills(result.skills);
          setNextCursor(result.nextCursor ?? null);
        }
      })
      .catch((reason) => {
        if (live && current === inventoryGeneration.current)
          setError({ title: "Couldn't refresh skills", cause: reason });
      })
      .finally(() => {
        if (live && current === inventoryGeneration.current) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [client, workspaceId, refreshRevision]);
  useEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = {
      open: (id) => navigate(() => void open(id)),
      update: (id, patch) => {
        setSkills((list) =>
          list.map((skill) => (skill.id === id ? { ...skill, ...patch } : skill)),
        );
        setRecord((value) => (value?.id === id ? { ...value, ...patch } : value));
      },
    };
    return () => {
      controllerRef.current = null;
    };
  });

  // Keep the open page and the host's navigation in step: Back, Forward and shared links.
  const slotKey = slot?.openKey ?? null;
  useEffect(() => {
    if (!slot) return;
    if (slotKey?.startsWith("skill:")) {
      const id = slotKey.slice("skill:".length);
      if (id === "new") {
        if (record && record.id === draftId) return;
        if (newScope) create(newScope);
        else slot.close({ replace: true });
        return;
      }
      if (record?.id === id || openingRef.current === id) return;
      void open(id);
      return;
    }
    if (record) {
      generation.current++;
      setRecord(null);
      setDraftId(null);
      setBusy(false);
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- follows the host's navigation and a reloaded inventory
  }, [slotKey, loading]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  function navigate(action: () => void) {
    if (dirty) setDiscardAction(() => action);
    else action();
  }

  const loadMore = useCallback(async () => {
    if (!nextCursor || busy) return;
    const current = generation.current;
    const inventoryRequest = ++inventoryGeneration.current;
    setBusy(true);
    setError(null);
    try {
      const page = await client.listWorkspaceSkills(workspaceId, {
        ...listFilter,
        cursor: nextCursor,
      });
      if (inventoryGeneration.current !== inventoryRequest) return;
      setSkills((previous) => [
        ...new Map([...previous, ...page.skills].map((skill) => [skill.id, skill])).values(),
      ]);
      setNextCursor(page.nextCursor);
    } catch (reason) {
      if (generation.current === current)
        setError({ title: "Couldn't load more skills", cause: reason });
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }, [nextCursor, busy, client, workspaceId, listFilter]);

  useEffect(() => {
    if (query.trim() && nextCursor && !busy && !error) void loadMore();
  }, [query, nextCursor, busy, error, loadMore]);

  function show(next: SkillRecord, nextFiles: SkillRecord["files"] = next.files) {
    setRecord(next);
    setFiles(nextFiles);
    setPath("SKILL.md");
    setNewPath("");
  }
  async function readHistory(skillId: string): Promise<PreferenceRegistryRevisionSummary[]> {
    if (!withHistory || !client.getPreferenceRegistry) return [];
    return (await client.getPreferenceRegistry(workspaceId, skillId)).revisions;
  }
  async function open(skillId: string, revisionId?: string, uploaded?: SkillUpload): Promise<void> {
    if (!record) openerRef.current = document.activeElement as HTMLElement | null;
    openingRef.current = skillId;
    if (slot && slot.openKey !== `skill:${skillId}`) slot.open(`skill:${skillId}`);
    const current = ++generation.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const [next, revisions] = await Promise.all([
        client.readWorkspaceSkill(workspaceId, skillId, revisionId),
        readHistory(skillId),
      ]);
      if (generation.current !== current) return;
      setDraftId(null);
      show(next, uploaded?.files);
      setHistory(revisions);
      if (uploaded) setNotice(uploadNotice(uploaded, true));
    } catch (reason) {
      if (generation.current === current)
        setError({ title: "Couldn't open this skill", cause: reason });
    } finally {
      if (generation.current === current) {
        setBusy(false);
        openingRef.current = null;
      }
    }
  }
  function closePage() {
    generation.current++;
    setRecord(null);
    setDraftId(null);
    setError(null);
    setNotice(null);
    setBusy(false);
    if (slot?.openKey?.startsWith("skill:")) slot.close();
    const opener = openerRef.current;
    openerRef.current = null;
    queueMicrotask(() => {
      if (opener?.isConnected && !opener.matches(":disabled")) opener.focus();
      else headingRef.current?.focus();
    });
  }
  function create(scope: SkillScope, uploaded?: SkillUpload) {
    if (!record) openerRef.current = newSkillRef.current;
    generation.current++;
    setHistory([]);
    setError(null);
    setNotice(uploaded ? uploadNotice(uploaded, false) : null);
    const id = crypto.randomUUID();
    setDraftId(id);
    setDraftUploaded(Boolean(uploaded));
    if (slot && slot.openKey !== "skill:new") slot.open("skill:new");
    show({
      id,
      stableKey: "",
      scope,
      scopeVersion: 1,
      activationMode: "workspace_managed",
      pendingRevisionIds: [],
      status: "proposed",
      activeRevisionId: null,
      revisionId: null,
      title: uploaded?.name ?? "",
      description: "",
      contentHash: null,
      source: null,
      files: uploaded?.files ?? [{ path: "SKILL.md", content: NEW_SKILL_TEMPLATE }],
    });
  }
  async function upload(picked: Iterable<UploadedFile>) {
    if (!newScope || busy) return;
    const current = ++generation.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const uploaded = await readSkillUpload(picked);
      if (generation.current !== current) return;
      setBusy(false);
      // Uploading a skill that is already here updates it, rather than adding a second one.
      const existing = uploaded.name
        ? skills.find(
            (skill) =>
              (skill.title === uploaded.name || skill.stableKey === uploaded.name) &&
              visible(skill) &&
              canManage(skill.scope),
          )
        : undefined;
      if (existing) await open(existing.id, undefined, uploaded);
      else create(newScope, uploaded);
    } catch (reason) {
      if (generation.current === current) {
        setBusy(false);
        setError({ title: "Couldn't upload this skill", cause: reason });
      }
    }
  }
  async function changeScope(scope: SkillScope) {
    if (!record || scope === record.scope) return;
    if (!record.revisionId) {
      setRecord({ ...record, scope });
      return;
    }
    if (!client.changePreferenceRegistryScope) return;
    const current = ++generation.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await client.changePreferenceRegistryScope(workspaceId, record.id, {
        scope,
        expectedScopeVersion: record.scopeVersion,
        reason: "Change skill scope",
      });
      if (generation.current !== current) return;
      const inventoryRequest = ++inventoryGeneration.current;
      const [updated, inventory] = await Promise.all([
        client.readWorkspaceSkill(workspaceId, record.id, record.revisionId),
        client.listWorkspaceSkills(workspaceId, listFilter),
      ]);
      if (inventoryGeneration.current === inventoryRequest) {
        setSkills(inventory.skills);
        setNextCursor(inventory.nextCursor ?? null);
      }
      if (generation.current !== current) return;
      // Keep any unsaved file edits while refreshing scope/version metadata.
      setRecord(updated);
      setNotice("Skill scope updated.");
    } catch (reason) {
      if (generation.current === current)
        setError({ title: "Couldn't change who can use this skill", cause: reason });
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  /** A name another Skill here already uses; agents would see two with one name. */
  function nameTakenBy(): SkillSummary | undefined {
    if (!record) return undefined;
    let name: string | null = null;
    try {
      name = parseSkillFrontmatter(
        files.find((file) => file.path === "SKILL.md")?.content ?? "",
      ).name;
    } catch {
      return undefined;
    }
    if (!name) return undefined;
    return skills.find(
      (other) =>
        other.id !== record.id &&
        other.scope === record.scope &&
        (other.title === name || other.stableKey === name),
    );
  }
  async function mutate(operation: "save" | "approve" | "restore") {
    if (!record) return;
    if (operation === "save") {
      const problem = skillFilesProblem(files);
      const taken = problem ? undefined : nameTakenBy();
      if (problem || taken) {
        setNotice(null);
        setError({
          title: "Couldn't save this skill",
          cause: new Error(
            problem ??
              `Another skill here is already called ${skillName(taken!)}. Give this one a different name, or open that one to change it.`,
          ),
        });
        return;
      }
    }
    const current = ++generation.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const version = {
        ...(operation === "approve" && record.removalOperationId
          ? { removalOperationId: record.removalOperationId }
          : {}),
        operationId: crypto.randomUUID(),
        expectedRevisionId: record.activeRevisionId,
        expectedScopeVersion: record.scopeVersion,
        reason: operation === "save" ? "Save Skill files" : `${operation} Skill revision`,
      };
      const apply =
        operation === "approve" ? client.approveWorkspaceSkill : client.restoreWorkspaceSkill;
      if (operation !== "save" && !apply) return;
      const receipt =
        operation === "save"
          ? await client.saveWorkspaceSkill(workspaceId, {
              ...version,
              skillId: record.id,
              scope: record.scope,
              stableKey: record.stableKey || `authored-${record.id.replaceAll("-", "")}`,
              files,
              deletions: record.files
                .filter((file) => !files.some((next) => next.path === file.path))
                .map((file) => file.path),
            })
          : await apply!.call(client, workspaceId, record.id, {
              ...version,
              revisionId: record.revisionId!,
            });
      if (generation.current !== current) return;
      if (receipt.removed) {
        setRecord(null);
        if (slot?.openKey?.startsWith("skill:")) slot.close({ replace: true });
        setSkills((await client.listWorkspaceSkills(workspaceId, listFilter)).skills);
        setNotice("Skill and all stored revisions permanently deleted.");
        return;
      }
      const inventoryRequest = ++inventoryGeneration.current;
      const [updated, inventory, revisions] = await Promise.all([
        client.readWorkspaceSkill(workspaceId, receipt.skillId),
        client.listWorkspaceSkills(workspaceId, listFilter),
        readHistory(receipt.skillId),
      ]);
      if (inventoryGeneration.current === inventoryRequest) {
        setSkills(inventory.skills);
        setNextCursor(inventory.nextCursor ?? null);
      }
      if (generation.current !== current) return;
      show(updated);
      if (draftId) {
        setDraftId(null);
        if (slot) slot.open(`skill:${updated.id}`, { replace: true });
      }
      setHistory(revisions);
      setNotice(
        receipt.outcome === "pending"
          ? "Saved for approval; not active yet."
          : receipt.outcome === "preserved"
            ? "Your customized Skill was preserved."
            : "Skill saved. Agents use it from their next message.",
      );
    } catch (reason) {
      if (generation.current === current)
        setError({
          title:
            operation === "save"
              ? "Couldn't save this skill"
              : operation === "approve"
                ? "Couldn't approve this revision"
                : "Couldn't restore this revision",
          cause: reason,
        });
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  async function remove(): Promise<boolean> {
    if (!removal || busy) return false;
    const current = ++generation.current;
    setBusy(true);
    setRemovalError(null);
    try {
      const receipt = await client.removeWorkspaceSkill(
        workspaceId,
        removal.skill.id,
        removal.request,
      );
      if (generation.current !== current) return false;
      if (!receipt.removed) throw new Error("The skill was not removed. Reload and try again.");
      // Invalidate outstanding inventory reads before removing the row locally.
      inventoryGeneration.current++;
      setSkills((previous) => previous.filter((skill) => skill.id !== removal.skill.id));
      setRecord(null);
      setHistory([]);
      setDraftId(null);
      setNotice("Skill and all stored revisions permanently deleted.");
      if (slot?.openKey?.startsWith("skill:")) slot.close({ replace: true });
      onRemoved?.();
      return true;
    } catch (reason) {
      if (generation.current === current) setRemovalError(errorText(reason));
      return false;
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }

  const canUpload = uploadEnabled && newScope !== null;
  function pick(input: HTMLInputElement | null) {
    if (!input) return;
    input.value = "";
    input.click();
  }
  function onPicked(input: HTMLInputElement) {
    const picked = [...(input.files ?? [])];
    input.value = "";
    if (picked.length) navigate(() => void upload(picked));
  }
  const dropTarget = canUpload && !record;
  const dragHandlers = dropTarget
    ? {
        onDragEnter: (event: DragEvent<HTMLElement>) => {
          if (!hasFiles(event.dataTransfer)) return;
          event.preventDefault();
          dragDepth.current++;
          setDragging(true);
        },
        onDragOver: (event: DragEvent<HTMLElement>) => {
          if (!hasFiles(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        },
        onDrop: (event: DragEvent<HTMLElement>) => {
          if (!hasFiles(event.dataTransfer)) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          const transfer = event.dataTransfer;
          void filesFromDrop(transfer)
            .then((dropped) => upload(dropped))
            .catch((reason) => setError({ title: "Couldn't upload this skill", cause: reason }));
        },
      }
    : {};

  const editable =
    record &&
    canManage(record.scope) &&
    (record.revisionId === record.activeRevisionId || record.revisionId === null);
  const needle = query.trim().toLowerCase();
  const listed = skills.filter(visible);
  const matchingSkills = listed.filter((skill) =>
    `${skill.title} ${skill.stableKey}`.toLowerCase().includes(needle),
  );
  const describeRows = scopes.length === 1;
  const showEmptyState =
    !loading && !error && !listed.length && owner === "all" && emptyText === undefined;

  const back = () => navigate(() => closePage());
  const slotSkillKey = slot?.openKey?.startsWith("skill:") ? slot.openKey : null;
  const pageContent = record ? (
    <SkillPage
      record={record}
      files={files}
      path={path}
      newPath={newPath}
      history={history}
      error={error ? `${error.title}. ${errorText(error.cause)}` : null}
      notice={notice}
      busy={busy}
      dirty={dirty && record.id !== draftId}
      isNew={record.id === draftId}
      editable={Boolean(editable)}
      canManage={canManage}
      scopes={record.revisionId && !client.changePreferenceRegistryScope ? [record.scope] : scopes}
      backLabel={backLabel}
      onBack={back}
      onPathChange={setPath}
      onNewPathChange={setNewPath}
      onContentChange={(content) =>
        setFiles((current) =>
          current.map((file) => (file.path === path ? { ...file, content } : file)),
        )
      }
      onAddFile={() => {
        setFiles((current) => [...current, { path: newPath, content: "" }]);
        setPath(newPath);
        setNewPath("");
      }}
      onRemoveFile={() => {
        setFiles((current) => current.filter((file) => file.path !== path));
        setPath("SKILL.md");
      }}
      onRemove={() => {
        removalTriggerRef.current = document.activeElement as HTMLElement | null;
        setRemovalError(null);
        setRemoval({
          skill: record,
          request: {
            operationId: crypto.randomUUID(),
            expectedRevisionId: record.activeRevisionId,
            expectedScopeVersion: record.scopeVersion,
            reason: "Remove skill from the Skills editor",
          },
        });
      }}
      onSave={() => void mutate("save")}
      onDiscard={() => {
        setFiles(record.files);
        setPath("SKILL.md");
        setNotice(null);
        setError(null);
      }}
      onReviewRevision={(operation) => void mutate(operation)}
      onChangeScope={(scope) => void changeScope(scope)}
      onOpenRevision={(revisionId) => navigate(() => void open(record.id, revisionId))}
      reachSummary={reach ? reach.summary(record) : undefined}
      onChangeReach={
        record.scope === "organization" && reach?.onChange
          ? () => reach.onChange?.(record)
          : undefined
      }
    />
  ) : slotSkillKey ? (
    <DetailPage back={{ label: backLabel, onClick: back }}>
      {error ? (
        <EmptyState
          variant="page"
          title="Couldn't open this skill"
          description={errorText(error.cause)}
          action={
            <Button type="button" variant="outline" size="sm" onClick={back}>
              Back to {backLabel}
            </Button>
          }
        />
      ) : (
        <DetailSkeleton />
      )}
    </DetailPage>
  ) : null;
  const portal = slot !== null && slot.target !== undefined;
  const pageInPlace = !portal && pageContent !== null;

  const addMenu =
    canUpload || addMenuItems ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" disabled={busy}>
            <UploadIcon aria-hidden="true" />
            {canUpload ? "Upload" : "Import"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canUpload ? (
            <>
              <DropdownMenuItem onSelect={() => pick(fileInputRef.current)}>
                <FileArchiveIcon />
                SKILL.md or .zip file
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => pick(folderInputRef.current)}>
                <FolderUpIcon />
                Skill folder
              </DropdownMenuItem>
            </>
          ) : null}
          {addMenuItems}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;
  const action =
    newScope || addMenu ? (
      <div
        hidden={Boolean(query.trim()) || showEmptyState}
        className="flex flex-wrap items-center gap-2"
      >
        {addMenu}
        {newScope ? (
          <Button
            ref={newSkillRef}
            type="button"
            variant="default"
            disabled={busy}
            onClick={() => navigate(() => create(newScope))}
          >
            <PlusIcon aria-hidden="true" />
            New skill
          </Button>
        ) : null}
      </div>
    ) : null;
  const headerHidden = Boolean(query.trim()) && !matchingSkills.length && !record;
  const heading = renderHeader ? (
    renderHeader({ title: title ?? "Skills", action, headingRef, hidden: headerHidden })
  ) : (
    <div
      hidden={headerHidden}
      className={cn(
        "flex flex-wrap items-start justify-between gap-3",
        title === null && "justify-end",
      )}
    >
      {title === null ? (
        <h2 ref={headingRef} tabIndex={-1} className="sr-only">
          Skills
        </h2>
      ) : (
        <div className="min-w-0 space-y-0.5">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="m-0 text-base leading-6 font-semibold text-fg outline-hidden"
          >
            {title}
          </h2>
          {description ? (
            <p className="m-0 max-w-3xl text-sm leading-5 text-fg-muted">{description}</p>
          ) : null}
        </div>
      )}
      {action}
    </div>
  );

  const rows = matchingSkills.map((skill) => {
    const name = skillName(skill) || "Untitled skill";
    const state = skill.availableHere === false ? "Not used here" : skillStatus(skill);
    const detail = describeRows
      ? state === "Installed"
        ? (skillShortDescription(skill.description) ?? "No description")
        : state
      : `${state} · ${SKILL_SCOPE_LABEL[skill.scope]}`;
    return {
      id: skill.id,
      name,
      icon: <LogoTile name={name} icon={<GraduationCapIcon />} />,
      status: detail,
      statusTone: describeRows && state === "Installed" ? ("description" as const) : undefined,
      needsAttention: Boolean(skill.pendingRevisionIds.length),
      disabled: busy,
      onOpen: () => {
        if (!busy) navigate(() => void open(skill.id));
      },
    };
  });
  const emptyAction =
    canUpload || newScope ? (
      <div className="flex flex-wrap justify-center gap-2">
        {canUpload ? (
          <Button type="button" variant="outline" onClick={() => pick(fileInputRef.current)}>
            <UploadIcon aria-hidden="true" />
            Upload a skill
          </Button>
        ) : null}
        {newScope ? (
          <Button type="button" onClick={() => navigate(() => create(newScope))}>
            <PlusIcon aria-hidden="true" />
            New skill
          </Button>
        ) : null}
      </div>
    ) : undefined;

  return (
    <section
      ref={setRoot}
      aria-label="Skills"
      className={cn("og-root skills-panel relative min-w-0 space-y-4", className)}
      {...dragHandlers}
    >
      <StandaloneOverlayRoot source={root}>
        {canUpload ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              hidden
              tabIndex={-1}
              aria-hidden="true"
              accept=".md,.markdown,.zip,text/markdown,application/zip"
              onChange={(event) => onPicked(event.currentTarget)}
            />
            <input
              ref={(node) => {
                folderInputRef.current = node;
                // Not in React's input typings; every current browser supports it.
                node?.setAttribute("webkitdirectory", "");
              }}
              type="file"
              hidden
              multiple
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => onPicked(event.currentTarget)}
            />
          </>
        ) : null}
        <div hidden={pageInPlace} className="space-y-4">
          {heading}
          {error && !record ? (
            isPermissionDenied(error.cause) ? (
              <p className="text-sm text-fg-muted">
                You can't see skills here. Ask a workspace admin for access.
              </p>
            ) : (
              <ErrorMessage
                variant="inline"
                announce
                title={`${error.title}.`}
                {...(isApiError(error.cause) ? apiErrorDetails(error.cause) : {})}
                action={
                  error.title === "Couldn't upload this skill" ? undefined : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => navigate(() => setReload((value) => value + 1))}
                    >
                      Try again
                    </Button>
                  )
                }
              >
                {(refusalCodes && serverRefusalText(error.cause, refusalCodes)) ??
                  userErrorTextWithoutReference(error.cause)}
              </ErrorMessage>
            )
          ) : null}
          {notice && !record ? (
            <p role="status" className="text-sm text-fg">
              {notice}
            </p>
          ) : null}
          {loading ? (
            <div role="status" aria-label="Loading skills" className="grid gap-1 sm:grid-cols-2">
              {[0, 1].map((index) => (
                <div key={index} className="flex items-center gap-3 px-3 py-3">
                  <Skeleton className="size-10 rounded-[10px]" />
                  <div className="grid flex-1 gap-1.5">
                    <Skeleton className="h-3.5 w-1/3" />
                    <Skeleton className="h-3 w-2/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {!loading && !error && !listed.length ? (
            owner !== "all" ? (
              <p className="text-sm text-fg-subtle">No skills here.</p>
            ) : emptyText !== undefined ? (
              <p className="text-sm text-fg-subtle">{emptyText}</p>
            ) : (
              <EmptyState
                variant="page"
                icon={<GraduationCapIcon />}
                title="No skills yet"
                description={
                  newScope
                    ? "Skills are instructions agents load when a task needs them. Write one, or upload a SKILL.md, a folder or a .zip."
                    : "Skills are instructions agents load when a task needs them. Admins add them here."
                }
                action={emptyAction}
              />
            )
          ) : null}
          <ConnectionInstalled
            title={listTitle}
            aria-label={listTitle ?? title ?? "Skills"}
            items={rows}
          />
          {nextCursor ? (
            <Button variant="outline" disabled={busy} onClick={() => void loadMore()}>
              Load more skills
            </Button>
          ) : null}
          {!loading && listed.length && newScope === null && !scopes.some(canManage) ? (
            <p className="m-0 text-xs leading-5 text-fg-muted">
              Only admins can add or change skills here.
            </p>
          ) : null}
        </div>
        {pageContent
          ? portal
            ? slot?.target && slotSkillKey
              ? createPortal(pageContent, slot.target)
              : null
            : pageContent
          : null}
        {dragging ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-[12px] border-2 border-dashed border-brand bg-bg/90 p-6 text-center"
          >
            <div className="grid justify-items-center gap-2">
              <UploadIcon className="size-6 text-brand" />
              <p className="m-0 text-sm font-medium text-fg">Drop to upload a skill</p>
              <p className="m-0 text-xs text-fg-muted">A SKILL.md, a skill folder or a .zip</p>
            </div>
          </div>
        ) : null}
        {children?.(record)}
        <ConfirmDialog
          open={removal !== null}
          onOpenChange={(isOpen) => {
            if (!isOpen) setRemoval(null);
          }}
          title={`Remove “${humanizeName(removal?.skill.title || removal?.skill.stableKey || "skill")}”?`}
          description="This permanently deletes the skill and all its saved revisions. It cannot be undone. Existing conversations stay unchanged."
          confirmLabel="Remove skill"
          cancelAutoFocus
          restoreFocusRef={removalTriggerRef}
          restoreFocusFallbackRef={headingRef}
          onConfirm={remove}
        >
          {dirty ? (
            <p className="text-sm text-fg-muted">Unsaved changes will also be discarded.</p>
          ) : null}
          {removal?.skill.source ? (
            <p className="text-sm text-fg-muted">
              If a plugin still owns this skill, remove it from the plugin first.
            </p>
          ) : null}
          {removalError ? (
            <p role="alert" className="text-sm text-danger">
              {removalError}
            </p>
          ) : null}
        </ConfirmDialog>
        <ConfirmDialog
          open={discardAction !== null}
          onOpenChange={(isOpen) => {
            if (!isOpen) setDiscardAction(null);
          }}
          title="Discard unsaved skill changes?"
          description="Your edits have not been saved. Switching will discard them."
          confirmLabel="Discard changes"
          cancelAutoFocus
          onConfirm={() => {
            discardAction?.();
          }}
        />
      </StandaloneOverlayRoot>
    </section>
  );
}
