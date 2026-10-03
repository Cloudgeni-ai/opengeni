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
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3653-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8414 3.3698-2.02 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.783-2.7622a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
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
