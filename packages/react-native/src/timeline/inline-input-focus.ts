import { createContext, useContext } from "react";

/** Anything the timeline can locate on screen, such as a focused `TextInput`. */
export type InlineInputNode = {
  measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void;
};

/**
 * Fields inside timeline cards (a key in a connect card, a secret answer)
 * report focus here. While one is focused the timeline keeps it above the
 * keyboard and hides its floating navigation buttons, which would otherwise
 * cover the card being filled in.
 */
export type InlineInputFocus = {
  focused(node: InlineInputNode | null): void;
  blurred(node: InlineInputNode | null): void;
};

export const InlineInputFocusContext = createContext<InlineInputFocus | null>(null);

/** Focus and blur handlers for one inline field; no-ops outside a timeline. */
export function useInlineInputFocus(node: () => InlineInputNode | null): {
  onFocus: () => void;
  onBlur: () => void;
} {
  const focus = useContext(InlineInputFocusContext);
  return {
    onFocus: () => focus?.focused(node()),
    onBlur: () => focus?.blurred(node()),
  };
}
