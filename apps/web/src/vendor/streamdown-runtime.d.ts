import type { ComponentType, ReactNode } from "react";

export type StreamdownComponents = Record<string, ComponentType<any> | string>;

export const Streamdown: ComponentType<{
  children?: string;
  className?: string;
  components?: StreamdownComponents;
  controls?: boolean | Record<string, unknown>;
  mode?: "static" | "streaming";
  parseIncompleteMarkdown?: boolean;
}>;
