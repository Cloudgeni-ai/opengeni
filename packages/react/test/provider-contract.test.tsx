import { describe, expect, test } from "bun:test";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";
import { OpenGeniProvider } from "../src/provider";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

describe("OpenGeniProvider deployment contract", () => {
  test("blocks stale embedded clients with explicit reload guidance before reconnect", async () => {
    const actual = "future-contract";
    sessionStorage.setItem(
      `opengeni.reloadForApiContract:${actual}`,
      OPENGENI_API_CONTRACT_REVISION,
    );
    let workspaceReads = 0;
    const client = fakeClient({
      getClientConfig: async () => ({ apiContractRevision: actual }) as never,
      getWorkspace: async () => {
        workspaceReads += 1;
        return {} as never;
      },
    });
    const rendered = await renderComponent(
      <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
        <div>stale child</div>
      </OpenGeniProvider>,
    );
    await flush();

    const screen = rendered.container.querySelector<HTMLElement>(
      "[data-opengeni-api-contract-mismatch]",
    );
    expect(screen).not.toBeNull();
    expect(screen?.textContent).toContain("OpenGeni updated");
    expect(screen?.textContent).toContain(`Client ${OPENGENI_API_CONTRACT_REVISION}`);
    expect(screen?.textContent).toContain(`API ${actual}`);
    expect(workspaceReads).toBe(0);

    await rendered.unmount();
    sessionStorage.removeItem(`opengeni.reloadForApiContract:${actual}`);
  });
});
