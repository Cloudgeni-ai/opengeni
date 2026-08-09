import { describe, expect, test } from "bun:test";
import { JsonBase64ResponseError, readJsonBase64Field } from "../src/json-base64";

function streamedResponse(body: string, chunkBytes = 1, headers?: HeadersInit): Response {
  const encoded = new TextEncoder().encode(body);
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= encoded.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(encoded.byteLength, offset + chunkBytes);
        controller.enqueue(encoded.slice(offset, end));
        offset = end;
      },
    }),
    { headers },
  );
}

describe("bounded streaming JSON base64 decoder", () => {
  test("decodes direct and first-array string fields across arbitrary boundaries", async () => {
    const expected = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    const encoded = Buffer.from(expected).toString("base64");
    const direct = await readJsonBase64Field(
      streamedResponse(JSON.stringify({ data: [{ b64_json: encoded }] }), 1),
      {
        fieldName: "b64_json",
        shape: "string",
        maxResponseBytes: 1_024,
        maxDecodedBytes: 128,
        label: "direct image",
      },
    );
    const array = await readJsonBase64Field(
      streamedResponse(JSON.stringify({ images: [encoded], ignored: "tail" }), 2),
      {
        fieldName: "images",
        shape: "first_array_string",
        maxResponseBytes: 1_024,
        maxDecodedBytes: 128,
        label: "array image",
      },
    );
    expect(direct).toEqual(expected);
    expect(array).toEqual(expected);
  });

  test("does not confuse an escaped or value string with the requested object key", async () => {
    const expected = Uint8Array.from([1, 2, 3]);
    const body = `{"other":"images","ima\\u0067es":"ignored","images":["${Buffer.from(expected).toString("base64")}"]}`;
    expect(
      await readJsonBase64Field(streamedResponse(body, 3), {
        fieldName: "images",
        shape: "first_array_string",
        maxResponseBytes: 1_024,
        maxDecodedBytes: 128,
        label: "image",
      }),
    ).toEqual(expected);
  });

  test("rejects non-canonical base64 and empty arrays", async () => {
    await expect(
      readJsonBase64Field(streamedResponse('{"images":["AB=="]}'), {
        fieldName: "images",
        shape: "first_array_string",
        maxResponseBytes: 1_024,
        maxDecodedBytes: 128,
        label: "image",
      }),
    ).rejects.toBeInstanceOf(JsonBase64ResponseError);
    await expect(
      readJsonBase64Field(streamedResponse('{"images":[]}'), {
        fieldName: "images",
        shape: "first_array_string",
        maxResponseBytes: 1_024,
        maxDecodedBytes: 128,
        label: "image",
      }),
    ).rejects.toBeInstanceOf(JsonBase64ResponseError);
  });

  test("rejects declared and streamed response overflow before unbounded allocation", async () => {
    await expect(
      readJsonBase64Field(
        streamedResponse('{"images":["AQID"]}', 8, { "content-length": "1000" }),
        {
          fieldName: "images",
          shape: "first_array_string",
          maxResponseBytes: 32,
          maxDecodedBytes: 8,
          label: "image",
        },
      ),
    ).rejects.toBeInstanceOf(JsonBase64ResponseError);
    await expect(
      readJsonBase64Field(streamedResponse(`{"padding":"${"x".repeat(64)}"}`), {
        fieldName: "images",
        shape: "first_array_string",
        maxResponseBytes: 32,
        maxDecodedBytes: 8,
        label: "image",
      }),
    ).rejects.toBeInstanceOf(JsonBase64ResponseError);
  });
});
