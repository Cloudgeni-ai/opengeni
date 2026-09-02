// The active version's setup + definition, and the editor that proposes changes
// to it. Editing never mutates the active version directly (versions are
// immutable) — it proposes a `definition_edit` change that must pass verification
// in a clean sandbox before a human promotes it into a new version.
import { PencilIcon, RotateCwIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  RigDefinitionFields,
  cleanRigChecks,
  type RigDefinitionDraft,
} from "@/components/rigs/rig-definition-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import type {
  CreateRigVersionRequest,
  ProposeRigChangeRequest,
  ResourceAuthorityScope,
  RigVersion,
  VariableSet,
} from "@/types";

export function RigSetupSection({
  activeVersion,
  versions,
  versionsLoading,
  versionsError,
  rigScope,
  variableSets,
  canPropose,
  canManage,
  mutating,
  onPropose,
  onProposed,
  onCreateVersion,
  onRetryVersions,
}: {
  activeVersion: RigVersion | null;
  versions: RigVersion[] | null;
  versionsLoading: boolean;
  versionsError: Error | null;
  rigScope: ResourceAuthorityScope;
  variableSets: VariableSet[];
  canPropose: boolean;
  canManage: boolean;
  mutating: boolean;
  onPropose: (request: ProposeRigChangeRequest) => Promise<unknown>;
  /** Called after a successful propose so the detail view can jump to Changes. */
  onProposed: () => void;
  onCreateVersion: (request: CreateRigVersionRequest) => Promise<unknown>;
  onRetryVersions: () => void;
}) {
  const [editing, setEditing] = useState(false);

  if (!activeVersion) {
    if (canManage) {
      if (versionsError && versions === null) {
        return (
          <Notice
            tone="failed"
            title="Couldn't load replacement-version history"
            action={
              <Button type="button" variant="secondary" size="sm" onClick={onRetryVersions}>
                Retry
              </Button>
            }
          >
            OpenGeni couldn't determine which inactive versions are available as exact recovery
            bases.
          </Notice>
        );
      }
      if (versionsLoading || versions === null) {
        return (
          <Notice tone="muted" title="Loading replacement-version history">
            Checking inactive versions before enabling manager recovery.
          </Notice>
        );
      }
      return (
        <ReplacementVersionEditor
          versions={versions}
          rigScope={rigScope}
          variableSets={variableSets}
          mutating={mutating}
          onSubmit={onCreateVersion}
        />
      );
    }
    return (
      <Notice tone="muted" title="No active version to edit">
        This rig has no active version yet.
      </Notice>
    );
  }

  if (editing) {
    return (
      <DefinitionEditor
        activeVersion={activeVersion}
        rigScope={rigScope}
        variableSets={variableSets}
        mutating={mutating}
        onCancel={() => setEditing(false)}
        onSubmit={async (request) => {
          const result = await onPropose(request);
          if (result) {
            setEditing(false);
            toast.success("Change proposed", {
              description: "It's being verified in a clean sandbox before it can merge.",
            });
            onProposed();
          }
          return result;
        }}
      />
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-xl text-xs leading-5 text-fg-muted">
          Editing the machine doesn't change the active version in place. It proposes a change
          that's verified from a clean sandbox, then promoted into a new immutable version — so the
          team's machine only ever moves forward on things that actually reproduce.
        </p>
        {canPropose ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-8 shrink-0"
            onClick={() => setEditing(true)}
          >
            <PencilIcon className="size-3.5" />
            Propose edit
          </Button>
        ) : null}
      </div>

      <Section label="Setup script">
        {activeVersion.setupScript ? (
          <pre className="max-h-96 overflow-auto rounded-md border border-border/70 bg-bg/40 p-3 font-mono text-2xs leading-4">
            {activeVersion.setupScript}
          </pre>
        ) : (
          <p className="text-xs text-fg-subtle">
            No setup script — sandboxes use the deployment-managed platform image unchanged.
          </p>
        )}
      </Section>
    </div>
  );
}

function ReplacementVersionEditor({
  versions,
  rigScope,
  variableSets,
  mutating,
  onSubmit,
}: {
  versions: RigVersion[];
  rigScope: ResourceAuthorityScope;
  variableSets: VariableSet[];
  mutating: boolean;
  onSubmit: (request: CreateRigVersionRequest) => Promise<unknown>;
}) {
  const inactiveVersions = versions.filter((version) => !version.active);
  const [baseVersionId, setBaseVersionId] = useState("");
  const [draft, setDraft] = useState<RigDefinitionDraft>({
    setupScript: "",
    checks: [],
    defaultVariableSetIds: [],
  });
  const [changelog, setChangelog] = useState("");

  function selectBase(nextId: string) {
    setBaseVersionId(nextId);
    const base = inactiveVersions.find((version) => version.id === nextId);
    if (base) {
      setDraft({
        setupScript: base.setupScript ?? "",
        checks: base.checks.map((check) => ({ ...check })),
        defaultVariableSetIds: [...base.defaultVariableSetIds],
      });
    }
  }

  async function submit() {
    const request: CreateRigVersionRequest = {
      expectedActiveVersionId: null,
      ...(baseVersionId
        ? { baseVersionId }
        : {
            setupScript: draft.setupScript.trim() ? draft.setupScript : null,
            checks: cleanRigChecks(draft.checks),
            credentialHooks: [],
            defaultVariableSetIds: draft.defaultVariableSetIds,
          }),
      ...(changelog.trim() ? { changelog: changelog.trim() } : {}),
    };
    const result = await onSubmit(request);
    if (result) {
      toast.success("Replacement version created", {
        description: "It remains inactive until its saved verification attempt passes.",
      });
    }
  }

  return (
    <div className="grid gap-4 rounded-lg border border-border bg-surface p-4">
      <div>
        <h3 className="text-sm font-medium">Create a replacement version</h3>
        <p className="mt-0.5 text-xs text-fg-muted">
          This Rig has no active version. Recovery is pinned to that exact state and cannot
          overwrite a version activated by another manager.
        </p>
      </div>

      {inactiveVersions.length > 0 ? (
        <div className="grid gap-1.5">
          <Label htmlFor="replacement-rig-base">Historical base</Label>
          <Select
            id="replacement-rig-base"
            value={baseVersionId}
            disabled={mutating}
            onChange={(event) => selectBase(event.target.value)}
          >
            <option value="">Complete replacement definition</option>
            {inactiveVersions.map((version) => (
              <option key={version.id} value={version.id}>
                Version {version.version}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      <RigDefinitionFields
        value={draft}
        onChange={setDraft}
        variableSets={variableSets}
        rigScope={rigScope}
        disabled={mutating || Boolean(baseVersionId)}
        idPrefix="replacement-rig"
      />

      <div className="grid gap-1.5">
        <Label htmlFor="replacement-rig-changelog">Changelog</Label>
        <Input
          id="replacement-rig-changelog"
          value={changelog}
          onChange={(event) => setChangelog(event.target.value)}
          placeholder="Why this replacement is needed"
          className="h-9"
        />
      </div>

      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={mutating} onClick={() => void submit()}>
          <RotateCwIcon className="size-3.5" />
          Create and verify replacement
        </Button>
      </div>
    </div>
  );
}

function DefinitionEditor({
  activeVersion,
  rigScope,
  variableSets,
  mutating,
  onCancel,
  onSubmit,
}: {
  activeVersion: RigVersion;
  rigScope: ResourceAuthorityScope;
  variableSets: VariableSet[];
  mutating: boolean;
  onCancel: () => void;
  onSubmit: (request: ProposeRigChangeRequest) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<RigDefinitionDraft>({
    setupScript: activeVersion.setupScript ?? "",
    checks: activeVersion.checks.map((check) => ({ ...check })),
    defaultVariableSetIds: [...activeVersion.defaultVariableSetIds],
  });
  const [changelog, setChangelog] = useState("");

  async function submit() {
    await onSubmit({
      kind: "definition_edit",
      payload: {
        setupScript: draft.setupScript.trim() ? draft.setupScript : null,
        checks: cleanRigChecks(draft.checks),
        defaultVariableSetIds: draft.defaultVariableSetIds,
        ...(changelog.trim() ? { changelog: changelog.trim() } : {}),
      },
    });
  }

  return (
    <div className="grid gap-4 rounded-lg border border-border bg-surface p-4">
      <div>
        <h3 className="text-sm font-medium">Propose a definition edit</h3>
        <p className="mt-0.5 text-xs text-fg-muted">
          Changes are verified from a clean sandbox before you can promote them.
        </p>
      </div>

      <RigDefinitionFields
        value={draft}
        onChange={setDraft}
        variableSets={variableSets}
        rigScope={rigScope}
        disabled={mutating}
        idPrefix="edit-rig"
      />

      <div className="grid gap-1.5">
        <Label htmlFor="edit-rig-changelog">Changelog</Label>
        <Input
          id="edit-rig-changelog"
          value={changelog}
          onChange={(event) => setChangelog(event.target.value)}
          placeholder="What this change does and why"
          className="h-9"
        />
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" className="h-9" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-9"
          disabled={mutating}
          onClick={() => void submit()}
        >
          Propose change
        </Button>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <div className="text-2xs font-medium uppercase tracking-wide text-fg-subtle">{label}</div>
      {children}
    </div>
  );
}
