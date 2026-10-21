// The small part of office.js (loaded from Microsoft's CDN by the page) that the
// add-in itself uses. Agent code gets the real `context` and `Excel` objects.
declare namespace Office {
  type AsyncResult<T> = {
    status: "succeeded" | "failed";
    value: T;
    error?: { code: number; message: string };
  };
  type Dialog = {
    addEventHandler(
      type: string,
      handler: (event: { message?: string; origin?: string; error?: number }) => void,
    ): void;
    close(): void;
  };
  const EventType: {
    DialogMessageReceived: string;
    DialogEventReceived: string;
    OfficeThemeChanged?: string;
  };
  function onReady(): Promise<{ host: string | null; platform: string | null }>;
  const context: {
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
        options: {
          height?: number;
          width?: number;
          displayInIframe?: boolean;
          promptBeforeOpen?: boolean;
        },
        callback: (result: AsyncResult<Dialog>) => void,
      ): void;
      messageParent(message: string): void;
      openBrowserWindow(url: string): void;
    };
  };
}

declare namespace Excel {
  type RequestContext = {
    workbook: { name: string; load(properties: string): void };
    sync(): Promise<void>;
  };
  function run<T>(batch: (context: RequestContext) => Promise<T>): Promise<T>;
}
