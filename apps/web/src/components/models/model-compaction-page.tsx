import { ModelPicker } from "@opengeni/react";
import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/error-message";
import { Field, FieldStack, TextInput } from "@/components/ui/field";
import { useAppContext } from "@/context";
import { useWorkspaceModelCatalog } from "@/lib/use-workspace-model-catalog";
import { ModelsFormPage, payerShortLabel } from "./models-ui";

type Draft = Record<string, string | null>;
const count = (value: number) => value.toLocaleString("en-US");

export function compactionDraftError(
  value: string | null,
  model: WorkspaceModelCatalogModel,
): string | null {
  if (value === null) return null;
  const policy = model.compactionPolicy;
  if (!policy) return "Refresh to load this model’s context limits.";
  const tokens = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(tokens) ||
    tokens < Math.max(16_000, policy.minimumTokens) ||
    tokens > policy.maximumTokens
  ) {
    return `Enter a whole number from ${count(Math.max(16_000, policy.minimumTokens))} to ${count(policy.maximumTokens)}.`;
  }
  return null;
}

/** Workspace-only preferences; selecting a model here never changes a session's model. */
export function ModelCompactionPage({
  workspaceId,
  canManage,
  onClose,
}: {
  workspaceId: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const context = useAppContext();
  const catalog = useWorkspaceModelCatalog(workspaceId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const model =
    catalog.models.find((candidate) => candidate.id === selectedId) ??
    catalog.models.find((candidate) => candidate.id === catalog.defaultSelection?.model) ??
    catalog.models[0];
  const policy = model?.compactionPolicy;
  const value =
    model && Object.hasOwn(draft, model.id)
      ? draft[model.id]!
      : policy?.overrideTokens === null || !policy
        ? null
        : String(policy.overrideTokens);
  const error = model && Object.hasOwn(draft, model.id) ? compactionDraftError(value, model) : null;
  const invalidDraft = Object.entries(draft).some(([id, input]) => {
    const candidate = catalog.models.find((row) => row.id === id);
    return !candidate || Boolean(compactionDraftError(input, candidate));
  });
  const dirty = Object.keys(draft).length > 0;
  const disabled = !canManage || saving;
  const edit = (next: string | null) => {
    if (!model) return;
    setDraft((current) => {
      const changed = { ...current };
      const saved = policy?.overrideTokens == null ? null : String(policy.overrideTokens);
      if (next === saved) delete changed[model.id];
      else changed[model.id] = next;
      return changed;
    });
  };

  return (
    <ModelsFormPage
      title="Context & compaction"
      description="Choose when long conversations are summarized. Lower thresholds use less context; higher thresholds keep more detail."
      onClose={onClose}
      loading={catalog.loading}
      loadingFields={2}
      submitLabel="Save changes"
      pendingLabel="Saving…"
      pending={saving}
      submitDisabled={disabled || !dirty || invalidDraft || Boolean(catalog.error) || !policy}
      disabledReason={
        !canManage
          ? "Only workspace admins can change these preferences."
          : invalidDraft
            ? "Check the threshold for each edited model."
            : undefined
      }
      footerStart={
        dirty
          ? `${Object.keys(draft).length} model preference${Object.keys(draft).length === 1 ? "" : "s"} changed`
          : undefined
      }
      onSubmit={async () => {
        if (disabled || !dirty || invalidDraft) return false;
        const transition = context.captureWorkspaceInvocation(workspaceId);
        if (!transition) return false;
        setSaving(true);
        try {
          const updated = await context.updateWorkspaceSettings(workspaceId, {
            modelCompactionThresholds: Object.fromEntries(
              Object.entries(draft).map(([id, input]) => [
                id,
                input === null ? null : Number(input),
              ]),
            ),
          });
          if (!context.ownsWorkspaceInvocation(workspaceId, transition)) return false;
          if (!updated)
            throw new Error(
              "Couldn’t confirm the save. Your edits are kept. Reload to check the saved value before trying again.",
            );
          return true;
        } finally {
          setSaving(false);
        }
      }}
      onSubmitted={onClose}
    >
      {catalog.error ? (
        <ErrorMessage
          title="Couldn’t load model preferences."
          action={
            <Button type="button" variant="outline" onClick={() => void catalog.refresh()}>
              Try again
            </Button>
          }
        >
          {catalog.error}
        </ErrorMessage>
      ) : !model ? (
        <p className="text-sm text-fg-muted">Connect a model account to configure compaction.</p>
      ) : (
        <FieldStack>
          <Field
            label="Model"
            hint={payerShortLabel(
              catalog.rows.find((row) => row.id === model.id) ?? {
                billingClass: "",
                providerLabel: model.providerLabel,
              },
            )}
          >
            <ModelPicker
              rows={catalog.rows.map((row) => ({
                ...row,
                selectable: true,
                unavailableReason: null,
              }))}
              value={model.id}
              onChange={setSelectedId}
              disabled={saving}
              label="Model for compaction preference"
              className="w-full [&>select]:w-full [&>select]:max-w-none"
            />
          </Field>
          {policy ? (
            <>
              <Field
                label="Compact after"
                hint={`Model default: ${count(policy.defaultTokens)} input tokens. Leave empty to follow the default.`}
                error={error ?? undefined}
                aside="tokens"
              >
                <TextInput
                  type="text"
                  inputMode="numeric"
                  value={value ?? ""}
                  placeholder={String(policy.defaultTokens)}
                  disabled={disabled}
                  onChange={(event) => edit(event.target.value === "" ? null : event.target.value)}
                />
              </Field>
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <p className="m-0 text-fg-muted" aria-live="polite">
                  {Object.hasOwn(draft, model.id) ? "After saving" : "Effective now"}:{" "}
                  {error
                    ? "check threshold"
                    : `${count(value === null ? policy.defaultTokens : Math.min(Number(value), policy.maximumTokens))} tokens`}
                  {value === null ? " · model default" : " · workspace override"}
                </p>
                {value !== null && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() => edit(null)}
                  >
                    Use model default
                  </Button>
                )}
              </div>
              {policy.overrideTokens !== null &&
                policy.overrideTokens !== policy.effectiveTokens &&
                !Object.hasOwn(draft, model.id) && (
                  <p className="m-0 text-sm text-fg-muted">
                    Your saved threshold is outside this model’s current range. The effective
                    threshold above respects its input limit.
                  </p>
                )}
              <p className="m-0 text-sm leading-6 text-fg-muted">
                Applies to subsequent turns in this workspace, including existing sessions.
                Compaction is checked between steps, so a request can exceed this threshold. It is
                not a hard token or spending limit; request-size safety checks remain active.
              </p>
            </>
          ) : (
            <p className="text-sm text-fg-muted">
              This server does not expose model compaction preferences yet. Update the server before
              changing them.
            </p>
          )}
        </FieldStack>
      )}
    </ModelsFormPage>
  );
}
