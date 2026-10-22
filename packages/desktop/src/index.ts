// The package entry. Publishable packages keep their committed entry points on
// ./src/index.ts (the release step rewrites them to dist), so this re-exports
// the main-process kit.
export * from "./main/index";
