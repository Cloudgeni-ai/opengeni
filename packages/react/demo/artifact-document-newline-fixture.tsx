import { Document } from "@opengeni/artifact-tool/reference";
import { DocumentEditor } from "@opengeni/react/artifacts/document";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

type Host = typeof globalThis & {
  __ogDocumentNewline?: {
    document: Document;
    paragraphId: string;
    root: Root;
    target: HTMLElement;
  };
};

/** Browser-only acceptance fixture for trailing-newline caret and IME Enter. */
export function mountDocumentNewlineEditor(
  target: HTMLElement,
  options?: { text?: string; readOnly?: boolean },
): void {
  const document = Document.create();
  const paragraph = document.blocks.addParagraph(options?.text ?? "hello");
  const root = createRoot(target);
  root.render(
    createElement(DocumentEditor, {
      document,
      layout: "continuous",
      viewportHeight: 360,
      readOnly: options?.readOnly,
    }),
  );
  (globalThis as Host).__ogDocumentNewline = {
    document,
    paragraphId: paragraph.id,
    root,
    target,
  };
}

/** Remount the same durable document — reload without changing stored text. */
export function remountDocumentNewlineEditor(): void {
  const host = (globalThis as Host).__ogDocumentNewline;
  if (!host) throw new Error("Document newline fixture is not mounted");
  host.root.unmount();
  const root = createRoot(host.target);
  root.render(
    createElement(DocumentEditor, {
      document: host.document,
      layout: "continuous",
      viewportHeight: 360,
    }),
  );
  host.root = root;
}

export function readDocumentNewlineText(): string {
  const host = (globalThis as Host).__ogDocumentNewline;
  const paragraph = host?.document.resolve(host.paragraphId) as { text?: string } | undefined;
  return paragraph?.text ?? "";
}
