import { defineConfig } from "tsup";

import pkg from "./package.json" with { type: "json" };

// @opengeni/react-native ships ESM for Metro. React, React Native, Expo, every
// dependency and peer, and all @opengeni/* packages stay external, so a host
// never bundles a second copy of React or the SDK. The iOS call module ships as
// source (ios/ and expo-module.config.json) for Expo autolinking.
const external = [
  "react",
  "react/jsx-runtime",
  "react-native",
  /^react-native\//,
  /^expo(-|\/|$)/,
  /^@opengeni\//,
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

// MathJax is bundled into the math engine, which the timeline requires only when a
// message first shows math. Left external, esbuild would hoist its imports to the top
// of the timeline module, so every chat would load MathJax as it opened.
const bundled = [/^mathjax-full(\/|$)/];

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/adapters.ts",
    "src/expo.ts",
    "src/recordings/index.ts",
    "src/meetings/index.ts",
    "src/webrtc.ts",
    "src/ui/index.ts",
    "src/timeline/index.ts",
    "src/timeline/markdown.tsx",
    "src/timeline/previews.tsx",
  ],
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
  external,
  noExternal: bundled,
});
