import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { OpenGeniApiError } from "@opengeni/sdk";
import { toast } from "sonner";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import type { AppContextValue } from "../app-context";
import { sessionDisplayTitle, type SessionListRow } from "../../session-list-model";
import { useAppHost } from "./app-host";
import { useRouterState } from "./navigation";

type Confirmation = {
  title: string;
  description: string;
  confirmLabel: string;
  /**
   * The page the archive was asked on. An answer that arrives after the
   * person has moved to another page asks with `late` instead of a dialog.
   */
  page?: number | undefined;
  late?: { title: string; description: string } | undefined;
};

export type ArchiveConfirmation = {
  /** The page shown now; it changes each time the person moves to another one. */
  page(): number;
  confirm(input: Confirmation): Promise<boolean>;
};

const ArchiveConfirmationContext = createContext<ArchiveConfirmation>({
  page: () => 0,
  confirm: async () => false,
});

/** Counts the pages the person visits, where the app has navigation. */
function PageWatcher({ onPage }: { onPage: (pathname: string) => void }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useEffect(() => onPage(pathname), [onPage, pathname]);
  return null;
}

/** One dialog for mouse, keyboard, header and command-menu archive actions. */
export function ArchiveConfirmationProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Confirmation | null>(null);
  const resolve = useRef<((confirmed: boolean) => void) | null>(null);
  const navigable = Boolean(useAppHost().navigation);
  const pathname = useRef<string | null>(null);
  const page = useRef(0);
  const finish = useCallback((confirmed: boolean) => {
    resolve.current?.(confirmed);
    resolve.current = null;
    setPending(null);
  }, []);
  const onPage = useCallback(
    (next: string) => {
      if (pathname.current === next) return;
      const moved = pathname.current !== null;
      pathname.current = next;
      if (!moved) return;
      page.current += 1;
      // A question about a chat belongs to the page it was asked on.
      if (resolve.current) finish(false);
    },
    [finish],
  );
  useEffect(
    () => () => {
      resolve.current?.(false);
    },
    [],
  );
  const confirm = useCallback((input: Confirmation): Promise<boolean> => {
    if (input.page !== undefined && input.page !== page.current) {
      // The person has moved on: a dialog here would be about a chat they
      // asked for on another page, so ask in a notice they can leave.
      return new Promise((done) => {
        let settled = false;
        const settle = (confirmed: boolean) => {
          if (settled) return;
          settled = true;
          done(confirmed);
        };
        const late = input.late ?? input;
        toast(late.title, {
          description: late.description,
          duration: 10_000,
          action: { label: input.confirmLabel, onClick: () => settle(true) },
          onDismiss: () => settle(false),
          onAutoClose: () => settle(false),
        });
      });
    }
    resolve.current?.(false);
    setPending(input);
    return new Promise((done) => {
      resolve.current = done;
    });
  }, []);
  const value = useMemo<ArchiveConfirmation>(
    () => ({ page: () => page.current, confirm }),
    [confirm],
  );
  return (
    <ArchiveConfirmationContext.Provider value={value}>
      {navigable ? <PageWatcher onPage={onPage} /> : null}
      {children}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
        title={pending?.title}
        description={pending?.description}
        confirmLabel={pending?.confirmLabel ?? "Pause and archive"}
        destructive={false}
        cancelAutoFocus
        onConfirm={() => finish(true)}
      />
    </ArchiveConfirmationContext.Provider>
  );
}

export const useArchiveConfirmation = () => useContext(ArchiveConfirmationContext);

export function canPauseArchivedChat(
  context: Pick<AppContextValue, "accessContext">,
  workspaceId: string,
): boolean {
  const grant = context.accessContext.workspaceGrants.find(
    (candidate) => candidate.workspaceId === workspaceId,
  );
  return (
    !!grant &&
    (grant.permissions.includes("sessions:control") ||
      (grant.permissionMode !== "explicit" && grant.permissions.includes("workspace:admin")))
  );
}

export function archiveActionLabel(
  context: Pick<AppContextValue, "accessContext">,
  chat: Pick<SessionListRow, "archived" | "workspaceId">,
): string {
  return chat.archived
    ? "Restore"
    : canPauseArchivedChat(context, chat.workspaceId)
      ? "Archive"
      : "Hide for me";
}

export async function requestSessionArchive(
  context: AppContextValue,
  chat: SessionListRow,
  archived: boolean,
  confirmation: ArchiveConfirmation,
) {
  const accepted = context.captureWorkspaceInvocation(chat.workspaceId);
  if (!accepted) return null;
  // Where the archive was asked: a late answer must not open a dialog elsewhere.
  const page = confirmation.page();
  const pause = canPauseArchivedChat(context, chat.workspaceId);
  if (
    archived &&
    !pause &&
    !(await confirmation.confirm({
      title: "Hide this chat for you?",
      description:
        "You cannot pause this chat. Hiding it only removes it from your sidebar; its work and automations can keep running.",
      confirmLabel: "Hide for me",
    }))
  )
    return null;
  const clientEventId = crypto.randomUUID();
  const request = (confirmPause = false) => {
    if (!context.ownsWorkspaceInvocation(chat.workspaceId, accepted)) return Promise.resolve(null);
    return context.client.updateSessionArchive(chat.workspaceId, chat.id, {
      archived,
      clientEventId,
      expectedVersion: chat.archiveVersion ?? 0,
      mode: pause ? "pause_and_archive" : "hide_for_me",
      confirmPause,
    });
  };
  try {
    return await request();
  } catch (error) {
    if (
      !(error instanceof OpenGeniApiError) ||
      (error.details?.code ?? error.code) !== "session_archive_confirmation_required"
    )
      throw error;
    if (!context.ownsWorkspaceInvocation(chat.workspaceId, accepted)) return null;
    const name = quotedChatName(chat);
    if (
      !(await confirmation.confirm({
        title: `Pause and archive ${name}?`,
        description:
          "This chat has active work. Pause stops it and its sub-chats for everyone with access, removes their one-time waits, and blocks automations from starting work in them. Only your sidebar hides the chat. Restoring it will not resume it.",
        confirmLabel: "Pause and archive",
        page,
        late: {
          title: `${name} wasn't archived`,
          description: "It has active work.",
        },
      }))
    )
      return null;
    return await request(true);
  }
}

const CHAT_NAME_MAX = 60;

/** The chat's sidebar title in quotes, shortened to fit a dialog title. */
export function quotedChatName(chat: SessionListRow): string {
  const title = sessionDisplayTitle(chat).trim();
  if (!title) return "this chat";
  const short =
    title.length > CHAT_NAME_MAX ? `${title.slice(0, CHAT_NAME_MAX - 1).trimEnd()}…` : title;
  return `“${short}”`;
}
