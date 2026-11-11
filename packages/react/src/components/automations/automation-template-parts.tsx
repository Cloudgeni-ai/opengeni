/**
 * Templates on screen: the tile that tells a template's kind at a glance, the
 * list a person picks one from, and the dialog that saves an automation as a
 * template or renames one. Controlled; the host reads and writes templates.
 */
import { useState, type ReactNode } from "react";
import { CalendarClockIcon } from "lucide-react";

import {
  AUTOMATION_TEMPLATE_DESCRIPTION_MAX_LENGTH,
  AUTOMATION_TEMPLATE_NAME_MAX_LENGTH,
} from "@opengeni/contracts/automation-templates";

import { useOpenGeniText } from "../../messages/runtime";
import { Field, FieldStack, TextArea, TextInput } from "../../ui/field";
import { FormDialog } from "../../ui/form-dialog";
import { inAppClick } from "../../ui/in-app-click";
import { ListRow, RowList } from "../../ui/list-row";
import { LogoTile, type LogoTileSize } from "../../ui/logo-tile";
import {
  automationTemplateSourceChoice,
  automationTemplateWhenWords,
  type AutomationTemplate,
} from "./automation-template-model";
import { eventSourceSubjectOfChoice } from "./event-source-model";
import { EventSourceTile, type EventSourceLogoResolver } from "./event-source-tile";

export interface AutomationTemplateTileProps {
  template: AutomationTemplate;
  sourceLogo?: EventSourceLogoResolver | undefined;
  /** The host's own art for this template. */
  icon?: ReactNode | undefined;
  size?: LogoTileSize | undefined;
}

/**
 * The tile for a template: the app its first event comes from, or a calendar
 * for one that runs on a schedule. `icon` replaces it, for a host's own art.
 */
export function AutomationTemplateTile({
  template,
  sourceLogo,
  icon,
  size,
}: AutomationTemplateTileProps) {
  const t = useOpenGeniText();
  const [first] = template.triggers;
  if (icon || !first) {
    return <LogoTile size={size} name={template.name} icon={icon ?? <CalendarClockIcon />} />;
  }
  const choice = automationTemplateSourceChoice(first.source);
  const subject = {
    ...eventSourceSubjectOfChoice(t, choice),
    ...(first.source.kind === "mcp" && first.source.mcpServerId
      ? { mcp: { serverId: first.source.mcpServerId, connectionId: null } }
      : {}),
  };
  return <EventSourceTile source={subject} logo={sourceLogo} size={size} />;
}

export interface AutomationTemplateListProps {
  /** Names the list for assistive technology: "Templates". */
  label: string;
  templates: readonly AutomationTemplate[];
  /** Opens the form filled in from the template. */
  onUse: (template: AutomationTemplate) => void;
  /**
   * The form's address for a template, so a row is a link that can open in
   * a new tab; a plain click still calls `onUse`.
   */
  href?: ((template: AutomationTemplate) => string) | undefined;
  sourceLogo?: EventSourceLogoResolver | undefined;
  /** A host's own tile for a template, by id. */
  icon?: ((template: AutomationTemplate) => ReactNode | undefined) | undefined;
  /** Menu items for one template, such as Rename and Delete; none for a template without any. */
  menu?: ((template: AutomationTemplate) => ReactNode | undefined) | undefined;
  /** The menu button's accessible name. */
  menuLabel?: ((template: AutomationTemplate) => string) | undefined;
  now: Date;
}

/**
 * Templates as a catalog to pick from: what each does, in up to two lines,
 * and when it runs. Opening one uses it.
 */
export function AutomationTemplateList({
  label,
  templates,
  onUse,
  href,
  sourceLogo,
  icon,
  menu,
  menuLabel,
  now,
}: AutomationTemplateListProps) {
  const t = useOpenGeniText();
  return (
    <RowList label={label} variant="catalog">
      {templates.map((template) => {
        const items = menu?.(template);
        return (
          <ListRow
            key={template.id}
            leading={
              <AutomationTemplateTile
                template={template}
                sourceLogo={sourceLogo}
                icon={icon?.(template)}
              />
            }
            title={template.name}
            description={template.description || undefined}
            meta={[automationTemplateWhenWords(t, template, now)]}
            menu={items}
            menuLabel={items ? menuLabel?.(template) : undefined}
            {...(href
              ? {
                  href: href(template),
                  linkProps: { onClick: inAppClick(() => onUse(template)) },
                }
              : { onOpen: () => onUse(template) })}
          />
        );
      })}
    </RowList>
  );
}

export interface AutomationTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Save an automation as a new template, or rename a saved one. */
  mode: "save" | "rename";
  /** The name and description it opens with. */
  initial: { name: string; description: string };
  /** Saves; a thrown error shows in the dialog and keeps it open. */
  onSubmit: (values: { name: string; description: string }) => Promise<void>;
}

/** The name and description of a template, to save one or rename it. */
export function AutomationTemplateDialog({
  open,
  onOpenChange,
  mode,
  initial,
  onSubmit,
}: AutomationTemplateDialogProps) {
  const t = useOpenGeniText();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [nameError, setNameError] = useState<string | null>(null);
  const [opened, setOpened] = useState(open);
  // Each opening starts from what it was opened with.
  if (open !== opened) {
    setOpened(open);
    if (open) {
      setName(initial.name);
      setDescription(initial.description);
      setNameError(null);
    }
  }
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={
        mode === "save"
          ? t("automations.templateDialog.saveTitle")
          : t("automations.templateDialog.renameTitle")
      }
      description={mode === "save" ? t("automations.templateDialog.saveDescription") : undefined}
      submitLabel={
        mode === "save"
          ? t("automations.templateDialog.saveSubmit")
          : t("automations.templateDialog.renameSubmit")
      }
      pendingLabel={t("automations.templateDialog.saving")}
      cancelLabel={t("automations.form.cancel")}
      onSubmit={async () => {
        const trimmed = name.trim();
        if (!trimmed) {
          setNameError(t("automations.templateDialog.nameRequired"));
          return false;
        }
        await onSubmit({ name: trimmed, description: description.trim() });
        return true;
      }}
    >
      <FieldStack>
        <Field label={t("automations.templateDialog.name")} error={nameError ?? undefined}>
          <TextInput
            value={name}
            maxLength={AUTOMATION_TEMPLATE_NAME_MAX_LENGTH}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
          />
        </Field>
        <Field
          label={t("automations.templateDialog.description")}
          hint={t("automations.templateDialog.descriptionHint")}
        >
          <TextArea
            value={description}
            rows={2}
            maxLength={AUTOMATION_TEMPLATE_DESCRIPTION_MAX_LENGTH}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </FieldStack>
    </FormDialog>
  );
}
