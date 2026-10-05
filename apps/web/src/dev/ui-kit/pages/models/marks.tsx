import type { SVGProps } from "react";
import { OpenRouterMark, OpperMark } from "@opengeni/react";

import { ChatGptMark } from "@/components/chatgpt-mark";
import { LogoTile, type LogoTileSize } from "@/components/ui/logo-tile";

/* ----------------------------------------------------------------------------
   Provider marks for the Models page preview. The ChatGPT mark is the app's
   own; Vercel is the plain triangle; OpenRouter and Opper use their brand marks.
   All draw in currentColor, so they follow the theme.
   -------------------------------------------------------------------------- */

export type ProviderId = "codex" | "vercel" | "openrouter" | "opper";

function VercelMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M 12 3.5 22.5 20.5h-21z" />
    </svg>
  );
}

export function ProviderMark({
  provider,
  className,
}: {
  provider: ProviderId;
  className?: string;
}) {
  if (provider === "codex") return <ChatGptMark className={className} />;
  if (provider === "vercel") return <VercelMark className={className} />;
  if (provider === "opper") return <OpperMark className={className} />;
  return <OpenRouterMark className={className} />;
}

/** The provider's logo on the shared tile. Size follows the list or sheet it sits in. */
export function ProviderTile({ provider, size }: { provider: ProviderId; size?: LogoTileSize }) {
  return <LogoTile size={size} icon={<ProviderMark provider={provider} className="text-fg" />} />;
}
