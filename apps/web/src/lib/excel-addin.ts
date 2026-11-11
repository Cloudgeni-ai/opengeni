// Installing the Excel add-in from this deployment: its manifest URL, the
// folder desktop Excel on Mac loads add-in files from, and optional one-line
// commands for people who prefer a terminal (Mac: Excel's `wef` folder;
// Windows: the per-user developer add-ins registry key).

export const EXCEL_ADDIN_PATH = "/excel";
const MANIFEST_PATH = "/office/manifest.xml";

export type ExcelPlatform = "web" | "mac" | "windows" | "organization";

export function excelManifestUrl(origin: string): string {
  return `${origin.replace(/\/+$/u, "")}${MANIFEST_PATH}`;
}

/** The platform to show first: this computer's desktop Excel, or Excel on the web elsewhere. */
export function excelPlatformFor(userAgent: string | undefined): ExcelPlatform {
  if (!userAgent) return "web";
  if (/iphone|ipad|android/iu.test(userAgent)) return "web";
  if (/windows/iu.test(userAgent)) return "windows";
  if (/macintosh|mac os x/iu.test(userAgent)) return "mac";
  return "web";
}

/** The Finder folder that holds Excel's `wef` add-in folder on Mac. */
export const MAC_EXCEL_DOCUMENTS = "~/Library/Containers/com.microsoft.Excel/Data/Documents";

function singleQuoted(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

/** Terminal: save the manifest in Excel's add-in folder. */
export function macInstallCommand(manifestUrl: string): string {
  const folder = `${MAC_EXCEL_DOCUMENTS}/wef`;
  return `mkdir -p ${folder} && curl -fsSL ${singleQuoted(manifestUrl)} -o ${folder}/opengeni.xml`;
}

/**
 * PowerShell: save the manifest and list it under the current user's developer
 * add-ins. The key is created only when missing, so other entries in it stay.
 */
export function windowsInstallCommand(manifestUrl: string): string {
  const url = manifestUrl.replace(/'/gu, "''");
  return [
    `$f="$env:LOCALAPPDATA\\Opengeni\\opengeni-excel.xml"`,
    `New-Item -ItemType Directory -Force (Split-Path $f) | Out-Null`,
    `Invoke-WebRequest '${url}' -OutFile $f`,
    `$k='HKCU:\\Software\\Microsoft\\Office\\16.0\\WEF\\Developer'`,
    `if (!(Test-Path $k)) { New-Item $k -Force | Out-Null }`,
    `Set-ItemProperty $k -Name $f -Value $f`,
  ].join("; ");
}
