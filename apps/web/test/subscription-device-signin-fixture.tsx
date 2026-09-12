import { createRoot } from "react-dom/client";
import { CodexDeviceCodePanel } from "../src/components/codex-connection";
import { SuperGrokDeviceCodePanel } from "../src/components/supergrok-connection";
import { DeviceAuthorization } from "@opengeni/react/connect";
import "../src/styles.css";
import "@opengeni/react/connect.css";

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto grid max-w-3xl gap-8 px-5 py-10 text-fg">
    <h1 className="text-xl font-semibold">Subscription sign-in</h1>
    <section aria-label="Codex" className="grid gap-3">
      <h2 className="text-sm font-medium">Codex</h2>
      <CodexDeviceCodePanel
        userCode="ABCD-1234"
        verificationUri="https://auth.openai.com/codex/device"
      />
    </section>
    <section aria-label="SuperGrok" className="grid gap-3">
      <h2 className="text-sm font-medium">SuperGrok</h2>
      <SuperGrokDeviceCodePanel userCode="XAI-5678" verificationUri="https://auth.x.ai/device" />
    </section>
    <section aria-label="Embedded default" className="grid gap-3">
      <h2 className="text-sm font-medium">Embedded default (unchanged)</h2>
      <DeviceAuthorization userCode="HOST-1234" verificationUri="https://example.com/device" />
    </section>
  </main>,
);
