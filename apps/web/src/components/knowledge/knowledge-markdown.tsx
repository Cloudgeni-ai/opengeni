import type { ReactNode } from "react";

/** Headings, bullets and paragraphs, as they read. Enough for instructions. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length === 0) return;
    const items = bullets;
    blocks.push(
      <ul
        key={`list-${blocks.length}`}
        className="flex list-disc flex-col gap-1 pl-5 marker:text-fg-subtle"
      >
        {items.map((item, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- lines of one static text
          <li key={index}>{item}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      bullets.push(bullet[1] ?? "");
      continue;
    }
    flush();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    blocks.push(
      heading ? (
        <p key={`h-${blocks.length}`} className="font-semibold text-fg">
          {heading[1]}
        </p>
      ) : (
        <p key={`p-${blocks.length}`}>{line}</p>
      ),
    );
  }
  flush();
  return (
    <div
      className={`flex min-w-0 flex-col gap-2 text-sm leading-6 break-words text-fg ${className ?? ""}`}
    >
      {blocks}
    </div>
  );
}
