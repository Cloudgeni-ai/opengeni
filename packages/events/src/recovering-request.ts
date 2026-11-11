import {
  createInbox,
  ErrorCode,
  NatsError,
  type Msg,
  type NatsConnection,
  type Subscription,
  type Status,
} from "nats";

/** Opt-in only for a caller that can safely resend the SAME delivery. Listen
 * before publishing so a responder reconnect cannot strand an outstanding
 * request until its operation deadline. One inbox and deadline survive resends;
 * neither receipt recovery nor transport reconnect grants another execution. */
export async function recoveringRequest(
  connection: NatsConnection,
  subject: string,
  payload: Uint8Array,
  options: { timeout: number; resendOn?: string },
  observeTransport: (listener: (status: Status) => void) => () => void,
): Promise<Msg> {
  const subscriptions: Subscription[] = [];
  let removeReconnect: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let published = false;
  let resent = false;
  try {
    return await new Promise<Msg>((resolve, reject) => {
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        // A refusal of a resend cannot certify that the original did not run.
        reject(
          resent
            ? Object.assign(NatsError.errorForCode(ErrorCode.Timeout), { cause: error })
            : error,
        );
      };
      const inbox = createInbox();
      const send = () => {
        if (settled) return;
        resent ||= published;
        try {
          connection.publish(subject, payload, { reply: inbox });
          published = true;
        } catch (error) {
          fail(error);
        }
      };
      const watch = (subscription: Subscription) => {
        subscriptions.push(subscription);
        void subscription.closed.then(() =>
          fail(NatsError.errorForCode(ErrorCode.ConnectionClosed)),
        );
      };
      watch(
        connection.subscribe(inbox, {
          callback: (error, message) => {
            if (error) return fail(error);
            if (message.data.length === 0 && message.headers?.code === 503) {
              return fail(NatsError.errorForCode(ErrorCode.NoResponders));
            }
            if (!settled) {
              settled = true;
              resolve(message);
            }
          },
        }),
      );
      if (options.resendOn) {
        watch(
          connection.subscribe(options.resendOn, {
            callback: (error) => (error ? fail(error) : send()),
          }),
        );
      }
      removeReconnect = observeTransport((status) => {
        if (status.type === "reconnect") send();
        // Core NATS publishes authorization errors on its status feed, not the
        // reply inbox. Preserve the ordinary request API's fail-fast behavior.
        if (
          status.permissionContext?.operation === "publish" &&
          status.permissionContext.subject === subject
        ) {
          fail(NatsError.errorForCode(ErrorCode.PermissionsViolation));
        }
      });
      timer = setTimeout(() => fail(NatsError.errorForCode(ErrorCode.Timeout)), options.timeout);
      send();
    });
  } finally {
    settled = true;
    clearTimeout(timer);
    removeReconnect?.();
    for (const subscription of subscriptions) subscription.unsubscribe();
  }
}
