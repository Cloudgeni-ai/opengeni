export interface AuditSink { write(event: string): Promise<void> }
export async function recordAccepted(enabled: boolean, sink: AuditSink, id: string) {
  if (enabled) await sink.write(`accepted:${id}`);
}
