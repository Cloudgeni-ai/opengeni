/**
 * "Create with OpenGeni": say what should happen and how often, and a chat
 * researches the rest (repositories, variable sets, integrations) and creates
 * the schedule with its scheduling tools. Starts the chat the same way
 * Knowledge's "Ask OpenGeni" does: context.startSession on the workspace's
 * model, then navigate to the new chat.
 */
import { useNavigate } from "@tanstack/react-router";
import { SparklesIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, TextArea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { useAppContext } from "@/context";
import { resolveAgentBrainPromptModel } from "@/lib/agent-brain-prompt-model";
import { hasWorkspacePermission } from "@/lib/permissions";
import { useAgentBrainPromptCatalog } from "@/routes/agent-brain-prompt";

import { scheduleAgentOpeningMessage } from "./schedule-model";

/** Starting the chat needs sessions:create; the agent's create needs scheduled_tasks:manage. */
export function useCanCreateScheduleWithAgent(workspaceId: string): boolean {
  const { accessContext } = useAppContext();
  return (
    hasWorkspacePermission(accessContext, workspaceId, "sessions:create") &&
    hasWorkspacePermission(accessContext, workspaceId, "scheduled_tasks:manage")
  );
}

/** Opens the dialog; mounts it on first use so the list doesn't load the model catalog. */
export function useCreateWithOpenGeni(workspaceId: string) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  return {
    open: () => {
      setMounted(true);
      setOpen(true);
    },
    dialog: mounted ? (
      <CreateWithOpenGeniDialog workspaceId={workspaceId} open={open} onOpenChange={setOpen} />
    ) : null,
  };
}

export function CreateWithOpenGeniButton({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" variant="outline" onClick={onClick} className="pointer-coarse:h-11">
      <SparklesIcon aria-hidden="true" />
      Create with Opengeni
    </Button>
  );
}

function CreateWithOpenGeniDialog({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
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
      title="Create a schedule with Opengeni"
      description="It starts a chat, finds the repositories, variable sets and integrations the schedule needs, and creates it. It asks you only for what it can't find."
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
          setFieldError("Say what should happen and how often.");
          return false;
        }
        if (!model) return false;
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        const created = await context.startSession(workspaceId, {
          text: scheduleAgentOpeningMessage(trimmed, timeZone),
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
      <Field label="What should happen, and how often?" error={fieldError ?? undefined}>
        <TextArea
          rows={3}
          value={request}
          placeholder="Every weekday morning, summarize new Sentry errors and post them to #eng"
          onChange={(event) => {
            setRequest(event.target.value);
            setFieldError(null);
          }}
        />
      </Field>
    </FormDialog>
  );
}
