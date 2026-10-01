import { LogoTile, type LogoTileSize } from "@/components/ui/logo-tile";

import linearLogo from "../../../../../../../data/catalog/logos/linear-app-4b4a9f349c60.png";
import sentryLogo from "../../../../../../../data/catalog/logos/sentry-io-2bcd2164011c.svg";
import slackLogo from "../../../../../../../data/catalog/logos/slack-com-5a15dccc0dc0.jpg";
import { toolById } from "./model";

const LOGOS: Record<string, { src: string; fit: "cover" | "contain" }> = {
  slack: { src: slackLogo, fit: "cover" },
  github: { src: "/capability-logos/github.svg", fit: "cover" },
  sentry: { src: sentryLogo, fit: "contain" },
  linear: { src: linearLogo, fit: "cover" },
};

/** A tool's logo tile (or monogram), sized for chips and fact rows. */
export function ToolLogo({
  toolId,
  size = "sm",
  className,
}: {
  toolId: string;
  size?: LogoTileSize;
  /** "size-5" for chips. */
  className?: string;
}) {
  const tool = toolById(toolId);
  const logo = LOGOS[toolId];
  return (
    <LogoTile
      size={size}
      src={logo?.src}
      fit={logo?.fit}
      name={tool?.name ?? toolId}
      className={className}
    />
  );
}

/** Logo and name, for fact rows. */
export function ToolMark({ toolId }: { toolId: string }) {
  const tool = toolById(toolId);
  return (
    // Baseline-aligned on the name, so it lines up with the fact's label.
    <span className="inline-flex min-w-0 items-baseline gap-1.5">
      {/* A flex box, so the tile doesn't sit on a text line and grow taller than 20px. */}
      <span className="flex shrink-0 self-center">
        <ToolLogo toolId={toolId} className="size-5" />
      </span>
      <span className="truncate">{tool?.name ?? toolId}</span>
    </span>
  );
}
