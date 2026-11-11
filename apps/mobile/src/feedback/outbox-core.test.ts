import { expect, test } from "bun:test";
import {
  createFeedbackOutbox,
  type FeedbackOutboxStorage,
  type QueuedFeedback,
} from "./outbox-core";

function memoryStorage() {
  const files = new Map<string, string>();
  const storage: FeedbackOutboxStorage = {
    async list(accountId) {
      return [...files.keys()]
        .filter((key) => key.startsWith(`${accountId}/`))
        .map((key) => key.slice(accountId.length + 1));
    },
    async read(accountId, id) {
      return files.get(`${accountId}/${id}`) ?? null;
    },
    async write(accountId, id, value) {
      files.set(`${accountId}/${id}`, value);
    },
    async remove(accountId, id) {
      files.delete(`${accountId}/${id}`);
    },
  };
  return { files, storage };
}

const report = (key: string) => ({ idempotencyKey: key, comment: `report ${key}` });

test("a report waits on the device while the server is unreachable, then goes out in order", async () => {
  const { files, storage } = memoryStorage();
  let online = false;
  const sent: string[] = [];
  let clock = 0;
  const outbox = createFeedbackOutbox({
    storage,
    now: () => new Date(++clock * 1000),
    async send(_accountId, entry: QueuedFeedback) {
      if (!online) throw new Error("offline");
      sent.push(entry.request.idempotencyKey);
    },
    classify: () => "retry",
  });
  expect(await outbox.submit("a", "w", report("k1"))).toEqual({ sent: 0, pending: 1 });
  expect(await outbox.submit("a", "w", report("k2"))).toEqual({ sent: 0, pending: 2 });
  expect(files.size).toBe(2);
  expect(outbox.pending("a")).toBe(2);
  online = true;
  expect(await outbox.flush("a")).toEqual({ sent: 2, pending: 0 });
  expect(sent).toEqual(["k1", "k2"]);
  expect(files.size).toBe(0);
  expect(outbox.pending("a")).toBe(0);
});

test("a report the server refuses for good is dropped so later ones still send", async () => {
  const { files, storage } = memoryStorage();
  const sent: string[] = [];
  const outbox = createFeedbackOutbox({
    storage,
    async send(_accountId, entry) {
      if (entry.request.idempotencyKey === "bad") throw new Error("invalid");
      sent.push(entry.request.idempotencyKey);
    },
    classify: () => "rejected",
  });
  await storage.write(
    "a",
    "bad",
    JSON.stringify({ workspaceId: "w", queuedAt: "1", request: report("bad") }),
  );
  await storage.write("a", "junk", "{not json");
  expect(await outbox.submit("a", "w", report("good"))).toEqual({ sent: 1, pending: 0 });
  expect(sent).toEqual(["good"]);
  expect(files.size).toBe(0);
});

test("reports stay with the account that wrote them", async () => {
  const { storage } = memoryStorage();
  const sentBy: string[] = [];
  const outbox = createFeedbackOutbox({
    storage,
    async send(accountId) {
      sentBy.push(accountId);
    },
    classify: () => "retry",
  });
  await storage.write(
    "b",
    "k",
    JSON.stringify({ workspaceId: "w", queuedAt: "1", request: report("k") }),
  );
  await outbox.flush("a");
  expect(sentBy).toEqual([]);
  await outbox.flush("b");
  expect(sentBy).toEqual(["b"]);
});
