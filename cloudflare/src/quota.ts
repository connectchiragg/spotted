/** Guest library limits, shared by uploads (api.ts) and Photos imports (library.ts). */
import { Limits } from './env';

export interface Usage { videos: number; bytes: number }

/** Why a guest cannot add one more video of `size` bytes, with the HTTP status for an upload; null when they can. */
export function libraryReason(usage: Usage, size: number | null, limits: Limits): { status: number; detail: string } | null {
  if (usage.videos >= limits.maxVideos) return { status: 429, detail: `You've reached your limit of ${limits.maxVideos} videos. Delete a video to add more.` };
  if (usage.bytes + (size ?? 0) > limits.maxBytes) {
    return { status: 413, detail: `This would go over your ${Math.round(limits.maxBytes / 1e6)} MB storage limit. Delete a video to add more.` };
  }
  return null;
}
