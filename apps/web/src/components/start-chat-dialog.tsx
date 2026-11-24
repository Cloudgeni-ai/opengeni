/**
 * Say what you want in a sentence, and a chat does the setup with its own
 * tools: "Create with Opengeni" for automations and "Create with chat" for
 * agents. Starts the chat the same way Knowledge's "Ask Opengeni" does:
 * context.startSession on the workspace's model, then navigate to the new
 * chat.
 */
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { Field, TextArea } from "@opengeni/react/ui/field";
import { FormDialog } from "@opengeni/react/ui/form-dialog";
import { useAppContext } from "@opengeni/react/app/app-context";
import { resolveAgentBrainPromptModel } from "@/lib/agent-brain-prompt-model";
import { useAgentBrainPromptCatalog } from "@/routes/agent-brain-prompt";

export interface StartChatDialogCopy {
  title: string;
  description: string;
  fieldLabel: string;
  placeholder: string;
  /** Shown when the person sends nothing. */
  emptyError: string;
  /** The chat's first message, from the request and the person's time zone. */
  openingMessage: (request: string, timeZone: string) => string;
}

/** Opens the dialog; mounts it on first use so the page doesn't load the model catalog. */
export function useStartChatDialog(workspaceId: string, copy: StartChatDialogCopy) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  return {
    open: () => {
      setMounted(true);
      setOpen(true);
    },
    dialog: mounted ? (
      <StartChatDialog workspaceId={workspaceId} copy={copy} open={open} onOpenChange={setOpen} />
    ) : null,
  };
}

function StartChatDialog({
  workspaceId,
  copy,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  copy: StartChatDialogCopy;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const catalog = useAgentBrainPromptCatalog(workspaceId);
  const [request, setRequest] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const model = useMemo(
    () =>
      catalog.loading || catalog.error
        ? null
        : resolveAgentBrainPromptModel(catalog.models, {
            model: context.model,
            reasoningEffort: context.reasoningEffort,
            latencyMode: context.latencyMode,
          }),
    [
      catalog.loading,
      catalog.error,
      catalog.models,
      context.model,
      context.reasoningEffort,
      context.latencyMode,
    ],
  );
  const unavailable = !catalog.loading && !catalog.error && model === null;
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setRequest("");
          setFieldError(null);
        }
      }}
      size="sm"
      title={copy.title}
      description={copy.description}
      submitLabel="Start chat"
      pendingLabel="Starting…"
      submitDisabled={catalog.loading || model === null || context.busy}
      disabledReason={
        unavailable
          ? "No model is available in this workspace. Check Models in workspace settings."
          : catalog.error
            ? "Couldn't load the workspace's models. Close this and try again."
            : undefined
      }
      footerStart={
        model ? (
          <>
            Uses {model.label} · {model.paymentSource}
          </>
        ) : undefined
      }
      onSubmit={async () => {
        const trimmed = request.trim();
        if (!trimmed) {
          setFieldError(copy.emptyError);
          return false;
        }
        if (!model) return false;
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        const created = await context.startSession(workspaceId, {
          text: copy.openingMessage(trimmed, timeZone),
          model: model.model,
          reasoningEffort: model.reasoningEffort,
          latencyMode: model.latencyMode,
        });
        if (!created) throw new Error("Couldn't start the chat. Try again.");
        await navigate({
          to: "/workspaces/$workspaceId/sessions/$sessionId",
          params: { workspaceId, sessionId: created.id },
        });
        return true;
      }}
    >
      <Field label={copy.fieldLabel} error={fieldError ?? undefined}>
        <TextArea
          rows={3}
          value={request}
          placeholder={copy.placeholder}
          onChange={(event) => {
            setRequest(event.target.value);
            setFieldError(null);
          }}
        />
      </Field>
    </FormDialog>
  );
}
