// Opening the app, without a window, at login on macOS 13 and later.
//
// Registering the app itself as a login item (SMAppService.mainApp) opens it
// like a click in the Dock would: macOS passes no arguments, and Electron's
// `wasOpenedAtLogin` stays false, so the app can't tell it should stay hidden.
// Instead the app bundles a launch agent that runs `open` with `--hidden` once
// at login. The job exits as soon as the app is open, so unregistering it never
// stops the running app. macOS lists it under the app in Login Items.
//
// macOS first reopens the apps that were running at logout ("Reopen windows
// when logging back in"), and `open` on a running app reopens its window like
// a click in the Dock. So the agent waits a moment and leaves a running app
// alone; the app itself remembers whether its window was closed at logout.
//
// Electron registers the agent from Contents/Library/LaunchAgents; the build
// writes the file there (electron-builder `mac.extraFiles`).

/** The launch agent's file name inside Contents/Library/LaunchAgents. */
export function macLoginAgentName(appId: string): string {
  return `${appId}.open-at-login.plist`;
}

function xml(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

/** Seconds the agent waits for macOS to reopen apps from before logout. */
const REOPEN_GRACE_SECONDS = 5;

/**
 * The launch agent's command, with the bundle identifier as `$0`: open the app
 * with `--hidden` unless it's already running.
 */
const LOGIN_COMMAND =
  `sleep ${REOPEN_GRACE_SECONDS}; ` +
  '/usr/bin/lsappinfo find bundleid="$0" | /usr/bin/grep -q ASN || ' +
  'exec /usr/bin/open -g -b "$0" --args --hidden';

/** The launch agent that opens the app with `--hidden` at login. */
export function macLoginAgentPlist(appId: string): string {
  const strings = (values: string[]) =>
    values.map((value) => `    <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(appId)}.open-at-login</string>
  <key>ProgramArguments</key>
  <array>
${strings(["/bin/sh", "-c", LOGIN_COMMAND, appId])}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>AssociatedBundleIdentifiers</key>
  <array>
${strings([appId])}
  </array>
</dict>
</plist>
`;
}
