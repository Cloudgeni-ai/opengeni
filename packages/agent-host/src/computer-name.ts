import { execFile } from "node:child_process";
import { hostname } from "node:os";

/**
 * The name people gave this computer, as the system shows it: "Ada's MacBook
 * Pro" from macOS sharing settings rather than the network host name
 * ("adas-MacBook-Pro.local"). Read once and cached; falls back to the host
 * name without its local-network suffix.
 */
let cached: Promise<string> | null = null;

export function hostLabel(raw: string = hostname()): string {
  return raw.replace(/\.(local|lan|home)$/iu, "") || "this computer";
}

export function computerName(platform: NodeJS.Platform = process.platform): Promise<string> {
  cached ??= readComputerName(platform);
  return cached;
}

function readComputerName(platform: NodeJS.Platform): Promise<string> {
  if (platform === "win32") {
    return Promise.resolve(process.env.COMPUTERNAME?.trim() || hostLabel());
  }
  if (platform !== "darwin") return Promise.resolve(hostLabel());
  return new Promise((resolve) => {
    execFile("/usr/sbin/scutil", ["--get", "ComputerName"], { timeout: 2_000 }, (error, stdout) => {
      const name = error ? "" : String(stdout).trim();
      resolve(name || hostLabel());
    });
  });
}
