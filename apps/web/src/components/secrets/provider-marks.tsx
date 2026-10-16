import { ServerIcon } from "lucide-react";
import type { ReactElement } from "react";

import { LogoTile, type LogoTileSize } from "@/components/ui/logo-tile";
import { cn } from "@/lib/utils";

import { PROVIDERS, type VaultProviderId } from "./vault-providers";

/* ----------------------------------------------------------------------------
   Password manager marks, drawn as simple shapes in each brand's color (no
   bitmap assets), and the tile every Secrets page uses for a provider.
   -------------------------------------------------------------------------- */

/** The 1Password mark, drawn as a keyhole in a ring. */
export function OnePasswordMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("size-full", className)} fill="none">
      <circle cx="12" cy="12" r="10.25" fill="#0572EC" />
      <circle cx="12" cy="12" r="6.6" stroke="#fff" strokeWidth="1.7" />
      <rect x="10.85" y="7.6" width="2.3" height="8.8" rx="1.15" fill="#fff" />
    </svg>
  );
}

/** Proton Pass: a violet tile with a rounded P. */
export function ProtonPassMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("size-full", className)} fill="none">
      <defs>
        <linearGradient id="og-protonpass-fill" x1="3" y1="2" x2="21" y2="22">
          <stop offset="0" stopColor="#8A6CFF" />
          <stop offset="1" stopColor="#5B2EE8" />
        </linearGradient>
      </defs>
      <rect x="1.75" y="1.75" width="20.5" height="20.5" rx="6" fill="url(#og-protonpass-fill)" />
      <path
        d="M8.6 18V6.4h4.3a3.85 3.85 0 0 1 0 7.7H8.6"
        stroke="#fff"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Keeper: a yellow tile with a black K. */
export function KeeperMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("size-full", className)} fill="none">
      <rect x="1.75" y="1.75" width="20.5" height="20.5" rx="5" fill="#FFC72C" />
      <path
        d="M8.4 6.5v11M15.6 6.5l-5.4 5.5 5.4 5.5"
        stroke="#111"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Bitwarden: a blue shield, its right half lit. */
export function BitwardenMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("size-full", className)} fill="none">
      <rect x="1.75" y="1.75" width="20.5" height="20.5" rx="5" fill="#175DDC" />
      <path
        d="M6.6 5.6h10.8v6.6c0 3.4-2.9 5.4-5.4 6.4-2.5-1-5.4-3-5.4-6.4z"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M 12 7.2h3.8v5c0 2.3-1.8 3.8-3.8 4.7z" fill="#fff" />
    </svg>
  );
}

const MARKS: Record<Exclude<VaultProviderId, "external">, () => ReactElement> = {
  onepassword: () => <OnePasswordMark />,
  protonpass: () => <ProtonPassMark />,
  keeper: () => <KeeperMark />,
  bitwarden: () => <BitwardenMark />,
};

/**
 * A provider's tile. Brands get their mark; your own vault service is not a
 * brand, so it gets a plain server glyph like any other non-brand object.
 */
export function ProviderTile({
  provider,
  size,
  labelled = true,
}: {
  provider: VaultProviderId;
  size?: LogoTileSize;
  /** Name the tile for screen readers; off when the name is already next to it. */
  labelled?: boolean;
}) {
  const extra = {
    ...(labelled ? { label: PROVIDERS[provider].name } : {}),
    ...(size ? { size } : {}),
  };
  return (
    <LogoTile icon={provider === "external" ? <ServerIcon /> : MARKS[provider]()} {...extra} />
  );
}
