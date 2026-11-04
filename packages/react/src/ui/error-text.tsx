import { useEffect, useRef, useState, type ReactNode } from "react";

import { splitErrorText } from "./error-reference";

/**
 * One line of error text from `userErrorText`. An unexpected failure's
 * "Reference: <id>." becomes a small "Copy details" instead of printed text,
 * and a raw "API 409:" prefix never shows. Anything that is not a string
 * renders as is.
 */
export function ErrorText({ children }: { children?: ReactNode }) {
  if (typeof children !== "string") return <>{children}</>;
  const { text, reference } = splitErrorText(children);
  if (!reference) return <>{text}</>;
  return (
    <>
      {text} <CopyDetails details={`${text}\nReference: ${reference}`} />
    </>
  );
}

function CopyDetails({ details }: { details: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      onClick={() => {
        void globalThis.navigator?.clipboard?.writeText(details).then(
          () => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1600);
          },
          () => setCopied(false),
        );
      }}
      className="font-medium whitespace-nowrap text-fg-subtle underline-offset-2 transition-colors duration-[120ms] hover:text-fg hover:underline"
    >
      {copied ? "Copied" : "Copy details"}
    </button>
  );
}
