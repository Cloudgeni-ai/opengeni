import { createOpenGeniSiteClient } from "./site";

Object.defineProperty(globalThis, "createOpenGeniSiteClient", {
  configurable: true,
  value: createOpenGeniSiteClient,
});
