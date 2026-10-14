import { useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";

import {
  LightboxProvider,
  Markdown,
  MessageTimeline,
  useLightboxGalleryItem,
  useLightboxOptional,
  type LightboxGalleryEntry,
  type TimelineItem,
} from "@opengeni/react";
import "./styles.css";

/*
 * Preview of paging through chat images in the lightbox. The timeline and
 * lightbox are the real components; the image renderer stands in for the
 * console's retained-artifact image (same 360px slot, click to expand, and a
 * gallery entry that resolves the image only when it is shown).
 */

const SCREENS: Record<string, { title: string; rows: string[] }> = {
  overview: {
    title: "Account rules",
    rows: ["Personal accounts", "Fall back to personal accounts", "Switch provider"],
  },
  locked: {
    title: "After locking a rule",
    rows: ["Platform · Spread work · Locked", "Research · Spread work · Locked"],
  },
  admin: {
    title: "Workspace admin view",
    rows: ["Sharing work between accounts", "Personal accounts", "Fall back", "Switch provider"],
  },
  member: {
    title: "Member view",
    rows: ["Use the workspace setting", "Locked by Acme"],
  },
};

const ARTIFACT_SCREENS: Record<string, string> = {
  "11111111-1111-4111-8111-111111111111": "overview",
  "22222222-2222-4222-8222-222222222222": "locked",
  "33333333-3333-4333-8333-333333333333": "admin",
  "44444444-4444-4444-8444-444444444444": "member",
};

function screenSvg(key: string): string {
  const screen = SCREENS[key]!;
  const rows = screen.rows
    .map(
      (row, index) =>
        `<text x="64" y="${150 + index * 64}" font-size="22" fill="#222">${row}</text>` +
        `<rect x="820" y="${132 + index * 64}" width="44" height="24" rx="12" fill="${index % 2 ? "#ccc" : "#222"}"/>` +
        `<line x1="64" x2="896" y1="${178 + index * 64}" y2="${178 + index * 64}" stroke="#e5e5e5"/>`,
    )
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600">` +
    `<rect width="960" height="600" fill="#f5f5f5"/>` +
    `<text x="64" y="80" font-family="sans-serif" font-size="30" font-weight="600" fill="#111">${screen.title}</text>` +
    `<g font-family="sans-serif">${rows}</g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function ChatImage({ src, alt }: { src: string; alt: string }) {
  const key = ARTIFACT_SCREENS[src.replace("artifact:", "")] ?? "overview";
  const url = screenSvg(key);
  const host = useRef<HTMLDivElement>(null);
  const lightbox = useLightboxOptional();
  const entry = useMemo<LightboxGalleryEntry>(
    () => ({ load: async () => ({ src: url, caption: alt, label: "Image" }) }),
    [url, alt],
  );
  useLightboxGalleryItem(host, entry);
  return (
    <div ref={host} className="my-2" style={{ height: 360 }}>
      <button
        type="button"
        aria-label={`Expand ${alt}`}
        className="block h-full w-full cursor-zoom-in"
        onClick={(event) => lightbox?.open(url, alt, event.currentTarget, "Image")}
      >
        <img src={url} alt={alt} className="h-full w-full rounded-md object-contain" />
      </button>
    </div>
  );
}

const items: TimelineItem[] = [
  {
    kind: "user-message",
    id: "ask",
    text: "Show me the account rules screens.",
    resources: [],
    tools: [],
    occurredAt: "2026-10-12T09:00:00.000Z",
  },
  {
    kind: "agent-message",
    id: "answer",
    turnId: "turn-1",
    text: [
      "Here are the four states.",
      "",
      "![Overview](artifact:11111111-1111-4111-8111-111111111111)",
      "",
      "![After locking a rule](artifact:22222222-2222-4222-8222-222222222222)",
      "",
      "![Workspace admin view](artifact:33333333-3333-4333-8333-333333333333)",
      "",
      "![Member view](artifact:44444444-4444-4444-8444-444444444444)",
    ].join("\n"),
    streaming: false,
    occurredAt: "2026-10-12T09:00:05.000Z",
  },
];

function Harness() {
  return (
    <LightboxProvider>
      <main className="og-root flex h-full flex-col bg-og-bg p-4 text-og-fg">
        <MessageTimeline
          className="min-h-0 flex-1 overflow-hidden"
          items={items}
          renderMessageText={(text) => (
            <Markdown renderImage={(image) => <ChatImage {...image} />}>{text}</Markdown>
          )}
        />
      </main>
    </LightboxProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
