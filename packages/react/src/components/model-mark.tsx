import { CHATGPT_MARK_PATH } from "../model-mark-paths";
import {
  modelDisplayName,
  modelVendor,
  type ModelDisplayInput,
  type ModelVendor,
} from "@opengeni/sdk/model-display";
import { SparklesIcon } from "lucide-react";
import type { ReactNode, SVGProps } from "react";
import { cn } from "../lib/cn";
import { ClaudeMark } from "./claude-mark";
import { GrokMark } from "./grok-mark";

/** ChatGPT / OpenAI mark (Simple Icons path), currentColor like the other marks. */
export function ChatGptMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d={CHATGPT_MARK_PATH} />
    </svg>
  );
}

const MARKED_VENDORS: ReadonlySet<ModelVendor> = new Set(["openai", "anthropic", "xai"]);

/** True when `ModelMark` has a real maker logo for this model (not the neutral fallback). */
export function modelHasMark(model: ModelDisplayInput): boolean {
  const vendor = modelVendor(model);
  return vendor !== null && MARKED_VENDORS.has(vendor);
}

/**
 * The model maker's logo (OpenAI, Claude, Grok), never the connection that
 * serves it. Makers without a bundled logo get a neutral mark, so an org- and
 * a workspace-connected copy of one model always look the same.
 */
export function ModelMark(props: {
  model: ModelDisplayInput;
  className?: string | undefined;
  /** Shown when the maker has no bundled logo. Defaults to a neutral sparkle. */
  fallback?: ReactNode;
  "aria-label"?: string | undefined;
}) {
  const vendor = modelVendor(props.model);
  const className = cn("size-3.5 shrink-0", props.className);
  const label = props["aria-label"];
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true };
  const mark =
    vendor === "openai" ? (
      <ChatGptMark className="size-full" />
    ) : vendor === "anthropic" ? (
      <ClaudeMark className="size-full" />
    ) : vendor === "xai" ? (
      <GrokMark className="size-full" />
    ) : props.fallback !== undefined ? (
      props.fallback
    ) : (
      <SparklesIcon className="size-full" aria-hidden />
    );
  if (mark === null) return null;
  return (
    <span
      className={cn("inline-flex items-center justify-center [&>svg]:size-full", className)}
      data-model-vendor={vendor ?? "unknown"}
      {...a11y}
    >
      {mark}
    </span>
  );
}

/**
 * A model as people should see it outside model settings: the maker's mark and
 * the clean display name. Never a routing prefix, connection id or scope.
 */
export function ModelName(props: {
  model: ModelDisplayInput;
  /** Hide the maker mark for dense text-only contexts. */
  mark?: boolean | undefined;
  className?: string | undefined;
  markClassName?: string | undefined;
}) {
  const name = modelDisplayName(props.model);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", props.className)} title={name}>
      {props.mark === false ? null : (
        <ModelMark model={props.model} className={props.markClassName} />
      )}
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}
