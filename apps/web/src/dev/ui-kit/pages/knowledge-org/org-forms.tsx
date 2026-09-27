import { useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { CircleAlertIcon, XIcon } from "lucide-react";

import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import {
  CheckboxField,
  Field,
  FieldStack,
  TextArea,
  TextInput,
  useFieldControlProps,
} from "@/components/ui/field";
import { FormDialog, FormPage } from "@/components/ui/form-dialog";
import { InlineHelp } from "@/components/ui/inline-help";
import { LogoTile } from "@/components/ui/logo-tile";
import { RoleSelect } from "@/components/ui/role-select";
import { cn } from "@/lib/utils";

import { organization, type OrganizationRole, type WorkspaceRole } from "../../fixtures";
import {
  firstName,
  isEmail,
  joinNames,
  organizationRoleOptions,
  REMOVED_PERSON,
  WORKSPACE_ROLE_OPTIONS,
  type OrgPerson,
  type OrgWorkspace,
} from "./org-data";
import { useOrg } from "./org-store";
import { wait } from "./picks";

/* ----------------------------------------------------------------------------
   Invite people, New workspace and Fine-tune (pages), and the confirmations
   the organization pages use (small centered dialogs).
   -------------------------------------------------------------------------- */

interface EmailChip {
  value: string;
  problem?: string;
}

/**
 * Several email addresses as chips (kit composition: the primitives have no
 * multi-value input yet). Enter, comma, space and paste make chips;
 * Backspace on an empty field removes the last one.
 */
function EmailChipsInput({
  chips,
  onChange,
  placeholder,
}: {
  chips: EmailChip[];
  onChange: (values: string[]) => void;
  placeholder: string;
}) {
  const field = useFieldControlProps();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const listId = useId();

  const commit = (text: string) => {
    const parts = text
      .split(/[\s,;]+/)
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    if (parts.length === 0) return;
    const values = chips.map((chip) => chip.value);
    onChange([...values, ...parts.filter((part) => !values.includes(part))]);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.key === "Enter" || event.key === "," || event.key === " ") && draft.trim()) {
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Backspace" && !draft && chips.length > 0) {
      onChange(chips.slice(0, -1).map((chip) => chip.value));
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (/[\s,;]/.test(text)) {
      event.preventDefault();
      commit(text);
    }
  };

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className={cn(
        "flex min-h-9 w-full min-w-0 cursor-text flex-wrap items-center gap-1.5 rounded-md border bg-surface px-2 py-1.5 transition-colors duration-[120ms] hover:border-border-strong pointer-coarse:min-h-11",
        "has-[input:focus-visible]:border-brand has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-brand/55",
        field["aria-invalid"] ? "border-danger hover:border-danger" : "border-border",
      )}
    >
      {chips.length > 0 ? (
        <ul id={listId} aria-label="Addresses" className="contents">
          {chips.map((chip) => (
            <li
              key={chip.value}
              className={cn(
                "inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-full border pr-0.5 pl-2 text-xs font-medium",
                chip.problem
                  ? "border-danger/50 bg-danger/5 text-danger"
                  : "border-border bg-surface-2 text-fg",
              )}
            >
              {chip.problem ? (
                <CircleAlertIcon aria-hidden="true" className="size-3 shrink-0" />
              ) : null}
              <span className="min-w-0 truncate">{chip.value}</span>
              {chip.problem ? <span className="sr-only">: {chip.problem}</span> : null}
              <button
                type="button"
                aria-label={`Remove ${chip.value}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onChange(chips.filter((each) => each !== chip).map((each) => each.value));
                  inputRef.current?.focus();
                }}
                className="grid size-5 shrink-0 place-items-center rounded-full text-current opacity-70 transition-opacity hover:opacity-100 pointer-coarse:size-8"
              >
                <XIcon aria-hidden="true" className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        ref={inputRef}
        {...field}
        type="email"
        inputMode="email"
        autoComplete="off"
        value={draft}
        placeholder={chips.length === 0 ? placeholder : undefined}
        aria-describedby={
          [field["aria-describedby"], chips.length > 0 ? listId : null].filter(Boolean).join(" ") ||
          undefined
        }
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => commit(draft)}
        className="h-6 min-w-40 flex-1 border-0 bg-transparent px-1 text-sm text-fg outline-none! placeholder:text-fg-subtle pointer-coarse:text-base"
      />
    </div>
  );
}

type InviteRole = OrganizationRole;

/** Invite people: its own page ("← People"). Mount it only while it's open. */
export function InviteForm({
  onClose,
  onInvite,
}: {
  onClose: () => void;
  onInvite: (
    invites: { email: string; role: InviteRole; grants: Record<string, WorkspaceRole> }[],
  ) => void;
}) {
  const store = useOrg();
  const { picks, vocab, questions } = store;
  const [emails, setEmails] = useState<string[]>([]);
  const [role, setRole] = useState<InviteRole>("member");
  const [grants, setGrants] = useState<Record<string, WorkspaceRole | null>>({});
  const [memberOnly, setMemberOnly] = useState<Record<string, boolean>>({});
  const [showErrors, setShowErrors] = useState(false);

  const existing = new Map(store.people.map((person) => [person.email ?? "", person]));
  const chips: EmailChip[] = emails.map((value) => {
    if (!isEmail(value)) return { value, problem: "Not an email address" };
    const person = existing.get(value);
    if (person) {
      return {
        value,
        problem:
          person.status === "invited" || person.status === "invite_failed"
            ? "Already invited"
            : `Already in ${organization.name}`,
      };
    }
    if (value === REMOVED_PERSON.email && questions.q37 === "never") {
      return { value, problem: "Removed earlier and can't be invited again" };
    }
    return { value };
  });
  const problems = chips.filter((chip) => chip.problem);
  const emailError =
    emails.length === 0
      ? showErrors
        ? "Add at least one email address."
        : undefined
      : problems.length > 0
        ? problems.length === 1
          ? `${problems[0]!.value}: ${problems[0]!.problem}.`
          : `Fix these addresses: ${problems.map((chip) => `${chip.value} (${chip.problem!.charAt(0).toLowerCase()}${chip.problem!.slice(1)})`).join(", ")}.`
        : undefined;
  const reinvite = emails.includes(REMOVED_PERSON.email) && questions.q37 === "allowed";
  const count = Math.max(1, chips.length - problems.length);

  const submit = async () => {
    setShowErrors(true);
    if (emails.length === 0 || problems.length > 0) return false;
    await wait(800);
    const chosen: Record<string, WorkspaceRole> = {};
    if (questions.q39 === "per-workspace") {
      for (const [id, value] of Object.entries(grants)) if (value) chosen[id] = value;
    } else {
      for (const [id, checked] of Object.entries(memberOnly)) if (checked) chosen[id] = "member";
    }
    onInvite(emails.map((email) => ({ email, role, grants: chosen })));
    return true;
  };

  const roles = organizationRoleOptions(vocab.adminLabel);
  const fields = (
    <FieldStack>
      <Field
        label="Email addresses"
        hint="Separate with commas, or press Enter after each one."
        error={emailError}
      >
        <EmailChipsInput
          chips={chips}
          onChange={setEmails}
          placeholder="name@acme.dev, another@acme.dev"
        />
      </Field>
      {reinvite ? (
        <InlineHelp icon className="-mt-3">
          {REMOVED_PERSON.name} was removed on {REMOVED_PERSON.removedLabel}. Inviting her starts
          fresh, with only the access you choose here.
        </InlineHelp>
      ) : null}
      <Field label="Organization role" group>
        <ChoiceCards
          variant={picks.choice}
          value={role}
          onValueChange={(value) => setRole(value as InviteRole)}
          aria-label="Organization role"
        >
          {roles.map((option) => (
            <ChoiceCard
              key={option.id}
              value={option.id}
              title={option.label}
              description={option.description}
            />
          ))}
        </ChoiceCards>
      </Field>
      {questions.q39 === "per-workspace" ? (
        <Field
          label={vocab.workspaceAccess}
          group
          hint="Everyone also gets a private Personal workspace."
        >
          <ul className="flex min-w-0 flex-col divide-y divide-border rounded-[14px] border border-border">
            {store.workspaces.map((workspace) => (
              <li
                key={workspace.id}
                className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-3 py-2.5 @[440px]/form:grid-cols-[1.5rem_minmax(0,1fr)_auto]"
              >
                <LogoTile size="sm" name={workspace.name} />
                <span className="min-w-0 truncate text-sm font-medium text-fg">
                  {workspace.name}
                </span>
                <RoleSelect<WorkspaceRole>
                  roles={WORKSPACE_ROLE_OPTIONS}
                  value={grants[workspace.id] ?? null}
                  noAccessLabel="No access"
                  aria-label={`Access to ${workspace.name}`}
                  onValueChange={(value) =>
                    setGrants((current) => ({ ...current, [workspace.id]: value }))
                  }
                  className="col-start-2 w-[11.5rem] @[440px]/form:col-start-3"
                />
              </li>
            ))}
          </ul>
        </Field>
      ) : (
        <Field
          label="Give access as Member to:"
          group
          hint="Everyone also gets a private Personal workspace."
        >
          <div className="flex min-w-0 flex-col gap-3">
            {store.workspaces.map((workspace) => (
              <CheckboxField
                key={workspace.id}
                label={workspace.name}
                description={workspace.description}
                checked={memberOnly[workspace.id] ?? false}
                onCheckedChange={(checked) =>
                  setMemberOnly((current) => ({ ...current, [workspace.id]: checked }))
                }
              />
            ))}
          </div>
        </Field>
      )}
    </FieldStack>
  );

  return (
    <FormPage
      title={vocab.invite}
      description={`They'll get an email with a link to join ${organization.name}.`}
      submitLabel={count > 1 ? `Send ${count} invitations` : "Send invitation"}
      pendingLabel="Sending…"
      onSubmit={submit}
      footerStart="Invitations expire in 7 days."
      back={{ label: vocab.peopleTitle, onClick: onClose }}
      onCancel={onClose}
      onSubmitted={onClose}
      className="flex-1"
    >
      {fields}
    </FormPage>
  );
}

/* ----------------------------------------------------------------------------
   Confirmations.
   -------------------------------------------------------------------------- */

export type OrgConfirm =
  | { kind: "suspend"; person: OrgPerson }
  | { kind: "remove"; person: OrgPerson }
  | { kind: "delete-workspace"; workspace: OrgWorkspace }
  | { kind: "join"; workspace: OrgWorkspace };

export function OrgConfirmDialog({
  confirm,
  onClose,
  onSuspend,
  onRemove,
  onDeleteWorkspace,
  onJoin,
}: {
  confirm: OrgConfirm | null;
  onClose: () => void;
  onSuspend: (person: OrgPerson) => void;
  onRemove: (person: OrgPerson) => void;
  onDeleteWorkspace: (workspace: OrgWorkspace) => void;
  onJoin: (workspace: OrgWorkspace) => void;
}) {
  const store = useOrg();
  const { questions, vocab, picks } = store;
  const open = confirm !== null;
  const onOpenChange = (next: boolean) => {
    if (!next) onClose();
  };

  if (confirm?.kind === "join") {
    const admins = store.people.filter(
      (person) => person.grants[confirm.workspace.id] === "workspace_admin",
    );
    return (
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        size="sm"
        title={`Join ${confirm.workspace.name}?`}
        description={`You'll join as Workspace admin, so you can open its chats and files.${
          admins.length > 0
            ? ` ${joinNames(admins.map((person) => person.name))} will see that you joined.`
            : ""
        }`}
        submitLabel="Join as workspace admin"
        pendingLabel="Joining…"
        initialFocus="cancel"
        onSubmit={async () => {
          await wait(600);
          onJoin(confirm.workspace);
          return true;
        }}
      />
    );
  }

  if (confirm?.kind === "suspend") {
    const person = confirm.person;
    const names = store.workspaces
      .filter((workspace) => person.grants[workspace.id])
      .map((workspace) => workspace.name);
    const pause = questions.q36 === "pause";
    return (
      <DestructiveConfirm
        open={open}
        onOpenChange={onOpenChange}
        variant={picks.destructive === "type-to-confirm" ? "type-to-confirm" : "consequences"}
        confirmText={person.name}
        confirmPlaceholder="Type the name"
        title={pause ? `Pause ${person.name}'s access?` : `Suspend ${person.name}?`}
        consequences={
          pause
            ? [
                `${firstName(person)} can't sign in to ${organization.name} until you resume access.`,
                names.length > 0
                  ? `Their access to ${joinNames(names)} is kept for when you resume it.`
                  : "They have no shared workspaces right now.",
                `Schedules ${firstName(person)} owns don't run while access is paused.`,
              ]
            : [
                `${firstName(person)} can't sign in to ${organization.name}.`,
                names.length > 0
                  ? `Their access to ${joinNames(names)} is removed. Restoring doesn't bring it back.`
                  : "They have no shared workspaces right now.",
                "Their Personal workspace is kept.",
              ]
        }
        confirmLabel={vocab.suspendVerb}
        pendingLabel={pause ? "Pausing…" : "Suspending…"}
        onConfirm={async () => {
          await wait(700);
          onSuspend(person);
        }}
      />
    );
  }

  if (confirm?.kind === "remove") {
    const person = confirm.person;
    const count = Object.keys(person.grants).length;
    const never = questions.q37 === "never";
    const owned = person.id === "person-maria" ? ["Monthly access review"] : [];
    return (
      <DestructiveConfirm
        open={open}
        onOpenChange={onOpenChange}
        variant={
          never || picks.destructive === "type-to-confirm" ? "type-to-confirm" : "consequences"
        }
        confirmText={person.name}
        confirmPlaceholder="Type the name"
        title={`Remove ${person.name} from ${organization.name}?`}
        consequences={[
          count > 0
            ? `${firstName(person)} loses access to ${organization.name} and ${count} shared ${count === 1 ? "workspace" : "workspaces"}.`
            : `${firstName(person)} loses access to ${organization.name}.`,
          owned.length > 0
            ? `Schedules ${firstName(person)} owns stop running: ${joinNames(owned)}.`
            : "Chats they shared stay in their workspaces.",
          never
            ? `${firstName(person)} can never be invited to ${organization.name} again.`
            : `You can invite ${firstName(person)} again later.`,
        ]}
        dependencies={
          owned.length > 0
            ? owned.map((name) => ({
                id: name,
                kind: "schedule" as const,
                kindLabel: "Schedule",
                name,
                detail: "Every month on day 1 at 09:00 · Oslo",
                href: "#schedules",
              }))
            : undefined
        }
        dependenciesTitle="Stops running"
        confirmLabel="Remove from organization"
        pendingLabel="Removing…"
        onConfirm={async () => {
          await wait(800);
          onRemove(person);
        }}
      />
    );
  }

  if (confirm?.kind === "delete-workspace") {
    const workspace = confirm.workspace;
    const members = store.people.filter((person) => person.grants[workspace.id]).length;
    return (
      <DestructiveConfirm
        open={open}
        onOpenChange={onOpenChange}
        variant="type-to-confirm"
        confirmText={workspace.name}
        confirmPlaceholder="Type the workspace name"
        title={`Delete ${workspace.name}?`}
        consequences={[
          `${members} ${members === 1 ? "person loses" : "people lose"} access.`,
          "Its chats, files, schedules and knowledge are deleted.",
          "This can't be undone.",
        ]}
        confirmLabel="Delete workspace"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          await wait(900);
          onDeleteWorkspace(workspace);
        }}
      />
    );
  }

  return null;
}

/** New workspace: its own page ("← Workspaces"). `onCreate` opens the new workspace. */
export function NewWorkspacePage({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, description: string) => void;
}) {
  const store = useOrg();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <FormPage
      title="New workspace"
      description={`A shared space for a team in ${organization.name}. You'll be its workspace admin.`}
      back={{ label: "Workspaces", onClick: onClose }}
      submitLabel="Create workspace"
      pendingLabel="Creating…"
      onCancel={onClose}
      onSubmit={async () => {
        const trimmed = name.trim();
        if (!trimmed) {
          setError("Name the workspace.");
          return false;
        }
        if (
          store.workspaces.some(
            (workspace) => workspace.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
          )
        ) {
          setError(`There's already a workspace called ${trimmed}.`);
          return false;
        }
        await wait(700);
        onCreate(trimmed, description.trim());
        return true;
      }}
      className="flex-1"
    >
      <FieldStack>
        <Field label="Name" error={error ?? undefined}>
          <TextInput
            value={name}
            placeholder="For example: Data science"
            suppressAutofill
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
          />
        </Field>
        <Field label="Description" optional>
          <TextArea
            rows={3}
            value={description}
            placeholder="What the team uses it for"
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </FieldStack>
    </FormPage>
  );
}

const FINE_TUNE_PERMISSIONS = [
  {
    id: "sessions",
    label: "Start and continue chats",
    description: "Also lets them run schedules they own.",
  },
  {
    id: "files",
    label: "Add files and knowledge",
    description: "Upload files and save knowledge entries.",
  },
  {
    id: "connections",
    label: "Use shared connections",
    description: "Gmail, Linear and other workspace connections.",
  },
  {
    id: "variables",
    label: "Use variable sets",
    description: "Secrets and config in the sandbox.",
  },
  {
    id: "settings",
    label: "Change workspace settings",
    description: "Models, defaults and integrations.",
  },
  { id: "access", label: "Manage who has access", description: "Add and remove people." },
] as const;

/** Q34, the other answer: hand-picked permissions, in human words. Its own page. */
export function FineTunePage({
  person,
  workspace,
  onClose,
}: {
  person: OrgPerson;
  workspace: OrgWorkspace;
  onClose: () => void;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>({
    sessions: true,
    files: true,
    connections: true,
  });
  return (
    <FormPage
      title="Fine-tune permissions"
      description={`${person.name} in ${workspace.name}. They'll show as Custom.`}
      back={{ label: person.name, onClick: onClose }}
      submitLabel="Save permissions"
      pendingLabel="Saving…"
      onCancel={onClose}
      onSubmitted={onClose}
      onSubmit={async () => {
        await wait(600);
        return true;
      }}
      className="flex-1"
    >
      <div className="flex min-w-0 flex-col gap-3">
        {FINE_TUNE_PERMISSIONS.map((permission) => (
          <CheckboxField
            key={permission.id}
            label={permission.label}
            description={permission.description}
            checked={checked[permission.id] ?? false}
            onCheckedChange={(next) =>
              setChecked((current) => ({ ...current, [permission.id]: next }))
            }
          />
        ))}
      </div>
    </FormPage>
  );
}
