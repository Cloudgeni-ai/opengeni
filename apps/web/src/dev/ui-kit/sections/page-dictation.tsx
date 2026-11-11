import { useMemo } from "react";
import type {
  DesktopDictation,
  DesktopDictationHistoryEntry,
  DesktopDictationModel,
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

/**
 * The desktop app's side of dictation, on fixtures: settings change in
 * memory. `workspace` is the one saved for dictation; `norwegian` the
 * Norwegian shortcut's own model.
 */
function fakeDictation(
  workspace: Settings["workspace"] = null,
  norwegian: DesktopDictationModel | null = null,
): DesktopDictation {
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
        model: norwegian,
      },
    ],
    output: "paste",
    mode: "toggle",
    vocabulary: ["Kubernetes", "Ada Lovelace", "Opengeni"],
    retryShortcut: { kind: "accelerator", accelerator: "Control+Option+R" },
    cancelShortcut: null,
    workspace,
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

/**
 * The person's workspaces, as the app lists them: a Personal one in each of
 * their two organizations, and three shared ones, one with voice input off.
 */
const WORKSPACES = {
  choices: [
    { id: "ws-acme-ada", name: "Ada Lovelace", organization: "Acme Inc.", personal: true },
    { id: "ws-acme", name: "Acme", organization: "Acme Inc." },
    { id: "ws-acme-support", name: "Customer support", organization: "Acme Inc." },
    {
      id: "ws-acme-legal",
      name: "Legal",
      organization: "Acme Inc.",
      voiceInputOff: true,
    },
    { id: "ws-babbage-ada", name: "Ada Lovelace", organization: "Babbage & Co.", personal: true },
    { id: "ws-analytical", name: "Analytical Engine", organization: "Babbage & Co." },
  ],
  defaultWorkspaceId: "ws-acme-ada",
};

/** The voice input models the dictation workspace offers each shortcut. */
const MODELS = [
  {
    providerId: "azure-speech",
    model: "MAI-Transcribe-2",
    providerName: "Azure Speech",
    name: "MAI-Transcribe-2",
  },
  {
    providerId: "elevenlabs",
    model: "scribe_v2",
    providerName: "ElevenLabs",
    name: "Scribe v2",
  },
];

function Page({ dictation }: { dictation: DesktopDictation }) {
  return (
    <KitCanvas>
      <div className="mx-auto w-full max-w-[720px] p-6">
        <DesktopDictationSettings dictation={dictation} workspaces={WORKSPACES} models={MODELS} />
      </div>
    </KitCanvas>
  );
}

export default function PageDictationSection() {
  const dictation = useMemo(() => fakeDictation(), []);
  const gone = useMemo(() => fakeDictation({ id: "ws-left", name: "Difference Engine" }), []);
  const quiet = useMemo(() => fakeDictation({ id: "ws-acme-legal", name: "Legal" }), []);
  const notOffered = useMemo(
    () =>
      fakeDictation(
        { id: "ws-acme", name: "Acme" },
        { providerId: "openai", model: "gpt-4o-transcribe", name: "OpenAI · GPT-4o Transcribe" },
      ),
    [],
  );
  return (
    <KitSection sectionKey="page-dictation">
      <KitBlock
        title="Page"
        description="Settings → Computer use → Dictation in the desktop app, on fixtures: the workspace shortcut dictations go to, two shortcuts with their own language, the vocabulary, the retry and cancel shortcuts, and recent dictations with Play, Transcribe again and Copy."
      >
        <Page dictation={dictation} />
      </KitBlock>
      <KitBlock
        title="Workspace no longer available"
        description="The person left the saved workspace. It is named, and every press says so with Open settings instead of recording; nothing records into a workspace they didn't pick."
      >
        <Page dictation={gone} />
      </KitBlock>
      <KitBlock
        title="Voice input off in the workspace"
        description="The saved workspace turned voice input off, so presses fail until another is chosen."
      >
        <Page dictation={quiet} />
      </KitBlock>
      <KitBlock
        title="A shortcut's model the workspace doesn't offer"
        description="The Norwegian shortcut keeps a model this workspace doesn't offer: its row says so rather than another model hearing it."
      >
        <Page dictation={notOffered} />
      </KitBlock>
    </KitSection>
  );
}
