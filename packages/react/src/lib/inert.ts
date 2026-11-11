import { version } from "react";

/**
 * React 19 treats `inert` as a boolean attribute. React 18 does not know it:
 * it drops `inert={true}` with a warning and writes the attribute only for a
 * string. The attribute's presence is what makes an element inert, and the
 * string "true" also sets the DOM property for runtimes that assign it.
 */
const inertValue = (Number.parseInt(version, 10) >= 19 ? true : "true") as true;

/** Spread onto an element: `<div {...inertProps(hidden)} />`. */
export function inertProps(inert: boolean | undefined): { inert?: true } {
  return inert ? { inert: inertValue } : {};
}
