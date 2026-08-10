import { describe, expect, test } from "bun:test";
import {
  ConfirmedNatsEditableArtifactHintBroker,
  EditableArtifactNatsHintPublishError,
  type EditableArtifactHintNatsConnection,
} from "../src/editable-artifact-hint-broker";

describe("confirmed editable artifact NATS hint broker", () => {
  test("requires a flush ACK and remains usable after NATS reconnect", async () => {
    const connection = new TestNatsConnection();
    connection.flushFailures = 1;
    const broker = new ConfirmedNatsEditableArtifactHintBroker(connection);
    const input = publishInput();

    await expect(broker.publish(input)).rejects.toMatchObject({ code: "broker_unavailable" });
    connection.reconnect();
    await broker.publish(input);

    expect(connection.publishes).toHaveLength(2);
    expect(connection.trace).toEqual([
      "publish",
      "flush:disconnected",
      "reconnect",
      "publish",
      "flush:ack",
    ]);
  });

  test("rejects malformed or oversized hints before touching NATS", async () => {
    const connection = new TestNatsConnection();
    const broker = new ConfirmedNatsEditableArtifactHintBroker(connection, { maxHintBytes: 64 });

    await expect(
      broker.publish({ ...publishInput(), subject: "editable_artifacts.*.bad" }),
    ).rejects.toBeInstanceOf(EditableArtifactNatsHintPublishError);
    await expect(
      broker.publish({ ...publishInput(), payload: new Uint8Array(65) }),
    ).rejects.toMatchObject({ code: "broker_backpressure" });
    expect(connection.publishes).toHaveLength(0);
  });

  test("returns promptly when a timed publication is aborted", async () => {
    const connection = new TestNatsConnection();
    connection.flushGate = new Promise<void>(() => undefined);
    const broker = new ConfirmedNatsEditableArtifactHintBroker(connection);
    const abort = new AbortController();
    const publishing = broker.publish({ ...publishInput(), signal: abort.signal });
    abort.abort();

    await expect(publishing).rejects.toMatchObject({ code: "broker_unavailable" });
    expect(connection.publishes).toHaveLength(1);
  });

  test("drains the dedicated connection on shutdown", async () => {
    const connection = new TestNatsConnection();
    const broker = new ConfirmedNatsEditableArtifactHintBroker(connection);
    await broker.close();
    expect(connection.trace).toEqual(["drain"]);
  });
});

class TestNatsConnection implements EditableArtifactHintNatsConnection {
  readonly publishes: Array<{ subject: string; payload: Uint8Array }> = [];
  readonly trace: string[] = [];
  flushFailures = 0;
  flushGate: Promise<void> | null = null;
  private closedValue = false;
  private draining = false;

  publish(subject: string, payload?: Uint8Array): void {
    this.trace.push("publish");
    this.publishes.push({ subject, payload: payload?.slice() ?? new Uint8Array() });
  }

  async flush(): Promise<void> {
    if (this.flushFailures > 0) {
      this.flushFailures -= 1;
      this.trace.push("flush:disconnected");
      throw new Error("disconnected");
    }
    if (this.flushGate) await this.flushGate;
    this.trace.push("flush:ack");
  }

  reconnect(): void {
    this.trace.push("reconnect");
  }

  isClosed(): boolean {
    return this.closedValue;
  }

  isDraining(): boolean {
    return this.draining;
  }

  async drain(): Promise<void> {
    this.trace.push("drain");
    this.draining = true;
    this.closedValue = true;
  }

  async close(): Promise<void> {
    this.trace.push("close");
    this.closedValue = true;
  }

  async closed(): Promise<void> {}
}

function publishInput() {
  return {
    subject: "editable_artifacts.v1.account.workspace.00000000000000010000000000000001",
    payload: new TextEncoder().encode('{"kind":"head_advanced"}'),
    signal: new AbortController().signal,
  };
}
