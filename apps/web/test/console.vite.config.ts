import { defineConfig, type UserConfig } from "vite";
import webConfig from "../vite.config";
import { previewHost } from "./preview-host";

// Isolated browser fixture: the real Console pages with an in-memory client.
const config = webConfig as UserConfig;
export default defineConfig({
  ...config,
  plugins: [...(config.plugins ?? []), previewHost()],
});
