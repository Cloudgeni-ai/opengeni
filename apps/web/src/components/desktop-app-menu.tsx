import {
  DownloadIcon,
  ExternalLinkIcon,
  MonitorDownIcon,
  PackageIcon,
  TerminalIcon,
} from "lucide-react";
import { toast } from "sonner";

import { apiBaseUrl } from "@/api";
import { copyText } from "@/components/ui/copy-field";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { detectConnectOs } from "@/lib/deployment";
import { desktopBridge } from "@/lib/desktop";
import {
  desktopDownloadsFor,
  desktopDownloadUrl,
  desktopInstallCommand,
  desktopReleasePageUrl,
} from "@/lib/desktop-download";
import { currentPhoneAppPlatform } from "@/lib/open-in-app";

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
