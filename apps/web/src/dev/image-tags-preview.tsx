import { useCallback, useMemo, useRef, useState } from "react";
import { ChatComposer, type ComposerState, type UseFileAttachmentsResult } from "@opengeni/react";
import type { FileAttachment } from "@opengeni/react";
import { emptyAttachments, idleComposer } from "@/dev/composer-chrome-fixtures";

/** DEV only. The production composer with image tags on and local, fake uploads. */
const SAMPLES = [
  { label: "Settings page", color: "#2563eb" },
  { label: "Header, mobile", color: "#16a34a" },
  { label: "Empty state", color: "#d97706" },
  { label: "Error toast", color: "#dc2626" },
];

function sampleScreenshot(label: string, color: string): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 400;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#f8fafc";
  context.fillRect(0, 0, 640, 400);
  context.fillStyle = color;
  context.fillRect(0, 0, 640, 56);
  context.fillStyle = "#e2e8f0";
  for (let row = 0; row < 5; row++) context.fillRect(40, 96 + row * 52, 560 - row * 60, 24);
  context.fillStyle = "#ffffff";
  context.font = "bold 26px sans-serif";
  context.fillText(label, 24, 38);
  return new Promise((resolve) =>
    canvas.toBlob((blob) =>
      resolve(
        new File([blob!], `${label.toLowerCase().replace(/\W+/g, "-")}.png`, { type: "image/png" }),
      ),
    ),
  );
}

export function ImageTagsPreview() {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [sent, setSent] = useState<{ text: string; images: string[] } | null>(null);
  const next = useRef(0);

  const addFiles = useCallback((incoming: Iterable<File>) => {
    const added = [...incoming].map((file): FileAttachment => {
      next.current += 1;
      return {
        id: `local-${next.current}`,
        name: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        status: "ready",
        previewUrl: URL.createObjectURL(file),
      };
    });
    setFiles((current) => [...current, ...added]);
  }, []);

  const attachments = useMemo<UseFileAttachmentsResult>(
    () => ({
      ...emptyAttachments(),
      attachments: files,
      addFiles,
      addFromPaste: (event) => {
        const pasted = [...(event.clipboardData?.files ?? [])];
        if (pasted.length) addFiles(pasted);
      },
      remove: (id) => setFiles((current) => current.filter((file) => file.id !== id)),
      clear: () => setFiles([]),
    }),
    [addFiles, files],
  );

  const composer = useMemo<ComposerState>(
    () =>
      idleComposer({
        value,
        setValue,
        canSend: value.trim().length > 0 || files.length > 0,
        hasDraftContent: () => value.length > 0 || files.length > 0,
        send: async () => {
          setSent({ text: value, images: files.map((file) => file.name) });
          setValue("");
          setFiles([]);
          return true;
        },
      }),
    [files, value],
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <div className="flex flex-wrap gap-2">
        {SAMPLES.map((sample) => (
          <button
            key={sample.label}
            type="button"
            className="rounded-og-md border border-og-border px-2 py-1 text-og-sm"
            onClick={() =>
              void sampleScreenshot(sample.label, sample.color).then((file) => addFiles([file]))
            }
          >
            Paste “{sample.label}”
          </button>
        ))}
      </div>
      <ChatComposer
        responsiveBasis="container"
        composer={composer}
        placeholder="Send a message…"
        attachments={attachments}
        imageTags
      />
      {sent ? (
        <div data-sent-preview="" className="rounded-og-md border border-og-border p-3 text-og-sm">
          <div className="mb-1 font-medium">Sent text</div>
          <pre className="whitespace-pre-wrap">{sent.text}</pre>
          <div className="mt-2 mb-1 font-medium">Images, in order</div>
          <ol className="list-decimal pl-5">
            {sent.images.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
