import {
  DownloadIcon,
  ExternalLinkIcon,
  MonitorDownIcon,
  PackageIcon,
  SheetIcon,
  TerminalIcon,
} from "lucide-react";
import { toast } from "sonner";

import { apiBaseUrl } from "@/api";
import { EXCEL_ADDIN_PATH } from "@/lib/excel-addin";
import { copyText } from "@opengeni/react/ui/copy-field";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@opengeni/react/ui/dropdown-menu";
import { detectConnectOs } from "@opengeni/react/app/lib/deployment";
import { desktopBridge } from "@opengeni/react/app/lib/desktop";
import {
  desktopDownloadsFor,
  desktopDownloadUrl,
  desktopInstallCommand,
  desktopReleasePageUrl,
} from "@opengeni/react/app/lib/desktop-download";
import { currentPhoneAppPlatform } from "@opengeni/react/app/lib/open-in-app";

/**
 * The account menu's "Desktop app" row: the download for this computer, the
 * install command for Mac and Linux, and the release page with every
 * platform. Hidden inside the desktop app and on phones and tablets.
 */
export function DesktopAppSubmenu() {
  if (desktopBridge || typeof window === "undefined" || currentPhoneAppPlatform()) return null;
  const origin = apiBaseUrl || window.location.origin;
  const userAgent = navigator.userAgent;
  const os = detectConnectOs(userAgent);
  const copyInstallCommand = async () => {
    if (await copyText(desktopInstallCommand(origin))) {
      toast.success("Install command copied", {
        description: "Paste it into a terminal to install or update Opengeni.",
      });
    } else {
      toast.error("Couldn't copy the install command");
    }
  };
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <MonitorDownIcon />
        Desktop app
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-56">
        {desktopDownloadsFor(os, userAgent).map((download) => (
          <DropdownMenuItem key={download.asset} asChild>
            <a href={desktopDownloadUrl(origin, download.asset)}>
              <DownloadIcon />
              {download.label}
            </a>
          </DropdownMenuItem>
        ))}
        {os === "windows" ? null : (
          <DropdownMenuItem onSelect={() => void copyInstallCommand()}>
            <TerminalIcon />
            Copy install command
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <a href={desktopReleasePageUrl(origin)} target="_blank" rel="noopener noreferrer">
            <PackageIcon />
            All downloads
            <ExternalLinkIcon className="ml-auto size-3.5 text-fg-muted" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** The account menu's "Excel add-in" row: how to add Opengeni to Excel. Hidden on phones and tablets. */
export function ExcelAddinMenuItem() {
  if (typeof window === "undefined" || currentPhoneAppPlatform()) return null;
  return (
    <DropdownMenuItem asChild>
      <a href={EXCEL_ADDIN_PATH} target="_blank" rel="noopener noreferrer">
        <SheetIcon />
        Excel add-in
        <ExternalLinkIcon className="ml-auto size-3.5 text-fg-muted" aria-hidden="true" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    </DropdownMenuItem>
  );
}
