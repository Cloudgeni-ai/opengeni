import { expect, test } from "bun:test";
import {
  Capabilities,
  ControlRequest,
  ControlResponse,
  ErrorCode,
  Hello,
} from "@opengeni/agent-proto";
import { helloRuntimeCapabilities } from "../src/sandbox/metrics-ingestion";
import { reconcileScreenControlOnHello } from "../src/sandbox/screen-control";

const target = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  enrollmentId: "22222222-2222-4222-8222-222222222222",
  connectionInstanceId: "33333333-3333-4333-8333-333333333333",
};

function hello(capabilities: Partial<Capabilities>): Hello {
  return Hello.fromPartial({ capabilities: Capabilities.fromPartial(capabilities) });
}

/** A request connection that answers each credentialRenew from a script. */
function fakeBus(replies: Array<"offline" | "consented">) {
  const subjects: string[] = [];
  const bus = {
    getRequestConnection: () => ({
      request: async (subject: string, payload: Uint8Array) => {
        const request = ControlRequest.decode(payload);
        expect(request.op?.$case).toBe("credentialRenew");
        subjects.push(subject);
        const reply = replies.shift();
        return {
          data: ControlResponse.encode(
            reply === "offline"
              ? {
                  requestId: request.requestId,
                  error: {
                    code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
                    message: "offline",
                    retryable: true,
                    detail: {},
                  },
                  result: undefined,
                }
              : {
                  requestId: request.requestId,
                  error: undefined,
                  result: {
                    $case: "credentialRenew",
                    credentialRenew: { renewed: true, consentedScreenControl: true },
                  },
                },
          ).finish(),
        };
      },
    }),
  };
  return { bus: bus as never, subjects };
}

test("a Hello renews credentials only when the row allows screen control and they lack it", async () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  const { bus, subjects } = fakeBus([]);
  const skip = async (allow: boolean, caps: Partial<Capabilities>) =>
    await reconcileScreenControlOnHello(
      { bus, sleep },
      { authority: { allowScreenControl: allow }, hello: hello(caps), target },
    );
  expect(await skip(false, { credentialRenew: true, consentedScreenControl: false })).toBeNull();
  expect(await skip(true, { credentialRenew: false, consentedScreenControl: false })).toBeNull();
  expect(await skip(true, { credentialRenew: true, consentedScreenControl: true })).toBeNull();
  expect(subjects).toHaveLength(0);
  expect(sleeps).toHaveLength(0);
});

test("a Hello renewal waits for the agent to subscribe and retries once", async () => {
  const sleeps: number[] = [];
  const { bus, subjects } = fakeBus(["offline", "consented"]);
  const outcome = await reconcileScreenControlOnHello(
    {
      bus,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
    {
      authority: { allowScreenControl: true },
      hello: hello({ credentialRenew: true, consentedScreenControl: false }),
      target,
    },
  );
  expect(outcome).toEqual({ kind: "renewed", consentedScreenControl: true });
  expect(sleeps).toEqual([2_000, 5_000]);
  expect(subjects).toEqual([
    `agent.${target.workspaceId}.${target.enrollmentId}.connection.${target.connectionInstanceId}.rpc`,
    `agent.${target.workspaceId}.${target.enrollmentId}.connection.${target.connectionInstanceId}.rpc`,
  ]);
});

test("Hello capabilities record renew support, held consent and Mac permissions", () => {
  expect(
    helloRuntimeCapabilities(
      hello({
        exec: true,
        credentialRenew: true,
        consentedScreenControl: true,
        macPermissions: { screenRecording: true, accessibility: false, inputMonitoring: true },
      }),
    ),
  ).toMatchObject({
    exec: true,
    credentialRenew: true,
    screenControl: true,
    macScreenRecording: true,
    macAccessibility: false,
    macInputMonitoring: true,
  });
  const older = helloRuntimeCapabilities(hello({ exec: true }));
  expect(older).toMatchObject({ credentialRenew: false, screenControl: false });
  expect("macScreenRecording" in older).toBe(false);
});
