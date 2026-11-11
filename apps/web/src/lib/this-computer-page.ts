import { desktopCapability } from "@opengeni/react/app/lib/desktop";

/**
 * Whether Settings > Computer use has anything to show: only inside a
 * desktop app that offers this computer, its switches or app-shots.
 */
export function thisComputerSettingsAvailable(): boolean {
  return Boolean(
    desktopCapability("computerCapabilities") ??
    desktopCapability("thisComputer") ??
    desktopCapability("appShots"),
  );
}
