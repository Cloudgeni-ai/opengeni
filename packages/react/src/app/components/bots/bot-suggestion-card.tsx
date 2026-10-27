import type { Session, SessionAvatar as SessionAvatarValue, SessionEvent } from "@opengeni/sdk";
import { SparkleIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { userErrorText } from "../../../ui/api-error";
import { Button } from "../../../ui/button";
import { useAppContext } from "../../app-context";
import {
  botSuggestionDismissed,
  currentBotSuggestion,
  dismissBotSuggestion,
} from "../../lib/bot-suggestions";
import { useNavigate } from "../../lib/navigation";
import { toast } from "../../lib/toast";
import {
  SessionAvatar,
  sessionAvatarFallbackHue,
  sessionAvatarInitials,
} from "../session/session-avatar";
import { BotTemplateDialog } from "./bot-template-dialog";

/**
 * The agent's own bot suggestion (`bot_suggest`), as a card under the chat.
 * `create`: make this chat a bot with the name, description and avatar the
 * agent chose, and optionally save a template from its draft. `reuse`: open
 * the bot chat, or start a bot from the template, that already does this
 * work. Nothing changes until the person acts; "Not now" hides it here.
 */
export function BotSuggestionCard(props: { session: Session; events: readonly SessionEvent[] }) {
  const { session } = props;
  const context = useAppContext();
  const navigate = useNavigate();
  const suggestion = useMemo(
    () => currentBotSuggestion(session, props.events),
    [session, props.events],
  );
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);

  if (!suggestion) return null;
  if (dismissedId === suggestion.id || botSuggestionDismissed(session.id, suggestion.id)) {
    return null;
  }
  const isBot = Boolean(session.avatar || session.description);
  // A chat that became a bot no longer needs to be offered one. With a draft
  // template, the card stays to offer saving it until it is saved or hidden.
  if (suggestion.kind === "create" && isBot && !suggestion.setupInstructions) return null;
  if (suggestion.kind === "reuse" && suggestion.sessionId === session.id) return null;

  const avatar: SessionAvatarValue = suggestion.avatar ?? {
    kind: "letters",
    letters: sessionAvatarInitials(suggestion.name),
    hue: sessionAvatarFallbackHue(suggestion.name),
  };
  const dismiss = () => {
    dismissBotSuggestion(session.id, suggestion.id);
    setDismissedId(suggestion.id);
  };

  const makeBot = async () => {
    if (!context.updateSessionProfile) return;
    setBusy(true);
    try {
      const updated = await context.updateSessionProfile(session.workspaceId, session.id, {
        title: suggestion.name,
        description: suggestion.description,
        ...(suggestion.avatar ? { avatar: suggestion.avatar } : {}),
      });
      if (!updated) return;
      // A bot is a long-lived chat: keep it out of the idle-session archive.
      await context.client
        .updateSessionRetention(session.workspaceId, session.id, { keepLive: true })
        .catch(() => undefined);
      toast.success(`This chat is now ${suggestion.name}`, {
        description: "Mention it with @ from other chats.",
      });
      if (!suggestion.setupInstructions) dismiss();
    } catch (error) {
      toast.error(`Couldn't make this chat ${suggestion.name}`, {
        description: userErrorText(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const openReuse = () => {
    dismiss();
    if (suggestion.sessionId) {
      void navigate({
        to: "/workspaces/$workspaceId/sessions/$sessionId",
        params: { workspaceId: session.workspaceId, sessionId: suggestion.sessionId },
      });
    } else if (suggestion.templateId) {
      void navigate({
        to: "/workspaces/$workspaceId/sessions",
        params: { workspaceId: session.workspaceId },
        search: { botTemplateId: suggestion.templateId },
      });
    }
  };

  const create = suggestion.kind === "create";
  return (
    <section
      aria-label="Bot suggestion"
      data-bot-suggestion=""
      className="relative overflow-hidden rounded-lg border border-border-strong bg-surface p-4"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(420px_120px_at_0%_0%,var(--color-glow-teal),transparent)]"
      />
      <div className="relative flex flex-col gap-3">
        <span className="inline-flex items-center gap-1.5 text-2xs font-medium text-fg-muted">
          <SparkleIcon aria-hidden="true" className="size-3" />
          Suggestion
        </span>
        <div className="flex items-start gap-3">
          <SessionAvatar
            avatar={avatar}
            name={suggestion.name}
            workspaceId={session.workspaceId}
            seed={suggestion.id}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-fg">
              {!create
                ? `${suggestion.name} already does this`
                : isBot
                  ? `Save ${suggestion.name} as a template so others can start one`
                  : `Make this chat a bot: ${suggestion.name}`}
            </p>
            {suggestion.description ? (
              <p className="mt-0.5 text-sm text-fg-muted">{suggestion.description}</p>
            ) : null}
          </div>
        </div>
        {suggestion.reason ? <p className="text-xs text-fg-subtle">{suggestion.reason}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          {create ? (
            <>
              {!isBot ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || !context.updateSessionProfile}
                  onClick={() => void makeBot()}
                >
                  Make it a bot
                </Button>
              ) : null}
              {suggestion.setupInstructions ? (
                <Button
                  type="button"
                  size="sm"
                  variant={isBot ? "default" : "outline"}
                  onClick={() => setTemplateOpen(true)}
                >
                  Save as template…
                </Button>
              ) : null}
            </>
          ) : (
            <Button type="button" size="sm" onClick={openReuse}>
              {suggestion.sessionId ? `Open ${suggestion.name}` : `Start ${suggestion.name}`}
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={dismiss}>
            Not now
          </Button>
        </div>
      </div>
      {create && suggestion.setupInstructions ? (
        <BotTemplateDialog
          open={templateOpen}
          onOpenChange={setTemplateOpen}
          workspaceId={session.workspaceId}
          seed={session.id}
          mode="save"
          initial={{
            name: suggestion.name,
            description: suggestion.description ?? "",
            avatar: suggestion.avatar,
            setupInstructions: suggestion.setupInstructions,
            visibility: session.tenancy?.visibility === "private" ? "private" : "workspace",
          }}
          onSubmit={async (values) => {
            const created = await context.client.createBotTemplate(session.workspaceId, {
              ...values,
              sourceSessionId: session.id,
            });
            toast.success("Bot template saved", { description: created.name });
            dismiss();
          }}
        />
      ) : null}
    </section>
  );
}
