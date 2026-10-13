// Edit setup: a page that proposes a change to the active version's setup and
// checks. Versions never change in place; the edit
// becomes a `definition_edit` change that is verified in a clean sandbox
// before someone promotes it into a new version.
import { useState } from "react";

import {
  RigDefinitionFields,
  cleanRigChecks,
  type RigDefinitionDraft,
} from "@/components/rigs/rig-definition-fields";
import { Field, FieldStack, TextInput } from "@/components/ui/field";
import { FlushFormPage } from "@/components/ui/flush-form-page";
import type { ProposeRigChangeRequest, RigVersion } from "@/types";

export function RigSetupEditPage({
  rigName,
  activeVersion,
  onClose,
  onPropose,
}: {
  rigName: string;
  activeVersion: RigVersion;
  onClose: () => void;
  /** Proposes the change. Throws a user-facing error. */
  onPropose: (request: ProposeRigChangeRequest) => Promise<void>;
}) {
  const [draft, setDraft] = useState<RigDefinitionDraft>({
    setupScript: activeVersion.setupScript ?? "",
    checks: activeVersion.checks.map((check) => ({ ...check })),
  });
  const [changelog, setChangelog] = useState("");

  return (
    <FlushFormPage
      backLabel={rigName}
      onClose={onClose}
      title="Edit setup"
      description={`Proposes a change to ${rigName}. It's checked in a clean sandbox before it can become a new version.`}
      submitLabel="Propose change"
      pendingLabel="Proposing…"
      onSubmit={async () => {
        await onPropose({
          kind: "definition_edit",
          payload: {
            setupScript: draft.setupScript.trim() ? draft.setupScript : null,
            checks: cleanRigChecks(draft.checks),
            ...(changelog.trim() ? { changelog: changelog.trim() } : {}),
          },
        });
        return true;
      }}
    >
      <FieldStack>
        <RigDefinitionFields value={draft} onChange={setDraft} idPrefix="edit-rig" />
        <Field label="What changed" optional hint="A line for the version history.">
          <TextInput
            value={changelog}
            onChange={(event) => setChangelog(event.target.value)}
            placeholder="e.g. Install Playwright browsers"
            autoComplete="off"
          />
        </Field>
      </FieldStack>
    </FlushFormPage>
  );
}
