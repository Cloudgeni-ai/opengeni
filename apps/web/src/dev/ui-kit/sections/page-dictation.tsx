import { useMemo } from "react";
import type {
  DesktopDictation,
  DesktopDictationHistoryEntry,
  DesktopDictationSettings as Settings,
  DesktopDictationStatus,
} from "@opengeni/sdk/desktop-bridge";
import { DesktopDictationSettings } from "@opengeni/react/desktop-dictation";

import { KitBlock, KitCanvas, KitSection } from "../kit";

const MINUTE = 60_000;

/** Recent dictations, as the app keeps them: text, when, which shortcut, and the speech. */
function fakeHistory(): DesktopDictationHistoryEntry[] {
  const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE).toISOString();
  return [
    {
      id: "d1",
      text: "Can you move the Kubernetes upgrade to Thursday and let Ada know?",
      at: ago(2),
      profileName: "English",
      language: "en",
      audio: { mimeType: "audio/webm;codecs=opus", durationMilliseconds: 4_200 },
    },
    {
      id: "d2",
      text: "Husk å sende tallene til regnskap før fredag.",
      at: ago(41),
      profileName: "Norwegian",
      language: "nb",
      audio: { mimeType: "audio/webm;codecs=opus", durationMilliseconds: 3_100 },
    },
    {
      id: "d3",
      text: "Thanks, looks good to me.",
      at: ago(60 * 26),
      profileName: "English",
      language: "en",
      audio: null,
    },
  ];
}

/** The desktop app's side of dictation, on fixtures: settings change in memory. */
function fakeDictation(): DesktopDictation {
  let settings: Settings = {
    enabled: true,
    profiles: [
      {
        id: "default",
        name: "English",
        shortcut: { kind: "modifierChord", modifiers: ["control", "fn"] },
        language: "en",
      },
      {
        id: "nb",
        name: "Norwegian",
        shortcut: { kind: "accelerator", accelerator: "Control+Option+N" },
        language: "nb",
      },
    ],
    output: "paste",
    mode: "toggle",
    vocabulary: ["Kubernetes", "Ada Lovelace", "Opengeni"],
    retryShortcut: { kind: "accelerator", accelerator: "Control+Option+R" },
    cancelShortcut: null,
  };
  const listeners = new Set<() => void>();
  const status = (): DesktopDictationStatus => ({
    settings,
    supported: true,
    platform: "macos",
    modifierPairs: ["command", "option", "control", "shift"],
    modifierChords: true,
    permissions: [{ id: "accessibility", granted: true }],
    shortcutErrors: [],
    actionShortcutErrors: [],
    paste: { available: true, blocker: null },
    ready: true,
  });
  const history = fakeHistory();
  return {
    status: async () => status(),
    update: async (change) => {
      settings = { ...settings, ...change };
      for (const listener of listeners) listener();
      return status();
    },
    requestPermission: async () => undefined,
    history: async () => history,
    clearHistory: async () => {
      history.splice(0);
      for (const listener of listeners) listener();
    },
    historyAudio: async () => null,
    transcribeAgain: async () => undefined,
    onRequest: () => () => undefined,
    report: () => undefined,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export default function PageDictationSection() {
  const dictation = useMemo(() => fakeDictation(), []);
  return (
    <KitSection sectionKey="page-dictation">
      <KitBlock
        title="Page"
        description="Settings → Computer use → Dictation in the desktop app, on fixtures: two shortcuts with their own language, the vocabulary, the retry and cancel shortcuts, and recent dictations with Play, Transcribe again and Copy."
      >
        <KitCanvas>
          <div className="mx-auto w-full max-w-[720px] p-6">
            <DesktopDictationSettings dictation={dictation} />
          </div>
        </KitCanvas>
      </KitBlock>
    </KitSection>
  );
}
