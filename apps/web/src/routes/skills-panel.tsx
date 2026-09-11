import { useEffect, useRef, useState } from "react";
import type {
  SkillRecord,
  SkillScope,
  SkillSummary,
  PreferenceRegistryRevisionSummary,
} from "@opengeni/sdk";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useAppContext, type AppContextValue } from "@/context";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";

const SCOPE_LABEL: Record<SkillScope, string> = {
  workspace: "Workspace",
  organization: "Company",
  user: "Only me",
};

/** Both product destinations use this catalog and the same folder write API. */
export function SkillsPanel({
  workspaceId,
  personalWorkspace = false,
}: {
  workspaceId: string;
  personalWorkspace?: boolean;
}) {
  return (
    <SkillsPanelContent
      context={useAppContext()}
      workspaceId={workspaceId}
      personalWorkspace={personalWorkspace}
    />
  );
}

export function SkillsPanelContent({
  context,
  workspaceId,
  personalWorkspace = false,
}: {
  context: AppContextValue;
  workspaceId: string;
  personalWorkspace?: boolean;
}) {
  const { client } = context;
  const grant = context.accessContext.workspaceGrants.find(
    (entry) => entry.workspaceId === workspaceId,
  );
  const human = grant?.principalKind === "human_session" || context.authSession != null;
  const canManage = (scope: SkillScope) =>
    Boolean(
      human &&
      (scope === "user" ||
        (scope === "workspace" &&
          hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin")) ||
        (scope === "organization" &&
          grant &&
          hasAccountPermission(context.accessContext, grant.accountId, "account:admin"))),
    );
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [record, setRecord] = useState<SkillRecord | null>(null);
  const [files, setFiles] = useState<SkillRecord["files"]>([]);
  const [path, setPath] = useState("SKILL.md");
  const [newPath, setNewPath] = useState("");
  const [history, setHistory] = useState<PreferenceRegistryRevisionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null);
  const generation = useRef(0);
  const dirty = Boolean(
    record &&
    (files.length !== record.files.length ||
      files.some(
        (file, index) =>
          file.path !== record.files[index]?.path || file.content !== record.files[index]?.content,
      )),
  );

  useEffect(() => {
    const current = ++generation.current;
    setLoading(true);
    setBusy(false);
    setRecord(null);
    setHistory([]);
    setNotice(null);
    setDiscardAction(null);
    setSkills([]);
    setNextCursor(null);
    setError(null);
    void client
      .listWorkspaceSkills(workspaceId)
      .then((result) => {
        if (generation.current === current) {
          setSkills(result.skills);
          setNextCursor(result.nextCursor ?? null);
        }
      })
      .catch((reason) => {
        if (generation.current === current)
          setError(reason instanceof Error ? reason.message : "Could not load Skills");
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      // Invalidate every request started since this effect, not only its initial list.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
    };
  }, [client, workspaceId, reload]);

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

  async function loadMore() {
    if (!nextCursor || busy) return;
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      const page = await client.listWorkspaceSkills(workspaceId, { cursor: nextCursor });
      if (generation.current !== current) return;
      setSkills((previous) => [
        ...new Map([...previous, ...page.skills].map((skill) => [skill.id, skill])).values(),
      ]);
      setNextCursor(page.nextCursor);
    } catch (reason) {
      if (generation.current === current)
        setError(reason instanceof Error ? reason.message : "Could not load more Skills");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }

  function show(next: SkillRecord) {
    setRecord(next);
    setFiles(next.files);
    setPath("SKILL.md");
    setNewPath("");
  }
  async function open(skillId: string, revisionId?: string) {
    const current = ++generation.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const [next, detail] = await Promise.all([
        client.readWorkspaceSkill(workspaceId, skillId, revisionId),
        client.getPreferenceRegistry(workspaceId, skillId),
      ]);
      if (generation.current !== current) return;
      show(next);
      setHistory(detail.revisions);
    } catch (reason) {
      if (generation.current === current)
        setError(reason instanceof Error ? reason.message : "Could not open Skill");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  function create(scope: SkillScope) {
    generation.current++;
    setHistory([]);
    setError(null);
    setNotice(null);
    show({
      id: crypto.randomUUID(),
      stableKey: "",
      scope,
      scopeVersion: 1,
      activationMode: "workspace_managed",
      pendingRevisionIds: [],
      status: "proposed",
      activeRevisionId: null,
      revisionId: null,
      title: "",
      description: "",
      contentHash: null,
      source: null,
      files: [
        {
          path: "SKILL.md",
          content: "---\nname: my-skill\ndescription: When to use this Skill\n---\n\n",
        },
      ],
    });
  }
  async function mutate(operation: "save" | "approve" | "restore") {
    if (!record) return;
    const current = ++generation.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const version = {
        operationId: crypto.randomUUID(),
        expectedRevisionId: record.activeRevisionId,
        expectedScopeVersion: record.scopeVersion,
        reason: operation === "save" ? "Save Skill files" : `${operation} Skill revision`,
      };
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
          : await (
              operation === "approve"
                ? client.approveWorkspaceSkill.bind(client)
                : client.restoreWorkspaceSkill.bind(client)
            )(workspaceId, record.id, { ...version, revisionId: record.revisionId! });
      if (generation.current !== current) return;
      const [updated, inventory, detail] = await Promise.all([
        client.readWorkspaceSkill(workspaceId, receipt.skillId),
        client.listWorkspaceSkills(workspaceId),
        client.getPreferenceRegistry(workspaceId, receipt.skillId),
      ]);
      if (generation.current !== current) return;
      show(updated);
      setSkills(inventory.skills);
      setNextCursor(inventory.nextCursor ?? null);
      setHistory(detail.revisions);
      setNotice(
        receipt.outcome === "pending"
          ? "Saved for approval; not active yet."
          : receipt.outcome === "preserved"
            ? "Your customized Skill was preserved."
            : "Skill saved and active.",
      );
    } catch (reason) {
      if (generation.current === current)
        setError(reason instanceof Error ? reason.message : "Skill change failed");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  const editable =
    record &&
    canManage(record.scope) &&
    (record.revisionId === record.activeRevisionId || record.revisionId === null);
  const selected = files.find((file) => file.path === path);

  return (
    <section aria-label="Skills" className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex flex-wrap gap-2">
          {([personalWorkspace ? "user" : "workspace", "organization"] as const)
            .filter(canManage)
            .map((scope) => (
              <Button
                key={scope}
                variant={scope === "organization" ? "outline" : "default"}
                disabled={busy}
                onClick={() => navigate(() => create(scope))}
              >
                New {scope === "organization" ? "company " : ""}Skill
              </Button>
            ))}
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-status-error">
          {error}{" "}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => navigate(() => setReload((value) => value + 1))}
          >
            Reload Skills
          </Button>
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {loading ? <p role="status">Loading Skills…</p> : null}
      {!loading && !skills.length ? (
        <p className="text-sm text-fg-subtle">
          No Skills yet. Create one here or install one from the catalog.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {skills.map((skill) => (
          <Button
            key={skill.id}
            variant={record?.id === skill.id ? "secondary" : "outline"}
            disabled={busy}
            onClick={() => navigate(() => void open(skill.id))}
          >
            {skill.title || skill.stableKey} · {SCOPE_LABEL[skill.scope]}
            {skill.status !== "active" ? ` · ${skill.status}` : ""}
            {skill.pendingRevisionIds.length ? " · needs review" : ""}
          </Button>
        ))}
        {nextCursor ? (
          <Button variant="outline" disabled={busy} onClick={() => void loadMore()}>
            Load more Skills
          </Button>
        ) : null}
      </div>
      {record ? (
        <div className="space-y-4">
          <p className="text-xs text-fg-subtle">
            {record.source ? "Installed Skill" : "Authored Skill"} · {SCOPE_LABEL[record.scope]}
          </p>
          <p className="text-sm text-muted-foreground">
            Edit the name and description in SKILL.md.
          </p>
          {history.length ? (
            <label className="block text-sm">
              History
              <Select
                aria-label="History"
                value={record.revisionId ?? ""}
                disabled={busy}
                onChange={(event) => {
                  const revisionId = event.target.value;
                  navigate(() => void open(record.id, revisionId));
                }}
              >
                {history.map((revision) => (
                  <option key={revision.id} value={revision.id}>
                    Version {revision.revision}
                    {revision.id === record.activeRevisionId ? " · active" : ""}
                    {record.pendingRevisionIds.includes(revision.id) ? " · pending" : ""}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          <label className="block text-sm">
            File
            <Select
              aria-label="File"
              value={path}
              onChange={(event) => setPath(event.target.value)}
            >
              {files.map((file) => (
                <option key={file.path} value={file.path}>
                  {file.path}
                </option>
              ))}
            </Select>
          </label>
          <Textarea
            aria-label={`Contents of ${path}`}
            value={selected?.content ?? ""}
            disabled={!editable || busy}
            className="min-h-72 font-mono"
            onChange={(event) =>
              setFiles((current) =>
                current.map((file) =>
                  file.path === path ? { ...file, content: event.target.value } : file,
                ),
              )
            }
          />
          {editable ? (
            <div className="flex flex-wrap gap-2">
              <Input
                aria-label="New relative file path"
                placeholder="references/example.md"
                value={newPath}
                onChange={(event) => setNewPath(event.target.value)}
                disabled={busy}
                className="max-w-sm"
              />
              <Button
                variant="outline"
                disabled={busy || !newPath || files.some((file) => file.path === newPath)}
                onClick={() => {
                  setFiles((current) => [...current, { path: newPath, content: "" }]);
                  setPath(newPath);
                  setNewPath("");
                }}
              >
                Add text file
              </Button>
              <Button
                variant="outline"
                disabled={busy || path === "SKILL.md"}
                onClick={() => {
                  setFiles((current) => current.filter((file) => file.path !== path));
                  setPath("SKILL.md");
                }}
              >
                Remove selected file
              </Button>
              <Button
                disabled={
                  busy || !files.some((file) => file.path === "SKILL.md" && file.content.trim())
                }
                onClick={() => void mutate("save")}
              >
                Save Skill
              </Button>
            </div>
          ) : null}
          {canManage(record.scope) &&
          record.revisionId &&
          record.revisionId !== record.activeRevisionId ? (
            <Button
              disabled={busy}
              onClick={() =>
                void mutate(
                  record.pendingRevisionIds.includes(record.revisionId!) ? "approve" : "restore",
                )
              }
            >
              {record.pendingRevisionIds.includes(record.revisionId)
                ? "Approve this revision"
                : "Restore as a new revision"}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={discardAction !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setDiscardAction(null);
        }}
        title="Discard unsaved Skill changes?"
        description="Your edits have not been saved. Switching will discard them."
        confirmLabel="Discard changes"
        cancelAutoFocus
        onConfirm={() => {
          discardAction?.();
        }}
      />
    </section>
  );
}
