import type { ProductAccessMode } from "@opengeni/sdk";

import { Notice } from "@/components/ui/notice";

type BrowserSecurityEnvironment = {
  window?: { isSecureContext?: boolean | undefined } | undefined;
  crypto?: { subtle?: { digest?: unknown } | undefined } | undefined;
};

export type BrowserSecureContextIssue = "insecure_context" | "web_crypto_unavailable";

export function browserSecureContextIssue(
  environment: BrowserSecurityEnvironment = globalThis,
): BrowserSecureContextIssue | null {
  if (!environment.window) return null;
  if (environment.window.isSecureContext === false) return "insecure_context";
  if (typeof environment.crypto?.subtle?.digest !== "function") {
    return "web_crypto_unavailable";
  }
  return null;
}

export function shouldShowSecureContextWarning(
  productAccessMode: ProductAccessMode,
  environment: BrowserSecurityEnvironment = globalThis,
): boolean {
  return productAccessMode !== "managed" && browserSecureContextIssue(environment) !== null;
}

export function SecureContextWarning({
  productAccessMode,
}: {
  productAccessMode: ProductAccessMode;
}) {
  const issue = browserSecureContextIssue();
  if (productAccessMode === "managed" || issue === null) return null;

  return (
    <div role="alert" className="shrink-0 px-3 pt-3">
      <Notice tone="waiting" title="Secure connection required">
        {issue === "insecure_context"
          ? "OpenGeni is open over HTTP. Configure HTTPS or use a secure URL. File uploads, microphone access, voice recordings, and some artifact features may not work."
          : "This browser does not expose secure cryptography. Use a current browser over HTTPS. File uploads and some voice or artifact features may not work."}
      </Notice>
    </div>
  );
}
