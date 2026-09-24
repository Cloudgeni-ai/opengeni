import { Component, type ReactNode, useEffect, useState } from "react";
import type { RetainedArtifactReference } from "@opengeni/sdk";
import { PierreFile } from "@opengeni/react";
import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { decodeRetainedText, TEXT_PREVIEW_MAX_BYTES } from "./retained-text-preview-policy";

class HighlightBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export default function RetainedTextPreview({
  workspaceId,
  artifact: initialArtifact,
  filename,
}: {
  workspaceId: string;
  artifact: RetainedArtifactReference;
  filename?: string | undefined;
}) {
  // Receipt identity changes remount this component in RetainedFilePreview.
  const [artifact] = useState(initialArtifact);
  const { client } = useAppContext();
  const [result, setResult] = useState<{
    text?: string;
    error?: string;
    retry?: boolean;
    client: typeof client;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [plain, setPlain] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  useEffect(() => {
    const read = () =>
      setTheme(document.documentElement.dataset.ogTheme === "light" ? "light" : "dark");
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-og-theme"],
    });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    if (
      !Number.isSafeInteger(artifact.originalBytes) ||
      artifact.originalBytes < 0 ||
      artifact.originalBytes > TEXT_PREVIEW_MAX_BYTES
    ) {
      setResult({ error: "This file is too large for inline preview (256 KiB limit).", client });
      return;
    }
    void client
      .downloadRetainedArtifact(workspaceId, artifact, { signal: controller.signal })
      .then(({ bytes }) => {
        if (controller.signal.aborted) return;
        try {
          setResult({ text: decodeRetainedText(bytes), client });
        } catch (error) {
          setResult({ error: (error as Error).message, client });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setResult({ error: "Preview could not be loaded.", retry: true, client });
      });
    return () => controller.abort();
  }, [client, workspaceId, artifact, attempt]);
  if (!result || result.client !== client)
    return (
      <p role="status" className="p-4 text-sm">
        Loading preview…
      </p>
    );
  if (result.error)
    return (
      <div role="status" className="p-4 text-sm">
        {result.error}
        {result.retry && (
          <Button variant="ghost" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            Retry preview
          </Button>
        )}
      </div>
    );
  if (!result.text)
    return (
      <p role="status" className="p-4 text-sm">
        This file is empty.
      </p>
    );
  const source = (
    <pre
      tabIndex={0}
      aria-label="File contents"
      className="max-h-[560px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs"
    >
      {result.text}
    </pre>
  );
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between px-3 pb-2 text-xs text-fg-muted">
        <span>Read-only source</span>
        <Button variant="ghost" size="sm" onClick={() => setPlain((value) => !value)}>
          {plain ? "Code view" : "Plain text"}
        </Button>
      </div>
      <div className="max-h-[560px] overflow-auto" tabIndex={0} aria-label="File preview">
        {plain ? (
          source
        ) : (
          <HighlightBoundary fallback={source}>
            <PierreFile
              path={filename ?? "file.txt"}
              contents={result.text}
              themeType={theme}
              disableWorkerPool
              fallback={source}
            />
          </HighlightBoundary>
        )}
      </div>
    </div>
  );
}
