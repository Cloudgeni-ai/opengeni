export interface RuntimeEnv { [key: string]: string | undefined }
export interface Job { id: string; payload: string }
export interface HttpResponse { status: number }
export type Fetcher = (url: string, init: {
  method: string; body: string; signal?: AbortSignal;
}) => Promise<HttpResponse>;
export interface Store { save(id: string, status: number): Promise<void> }
