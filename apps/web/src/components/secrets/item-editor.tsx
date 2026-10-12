import {
  isValidSecretName,
  isValidTotpInput,
  VAULT_LIMITS,
  type GeneratePasswordSpecInput,
} from "@opengeni/contracts";
import {
  vaultErrorCode,
  type CreateVaultItemRequest,
  type UpdateVaultItemRequest,
  type VaultFieldInput,
  type VaultFieldKind,
  type VaultItem,
  type VaultItemType,
  type VaultSummary,
} from "@opengeni/react";
import { PlusIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldStack, TextArea, TextInput } from "@/components/ui/field";
import { FlushFormPage } from "@/components/ui/flush-form-page";
import { SecretInput } from "@/components/ui/secret-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectMenu } from "@/components/ui/select-menu";
import { cn } from "@/lib/utils";

import { fieldLabel } from "./item-page";
import { PasswordGeneratorPopover } from "./password-generator-popover";
import { HIT_AREA } from "./secret-actions";
import { formatTotpCode, TotpRing, useTotp } from "./totp-code";
import { ITEM_TYPE_LABEL, vaultErrorText } from "./vault-model";

/* ----------------------------------------------------------------------------
   New item and Edit item (S4): a form page. Concealed values are never
   prefilled; leaving one empty keeps the saved value.
   -------------------------------------------------------------------------- */

type CreatableType = Exclude<VaultItemType, "passkey">;

type Draft = {
  key: string;
  fieldId?: string;
  name: string;
  kind: VaultFieldKind;
  /** Built-in fields have a fixed name. */
  custom: boolean;
  value: string;
  generate?: GeneratePasswordSpecInput;
  file?: { name: string; base64: string; size: number };
  removed?: boolean;
  existing: boolean;
  /** Bumped to remount a SecretInput revealed (after Generate). */
  revealNonce?: number;
};

let draftCounter = 0;
const nextKey = () => `draft-${(draftCounter += 1)}`;

function template(type: CreatableType): Draft[] {
  const make = (name: string, kind: VaultFieldKind): Draft => ({
    key: nextKey(),
    name,
    kind,
    custom: false,
    value: "",
    existing: false,
  });
  switch (type) {
    case "login":
      return [
        make("username", "text"),
        make("password", "concealed"),
        make("one-time password", "totp"),
      ];
    case "api_key":
      return [make("value", "concealed")];
    case "note":
      return [make("note", "concealed")];
    case "file":
      return [make("file", "file")];
  }
}

function fromItem(item: VaultItem): Draft[] {
  return [...item.fields]
    .sort((a, b) => a.position - b.position)
    .map((field) => ({
      key: nextKey(),
      fieldId: field.id,
      name: field.name,
      kind: field.kind,
      custom: false,
      value: field.kind === "text" ? (field.value ?? "") : "",
      existing: true,
    }));
}

const PRIMARY_LABEL: Partial<Record<string, string>> = { value: "Key" };
const draftLabel = (draft: Draft) => PRIMARY_LABEL[draft.name] ?? fieldLabel(draft.name);

const TYPE_OPTIONS: { value: CreatableType; label: string }[] = [
  { value: "login", label: "Login" },
  { value: "api_key", label: "API key" },
  { value: "note", label: "Note" },
  { value: "file", label: "File" },
];

const KIND_OPTIONS: {
  value: Exclude<VaultFieldKind, "file">;
  label: string;
  description: string;
}[] = [
  { value: "text", label: "Text", description: "Shown on the page, like a username." },
  { value: "concealed", label: "Concealed", description: "Hidden until you reveal it." },
  { value: "totp", label: "One-time password", description: "A TOTP seed or otpauth:// link." },
];

function bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function toDateInput(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

function TotpPreview({ seed }: { seed: string }) {
  const totp = useTotp(seed);
  if (!totp) return null;
  return (
    <span className="flex items-center gap-2">
      Current code
      <span className="font-mono font-medium text-fg tabular-nums">
        {formatTotpCode(totp.code)}
      </span>
      <TotpRing remainingMs={totp.remainingMs} periodSeconds={totp.periodSeconds} />
    </span>
  );
}

type Errors = { name?: string; fields: Record<string, string> };

export function ItemEditorPage({
  vault,
  item,
  initialType = "login",
  onClose,
  onCreate,
  onUpdate,
  onReload,
}: {
  vault: VaultSummary;
  /** Present when editing. */
  item?: VaultItem | undefined;
  initialType?: CreatableType;
  onClose: () => void;
  onCreate: (request: CreateVaultItemRequest) => Promise<void>;
  onUpdate: (request: UpdateVaultItemRequest) => Promise<void>;
  onReload: () => void;
}) {
  const editing = Boolean(item);
  const [type, setType] = useState<CreatableType>(
    item && item.type !== "passkey" ? item.type : initialType,
  );
  const [name, setName] = useState(item?.name ?? "");
  const [websites, setWebsites] = useState<string[]>(item?.websites.length ? item.websites : [""]);
  const [expires, setExpires] = useState(toDateInput(item?.expiresAt ?? null));
  const [drafts, setDrafts] = useState<Draft[]>(() => (item ? fromItem(item) : template(type)));
  const [errors, setErrors] = useState<Errors>({ fields: {} });
  const [formError, setFormError] = useState<ReactNode>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const nameId = useId();

  const touched = useRef(false);
  const changeType = (next: CreatableType) => {
    setType(next);
    // Keep what was typed into fields that exist in both templates.
    setDrafts((current) => {
      const kept = new Map(
        current.filter((draft) => draft.value).map((draft) => [draft.name, draft]),
      );
      return [
        ...template(next).map((draft) => kept.get(draft.name) ?? draft),
        ...current.filter((draft) => draft.custom),
      ];
    });
  };

  const update = (key: string, patch: Partial<Draft>) => {
    touched.current = true;
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)),
    );
    setErrors((current) => {
      if (!current.fields[key]) return current;
      const fields = { ...current.fields };
      delete fields[key];
      return { ...current, fields };
    });
  };

  const showWebsites = type === "login" || type === "api_key";
  const visibleDrafts = drafts.filter((draft) => !draft.removed);

  function validate(): Errors {
    const next: Errors = { fields: {} };
    const trimmed = name.trim();
    if (!trimmed) next.name = "Give the item a name.";
    else if (!isValidSecretName(trimmed))
      next.name = "Names can't contain /, {, }, # or \\, or start with id:.";
    const names = new Set<string>();
    for (const draft of visibleDrafts) {
      if (draft.custom) {
        const fieldName = draft.name.trim();
        if (!fieldName) next.fields[draft.key] = "Name this field.";
        else if (!isValidSecretName(fieldName) || fieldName.toLowerCase() === "otp")
          next.fields[draft.key] = "Use another name. Field names can't contain /, {, }, # or \\.";
        else if (names.has(fieldName.toLowerCase()))
          next.fields[draft.key] = "Another field already has this name.";
        names.add(fieldName.toLowerCase());
      } else names.add(draft.name);
      if (draft.kind === "totp" && draft.value.trim() && !isValidTotpInput(draft.value.trim()))
        next.fields[draft.key] =
          "That isn't a valid one-time password seed. Paste the setup key or the otpauth:// link.";
      if (draft.kind !== "file" && bytes(draft.value) > VAULT_LIMITS.textValueMaxBytes)
        next.fields[draft.key] = "This value is too large. Text can be up to 64 KB.";
      if (draft.file && draft.file.size > VAULT_LIMITS.fileValueMaxBytes)
        next.fields[draft.key] = "This file is too large. Files can be up to 256 KB.";
    }
    if (!editing && type === "file" && !visibleDrafts.some((draft) => draft.file))
      next.fields[visibleDrafts.find((draft) => draft.kind === "file")?.key ?? ""] =
        "Choose a file.";
    return next;
  }

  function fieldInput(draft: Draft): VaultFieldInput | null {
    const base = { name: draft.name.trim(), ...(draft.fieldId ? { fieldId: draft.fieldId } : {}) };
    if (draft.removed) return draft.fieldId ? { ...base, remove: true } : null;
    if (draft.file)
      return { ...base, kind: "file", fileBase64: draft.file.base64, fileName: draft.file.name };
    if (draft.generate && !draft.value)
      return { ...base, kind: draft.kind, generate: draft.generate };
    const value = draft.kind === "totp" ? draft.value.trim() : draft.value;
    if (draft.existing) {
      // Text shows its value, so an unchanged one is skipped; concealed empty keeps the saved one.
      const original = item?.fields.find((field) => field.id === draft.fieldId);
      if (draft.kind === "text" ? value === (original?.value ?? "") : !value) return null;
      return { ...base, value };
    }
    if (!value) return null;
    return { ...base, kind: draft.kind, value };
  }

  async function submit(): Promise<boolean> {
    setFormError(null);
    const found = validate();
    setErrors(found);
    if (found.name || Object.keys(found.fields).length) return false;
    const fields = drafts
      .map(fieldInput)
      .filter((input): input is VaultFieldInput => input !== null);
    const cleanWebsites = websites.map((site) => site.trim()).filter(Boolean);
    const expiresAt = expires ? new Date(`${expires}T00:00:00Z`).toISOString() : null;
    try {
      if (item) {
        await onUpdate({
          expectedGeneration: item.generation,
          ...(name.trim() !== item.name ? { name: name.trim() } : {}),
          ...(showWebsites ? { websites: cleanWebsites } : {}),
          expiresAt,
          ...(fields.length ? { fields } : {}),
        });
      } else {
        await onCreate({
          type,
          name: name.trim(),
          ...(showWebsites && cleanWebsites.length ? { websites: cleanWebsites } : {}),
          ...(expiresAt ? { expiresAt } : {}),
          fields,
        });
      }
      return true;
    } catch (error) {
      const code = vaultErrorCode((error as { cause?: unknown }).cause ?? error);
      if (code === "vault_item_name_conflict") {
        setErrors((current) => ({
          ...current,
          name: `${vault.name} already has an item with this name. Choose another name.`,
        }));
        return false;
      }
      if (code === "vault_generation_conflict") {
        setFormError(
          <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>Changed elsewhere since you opened it. Reload to get the latest version.</span>
            <Button type="button" variant="outline" size="sm" onClick={onReload}>
              Reload
            </Button>
          </span>,
        );
        return false;
      }
      setFormError(vaultErrorText((error as { cause?: unknown }).cause ?? error));
      return false;
    }
  }

  const kindChoices = useMemo(
    () =>
      KIND_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description,
      })),
    [],
  );

  const renderDraft = (draft: Draft) => {
    const error = errors.fields[draft.key];
    const removable =
      draft.custom ||
      (draft.existing &&
        draft.name !== (type === "login" ? "password" : type === "api_key" ? "value" : type));
    const removeButton = removable ? (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${draft.custom && !draft.name ? "field" : draftLabel(draft)}`}
        onClick={() =>
          draft.existing
            ? update(draft.key, { removed: true })
            : setDrafts((current) => current.filter((each) => each.key !== draft.key))
        }
        className={cn("text-fg-muted hover:text-danger", HIT_AREA)}
      >
        <Trash2Icon aria-hidden="true" />
      </Button>
    ) : null;
    const keepHint =
      draft.existing && draft.kind !== "text" ? "Leave empty to keep the saved value." : undefined;

    let control: ReactNode;
    let hint: ReactNode = keepHint;
    if (draft.kind === "file") {
      control = (
        <div className="flex min-w-0 items-center gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => fileInput.current?.click()}
            className="pointer-coarse:h-11"
          >
            <UploadIcon aria-hidden="true" />
            {draft.file || draft.existing ? "Replace file" : "Choose file"}
          </Button>
          <span className="min-w-0 truncate text-sm text-fg-muted">
            {draft.file
              ? draft.file.name
              : draft.existing
                ? item?.fields.find((field) => field.id === draft.fieldId)?.fileName
                : "Up to 256 KB"}
          </span>
          <input
            ref={fileInput}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const buffer = new Uint8Array(await file.arrayBuffer());
              let binary = "";
              for (const byte of buffer) binary += String.fromCharCode(byte);
              update(draft.key, {
                file: { name: file.name, base64: btoa(binary), size: file.size },
              });
            }}
          />
        </div>
      );
      hint = undefined;
    } else if (draft.kind === "text") {
      control = (
        <TextInput
          value={draft.value}
          onChange={(event) => update(draft.key, { value: event.target.value })}
          autoComplete="off"
          suppressAutofill
          spellCheck={false}
        />
      );
    } else if (draft.kind === "totp") {
      control = (
        <SecretInput
          value={draft.value}
          onChange={(event) => update(draft.key, { value: event.target.value })}
          placeholder={draft.existing ? "Unchanged" : "Setup key or otpauth:// link"}
        />
      );
      if (draft.value.trim() && isValidTotpInput(draft.value.trim()))
        hint = <TotpPreview seed={draft.value.trim()} />;
    } else if (type === "note" && draft.name === "note") {
      control = (
        <TextArea
          rows={6}
          value={draft.value}
          onChange={(event) => update(draft.key, { value: event.target.value })}
          placeholder={draft.existing ? "Unchanged" : undefined}
          className="font-mono text-xs"
          spellCheck={false}
        />
      );
    } else {
      const passwordLike = draft.name === "password" || draft.custom;
      control = (
        <div className="flex min-w-0 items-start gap-2">
          <SecretInput
            key={`${draft.key}-${draft.revealNonce ?? 0}`}
            className="min-w-0 flex-1"
            value={draft.value}
            defaultRevealed={Boolean(draft.revealNonce)}
            onChange={(event) =>
              update(draft.key, { value: event.target.value, generate: undefined })
            }
            placeholder={draft.existing ? "Unchanged" : undefined}
          />
          {passwordLike ? (
            <PasswordGeneratorPopover
              onUse={(password) =>
                update(draft.key, { value: password, revealNonce: (draft.revealNonce ?? 0) + 1 })
              }
            />
          ) : null}
        </div>
      );
    }

    if (draft.custom) {
      return (
        <div
          key={draft.key}
          className="flex min-w-0 flex-col gap-2 rounded-[10px] border border-border p-3"
        >
          <div className="flex min-w-0 items-end gap-2">
            <Field
              label="Field name"
              className="min-w-0 flex-1"
              error={error && !draft.value ? error : undefined}
            >
              <TextInput
                value={draft.name}
                onChange={(event) => update(draft.key, { name: event.target.value })}
                suppressAutofill
              />
            </Field>
            <SelectMenu
              aria-label="Field kind"
              options={kindChoices}
              value={draft.kind === "file" ? "concealed" : draft.kind}
              onValueChange={(kind) => update(draft.key, { kind: kind as VaultFieldKind })}
              className="w-44"
              align="end"
            />
            {removeButton}
          </div>
          <Field
            label={`${draft.name.trim() ? fieldLabel(draft.name.trim()) : "Field"} value`}
            hint={hint}
            error={draft.value ? error : undefined}
          >
            {control}
          </Field>
        </div>
      );
    }

    return (
      <Field
        key={draft.key}
        label={draftLabel(draft)}
        optional={draft.kind === "totp" || (draft.kind === "text" && !draft.existing)}
        hint={hint}
        error={error}
        aside={removeButton}
      >
        {control}
      </Field>
    );
  };

  return (
    <FlushFormPage
      backLabel={item ? item.name : vault.name}
      onClose={onClose}
      title={
        item
          ? `Edit ${item.name}`
          : `New ${type === "api_key" ? "API key" : ITEM_TYPE_LABEL[type].toLowerCase()}`
      }
      description={
        editing ? undefined : `Saved to ${vault.name}. Agents use it by reference, never by value.`
      }
      submitLabel={item ? "Save" : "Save item"}
      pendingLabel="Saving…"
      error={formError}
      onSubmit={async (event) => {
        event.preventDefault();
        return await submit();
      }}
    >
      <FieldStack>
        {!editing ? (
          <Field label="Type" group>
            <SegmentedControl
              options={TYPE_OPTIONS}
              value={type}
              onValueChange={changeType}
              fullWidth
            />
          </Field>
        ) : null}
        <Field label="Name" error={errors.name} id={nameId}>
          <TextInput
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (errors.name) setErrors((current) => ({ ...current, name: undefined }));
            }}
            placeholder={
              type === "login" ? "GitHub" : type === "api_key" ? "OpenAI API" : undefined
            }
            maxLength={VAULT_LIMITS.nameMaxChars}
            suppressAutofill
          />
        </Field>
        {showWebsites ? (
          <Field label={websites.length > 1 ? "Websites" : "Website"} optional>
            <div className="flex min-w-0 flex-col gap-2">
              {websites.map((site, index) => (
                <div key={index} className="flex min-w-0 items-center gap-2">
                  <TextInput
                    value={site}
                    aria-label={`Website ${index + 1}`}
                    onChange={(event) =>
                      setWebsites((current) =>
                        current.map((each, at) => (at === index ? event.target.value : each)),
                      )
                    }
                    placeholder="github.com"
                    inputMode="url"
                    suppressAutofill
                    className="min-w-0 flex-1"
                  />
                  {websites.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove website ${index + 1}`}
                      onClick={() =>
                        setWebsites((current) => current.filter((_, at) => at !== index))
                      }
                      className={cn("text-fg-muted hover:text-danger", HIT_AREA)}
                    >
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
              ))}
              {websites.length < VAULT_LIMITS.websitesPerItem ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2.5 self-start text-fg-muted hover:text-fg pointer-coarse:h-11"
                  onClick={() => setWebsites((current) => [...current, ""])}
                >
                  <PlusIcon aria-hidden="true" />
                  Add website
                </Button>
              ) : null}
            </div>
          </Field>
        ) : null}
        {visibleDrafts.map(renderDraft)}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2.5 self-start text-fg-muted hover:text-fg pointer-coarse:h-11"
          onClick={() =>
            setDrafts((current) => [
              ...current,
              {
                key: nextKey(),
                name: "",
                kind: "concealed",
                custom: true,
                value: "",
                existing: false,
              },
            ])
          }
        >
          <PlusIcon aria-hidden="true" />
          Add field
        </Button>
        <Field
          label="Expires"
          optional
          hint="Agents still get it after this date; it's marked Expired."
        >
          <TextInput
            type="date"
            value={expires}
            onChange={(event) => setExpires(event.target.value)}
            className="w-48"
          />
        </Field>
      </FieldStack>
    </FlushFormPage>
  );
}
