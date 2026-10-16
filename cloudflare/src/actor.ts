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

/** Typed stub for a user's LibraryDO (src/library.ts). The owner's keeps its original name, 'library'. */
export interface LibraryStub { poke(userId: string): Promise<void> }
export const libraryName = (userId: string) => (userId === 'owner' ? 'library' : `library:${userId}`);
export const libraryStub = (ns: DurableObjectNamespace, userId: string) => ns.get(ns.idFromName(libraryName(userId))) as unknown as LibraryStub;
