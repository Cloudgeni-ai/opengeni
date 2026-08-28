import type { CSSProperties, Ref } from "react";

export const PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX = [
  "allow-downloads",
  "allow-forms",
  "allow-modals",
  "allow-orientation-lock",
  "allow-pointer-lock",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-presentation",
  "allow-scripts",
].join(" ");

export type PublishedHtmlArtifactFrameProps = {
  html: string;
  title: string;
  className?: string;
  style?: CSSProperties;
  iframeRef?: Ref<HTMLIFrameElement>;
  onLoad?: () => void;
  sandbox?: string;
};

/**
 * Render exact published HTML in an opaque-origin iframe. Artifact scripts,
 * external resources, forms, popups, and downloads work without granting
 * parent-origin authority, shared cookies/storage, or top-level navigation.
 */
export function PublishedHtmlArtifactFrame(props: PublishedHtmlArtifactFrameProps) {
  return (
    <iframe
      ref={props.iframeRef}
      title={props.title}
      sandbox={props.sandbox ?? PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={props.html}
      className={props.className}
      style={props.style}
      onLoad={props.onLoad}
    />
  );
}
