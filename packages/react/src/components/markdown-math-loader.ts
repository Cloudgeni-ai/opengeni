import { useEffect, useState } from "react";

export type MathPlugins = typeof import("./markdown-math-plugins");

let loaded: MathPlugins | null = null;
let loading: Promise<MathPlugins> | null = null;

/** Load the math plugins (once); messages rendered afterwards typeset immediately. */
export function loadMathPlugins(): Promise<MathPlugins> {
  loading ??= import("./markdown-math-plugins").then(
    (module) => (loaded = module),
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/**
 * The math plugins once loaded, starting the load the first time a message needs them.
 * Until then the message renders without typesetting; every later message gets them
 * synchronously.
 */
export function useMathPlugins(needed: boolean): MathPlugins | null {
  const [plugins, setPlugins] = useState<MathPlugins | null>(loaded);
  useEffect(() => {
    if (!needed || plugins) return;
    if (loaded) {
      setPlugins(loaded);
      return;
    }
    let active = true;
    loadMathPlugins().then(
      (module) => {
        if (active) setPlugins(module);
      },
      () => {
        // Offline or a failed chunk: the message keeps its plain text.
      },
    );
    return () => {
      active = false;
    };
  }, [needed, plugins]);
  return needed ? (plugins ?? loaded) : null;
}
