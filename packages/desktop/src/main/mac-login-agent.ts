// Opening the app, without a window, at login on macOS 13 and later.
//
// Registering the app itself as a login item (SMAppService.mainApp) opens it
// like a click in the Dock would: macOS passes no arguments, and Electron's
// `wasOpenedAtLogin` stays false, so the app can't tell it should stay hidden.
// Instead the app bundles a launch agent that runs `open` with `--hidden` once
// at login. The job exits as soon as the app is open, so unregistering it never
// stops the running app. macOS lists it under the app in Login Items.
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
${strings(["/usr/bin/open", "-g", "-b", appId, "--args", "--hidden"])}
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
