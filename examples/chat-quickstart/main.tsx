import { OpenGeniChat } from "@opengeni/react/chat";
import "@opengeni/react/compiled.css";
import { createRoot } from "react-dom/client";

// One conversation id per chat thread. A product would store this beside the
// thread it belongs to; the session id is derived from it deterministically.
const conversation = new URLSearchParams(location.search).get("conversation") ?? "c_1";

function App() {
  return (
    <main
      className="og-root"
      style={{ maxWidth: 720, margin: "2rem auto", padding: "0 1rem", height: "80vh" }}
    >
      <h1 style={{ fontSize: "1.25rem", marginBottom: "1rem" }}>OpenGeni chat quickstart</h1>
      <OpenGeniChat
        handlerUrl="/api/chat"
        conversation={conversation}
        // The demo server reads this header as the signed-in user. Replace it
        // with your real session cookie or bearer.
        headers={{ "x-demo-user": "u_42" }}
        placeholder="Ask anything"
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
