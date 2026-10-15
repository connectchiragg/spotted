/** Typed stub for the per-video Durable Object (src/video.ts), importable without the class. */
export interface VideoStub {
  start(videoId: string, notBefore?: number): Promise<{ version: number; step: string; next_retry_at?: number | null }>;
  restart(videoId: string, notBefore?: number): Promise<{ version: number; step: string }>;
  reindex(videoId: string): Promise<boolean>;
  purge(videoId: string): Promise<{ gemini_files_deleted: string[] }>;
  purgeIfOrphan(videoId: string): Promise<boolean>;
  getState(): Promise<Record<string, any> | null>;
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export const videoStub = (ns: DurableObjectNamespace, videoId: string) => ns.get(ns.idFromName(videoId)) as unknown as VideoStub;

/** Typed stub for the singleton LibraryDO (src/library.ts). */
export interface LibraryStub { poke(): Promise<void> }
export const libraryStub = (ns: DurableObjectNamespace) => ns.get(ns.idFromName('library')) as unknown as LibraryStub;
