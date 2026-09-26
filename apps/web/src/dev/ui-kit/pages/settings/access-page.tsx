import { useId, useState, type ReactNode } from "react";
import { UserPlusIcon } from "lucide-react";
import { toast } from "sonner";

import { AccessList, type AccessMember } from "@/components/ui/access-list";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DetailBody,
  DetailFooter,
  DetailHeader,
  DetailSection,
  DetailSheet,
  DetailSheetContent,
} from "@/components/ui/detail-sheet";
import { showUndoToast } from "@/components/ui/destructive-confirm";
import { CheckboxField, Field, FieldStack } from "@/components/ui/field";
import { FormDialog, FormInline, FormPage, type FormFrameProps } from "@/components/ui/form-dialog";
import { HelpLink } from "@/components/ui/inline-help";
import { ListRow, RowList } from "@/components/ui/list-row";
import { RelativeTime } from "@/components/ui/relative-time";
import { RoleSelect, roleLabel, type RoleValue } from "@/components/ui/role-select";
import { Section, SectionStack } from "@/components/ui/section";

import {
  KIT_NOW,
  currentWorkspace,
  organization,
  personById,
  type AccessRequest,
  type WorkspaceRole,
} from "../../fixtures";
import { useKitNavigate, useKitView } from "../../view";
import { ADD_CANDIDATE_IDS, WORKSPACE_ROLE_OPTIONS, accessMemberFor, wait } from "./data";
import { useSettingsPicks } from "./picks";
import { SettingsFrame } from "./settings-frame";
import { FORM_PAGE_IN_SETTINGS, useFrameBase } from "./shared";
import { useSettingsPreview } from "./state";

/* ----------------------------------------------------------------------------
   Words.
   -------------------------------------------------------------------------- */

/** "a viewer", "a workspace admin": roles read as nouns inside sentences. */
function asRole(role: WorkspaceRole): string {
  const label = roleLabel(WORKSPACE_ROLE_OPTIONS, role).toLowerCase();
  return `${/^[aeiou]/.test(label) ? "an" : "a"} ${label}`;
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/* ----------------------------------------------------------------------------
   Membership changes: save, then confirm with Undo.
   -------------------------------------------------------------------------- */

function useAccessActions() {
  const { members, setMembers, workspaceName } = useSettingsPreview();
  const [savingIds, setSavingIds] = useState<string[]>([]);

  const setRole = (id: string, role: RoleValue<WorkspaceRole>) =>
    setMembers((current) =>
      current.map((member) =>
        member.id === id ? { ...member, role, grants: { [currentWorkspace.id]: role } } : member,
      ),
    );

  const onRoleChange = async (member: AccessMember<WorkspaceRole>, role: WorkspaceRole | null) => {
    if (role === null) return;
    const before = member.role;
    setSavingIds((ids) => [...ids, member.id]);
    await wait(700);
    setRole(member.id, role);
    setSavingIds((ids) => ids.filter((id) => id !== member.id));
    showUndoToast({
      title: `${member.name} is now ${asRole(role)}`,
      onUndo: () => setRole(member.id, before),
    });
  };

  const onRemove = (member: AccessMember<WorkspaceRole>) => {
    const index = members.findIndex((each) => each.id === member.id);
    setMembers((current) => current.filter((each) => each.id !== member.id));
    showUndoToast({
      title: `Removed ${member.name} from ${workspaceName}`,
      description: "Their sessions and files stay in the workspace.",
      onUndo: () =>
        setMembers((current) => [...current.slice(0, index), member, ...current.slice(index)]),
    });
  };

  const onResendInvite = (member: AccessMember<WorkspaceRole>) =>
    toast(`Sent a new invitation to ${member.email}`);

  return { savingIds, onRoleChange, onRemove, onResendInvite, onRevokeInvite: onRemove };
}

/* ----------------------------------------------------------------------------
   Add people: people who are already in Acme Robotics.
   -------------------------------------------------------------------------- */

function candidateNote(personId: string): { description: string; disabled?: boolean } {
  const person = personById(personId);
  if (person.status === "suspended") {
    return {
      description: `Suspended in ${organization.name}. An organization admin can reactivate them.`,
      disabled: true,
    };
  }
  if (person.status === "invited") {
    return { description: `${person.email} · Invited, hasn't joined yet` };
  }
  if (person.status === "invite_failed") {
    return { description: `${person.email} · Invitation email failed` };
  }
  return { description: person.email ?? "Service account" };
}

function RoleField({
  value,
  onChange,
}: {
  value: WorkspaceRole;
  onChange: (value: WorkspaceRole) => void;
}) {
  const labelId = useId();
  const role = WORKSPACE_ROLE_OPTIONS.find((each) => each.id === value);
  return (
    <div className="flex min-w-0 flex-col">
      <span id={labelId} className="mb-2 text-sm font-medium text-fg">
        Role
      </span>
      <RoleSelect
        size="md"
        align="start"
        aria-labelledby={labelId}
        roles={WORKSPACE_ROLE_OPTIONS}
        value={value}
        onValueChange={(next) => {
          if (next) onChange(next);
        }}
        className="w-full max-w-80"
      />
      <p className="mt-1.5 text-xs leading-4.5 text-fg-muted">{role?.description}</p>
    </div>
  );
}

function useAddPeopleForm(onDone: () => void) {
  const { members, setMembers, setRequests, requests, viewer, workspaceName } =
    useSettingsPreview();
  const view = useKitView();
  const kitNavigate = useKitNavigate(view);
  const [selected, setSelected] = useState<string[]>([]);
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [error, setError] = useState<string>();
  const available = ADD_CANDIDATE_IDS.filter((id) => !members.some((member) => member.id === id));
  const reset = () => {
    setSelected([]);
    setRole("member");
    setError(undefined);
  };

  const count = selected.length;
  const frame: Omit<FormFrameProps, "variant"> = {
    title: `Add people to ${workspaceName}`,
    description: `Choose people who are already in ${organization.name}.`,
    submitLabel: count === 0 ? "Add people" : count === 1 ? "Add 1 person" : `Add ${count} people`,
    pendingLabel: "Adding…",
    footerStart: (
      <>
        New to {organization.name}?{" "}
        <HelpLink onClick={() => kitNavigate({ section: "page-org-people" })}>
          Invite people
        </HelpLink>
      </>
    ),
    onSubmit: async () => {
      if (count === 0) {
        setError("Choose at least one person.");
        return false;
      }
      await wait(800);
      const added = selected.map((id) => ({
        ...accessMemberFor(personById(id), role, viewer),
        grants: { [currentWorkspace.id]: role },
      }));
      // Adding someone answers their open request too.
      const answered = requests.filter((request) => selected.includes(request.personId));
      setMembers((current) => [...current, ...added]);
      setRequests((current) => current.filter((request) => !selected.includes(request.personId)));
      showUndoToast({
        title: `Added ${listNames(added.map((member) => member.name))}`,
        description: `As ${asRole(role)} in ${workspaceName}.`,
        onUndo: () => {
          setMembers((current) => current.filter((member) => !selected.includes(member.id)));
          setRequests((current) => [...answered, ...current]);
        },
      });
      reset();
      return true;
    },
    onSubmitted: onDone,
    onCancel: () => {
      reset();
      onDone();
    },
    children:
      available.length === 0 ? (
        <p className="text-sm text-fg-muted">
          Everyone in {organization.name} already has access. Invite new people from Organization
          settings.
        </p>
      ) : (
        <FieldStack>
          <Field label="People" group error={error}>
            <div className="flex min-w-0 flex-col gap-3">
              {available.map((id) => {
                const person = personById(id);
                const note = candidateNote(id);
                return (
                  <CheckboxField
                    key={id}
                    label={person.name}
                    description={note.description}
                    disabled={note.disabled}
                    checked={selected.includes(id)}
                    onCheckedChange={(checked) => {
                      setError(undefined);
                      setSelected((current) =>
                        checked ? [...current, id] : current.filter((each) => each !== id),
                      );
                    }}
                  />
                );
              })}
            </div>
          </Field>
          <RoleField value={role} onChange={setRole} />
        </FieldStack>
      ),
    submitDisabled: available.length === 0,
  };
  return { frame, reset };
}

function AddPeopleDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const form = useAddPeopleForm(() => onOpenChange(false));
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (next) form.reset();
        onOpenChange(next);
      }}
      size="md"
      {...form.frame}
    />
  );
}

function AddPeopleInPage({ layout, onClose }: { layout: "page" | "inline"; onClose: () => void }) {
  const form = useAddPeopleForm(onClose);
  if (layout === "page") {
    return (
      <FormPage
        {...form.frame}
        back={{ label: "Access", onClick: onClose }}
        className={FORM_PAGE_IN_SETTINGS}
      />
    );
  }
  return <FormInline {...form.frame} className="mb-6" />;
}

/* ----------------------------------------------------------------------------
   Requests from Slack.
   -------------------------------------------------------------------------- */

function ReviewRequestDialog({
  request,
  onOpenChange,
}: {
  request: AccessRequest | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { setRequests, setMembers, viewer, workspaceName } = useSettingsPreview();
  const [role, setRole] = useState<RoleValue<WorkspaceRole>>("member");
  const roleLabelId = useId();
  const person = request ? personById(request.personId) : null;

  const decline = () => {
    if (!request || !person) return;
    setRequests((current) => current.filter((each) => each.id !== request.id));
    onOpenChange(false);
    showUndoToast({
      title: `Declined ${person.name}'s request`,
      description: "They get a message in Slack.",
      onUndo: () => setRequests((current) => [request, ...current]),
    });
  };

  return (
    <FormDialog
      open={request !== null}
      onOpenChange={(next) => {
        if (next) setRole("member");
        onOpenChange(next);
      }}
      size="sm"
      title={person ? `Give ${person.name} access?` : "Access request"}
      description={
        person
          ? `${person.email} · Asked in #design-reviews ${request?.requestedLabel}`
          : undefined
      }
      submitLabel="Give access"
      pendingLabel="Adding…"
      footerStart={
        <Button
          type="button"
          variant="ghost"
          onClick={decline}
          className="-ml-3 pointer-coarse:h-11"
        >
          Decline
        </Button>
      }
      onSubmit={async () => {
        if (!request || !person || !role || role === "custom") return false;
        await wait(700);
        const member = {
          ...accessMemberFor(person, role, viewer),
          grants: { [currentWorkspace.id]: role },
        };
        setMembers((current) => [...current, member]);
        setRequests((current) => current.filter((each) => each.id !== request.id));
        showUndoToast({
          title: `${person.name} can now use ${workspaceName}`,
          description: `As ${asRole(role)}. We let them know in Slack.`,
          onUndo: () => {
            setMembers((current) => current.filter((each) => each.id !== person.id));
            setRequests((current) => [request, ...current]);
          },
        });
        return true;
      }}
    >
      {request ? (
        <div className="min-w-0">
          <p id={roleLabelId} className="mb-2 text-sm font-medium text-fg">
            Role
          </p>
          <RoleSelect
            variant="list"
            aria-labelledby={roleLabelId}
            roles={WORKSPACE_ROLE_OPTIONS}
            value={role}
            subjectName={person?.name}
            onValueChange={(next) => setRole(next)}
          />
        </div>
      ) : null}
    </FormDialog>
  );
}

function RequestsSection({ requests }: { requests: AccessRequest[] }) {
  const [reviewing, setReviewing] = useState<AccessRequest | null>(null);
  return (
    <Section title="Requests">
      <RowList label="Access requests" variant="resource">
        {requests.map((request) => {
          const person = personById(request.personId);
          return (
            <ListRow
              key={request.id}
              leading={
                <Avatar aria-hidden="true">
                  <AvatarFallback className="bg-surface-2 text-xs font-semibold text-fg-muted">
                    {person.initials}
                  </AvatarFallback>
                </Avatar>
              }
              title={person.name}
              description={
                <>
                  Asked in {request.source} ·{" "}
                  <RelativeTime date="2026-09-26T09:48:00Z" now={KIT_NOW} />
                </>
              }
              control={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setReviewing(request)}
                >
                  Review
                </Button>
              }
            />
          );
        })}
      </RowList>
      <ReviewRequestDialog
        request={reviewing}
        onOpenChange={(open) => (open ? null : setReviewing(null))}
      />
    </Section>
  );
}

/* ----------------------------------------------------------------------------
   Person sheet, for the quieter "role as text" rows (access list B).
   -------------------------------------------------------------------------- */

function PersonSheet({
  member,
  onClose,
  actions,
}: {
  member: AccessMember<WorkspaceRole> | null;
  onClose: () => void;
  actions: ReturnType<typeof useAccessActions>;
}) {
  const { workspaceName, canManage } = useSettingsPreview();
  const headingId = useId();
  const person = member ? personById(member.id) : null;
  return (
    <DetailSheet open={member !== null} onOpenChange={(open) => (open ? null : onClose())}>
      {member && person ? (
        <DetailSheetContent>
          <DetailHeader
            leading={
              <Avatar size="lg" aria-hidden="true">
                <AvatarFallback className="bg-surface-2 text-sm font-semibold text-fg-muted">
                  {member.initials}
                </AvatarFallback>
              </Avatar>
            }
            title={member.name}
            subtitle={[
              member.kind === "service" ? "Service account" : member.email,
              person.joinedLabel,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
          <DetailBody>
            <DetailSection
              title={<span id={headingId}>Role in {workspaceName}</span>}
              description={canManage ? "Saves as soon as you pick one." : undefined}
            >
              <RoleSelect
                variant={canManage ? "list" : "text"}
                aria-labelledby={headingId}
                roles={WORKSPACE_ROLE_OPTIONS}
                value={member.role}
                subjectName={member.name}
                disabledReason={
                  member.isYou ? "You can't change your own role. Ask another admin." : undefined
                }
                onValueChange={(role) => actions.onRoleChange(member, role)}
              />
            </DetailSection>
          </DetailBody>
          <DetailFooter
            start={
              canManage && !member.isYou && !member.isOwner ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="-ml-3 text-danger hover:bg-danger/10 hover:text-danger pointer-coarse:h-11"
                  onClick={() => {
                    actions.onRemove(member);
                    onClose();
                  }}
                >
                  Remove from workspace
                </Button>
              ) : null
            }
          >
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="pointer-coarse:h-11"
            >
              Done
            </Button>
          </DetailFooter>
        </DetailSheetContent>
      ) : null}
    </DetailSheet>
  );
}

/* ----------------------------------------------------------------------------
   The page.
   -------------------------------------------------------------------------- */

function PeopleSection({ onAdd }: { onAdd: () => void }) {
  const { members, data, canManage, workspaceName, setData } = useSettingsPreview();
  const picks = useSettingsPicks();
  const actions = useAccessActions();
  const [openId, setOpenId] = useState<string | null>(null);
  const shown = data.access === "only-you" ? members.filter((member) => member.isYou) : members;
  const open = shown.find((member) => member.id === openId) ?? null;
  const readOnlyReason = canManage
    ? undefined
    : "Only workspace admins can change access. You're a member here.";
  const variant = picks.access;

  return (
    <Section title="People">
      <AccessList
        variant={variant}
        label={`People with access to ${workspaceName}`}
        roles={WORKSPACE_ROLE_OPTIONS}
        members={shown}
        scopes={[{ id: currentWorkspace.id, label: workspaceName }]}
        loading={data.access === "loading"}
        loadingRows={3}
        error={
          data.access === "error"
            ? {
                message: `Couldn't load who has access to ${workspaceName}.`,
                detail: "Check your connection and try again.",
                onRetry: () => setData("access", "filled"),
              }
            : undefined
        }
        readOnlyReason={readOnlyReason}
        savingIds={actions.savingIds}
        onRoleChange={actions.onRoleChange}
        onRemove={actions.onRemove}
        onResendInvite={actions.onResendInvite}
        onRevokeInvite={actions.onRevokeInvite}
        onOpen={variant === "text" ? (member) => setOpenId(member.id) : undefined}
        emptyMessage={
          canManage ? (
            <>
              Only you have access.{" "}
              <HelpLink onClick={onAdd}>Add people from {organization.name}</HelpLink> to share this
              workspace.
            </>
          ) : (
            "Only you have access."
          )
        }
      />
      {variant === "text" ? (
        <PersonSheet member={open} onClose={() => setOpenId(null)} actions={actions} />
      ) : null}
    </Section>
  );
}

export function AccessPage() {
  const base = useFrameBase();
  const { requests, canManage, data } = useSettingsPreview();
  const picks = useSettingsPicks();
  const [adding, setAdding] = useState(false);
  const layout = picks.form;
  const showRequests = canManage && requests.length > 0 && data.access === "filled";

  const addButton = canManage && !(adding && layout === "inline") ? (
    <Button type="button" onClick={() => setAdding(true)}>
      <UserPlusIcon aria-hidden="true" />
      Add people
    </Button>
  ) : null;

  let takeover: ReactNode;
  if (adding && layout === "page") {
    takeover = <AddPeopleInPage layout="page" onClose={() => setAdding(false)} />;
  }

  return (
    <SettingsFrame {...base} actions={addButton} takeover={takeover}>
      <div className="flex min-w-0 flex-col gap-6">
        {adding && layout === "inline" ? (
          <AddPeopleInPage layout="inline" onClose={() => setAdding(false)} />
        ) : null}
        <SectionStack variant={picks.section}>
          {showRequests ? <RequestsSection requests={requests} /> : null}
          <PeopleSection onAdd={() => setAdding(true)} />
        </SectionStack>
      </div>
      {layout === "dialog" ? <AddPeopleDialog open={adding} onOpenChange={setAdding} /> : null}
    </SettingsFrame>
  );
}
