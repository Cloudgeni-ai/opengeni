import { ClaudeMark, AnthropicMark, OpenRouterMark, GrokMark } from "@opengeni/react";
import type { SVGProps } from "react";

import { BrandMark } from "@/components/brand-mark";
import { ChatGptMark } from "@/components/chatgpt-mark";
import { LogoTile, type LogoTileSize } from "@/components/ui/logo-tile";

export type ModelProviderId =
  | "codex"
  | "supergrok"
  | "vercel"
  | "openrouter"
  | "anthropic"
  | "claude_subscription"
  | "openai"
  | "azure_openai";

function VercelMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M 12 3.5 22.5 20.5h-21z" />
    </svg>
  );
}

/** Microsoft Azure mark (Simple Icons path), currentColor like the other marks. */
function AzureMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M5.483 21.3H24L14.025 4.013l-3.038 8.347 5.836 6.938L5.483 21.3zM13.23 2.7L6.105 8.677 0 19.253h5.505v.014L13.23 2.7z" />
    </svg>
  );
}

export function ProviderMark({
  provider,
  className,
}: {
  provider: ModelProviderId;
  className?: string;
}) {
  if (provider === "codex" || provider === "openai") return <ChatGptMark className={className} />;
  if (provider === "azure_openai") return <AzureMark className={className} />;
  if (provider === "vercel") return <VercelMark className={className} />;
  if (provider === "claude_subscription") return <ClaudeMark className={className} />;
  if (provider === "anthropic") return <AnthropicMark className={className} />;
  if (provider === "supergrok") return <GrokMark className={className} />;
  return <OpenRouterMark className={className} />;
}

/** The provider's logo on the shared tile. Size follows the list or page it sits in. */
export function ProviderTile({
  provider,
  size,
}: {
  provider: ModelProviderId;
  size?: LogoTileSize;
}) {
  return <LogoTile size={size} icon={<ProviderMark provider={provider} className="text-fg" />} />;
}

/** The Opengeni credits logo tile, shared by every credits row. */
export function OpenGeniCreditsTile({ size }: { size?: LogoTileSize }) {
  return <LogoTile size={size} icon={<BrandMark className="text-fg" />} name="Opengeni" />;
}
