// The desktop app's app-shot settings: turning the shortcut on, choosing it,
// and allowing what the system asks for. Shown only inside a desktop app that
// supports app-shots on this computer.
import type {
  DesktopAppShotModifier,
  DesktopAppShotPermissionId,
  DesktopAppShotShortcut,
  DesktopAppShotStatus,
  DesktopPlatform,
} from "@opengeni/sdk/desktop-bridge";
import { CheckIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@opengeni/react/ui/button";
import { Section } from "@opengeni/react/ui/section";
import { SelectMenu, type SelectOption } from "@opengeni/react/ui/select-menu";
import { SettingRow } from "@opengeni/react/ui/setting-row";
import { Switch } from "@opengeni/react/ui/switch";
import { desktopCapability } from "@opengeni/react/app/lib/desktop";

const MODIFIER_NAMES: Record<DesktopAppShotModifier, { mac: string; other: string }> = {
  command: { mac: "⌘ Command", other: "Windows" },
  option: { mac: "⌥ Option", other: "Alt" },
  control: { mac: "⌃ Control", other: "Ctrl" },
  shift: { mac: "⇧ Shift", other: "Shift" },
};

const MAC_KEYS: Record<string, string> = {
  Command: "⌘",
  Cmd: "⌘",
  CommandOrControl: "⌘",
  CmdOrCtrl: "⌘",
  Control: "⌃",
  Ctrl: "⌃",
  Option: "⌥",
  Alt: "⌥",
  Shift: "⇧",
};

/** "⌘⇧2" on macOS, "Ctrl+Shift+2" elsewhere. */
export function shortcutLabel(shortcut: DesktopAppShotShortcut, platform: DesktopPlatform): string {
  if (shortcut.kind === "modifierPair") {
    const name = MODIFIER_NAMES[shortcut.modifier];
    return `Both ${platform === "macos" ? name.mac : name.other} keys`;
  }
  const parts = shortcut.accelerator.split("+");
  if (platform === "macos") return parts.map((part) => MAC_KEYS[part] ?? part).join("");
  return parts
    .map((part) =>
      part === "CommandOrControl" || part === "CmdOrCtrl" || part === "Control" ? "Ctrl" : part,
    )
    .join("+");
}

/**
 * The key combination a keydown makes, in Electron's accelerator syntax, or
 * null while only modifiers are held or none is (a shortcut needs one).
 */
export function acceleratorFromKey(
  event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: DesktopPlatform,
): string | null {
  const key = acceleratorKey(event.code);
  if (!key) return null;
  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push(platform === "macos" ? "Command" : "Super");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  // Shift alone would take an ordinary character from every app.
  if (modifiers.length === 0 || (modifiers.length === 1 && event.shiftKey)) return null;
  return [...modifiers, key].join("+");
}

const NAMED_KEYS: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Backquote: "`",
};

function acceleratorKey(code: string): string | null {
  const letter = /^Key([A-Z])$/u.exec(code);
  if (letter) return letter[1]!;
  const digit = /^Digit([0-9])$/u.exec(code);
  if (digit) return digit[1]!;
  if (/^F([1-9]|1[0-9]|2[0-4])$/u.test(code)) return code;
  return NAMED_KEYS[code] ?? null;
}

const PERMISSION_ROWS: Record<
  DesktopAppShotPermissionId,
  { label: string; description: string; needed: boolean }
> = {
  screenRecording: {
    label: "Screen Recording",
    description: "Needed to take the window's screenshot.",
    needed: true,
  },
  accessibility: {
    label: "Accessibility",
    description:
      "Lets the app-shot include the window's text, including parts scrolled out of view. Without it, only the screenshot is attached.",
    needed: false,
  },
};

const CUSTOM = "custom";

/** Inside the desktop app, where app-shots work on this computer. */
export function AppShotsSettings({ className }: { className?: string }) {
  const bridge = desktopCapability("appShots");
  const appShots = bridge?.appShots ?? null;
  const platform = bridge?.platform ?? "macos";
  const [status, setStatus] = useState<DesktopAppShotStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!appShots) return;
    void appShots
      .status()
      .then(setStatus)
      .catch(() => undefined);
  }, [appShots]);

  useEffect(() => {
    if (!appShots) return;
    refresh();
    const off = appShots.onChange(refresh);
    // Permissions are granted in System Settings, outside the app.
    window.addEventListener("focus", refresh);
    return () => {
      off();
      window.removeEventListener("focus", refresh);
    };
  }, [appShots, refresh]);

  const update = useCallback(
    async (change: Parameters<NonNullable<typeof appShots>["update"]>[0]) => {
      if (!appShots) return;
      setSaving(true);
      setError(null);
      try {
        setStatus(await appShots.update(change));
      } catch {
        setError("Couldn't save the change. Try again.");
      } finally {
        setSaving(false);
      }
    },
    [appShots],
  );

  // Recording a key combination: the next one pressed becomes the shortcut.
  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        setRecording(false);
        return;
      }
      const accelerator = acceleratorFromKey(event, platform);
      if (!accelerator) return;
      setRecording(false);
      void update({ shortcut: { kind: "accelerator", accelerator } });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [platform, recording, update]);

  if (!appShots || !status?.supported) return null;
  const { settings } = status;
  const shortcut = settings.shortcut;
  const options: SelectOption[] = [
    ...status.modifierPairs.map((modifier) => ({
      value: modifier,
      label: shortcutLabel({ kind: "modifierPair", modifier }, platform),
    })),
    {
      value: CUSTOM,
      label:
        shortcut.kind === "accelerator" ? shortcutLabel(shortcut, platform) : "Key combination…",
      description: "Press the keys you want to use.",
    },
  ];
  const selected = shortcut.kind === "modifierPair" ? shortcut.modifier : CUSTOM;

  return (
    <Section
      variant="group"
      title="App-shots"
      description="Press a shortcut in any app to attach its window to your chat: a screenshot and the text it shows. Nothing is sent until you send it."
      className={className}
    >
      <SettingRow
        label="App-shot shortcut"
        description={
          settings.enabled
            ? `${shortcutLabel(shortcut, platform)} attaches the window in front to the chat you're in.`
            : "Off. Turn on to attach windows from other apps with a shortcut."
        }
        error={settings.enabled ? (status.shortcutError ?? error) : error}
        control={
          <Switch
            checked={settings.enabled}
            pending={saving}
            onCheckedChange={(enabled) => {
              void update({ enabled });
              if (enabled) {
                const screen = status.permissions.find((p) => p.id === "screenRecording");
                if (screen && !screen.granted) {
                  void appShots.requestPermission("screenRecording").catch(() => undefined);
                }
              }
            }}
          />
        }
      >
        {settings.enabled ? (
          <>
            <SettingRow
              label="Shortcut"
              description={
                recording
                  ? "Press the key combination now. Esc cancels."
                  : shortcut.kind === "modifierPair"
                    ? "Press both keys together, left and right."
                    : "Works from any app while Opengeni is open."
              }
              controlWidth="select"
              control={
                recording ? (
                  <Button size="sm" variant="outline" onClick={() => setRecording(false)}>
                    Cancel
                  </Button>
                ) : (
                  <SelectMenu
                    size="sm"
                    className="w-56"
                    options={options}
                    value={selected}
                    disabled={saving}
                    align="end"
                    onValueChange={(value) => {
                      if (value === CUSTOM) {
                        setRecording(true);
                        return;
                      }
                      void update({
                        shortcut: {
                          kind: "modifierPair",
                          modifier: value as DesktopAppShotModifier,
                        },
                      });
                    }}
                  />
                )
              }
            />
            {status.permissions.map((permission) => {
              const row = PERMISSION_ROWS[permission.id];
              return (
                <SettingRow
                  key={permission.id}
                  label={row.label}
                  description={row.description}
                  control={
                    permission.granted ? (
                      <span className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
                        <CheckIcon className="size-4 text-success" aria-hidden />
                        Allowed
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant={row.needed ? "default" : "outline"}
                        onClick={() =>
                          void appShots.requestPermission(permission.id).catch(() => undefined)
                        }
                      >
                        Allow
                      </Button>
                    )
                  }
                />
              );
            })}
          </>
        ) : null}
      </SettingRow>
    </Section>
  );
}
