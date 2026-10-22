// The small part of office.js (loaded by the pane page from Microsoft's CDN,
// which defines the `Office` and `Excel` globals) that the add-in kit uses.
// Typed locally so the SDK needs no Office type package; agent code gets the
// real `context` and `Excel` objects.

export type OfficeAsyncResult<T> = {
  status: "succeeded" | "failed";
  value: T;
  error?: { code: number; message: string };
};

export type OfficeDialog = {
  addEventHandler(
    type: string,
    handler: (event: { message?: string; origin?: string; error?: number }) => void,
  ): void;
  close(): void;
};

export type OfficeHost = {
  EventType: {
    DialogMessageReceived: string;
    DialogEventReceived: string;
    OfficeThemeChanged?: string;
    DocumentSelectionChanged?: string;
  };
  onReady(): Promise<{ host: string | null; platform: string | null }>;
  context: {
    diagnostics?: { host: string; version: string; platform: string };
    platform?: string;
    document?: {
      url?: string | null;
      addHandlerAsync?(type: string, handler: () => void): void;
      removeHandlerAsync?(type: string, options: { handler: () => void }): void;
    };
    /** Excel's theme colors (Office 2016 and later). */
    officeTheme?: { bodyBackgroundColor?: string };
    requirements: { isSetSupported(name: string, version?: string): boolean };
    ui: {
      displayDialogAsync(
        url: string,
        options: { height?: number; width?: number; promptBeforeOpen?: boolean },
        callback: (result: OfficeAsyncResult<OfficeDialog>) => void,
      ): void;
      messageParent(message: string): void;
      openBrowserWindow(url: string): void;
    };
  };
};

export type ExcelBatch<T> = (context: unknown) => Promise<T>;

export type ExcelHost = {
  run<T>(batch: ExcelBatch<T>): Promise<T>;
};

/** office.js's `Office` global. Throws when the page didn't load office.js. */
export function office(): OfficeHost {
  const value = (globalThis as { Office?: OfficeHost }).Office;
  if (!value) throw new Error("office.js is not loaded on this page");
  return value;
}

/** office.js's `Excel` global. Throws outside Excel. */
export function excel(): ExcelHost {
  const value = (globalThis as { Excel?: ExcelHost }).Excel;
  if (!value) throw new Error("Excel is not available on this page");
  return value;
}
