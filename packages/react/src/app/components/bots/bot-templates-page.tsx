/**
 * Bot templates: where a new bot starts. A bot is an ordinary long-lived chat
 * with a name, description and avatar. Starting from a template opens a new
 * chat with the template's setup instructions as its first message, ready to
 * read and change before sending; the agent then sets itself up with its
 * ordinary tools. Templates can be exported as a file and imported into
 * another workspace. A template is Only me or shared with the workspace, like
 * a chat; anyone who starts chats here can change or delete a shared one.
 */
import { useRef, useState } from "react";
import { BotIcon, DownloadIcon, PlusIcon, UploadIcon } from "lucide-react";
import type { WorkspaceBotTemplate } from "@opengeni/contracts";

import { apiErrorDetails, userErrorText } from "../../../ui/api-error";
import { Button } from "../../../ui/button";
import { ConfirmDialog } from "../../../ui/confirm-dialog";
import { DetailPage, DetailPageHeader } from "../../../ui/detail-page";
import { DetailSection } from "../../../ui/detail-sheet";
import { DropdownMenuItem } from "../../../ui/dropdown-menu";
import { EmptyState } from "../../../ui/empty-state";
import { ErrorMessage } from "../../../ui/error-message";
import { ListRow, ListRowSkeleton, RowList } from "../../../ui/list-row";
import { LogoTile } from "../../../ui/logo-tile";
import { MetaChip } from "../../../ui/meta-chip";
import { Notice } from "../../../ui/notice";
import { useAppContext } from "../../app-context";
import {
  downloadBotTemplate,
  parseBotTemplateFile,
  useBotTemplates,
} from "../../lib/bot-templates";
import { useNavigate } from "../../lib/navigation";
import { toast } from "../../lib/toast";
import {
  SessionAvatar,
  sessionAvatarFallbackHue,
  sessionAvatarInitials,
} from "../session/session-avatar";
import { BotTemplateDialog, type BotTemplateValues } from "./bot-template-dialog";

const EMPTY_TEMPLATE: BotTemplateValues = {
  name: "",
  description: "",
  avatar: null,
  setupInstructions: "",
  visibility: "workspace",
};

export function BotTemplatesPage({ workspaceId }: { workspaceId: string }) {
  const { client } = useAppContext();
  const navigate = useNavigate();
  const saved = useBotTemplates(workspaceId);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<WorkspaceBotTemplate | null>(null);
  const [deleting, setDeleting] = useState<WorkspaceBotTemplate | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const start = (template: WorkspaceBotTemplate) =>
    void navigate({
      to: "/workspaces/$workspaceId/sessions",
      params: { workspaceId },
      search: { botTemplateId: template.id },
    });

  const importFile = async (file: File) => {
    const parsed = parseBotTemplateFile(await file.text());
    if (!parsed.ok) {
      toast.error("Couldn't import the template", {
        description: parsed.error,
      });
      return;
    }
    try {
      const created = await client.createBotTemplate(workspaceId, parsed.request);
      saved.replace((current) => [created, ...current]);
      toast.success("Template imported", { description: created.name });
    } catch (error) {
      toast.error("Couldn't import the template", {
        description: userErrorText(error),
      });
    }
  };

  const actions = (
    <>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importFile(file);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="pointer-coarse:h-11"
        onClick={() => fileInput.current?.click()}
      >
        <UploadIcon />
        Import
      </Button>
      <Button
        type="button"
        size="sm"
        className="pointer-coarse:h-11"
        onClick={() => setCreating(true)}
      >
        <PlusIcon />
        New template
      </Button>
    </>
  );

  return (
    <DetailPage>
      <DetailPageHeader
        leading={<LogoTile name="Bot templates" icon={<BotIcon />} />}
        title="Bot templates"
        meta={["Start a bot from one: a chat that sets itself up and stays around"]}
        actions={saved.supported ? actions : undefined}
      />
      {!saved.supported ? (
        <Notice className="mt-6">This server doesn't keep bot templates yet.</Notice>
      ) : saved.templates === undefined ? (
        <DetailSection title="Saved in this workspace">
          <RowList label="Bot templates" variant="catalog" busy>
            <ListRowSkeleton count={3} />
          </RowList>
        </DetailSection>
      ) : saved.error && saved.templates.length === 0 ? (
        <ErrorMessage
          className="mt-6"
          title="Couldn't load the bot templates"
          {...apiErrorDetails(saved.error)}
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={saved.reload}
              className="pointer-coarse:h-11"
            >
              Try again
            </Button>
          }
        >
          Check your connection, then try again.
        </ErrorMessage>
      ) : saved.templates.length === 0 ? (
        <EmptyState
          variant="page"
          icon={<BotIcon />}
          title="No bot templates yet"
          description="Save one from a chat's menu, ask a chat's agent to save itself as one, or write one here."
          action={
            <Button type="button" size="sm" onClick={() => setCreating(true)}>
              <PlusIcon />
              New template
            </Button>
          }
        />
      ) : (
        <DetailSection
          title="Saved in this workspace"
          description="Start a bot from one. Templates marked Only me are yours alone."
        >
          <RowList label="Bot templates" variant="catalog">
            {saved.templates.map((template) => (
              <ListRow
                key={template.id}
                leading={
                  template.avatar ? (
                    <SessionAvatar
                      avatar={template.avatar}
                      name={template.name}
                      workspaceId={workspaceId}
                      seed={template.id}
                      size="md"
                    />
                  ) : (
                    <SessionAvatar
                      avatar={{
                        kind: "letters",
                        letters: sessionAvatarInitials(template.name).slice(0, 2),
                        hue: sessionAvatarFallbackHue(template.id),
                      }}
                      name={template.name}
                      workspaceId={workspaceId}
                      size="md"
                    />
                  )
                }
                title={template.name}
                titleAddon={
                  template.visibility === "private" ? (
                    <MetaChip variant="soft">Only me</MetaChip>
                  ) : null
                }
                description={template.description || undefined}
                control={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="pointer-coarse:h-11"
                    onClick={() => start(template)}
                  >
                    Start
                  </Button>
                }
                menuLabel={`More actions for the ${template.name} template`}
                menu={
                  <>
                    <DropdownMenuItem onSelect={() => downloadBotTemplate(template)}>
                      <DownloadIcon />
                      Export
                    </DropdownMenuItem>
                    {template.viewerAccess === "manage" ? (
                      <>
                        <DropdownMenuItem onSelect={() => setEditing(template)}>
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setDeleting(template)}
                        >
                          Delete
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </>
                }
                onOpen={() => start(template)}
              />
            ))}
          </RowList>
        </DetailSection>
      )}
      <BotTemplateDialog
        open={creating}
        onOpenChange={setCreating}
        workspaceId={workspaceId}
        seed="new-bot-template"
        mode="new"
        initial={EMPTY_TEMPLATE}
        onSubmit={async (values) => {
          const created = await client.createBotTemplate(workspaceId, values);
          saved.replace((current) => [created, ...current]);
          toast.success("Template saved", { description: created.name });
        }}
      />
      <BotTemplateDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        workspaceId={workspaceId}
        seed={editing?.id ?? "bot-template"}
        mode="edit"
        initial={
          editing
            ? {
                name: editing.name,
                description: editing.description,
                avatar: editing.avatar,
                setupInstructions: editing.setupInstructions,
                visibility: editing.visibility,
              }
            : EMPTY_TEMPLATE
        }
        onSubmit={async (values) => {
          if (!editing) return;
          const updated = await client.updateBotTemplate(workspaceId, editing.id, values);
          saved.replace((current) =>
            current.map((entry) => (entry.id === updated.id ? updated : entry)),
          );
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete the “${deleting?.name ?? ""}” template?`}
        description="Bots started from it keep working."
        confirmLabel="Delete template"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          if (!deleting) return true;
          try {
            await client.deleteBotTemplate(workspaceId, deleting.id);
            saved.replace((current) => current.filter((entry) => entry.id !== deleting.id));
            toast.success("Template deleted", { description: deleting.name });
            return true;
          } catch (error) {
            toast.error("Couldn't delete the template", {
              description: userErrorText(error),
            });
            return false;
          }
        }}
      />
    </DetailPage>
  );
}
