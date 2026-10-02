import { registerCodeEditor, type CodeEditorLanguages } from "./lib/workbench-peers";

export { CodeEditor, languageForPath } from "./components/code-editor";
export type { CodeEditorProps } from "./components/code-editor";
export { registerCodeEditor } from "./lib/workbench-peers";
export type { CodeEditorLanguage, CodeEditorLanguages } from "./lib/workbench-peers";

const loadEditor = async () => ({ module: await import("@uiw/react-codemirror") });

/** Only name installed grammar peers in host-supplied language loaders. */
export function enableCodeEditor(languages?: CodeEditorLanguages): void {
  registerCodeEditor(languages ? async () => ({ ...(await loadEditor()), languages }) : loadEditor);
}
