import { expect, test } from "bun:test";
import OpenAI from "openai";
import { testSettings } from "@opengeni/testing";
import { configuredProviders } from "@opengeni/config";
import {
  generateSessionTitle,
  requestRemoteCompactionV2,
  summarizeForCompaction,
} from "../src/index";
import { ReplayableJsonOpenAI } from "../src/replayable-json-body";
import { withModelCallOutputBound } from "../src/model-request-capture";

const history = [{ type: "message", role: "user", content: "Preserve the accepted task" }];

for (const api of ["chat", "responses", "remote"] as const) {
  test(`${api} compaction awaits admission before provider dispatch and usage settlement`, async () => {
    const events: string[] = [];
    let request: Record<string, unknown> | undefined;
    const client = new OpenAI({
      apiKey: "test-key",
      baseURL: "http://compaction.test/v1",
      maxRetries: 0,
      fetch: async (_url, init) => {
        events.push("dispatch");
        if (typeof init?.body !== "string") throw new Error("Expected JSON provider request");
        request = JSON.parse(init.body);
        return Response.json(
          api === "chat"
            ? {
                id: "compaction",
                choices: [{ finish_reason: "stop", message: { content: "Accepted task summary" } }],
                usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
              }
            : {
                id: "compaction",
                status: "completed",
                output:
                  api === "remote"
                    ? [{ type: "compaction", encrypted_content: "opaque" }]
                    : [
                        {
                          type: "message",
                          role: "assistant",
                          status: "completed",
                          content: [{ type: "output_text", text: "Accepted task summary" }],
                        },
                      ],
                usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
              },
        );
      },
    });
    const accounting = {
      onModelCallAdmission: async () => {
        events.push("admission");
        await Promise.resolve();
        expect(request).toBeUndefined();
        return { maxOutputTokens: 7 };
      },
      onUsage: async () => {
        events.push("settlement");
      },
    };
    if (api === "remote") {
      await requestRemoteCompactionV2(testSettings(), history, {
        client,
        model: "gpt-6-astra",
        preparedRequest: {
          systemInstructions: "Keep the accepted task",
          tools: [],
          handoffs: [],
          outputType: "text",
          modelSettings: {},
          tracing: false,
        },
        ...accounting,
      });
      expect(request?.max_output_tokens).toBeUndefined();
    } else {
      await summarizeForCompaction(testSettings(), history, {
        client,
        api,
        maxOutputTokens: 100,
        ...accounting,
      });
      expect(request?.[api === "chat" ? "max_tokens" : "max_output_tokens"]).toBe(7);
    }
    expect(events).toEqual(["admission", "dispatch", "settlement"]);
  });

  test(`${api} compaction preserves an admission refusal without calling the provider`, async () => {
    const refusal = new Error("budget exhausted");
    let providerCalls = 0;
    const client = new OpenAI({
      apiKey: "test-key",
      baseURL: "http://compaction.test/v1",
      maxRetries: 0,
      fetch: async () => {
        providerCalls += 1;
        throw new Error("Admission must veto dispatch");
      },
    });
    const accounting = {
      onModelCallAdmission: async () => {
        throw refusal;
      },
    };
    const operation =
      api === "remote"
        ? requestRemoteCompactionV2(testSettings(), history, {
            client,
            model: "gpt-6-astra",
            preparedRequest: {
              systemInstructions: "Keep the accepted task",
              tools: [],
              handoffs: [],
              outputType: "text",
              modelSettings: {},
              tracing: false,
            },
            ...accounting,
          })
        : summarizeForCompaction(testSettings(), history, { client, api, ...accounting });
    await expect(operation).rejects.toBe(refusal);
    expect(providerCalls).toBe(0);
  });
}

for (const api of ["chat", "responses", "remote", "ordinary"] as const) {
  for (const failure of ["network", "server"] as const) {
    test(`${api} reserved calls dispatch once on a ${failure} failure despite SDK retry configuration`, async () => {
      let providerCalls = 0;
      const client = new ReplayableJsonOpenAI({
        apiKey: "test-key",
        baseURL: "http://compaction.test/v1",
        maxRetries: 2,
        fetch: async () => {
          providerCalls += 1;
          if (failure === "network") throw new TypeError("Synthetic network failure");
          return Response.json(
            { error: { message: "Synthetic server failure" } },
            { status: 500, headers: { "retry-after-ms": "1" } },
          );
        },
      });
      const accounting = { onModelCallAdmission: async () => ({ maxOutputTokens: 7 }) };
      const operation =
        api === "ordinary"
          ? withModelCallOutputBound(
              { maxTokens: 7 },
              async () =>
                await client.responses.create({ model: "gpt-6-astra", input: "Accepted task" }),
            )
          : api === "remote"
            ? requestRemoteCompactionV2(testSettings(), history, {
                client,
                model: "gpt-6-astra",
                preparedRequest: {
                  systemInstructions: "Keep the accepted task",
                  tools: [],
                  handoffs: [],
                  outputType: "text",
                  modelSettings: {},
                  tracing: false,
                },
                ...accounting,
              })
            : summarizeForCompaction(testSettings(), history, { client, api, ...accounting });
      await expect(operation).rejects.toBeInstanceOf(Error);
      expect(providerCalls).toBe(1);
    });
  }
}

test("uncapped standalone summaries preserve configured SDK retries", async () => {
  let providerCalls = 0;
  const client = new ReplayableJsonOpenAI({
    apiKey: "test-key",
    baseURL: "http://compaction.test/v1",
    maxRetries: 2,
    fetch: async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return Response.json(
          { error: { message: "Synthetic transient server failure" } },
          { status: 500, headers: { "retry-after-ms": "1" } },
        );
      }
      return Response.json({
        id: "compaction",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Accepted task summary" }],
          },
        ],
      });
    },
  });
  expect(await summarizeForCompaction(testSettings(), history, { client })).toBe(
    "Accepted task summary",
  );
  expect(providerCalls).toBe(2);
});

for (const api of ["chat", "responses"] as const) {
  test(`${api} title inference reserves before dispatch and settles usage even without a usable title`, async () => {
    const settings = testSettings();
    const provider = configuredProviders(settings)[0];
    if (!provider) throw new Error("Expected configured test provider");
    const events: string[] = [];
    let request: Record<string, unknown> | undefined;
    const client = new ReplayableJsonOpenAI({
      apiKey: "test-key",
      baseURL: "http://compaction.test/v1",
      maxRetries: 2,
      fetch: async (_url, init) => {
        events.push("dispatch");
        request = await new Response(init?.body).json();
        return Response.json(
          api === "chat"
            ? {
                id: "title",
                choices: [{ finish_reason: "length", message: { content: null } }],
                usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
              }
            : {
                id: "title",
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                output: [],
                usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
              },
        );
      },
    });
    const result = await generateSessionTitle(settings, "Accepted task", {
      client,
      provider: { ...provider, api },
      onModelCallAdmission: async () => {
        events.push("admission");
        await Promise.resolve();
        expect(request).toBeUndefined();
        return { maxOutputTokens: 7 };
      },
      onUsage: async (usage) => {
        events.push("settlement");
        expect(usage.usage.totalTokens).toBe(11);
      },
    });
    expect(result.title).toBeNull();
    expect(events).toEqual(["admission", "dispatch", "settlement"]);
    expect(request?.[api === "chat" ? "max_tokens" : "max_output_tokens"]).toBe(7);
  });

  test(`${api} title inference preserves budget refusal and suppresses hidden SDK retries`, async () => {
    const settings = testSettings();
    const provider = configuredProviders(settings)[0];
    if (!provider) throw new Error("Expected configured test provider");
    let providerCalls = 0;
    const client = new ReplayableJsonOpenAI({
      apiKey: "test-key",
      baseURL: "http://compaction.test/v1",
      maxRetries: 2,
      fetch: async () => {
        providerCalls += 1;
        throw new TypeError("Synthetic network failure");
      },
    });
    const refusal = new Error("Budget exhausted");
    await expect(
      generateSessionTitle(settings, "Accepted task", {
        client,
        provider: { ...provider, api },
        onModelCallAdmission: async () => {
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
    expect(providerCalls).toBe(0);
    await expect(
      generateSessionTitle(settings, "Accepted task", {
        client,
        provider: { ...provider, api },
        onModelCallAdmission: async () => ({ maxOutputTokens: 7 }),
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(providerCalls).toBe(1);
  });
}

test("an empty title prompt consumes no reservation", async () => {
  let admissions = 0;
  expect(
    await generateSessionTitle(testSettings(), "  ", {
      onModelCallAdmission: async () => {
        admissions += 1;
        return { maxOutputTokens: 7 };
      },
    }),
  ).toEqual({ title: null, usage: null });
  expect(admissions).toBe(0);
});
