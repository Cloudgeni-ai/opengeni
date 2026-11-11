import { CLAUDE_MARK_PATH } from "../model-mark-paths";
import type { SVGProps } from "react";

/** ClaudeMark: Simple Icons, CC0; https://github.com/simple-icons/simple-icons */
export function ClaudeMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d={CLAUDE_MARK_PATH} />
    </svg>
  );
}
