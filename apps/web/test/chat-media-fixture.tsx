import { MessageTimeline, type TimelineItem } from "@opengeni/react";
import { createRoot } from "react-dom/client";
import { ChatInteractiveBlock } from "../src/components/artifacts/chat-interactive-block";
import { InlineChatImage } from "../src/components/artifacts/inline-chat-image";
import { mediaFixture, workspaceId, siteId, imageId } from "./chat-media-context-fixture";
import "../src/styles.css";

declare global {
  interface Window {
    chatMediaFixture: typeof mediaFixture;
  }
}
window.chatMediaFixture = mediaFixture;
const items: TimelineItem[] = Array.from({ length: 18 }, (_, index) => ({
  kind: "agent-message",
  id: `message-${index}`,
  turnId: `turn-${index}`,
  occurredAt: "2026-09-14T00:00:00Z",
  streaming: false,
  text: String(index),
}));
createRoot(document.getElementById("root")!).render(
  <main className="flex h-dvh flex-col bg-bg text-fg">
    <h1 className="p-3 text-lg">Chat media entry regression</h1>
    <div className="min-h-0 flex-1">
      <MessageTimeline
        className="h-full"
        items={items}
        status="completed"
        renderMessageText={(text) => {
          const index = Number(text);
          return (
            <div data-media-row={index}>
              <p>Message {index}</p>
              {index % 3 === 0 ? (
                <ChatInteractiveBlock
                  workspaceId={workspaceId}
                  kind="html"
                  content={
                    '<h2>Inline preview</h2><div id="late">Growing content</div><script>setTimeout(()=>{document.getElementById("late").style.height="1100px"},700)</script>'
                  }
                />
              ) : index % 3 === 1 ? (
                <ChatInteractiveBlock
                  workspaceId={workspaceId}
                  kind="site"
                  content={JSON.stringify({ siteId })}
                />
              ) : (
                <InlineChatImage
                  workspaceId={workspaceId}
                  artifactId={imageId}
                  alt={`Image ${index}`}
                />
              )}
              <p data-media-anchor={index}>After media {index}</p>
            </div>
          );
        }}
      />
    </div>
    <footer className="h-16 shrink-0 border-t p-4">Composer</footer>
  </main>,
);
