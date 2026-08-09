import { describe, expect, test } from "bun:test";
import {
  editableArtifactId,
  editableArtifactLiveHintSubject,
  editableArtifactOutboxId,
  editableArtifactStateHash,
  encodeEditableArtifactBrokerHint,
} from "@opengeni/core";

import { EventBusEditableArtifactLiveHints } from "../src/editable-artifact-live-hints";

const scope = { accountId: "account-a", workspaceId: "workspace-a" };
const artifactId = editableArtifactId("00000000000000010000000000000001");

describe("event-bus editable artifact live hints", () => {
  test("establishes a flush barrier then projects only matching bounded hints", async () => {
    const messages = asyncQueue<{ data: Uint8Array }>();
    const trace: string[] = [];
    const connection = {
      subscribe(subject: string) {
        trace.push(`subscribe:${subject}`);
        return Object.assign(messages.iterable, {
          unsubscribe: () => {
            trace.push("unsubscribe");
            messages.end();
          },
        });
      },
      publish() {},
      async flush() {
        trace.push("flush");
      },
    };
    const port = new EventBusEditableArtifactLiveHints({
      getOpStreamConnection: () => connection,
    });
    const heads: number[] = [];
    const release = await port.subscribe({
      scope,
      artifactId,
      onHint: (hint) => heads.push(hint.headSequence),
      onReconnect: () => trace.push("reconnect"),
    });
    expect(trace).toEqual([
      `subscribe:${editableArtifactLiveHintSubject(scope, artifactId)}`,
      "flush",
    ]);

    messages.push({ data: new Uint8Array([1, 2, 3]) });
    messages.push({
      data: encodeEditableArtifactBrokerHint({
        outboxId: editableArtifactOutboxId("00000000000000020000000000000002"),
        event: {
          kind: "transaction_committed",
          schemaVersion: 1,
          scope,
          artifactId,
          modality: "spreadsheet",
          serverTransactionId: "00000000000000030000000000000003" as never,
          sequenceStart: 1,
          sequenceEnd: 4,
          stateHash: editableArtifactStateHash(`sha256:${"4".repeat(64)}`),
          operationProtocolVersion: 1,
          committedAt: "2026-08-08T12:00:00.000Z",
        },
        state: "publishing",
        attemptCount: 1,
        leaseOwner: "worker-1",
        leaseExpiresAt: "2026-08-08T12:01:00.000Z",
        nextAttemptAt: "2026-08-08T12:00:00.000Z",
        lastErrorCode: null,
        publishedAt: null,
        deadLetteredAt: null,
        createdAt: "2026-08-08T12:00:00.000Z",
      }).payload,
    });
    await settle();
    expect(heads).toEqual([4]);
    release();
    expect(trace.at(-1)).toBe("unsubscribe");
  });
});

function asyncQueue<T>() {
  const values: T[] = [];
  const readers: Array<(result: IteratorResult<T>) => void> = [];
  let done = false;
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            const value = values.shift();
            if (value) return Promise.resolve({ done: false as const, value });
            if (done) return Promise.resolve({ done: true as const, value: undefined });
            return new Promise<IteratorResult<T>>((resolve) => readers.push(resolve));
          },
        };
      },
    },
    push(value: T) {
      const reader = readers.shift();
      if (reader) reader({ done: false, value });
      else values.push(value);
    },
    end() {
      done = true;
      for (const reader of readers.splice(0)) reader({ done: true, value: undefined });
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
