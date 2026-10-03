import { expect, test } from "bun:test";
import {
  KnowledgeIndexUsageLimitError,
  knowledgeIndexFailureDiagnostic,
} from "../src/activities/knowledge-indexing";

const sentinel = "private-knowledge-content-8c1f";

test("classifies provider, persistence, worker, and limit failures without their content", () => {
  const provider = Object.assign(new Error(`rate limited ${sentinel}`), {
    status: 429,
    code: sentinel,
    body: sentinel,
  });
  expect(knowledgeIndexFailureDiagnostic("embedding", provider)).toEqual({
    errorClass: "KnowledgeIndexOperationError",
    errorCode: "knowledge_index_embedding_failed",
    origin: "worker",
    status: 429,
  });

  // postgres.js raises PostgresError; drizzle may wrap it as a cause.
  const postgres = Object.assign(new Error(`update ${sentinel} failed`), {
    name: "PostgresError",
    code: "40001",
    where: sentinel,
  });
  const wrapped = Object.assign(new Error(`query ${sentinel}`), {
    name: "DrizzleQueryError",
    cause: postgres,
  });
  expect(knowledgeIndexFailureDiagnostic("processing", wrapped)).toEqual({
    errorClass: "KnowledgeIndexOperationError",
    errorCode: "knowledge_index_persistence_failed",
    origin: "db",
    sqlState: "40001",
  });
  expect(
    knowledgeIndexFailureDiagnostic(
      "processing",
      Object.assign(new Error("x"), { name: "PostgresError", code: sentinel }),
    ),
  ).toEqual({
    errorClass: "KnowledgeIndexOperationError",
    errorCode: "knowledge_index_persistence_failed",
    origin: "db",
  });

  // Only a PostgreSQL error in the cause chain is attributed to the database.
  const chunking = Object.assign(new Error(`chunk ${sentinel}`), {
    code: "22001",
    cause: new Error(sentinel),
  });
  expect(knowledgeIndexFailureDiagnostic("processing", chunking)).toEqual({
    errorClass: "KnowledgeIndexOperationError",
    errorCode: "knowledge_index_failed",
    origin: "worker",
  });

  expect(
    knowledgeIndexFailureDiagnostic("processing", new KnowledgeIndexUsageLimitError()),
  ).toEqual({
    errorClass: "KnowledgeIndexOperationError",
    errorCode: "knowledge_index_usage_limit_reached",
    origin: "worker",
  });

  const invalidStatus = Object.assign(new Error(sentinel), { status: 42 });
  expect(knowledgeIndexFailureDiagnostic("embedding", invalidStatus)).toEqual({
    errorClass: "KnowledgeIndexOperationError",
    errorCode: "knowledge_index_embedding_failed",
    origin: "worker",
  });
  expect(JSON.stringify(knowledgeIndexFailureDiagnostic("embedding", provider))).not.toContain(
    sentinel,
  );
});

test("a hostile error cannot break classification", () => {
  const hostile = new Proxy(new Error(sentinel), {
    getOwnPropertyDescriptor() {
      throw new Error(`hostile ${sentinel}`);
    },
    get() {
      throw new Error(`hostile ${sentinel}`);
    },
  });
  expect(knowledgeIndexFailureDiagnostic("embedding", hostile)).toEqual({
    errorClass: "KnowledgeIndexOperationError",
    errorCode: "knowledge_index_embedding_failed",
    origin: "worker",
  });
  expect(knowledgeIndexFailureDiagnostic("processing", hostile)).toEqual({
    errorClass: "KnowledgeIndexOperationError",
    errorCode: "knowledge_index_failed",
    origin: "worker",
  });
  expect(knowledgeIndexFailureDiagnostic("processing", null)).toEqual({
    errorClass: "KnowledgeIndexOperationError",
    errorCode: "knowledge_index_failed",
    origin: "worker",
  });
});
