import { describe, expect, test } from "bun:test";

import {
  excelManifestUrl,
  excelPlatformFor,
  macInstallCommand,
  windowsInstallCommand,
} from "./excel-addin";

describe("excel add-in install", () => {
  test("points at this deployment's manifest", () => {
    expect(excelManifestUrl("https://app.example/")).toBe(
      "https://app.example/office/manifest.xml",
    );
  });

  test("starts with this computer's Excel", () => {
    expect(excelPlatformFor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("mac");
    expect(excelPlatformFor("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(excelPlatformFor("Mozilla/5.0 (X11; Linux x86_64)")).toBe("web");
    expect(excelPlatformFor("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("web");
    expect(excelPlatformFor(undefined)).toBe("web");
  });

  test("saves the manifest in Excel's add-in folder on Mac", () => {
    expect(macInstallCommand("https://app.example/office/manifest.xml")).toBe(
      "mkdir -p ~/Library/Containers/com.microsoft.Excel/Data/Documents/wef && curl -fsSL 'https://app.example/office/manifest.xml' -o ~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/opengeni.xml",
    );
  });

  test("registers the manifest for the current Windows user without clearing the key", () => {
    const command = windowsInstallCommand("https://app.example/office/manifest.xml");
    expect(command).toContain(
      "Invoke-WebRequest 'https://app.example/office/manifest.xml' -OutFile $f",
    );
    expect(command).toContain("HKCU:\\Software\\Microsoft\\Office\\16.0\\WEF\\Developer");
    expect(command).toContain("if (!(Test-Path $k)) { New-Item $k -Force | Out-Null }");
    expect(command).toContain("Set-ItemProperty $k -Name $f -Value $f");
  });
});
