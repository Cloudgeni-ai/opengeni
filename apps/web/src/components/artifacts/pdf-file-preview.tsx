import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
// Vite's ?url asset transform supplies the default URL export.
// oxlint-disable-next-line import/default
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Button } from "@/components/ui/button";

GlobalWorkerOptions.workerSrc = workerUrl;

/** Canvas-only PDF rendering: no document JavaScript, attachments or embedded HTML. */
export default function PdfFilePreview({ url, title }: { url: string; title: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let active = true;
    setDocument(null);
    setPage(1);
    setFailed(false);
    const task = getDocument({ url });
    void task.promise
      .then((pdf) => {
        if (active) setDocument(pdf);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      void task.destroy();
    };
  }, [url, retry]);
  useEffect(() => {
    if (!document) return;
    let active = true;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    void document
      .getPage(page)
      .then(async (pdfPage) => {
        const node = canvas.current;
        if (!active || !node) return;
        const natural = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({
          scale: Math.min(1.5, 2048 / natural.width, 2048 / natural.height),
        });
        node.width = viewport.width;
        node.height = viewport.height;
        render = pdfPage.render({ canvas: node, viewport });
        await render.promise;
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      render?.cancel();
    };
  }, [document, page]);
  if (failed)
    return (
      <p role="status">
        PDF preview could not be loaded.{" "}
        <Button variant="ghost" size="sm" onClick={() => setRetry((n) => n + 1)}>
          Retry PDF
        </Button>
      </p>
    );
  return (
    <div className="flex min-h-0 flex-col gap-2">
      {!document ? (
        <p role="status">Loading PDF…</p>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={page === 1}
            onClick={() => setPage((n) => n - 1)}
          >
            Previous page
          </Button>
          <span className="text-sm">
            Page {page} of {document.numPages}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={page === document.numPages}
            onClick={() => setPage((n) => n + 1)}
          >
            Next page
          </Button>
        </div>
      )}
      <canvas
        ref={canvas}
        aria-label={`${title}, page ${page}`}
        role="img"
        className="h-auto w-full bg-white"
      />
    </div>
  );
}
