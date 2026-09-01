import type { OpenGeniExternalStore } from "@opengeni/sdk/session";
import type { Readable } from "svelte/store";

export type ControllerReadableOptions = Readonly<{
  owned?: boolean | undefined;
  acquire?: (() => (() => void) | undefined) | undefined;
  release?: (() => void) | undefined;
  startOnServer?: boolean | undefined;
}>;

/** Direct Svelte readable view over a controller; no copied writable authority. */
export function readableFromController<Snapshot>(
  controller: OpenGeniExternalStore<Snapshot>,
  options: ControllerReadableOptions = {},
): Readable<Snapshot> {
  return createControllerReadableLifecycle(controller, options).store;
}

function createControllerReadableLifecycle<Snapshot>(
  controller: OpenGeniExternalStore<Snapshot>,
  options: ControllerReadableOptions,
): Readonly<{ store: Readable<Snapshot>; destroy(): void }> {
  let subscribers = 0;
  let destroyed = false;
  let retirement = 0;
  let releaseAcquisition: (() => void) | undefined;

  const retire = () => {
    releaseAcquisition?.();
    releaseAcquisition = undefined;
    if (options.release) {
      destroyed = true;
      options.release();
    } else if (options.owned ?? true) {
      destroyed = true;
      controller.destroy();
    }
  };

  const store: Readable<Snapshot> = {
    subscribe(run) {
      if (destroyed) {
        run(controller.getSnapshot());
        return () => undefined;
      }
      retirement += 1;
      subscribers += 1;
      run(controller.getSnapshot());
      const unsubscribe = controller.subscribe(() => run(controller.getSnapshot()));
      if (subscribers === 1 && (options.startOnServer || typeof window !== "undefined")) {
        releaseAcquisition = options.acquire?.();
        void controller.start();
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        unsubscribe();
        subscribers = Math.max(0, subscribers - 1);
        if (subscribers !== 0) return;
        const ticket = ++retirement;
        queueMicrotask(() => {
          if (destroyed || subscribers !== 0 || ticket !== retirement) return;
          retire();
        });
      };
    },
  };
  return {
    store,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      retirement += 1;
      releaseAcquisition?.();
      releaseAcquisition = undefined;
      if (options.release) options.release();
      else if (options.owned ?? true) controller.destroy();
    },
  };
}

export type OpenGeniControllerStore<Controller extends OpenGeniExternalStore<unknown>> = Readonly<{
  controller: Controller;
  store: Readable<ReturnType<Controller["getSnapshot"]>>;
  destroy(): void;
}>;

export function controllerStore<Controller extends OpenGeniExternalStore<unknown>>(
  controller: Controller,
  options: ControllerReadableOptions = {},
): OpenGeniControllerStore<Controller> {
  const readable = createControllerReadableLifecycle(
    controller as OpenGeniExternalStore<ReturnType<Controller["getSnapshot"]>>,
    options,
  );
  return Object.freeze({
    controller,
    store: readable.store,
    destroy: readable.destroy,
  });
}
