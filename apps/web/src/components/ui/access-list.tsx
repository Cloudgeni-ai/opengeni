/* ----------------------------------------------------------------------------
   AccessList - the one membership editor, used everywhere access is edited:
   Workspace Access, the person sheet, the workspace sheet and the invite
   dialog. Same rows, verbs and role definitions in all four places.

   Roles come from the server's role catalog (see RoleSelect). You and owners
   are always listed. Service accounts sit in their own subgroup.

   Variants:
   - "inline" (default): avatar, name and email, a role select that saves
     immediately, and a menu with Remove.
   - "text": quieter rows with the role as text; the whole row opens the
     person sheet, where the role is changed.
   - "matrix": people by workspaces, one role per cell. Only for a few
     workspaces.
   -------------------------------------------------------------------------- */

import { useId, type ReactNode } from "react";
import {
  BotIcon,
  ChevronRightIcon,
  MailIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  UserMinusIcon,
  XIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MetaChip } from "@/components/ui/meta-chip";
import { ErrorMessage } from "@/components/ui/error-message";
import { InlineDisabledReason } from "@/components/ui/select-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  RoleSelect,
  roleLabel,
  type RoleOption,
  type RoleValue,
} from "@/components/ui/role-select";

export type AccessMemberStatus = "active" | "invited" | "invite_failed" | "suspended";

export interface AccessMember<R extends string = string> {
  id: string;
  name: string;
  /** Service accounts have none. */
  email?: string | null;
  initials: string;
  kind?: "person" | "service";
  isYou?: boolean;
  /** Owners are always listed and can't be removed here. */
  isOwner?: boolean;
  /** A small tag after the name, for example "Only owner". */
  tag?: string;
  status?: AccessMemberStatus;
  /** "Invited · expires in 5 days". Shown only when not active. */
  statusLabel?: string;
  /** The role in this list's scope. */
  role: RoleValue<R>;
  /** For a legacy custom grant: the role "Reset to role" goes back to. */
  resetRole?: R;
  /** Why this person's role can't be changed here. */
  roleLockedReason?: string;
  /** Why this person can't be removed here. Owners and You never can. */
  removeLockedReason?: string;
  /** Matrix variant: the role per scope id (null is no access). */
  grants?: Record<string, RoleValue<R>>;
}

export interface AccessScope {
  id: string;
  /** "Platform engineering". */
  label: string;
}

export type AccessListVariant = "inline" | "text" | "matrix";

export interface AccessListProps<R extends string = string> {
  members: readonly AccessMember<R>[];
  /** From the server's role catalog, least to most access. */
  roles: readonly RoleOption<R>[];
  variant?: AccessListVariant;
  /** Accessible name for the list: "People with access to Platform engineering". */
  label: string;
  /** Matrix columns. */
  scopes?: readonly AccessScope[];
  /** Saves a role. Return a promise to show the saving state. */
  onRoleChange?: (
    member: AccessMember<R>,
    role: R | null,
    scopeId?: string,
  ) => void | Promise<unknown>;
  onRemove?: (member: AccessMember<R>) => void;
  /**
   * Opens the hand-picked permission editor ("Custom permissions…" in the ⋯
   * menu). Optional: most places only offer roles.
   */
  onCustomize?: (member: AccessMember<R>) => void;
  /** Replaces a legacy custom grant with `member.resetRole`. */
  onResetToRole?: (member: AccessMember<R>) => void | Promise<unknown>;
  /** Text variant: opens the person sheet. */
  onOpen?: (member: AccessMember<R>) => void;
  onResendInvite?: (member: AccessMember<R>) => void;
  onRevokeInvite?: (member: AccessMember<R>) => void;
  /** When set, nothing can be changed and this line says why. */
  readOnlyReason?: string;
  loading?: boolean;
  /** Skeleton rows while loading. Default 4. */
  loadingRows?: number;
  /** What happened, what to do next, and an optional retry. Replaces the list. */
  error?: { message: string; detail?: ReactNode; onRetry?: () => void };
  /** Members whose role is being saved elsewhere, shown with a spinner. */
  savingIds?: readonly string[];
  /** Shown when only you have access. */
  emptyMessage?: ReactNode;
  /** "Remove from workspace" or "Remove from organization". */
  removeLabel?: string;
  /** What the list sits on, so the matrix's sticky column matches. Default "bg". */
  canvas?: "bg" | "surface";
  /** Adds "No access" to role choices (matrix, person sheet). */
  noAccessLabel?: string;
  className?: string;
}

/** Service accounts go in their own subgroup, after the people. */
export function groupAccessMembers<R extends string>(
  members: readonly AccessMember<R>[],
): { people: AccessMember<R>[]; services: AccessMember<R>[] } {
  const people = members.filter((member) => member.kind !== "service");
  const services = members.filter((member) => member.kind === "service");
  // You first, then owners, then everyone else in the order the server sent.
  const rank = (member: AccessMember<R>) => (member.isYou ? 0 : member.isOwner ? 1 : 2);
  return {
    people: people
      .map((member, index) => ({ member, index }))
      .sort((a, b) => rank(a.member) - rank(b.member) || a.index - b.index)
      .map(({ member }) => member),
    services,
  };
}

/** Why a member can't be removed, or null when they can. */
export function removeBlockedReason(member: AccessMember): string | null {
  if (member.removeLockedReason) return member.removeLockedReason;
  if (member.isYou) return "You can't remove yourself here.";
  if (member.isOwner) return "Owners always have access.";
  return null;
}

function isInvite(member: AccessMember): boolean {
  return member.status === "invited" || member.status === "invite_failed";
}

/* ---------------------------------------------------------------- pieces */

function MemberAvatar({ member }: { member: AccessMember }) {
  if (member.kind === "service") {
    return (
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-border bg-surface-2 text-fg-muted"
      >
        <BotIcon className="size-4" />
      </span>
    );
  }
  // Someone who hasn't joined yet: a dashed outline, the same initials.
  const pending = isInvite(member);
  return (
    <Avatar aria-hidden="true">
      <AvatarFallback
        className={cn(
          "text-xs font-semibold",
          pending
            ? "border border-dashed border-border-strong bg-transparent text-fg-subtle"
            : "bg-surface-2 text-fg-muted",
        )}
      >
        {member.initials}
      </AvatarFallback>
    </Avatar>
  );
}

function MemberIdentity({
  member,
  roles,
  onResetToRole,
  readOnly,
}: {
  member: AccessMember<string>;
  roles: readonly RoleOption<string>[];
  onResetToRole?: (member: AccessMember<string>) => void | Promise<unknown>;
  readOnly: boolean;
}) {
  const showStatus = member.status && member.status !== "active" && member.statusLabel;
  const secondary = member.kind === "service" ? "Service account" : member.email;
  const resetTo =
    member.role === "custom" && member.resetRole ? roleLabel(roles, member.resetRole) : null;
  return (
    <div className="min-w-0">
      {/* One line: the name truncates before the chip wraps. */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-sm leading-5 font-medium text-fg">
          {member.name}
        </span>
        {member.isYou ? <MetaChip variant="outline">You</MetaChip> : null}
      </div>
      {secondary || member.tag ? (
        // Like a ListRow meta line: the separator trails its item, so a
        // wrapped tag ("Only owner") starts its own line cleanly.
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs leading-4.5 text-fg-muted">
          {secondary ? (
            <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate">{secondary}</span>
              {member.tag ? (
                <span aria-hidden="true" className="text-fg-subtle">
                  ·
                </span>
              ) : null}
            </span>
          ) : null}
          {member.tag ? <span className="whitespace-nowrap">{member.tag}</span> : null}
        </div>
      ) : null}
      {showStatus ? (
        <div className="mt-0.5 flex min-w-0">
          <StatusBadge variant="dot" status={member.status} className="min-w-0">
            {member.statusLabel}
          </StatusBadge>
        </div>
      ) : null}
      {member.role === "custom" ? (
        // The reset link carries its own icon, so it needs no separator (and no
        // dot is left dangling when it wraps under the text on narrow rows).
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs leading-4.5 text-fg-muted">
          <span className="whitespace-nowrap">Hand-picked permissions</span>
          {resetTo && onResetToRole && !readOnly ? (
            <button
              type="button"
              onClick={() => void onResetToRole(member)}
              className="inline-flex items-center gap-1 rounded-[6px] font-medium whitespace-nowrap text-brand hover:underline pointer-coarse:min-h-11"
            >
              <RotateCcwIcon aria-hidden="true" className="size-3" />
              Reset to {resetTo}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RowMenu({
  member,
  removeLabel,
  onRemove,
  onCustomize,
  onResetToRole,
  onResendInvite,
  onRevokeInvite,
  roles,
}: {
  member: AccessMember<string>;
  removeLabel: string;
  onRemove?: (member: AccessMember<string>) => void;
  onCustomize?: (member: AccessMember<string>) => void;
  onResetToRole?: (member: AccessMember<string>) => void | Promise<unknown>;
  onResendInvite?: (member: AccessMember<string>) => void;
  onRevokeInvite?: (member: AccessMember<string>) => void;
  roles: readonly RoleOption<string>[];
}) {
  const invite = isInvite(member);
  const blocked = removeBlockedReason(member);
  const canReset = member.role === "custom" && member.resetRole && onResetToRole;
  // Custom permissions follow the same rule as the role: never your own.
  const canCustomize = Boolean(onCustomize) && !member.isYou && !member.isOwner;
  const hasItems = invite
    ? Boolean(onResendInvite || onRevokeInvite)
    : Boolean((onRemove && !blocked) || canReset || canCustomize);
  if (!hasItems) return <span aria-hidden="true" className="size-8" />;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`More actions for ${member.name}`}
          className="grid size-8 shrink-0 place-items-center rounded-[10px] text-fg-subtle transition-colors duration-[120ms] outline-none hover:bg-surface-3 hover:text-fg focus-visible:ring-2 focus-visible:ring-brand/55 data-[state=open]:bg-surface-3 data-[state=open]:text-fg pointer-coarse:size-11"
        >
          <MoreHorizontalIcon aria-hidden="true" className="size-4" />
        </button>
      </DropdownMenuTrigger>
      {/* Same menu as a ListRow's ⋯: default content, icon + verb per item. */}
      <DropdownMenuContent align="end" className="min-w-44">
        {invite ? (
          <>
            {onResendInvite ? (
              <DropdownMenuItem onSelect={() => onResendInvite(member)}>
                <MailIcon />
                Resend invitation
              </DropdownMenuItem>
            ) : null}
            {onRevokeInvite ? (
              <DropdownMenuItem variant="destructive" onSelect={() => onRevokeInvite(member)}>
                <XIcon />
                Revoke invitation
              </DropdownMenuItem>
            ) : null}
          </>
        ) : (
          <>
            {canReset ? (
              <DropdownMenuItem onSelect={() => void onResetToRole!(member)}>
                <RotateCcwIcon />
                Reset to {roleLabel(roles, member.resetRole!)}
              </DropdownMenuItem>
            ) : null}
            {canCustomize ? (
              <DropdownMenuItem onSelect={() => onCustomize!(member)}>
                <SlidersHorizontalIcon />
                Custom permissions…
              </DropdownMenuItem>
            ) : null}
            {(canReset || canCustomize) && onRemove && !blocked ? <DropdownMenuSeparator /> : null}
            {onRemove && !blocked ? (
              <DropdownMenuItem variant="destructive" onSelect={() => onRemove(member)}>
                <UserMinusIcon />
                {removeLabel}
              </DropdownMenuItem>
            ) : null}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function roleLockReason(
  member: AccessMember,
  readOnlyReason: string | undefined,
): string | undefined {
  if (readOnlyReason) return undefined; // read-only lists show text, not locked controls
  if (member.roleLockedReason) return member.roleLockedReason;
  if (member.isYou) return "You can't change your own role. Ask another admin.";
  return undefined;
}

/* ---------------------------------------------------------------- states */

function LoadingRows({ rows, variant }: { rows: number; variant: AccessListVariant }) {
  return (
    <ul aria-hidden="true" className="flex flex-col divide-y divide-border">
      {Array.from({ length: rows }, (_, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- static placeholders
        <li key={index} className="flex min-h-14 items-center gap-3 px-3 py-3">
          <Skeleton className="size-8 shrink-0 rounded-full bg-surface-3" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-36 max-w-[60%] rounded-full bg-surface-3" />
            <Skeleton className="h-3 w-48 max-w-[80%] rounded-full bg-surface-3" />
          </div>
          {variant === "inline" ? (
            <Skeleton className="hidden h-8 w-[12.5rem] shrink-0 rounded-[10px] bg-surface-3 @md/access:block" />
          ) : (
            <Skeleton className="h-3.5 w-20 shrink-0 rounded-full bg-surface-3" />
          )}
        </li>
      ))}
    </ul>
  );
}

function ErrorState({ error }: { error: NonNullable<AccessListProps["error"]> }) {
  return (
    <ErrorMessage
      title={error.message}
      align="center"
      announce
      action={
        error.onRetry ? (
          <Button type="button" variant="outline" size="sm" onClick={error.onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    >
      {error.detail}
    </ErrorMessage>
  );
}

/* ---------------------------------------------------------------- variants */

interface RowProps {
  member: AccessMember<string>;
  props: AccessListProps<string>;
}

function InlineRow({ member, props }: RowProps) {
  const { roles, onRoleChange, readOnlyReason, noAccessLabel } = props;
  const readOnly = Boolean(readOnlyReason);
  const lockReason = roleLockReason(member, readOnlyReason);
  return (
    <li className="grid min-h-14 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-3 py-3 @md/access:grid-cols-[2rem_minmax(0,1fr)_12.5rem_2rem]">
      <div className="row-start-1 self-start @md/access:self-center">
        <MemberAvatar member={member} />
      </div>
      <div className="row-start-1 min-w-0">
        <MemberIdentity
          member={member}
          roles={roles}
          onResetToRole={props.onResetToRole}
          readOnly={readOnly}
        />
      </div>
      <div className="col-span-2 col-start-2 row-start-2 min-w-0 @md/access:col-span-1 @md/access:col-start-3 @md/access:row-start-1">
        {readOnly ? (
          <RoleSelect
            variant="text"
            roles={roles}
            value={member.role}
            noAccessLabel={noAccessLabel}
          />
        ) : (
          <RoleSelect
            roles={roles}
            value={member.role}
            subjectName={member.name}
            noAccessLabel={noAccessLabel}
            disabledReason={lockReason}
            pending={props.savingIds?.includes(member.id)}
            onValueChange={onRoleChange ? (role) => onRoleChange(member, role) : undefined}
            className="w-full max-w-[12.5rem] @md/access:max-w-none"
          />
        )}
      </div>
      <div className="col-start-3 row-start-1 flex justify-end @md/access:col-start-4">
        {readOnly ? null : (
          <RowMenu
            member={member}
            roles={roles}
            removeLabel={props.removeLabel ?? "Remove from workspace"}
            onRemove={props.onRemove}
            onCustomize={props.onCustomize}
            onResetToRole={props.onResetToRole}
            onResendInvite={props.onResendInvite}
            onRevokeInvite={props.onRevokeInvite}
          />
        )}
      </div>
    </li>
  );
}

function TextRow({ member, props }: RowProps) {
  const { roles, onOpen, noAccessLabel } = props;
  const content = (
    <>
      <MemberAvatar member={member} />
      <div className="min-w-0 flex-1">
        <MemberIdentity member={member} roles={roles} readOnly />
      </div>
      <span
        className={cn(
          "shrink-0 text-sm",
          member.role === null ? "text-fg-subtle" : "text-fg-muted",
        )}
      >
        {roleLabel(roles, member.role, { noAccessLabel })}
      </span>
      {onOpen ? (
        <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
      ) : null}
    </>
  );
  return (
    <li className="min-w-0">
      {onOpen ? (
        <button
          type="button"
          onClick={() => onOpen(member)}
          aria-label={`${member.name}, ${roleLabel(roles, member.role, { noAccessLabel })}`}
          className="flex min-h-14 w-full min-w-0 items-center gap-3 px-3 py-3 text-left transition-colors duration-[120ms] outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand/55"
        >
          {content}
        </button>
      ) : (
        <div className="flex min-h-14 min-w-0 items-center gap-3 px-3 py-3">{content}</div>
      )}
    </li>
  );
}

function ListVariant({ props }: { props: AccessListProps<string> }) {
  const { people, services } = groupAccessMembers(props.members);
  const servicesId = useId();
  const Row = props.variant === "text" ? TextRow : InlineRow;
  // Both list layouts use the resource row's hairlines (see ListRow).
  const listClass = "flex min-w-0 flex-col divide-y divide-border";
  const onlyYou = people.length <= 1 && services.length === 0;
  return (
    <>
      <ul aria-label={props.label} className={listClass}>
        {people.map((member) => (
          <Row key={member.id} member={member} props={props} />
        ))}
      </ul>
      {onlyYou && props.emptyMessage ? (
        <p className="border-t border-border px-3 pt-3 text-sm text-fg-muted">
          {props.emptyMessage}
        </p>
      ) : null}
      {services.length > 0 ? (
        <div className="border-t border-border pt-4">
          <h3 id={servicesId} className="px-3 text-xs leading-4.5 font-medium text-fg">
            Service accounts
          </h3>
          <ul aria-labelledby={servicesId} className={cn(listClass, "mt-1")}>
            {services.map((member) => (
              <Row key={member.id} member={member} props={props} />
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function MatrixVariant({ props }: { props: AccessListProps<string> }) {
  const { roles, scopes = [], onRoleChange, readOnlyReason, noAccessLabel = "No access" } = props;
  const { people, services } = groupAccessMembers(props.members);
  const readOnly = Boolean(readOnlyReason);
  const cellClass = "border-b border-border px-1.5 py-1.5 align-middle";
  // Sticky cells need an opaque fill that matches what the list sits on.
  const sticky = props.canvas === "surface" ? "bg-surface" : "bg-bg";
  const renderRow = (member: AccessMember<string>) => {
    const lockReason = roleLockReason(member, readOnlyReason);
    return (
      <tr key={member.id}>
        <th
          scope="row"
          className={cn(cellClass, sticky, "sticky left-0 z-10 pr-4 pl-0 text-left font-normal")}
        >
          <div className="flex min-w-0 items-center gap-3">
            <MemberAvatar member={member} />
            <MemberIdentity member={member} roles={roles} readOnly />
          </div>
        </th>
        {scopes.map((scope) => {
          const value = member.grants?.[scope.id] ?? null;
          return (
            <td key={scope.id} className={cellClass}>
              {readOnly ? (
                <span className="px-2">
                  <RoleSelect
                    variant="text"
                    roles={roles}
                    value={value}
                    noAccessLabel={noAccessLabel}
                  />
                </span>
              ) : (
                <RoleSelect
                  variant="cell"
                  roles={roles}
                  value={value}
                  noAccessLabel={noAccessLabel}
                  subjectName={member.name}
                  aria-label={`${member.name} in ${scope.label}`}
                  disabledReason={lockReason}
                  align="start"
                  onValueChange={
                    onRoleChange ? (role) => onRoleChange(member, role, scope.id) : undefined
                  }
                />
              )}
            </td>
          );
        })}
      </tr>
    );
  };
  return (
    <div
      role="region"
      aria-label={props.label}
      // A scrollable region must be reachable by keyboard.
      tabIndex={0}
      className="-mx-1 min-w-0 overflow-x-auto px-1 pb-1"
    >
      <table
        className="w-full table-fixed border-separate border-spacing-0 text-sm"
        style={{ minWidth: `${16 + scopes.length * 11}rem` }}
      >
        <colgroup>
          <col className="w-52 @md/access:w-64" />
          {scopes.map((scope) => (
            <col key={scope.id} className="w-44" />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th
              scope="col"
              className={cn(
                sticky,
                "sticky left-0 z-10 border-b border-border pr-4 pb-2 text-left text-xs leading-4.5 font-medium text-fg-subtle",
              )}
            >
              Person
            </th>
            {scopes.map((scope) => (
              <th
                key={scope.id}
                scope="col"
                className="truncate border-b border-border px-3.5 pb-2 text-left text-xs leading-4.5 font-medium text-fg-subtle"
              >
                {scope.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {people.map(renderRow)}
          {services.length > 0 ? (
            <tr>
              <th
                scope="colgroup"
                colSpan={scopes.length + 1}
                className={cn(
                  sticky,
                  "border-b border-border pt-4 pb-1.5 text-left text-xs leading-4.5 font-medium text-fg-subtle",
                )}
              >
                Service accounts
              </th>
            </tr>
          ) : null}
          {services.map(renderRow)}
        </tbody>
      </table>
    </div>
  );
}

/** Who has access, with one role each. */
export function AccessList<R extends string>(props: AccessListProps<R>) {
  const { variant = "inline", loading, loadingRows = 4, error, readOnlyReason, className } = props;
  // Rows are generic over the role id; internally they only pass ids through.
  const erased = { ...props, variant } as unknown as AccessListProps<string>;
  return (
    <div
      data-variant={variant}
      aria-busy={loading || undefined}
      className={cn("@container/access min-w-0", className)}
    >
      {readOnlyReason && !loading && !error ? (
        <p className="mb-1 flex min-w-0 px-3">
          <InlineDisabledReason>{readOnlyReason}</InlineDisabledReason>
        </p>
      ) : null}
      {loading ? (
        <>
          <span className="sr-only">Loading who has access</span>
          <LoadingRows rows={loadingRows} variant={variant} />
        </>
      ) : error ? (
        <ErrorState error={error} />
      ) : variant === "matrix" ? (
        <MatrixVariant props={erased} />
      ) : (
        <ListVariant props={erased} />
      )}
    </div>
  );
}
