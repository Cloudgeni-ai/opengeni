// The Opengeni session app for a page that holds a person's credentials: the
// web app's own chat list, session page, new-chat page and composer, with a
// feature preset. See docs/embedding.md ("The full session app").
export {
  SessionApp,
  type EditableArtifactSurfaceProps,
  type PdfPreviewProps,
  type SessionAppProps,
  type SessionAppSurfaces,
} from "./app/embed/session-app";
export {
  SESSION_UI_PRESETS,
  type SessionUiFeatures,
  type SessionUiPreset,
} from "./app/lib/session-ui-features";
export type { SessionShellSlots } from "./app/components/rail/rail-sections";
