/**
 * The shortcut sheet (⌘/): every action that has a key, grouped, in the
 * person's own notation. It reads the action registry, so it never drifts from
 * what the keys actually do.
 */
import { Fragment } from "react";
import { useAppActions } from "../../lib/actions/actions-provider";
import { applicableChords, chordLabel, type Chord } from "../../lib/actions/chords";
import {
  APP_ACTIONS,
  findAction,
  type ActionGroup,
  type AppAction,
} from "../../lib/actions/registry";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../../ui/dialog";
import { Keycaps } from "./keycaps";

const GROUPS: ReadonlyArray<{ group: ActionGroup; label: string }> = [
  { group: "chat", label: "Chats" },
  { group: "navigate", label: "Move around" },
  { group: "view", label: "View" },
  { group: "help", label: "Help" },
];

/** Titles that read better on the sheet than in menus, where the chat is implied. */
const SHEET_TITLES: Record<string, string> = {
  "chat.copyLink": "Copy chat link",
  "chat.pin": "Pin or unpin chat",
  "go.inbox": "Go to inbox",
  "go.previousChat": "Previous chat",
  "go.nextChat": "Next chat",
  "go.pinnedChat": "Open pinned chat 1 to 9",
  "commandMenu.open": "Search chats and actions",
};

type SheetRow = {
  action: AppAction;
  title: string;
  chords: Chord[];
  summary?: string | undefined;
  /** Only the desktop app has this key. */
  desktopOnly: boolean;
};

export default function ShortcutSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const actions = useAppActions();
  if (!actions) return null;
  const { platform, surface } = actions.env;
  const menuAction = findAction("commandMenu.open");
  const menuChord = menuAction ? actions.chordsFor(menuAction)[0] : undefined;
  const rows: SheetRow[] = APP_ACTIONS.flatMap((action) => {
    const here = applicableChords(action.chords, surface, platform);
    const desktop = surface === "web" ? applicableChords(action.chords, "desktop", platform) : [];
    if (here.length === 0 && desktop.length === 0) return [];
    const title =
      SHEET_TITLES[action.id] ??
      (typeof action.title === "string" ? action.title : action.title(actions.env, null));
    const summary = action.chordSummary?.(platform);
    return [
      {
        action,
        title,
        chords: here.length > 0 ? here : desktop,
        summary,
        desktopOnly: here.length === 0,
      },
    ];
  });

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        data-og-shortcut-sheet=""
        className="gap-0 p-0 sm:max-w-[560px] sm:p-0"
        aria-describedby="shortcut-sheet-description"
      >
        <div className="px-6 pt-6 pb-2 max-sm:px-5 max-sm:pt-5">
          <DialogTitle className="text-base">Keyboard shortcuts</DialogTitle>
          <DialogDescription id="shortcut-sheet-description" className="mt-1 text-sm text-fg-muted">
            Everything here, and more, is also in the command menu
            {menuChord ? (
              <>
                {" "}
                <Keycaps chord={menuChord} platform={platform} className="align-[-4px]" />
              </>
            ) : null}
            .
          </DialogDescription>
        </div>
        <div className="grid gap-x-8 px-6 pb-6 max-sm:px-5 sm:grid-cols-2">
          {GROUPS.map(({ group, label }) => {
            const groupRows = rows.filter((row) => row.action.group === group);
            if (groupRows.length === 0) return null;
            return (
              <section key={group} aria-label={label} className="min-w-0 pt-4">
                <h3 className="pb-1 text-xs leading-4.5 font-medium text-fg-muted">{label}</h3>
                <dl>
                  {groupRows.map((row) => (
                    <div
                      key={row.action.id}
                      className="flex min-h-8 items-center gap-3 border-b border-border/60 py-1 last:border-b-0"
                    >
                      <dt className="min-w-0 flex-1 text-sm text-fg-label">
                        {row.title}
                        {row.desktopOnly ? (
                          <span className="ml-1.5 text-xs text-fg-muted">Desktop app</span>
                        ) : null}
                      </dt>
                      <dd className="flex shrink-0 items-center gap-1.5 text-xs text-fg-muted">
                        {row.summary ? (
                          <span className="inline-flex items-center gap-1">
                            <Keycaps chord={row.chords[0]!} platform={platform} />
                            <span aria-hidden="true">–</span>
                            <Keycaps
                              chord={row.chords[row.chords.length - 1]!}
                              platform={platform}
                            />
                          </span>
                        ) : (
                          row.chords.map((chord, index) => (
                            <Fragment key={chordLabel(chord, platform)}>
                              {index > 0 ? <span>or</span> : null}
                              <Keycaps chord={chord} platform={platform} />
                            </Fragment>
                          ))
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
