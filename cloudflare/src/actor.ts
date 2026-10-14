/** Typed stub for the per-video Durable Object (src/video.ts), importable without the class. */
export interface VideoStub {
  start(videoId: string): Promise<{ version: number; step: string }>;
  reindex(videoId: string): Promise<boolean>;
  purge(videoId: string): Promise<{ gemini_files_deleted: string[] }>;
  getState(): Promise<Record<string, any> | null>;
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export const videoStub = (ns: DurableObjectNamespace, videoId: string) => ns.get(ns.idFromName(videoId)) as unknown as VideoStub;
