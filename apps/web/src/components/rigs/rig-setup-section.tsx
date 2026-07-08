// The active version's setup + definition, and the editor that proposes changes
// to it. Editing never mutates the active version directly (versions are
// immutable) — it proposes a `definition_edit` change that must pass verification
// in a clean sandbox before a human promotes it into a new version.
import { PencilIcon } from "lucide-react";
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
import type { ProposeRigChangeRequest, RigVersion, VariableSet } from "@/types";

export function RigSetupSection({
  activeVersion,
  variableSets,
  canPropose,
  mutating,
  onPropose,
  onProposed,
}: {
  activeVersion: RigVersion | null;
  variableSets: VariableSet[];
  canPropose: boolean;
  mutating: boolean;
  onPropose: (request: ProposeRigChangeRequest) => Promise<unknown>;
  /** Called after a successful propose so the detail view can jump to Changes. */
  onProposed: () => void;
}) {
  const [editing, setEditing] = useState(false);

  if (!activeVersion) {
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
            No setup script — sandboxes boot straight from the image.
          </p>
        )}
      </Section>
    </div>
  );
}

function DefinitionEditor({
  activeVersion,
  variableSets,
  mutating,
  onCancel,
  onSubmit,
}: {
  activeVersion: RigVersion;
  variableSets: VariableSet[];
  mutating: boolean;
  onCancel: () => void;
  onSubmit: (request: ProposeRigChangeRequest) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<RigDefinitionDraft>({
    image: activeVersion.image ?? "",
    setupScript: activeVersion.setupScript ?? "",
    checks: activeVersion.checks.map((check) => ({ ...check })),
    defaultVariableSetIds: [...activeVersion.defaultVariableSetIds],
  });
  const [changelog, setChangelog] = useState("");

  async function submit() {
    await onSubmit({
      kind: "definition_edit",
      payload: {
        image: draft.image.trim() ? draft.image.trim() : null,
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
