/**
 * Frame selection by pixel deviation, and the video duration from the MP4/MOV header.
 *
 * Candidates come from Media Transformations spritesheets: one JPEG per window that
 * stacks `count` tiles of `tileW x tileH` vertically (verified live: 15 tiles of 64x36
 * give a 64x540 JPEG). Each tile is reduced to grayscale and compared with the previous
 * one by mean absolute difference (MAD, 0-255). Selection keeps the first frame, then
 * frames whose change passes a threshold and are at least `minGap` seconds after the
 * last kept one; if more pass than the cap, the highest scores win, spread across time.
 * Then, while under the cap, gaps longer than `maxGap` seconds are split so slowly changing
 * footage still gets coverage.
 */
import jpeg from 'jpeg-js'; // pure-JS decoder: decode(bytes, { useTArray: true }) -> { width, height, data: RGBA }

export interface Candidate { t: number; score: number }
export interface Pick { index: number; t: number; score: number }

/** Grayscale tiles (Float32 luma per pixel) cut from a vertically stacked spritesheet JPEG. */
export function spriteTiles(bytes: Uint8Array, count: number): Float32Array[] {
  const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 64 }) as { width: number; height: number; data: Uint8Array };
  const tileH = Math.floor(image.height / count);
  if (tileH < 1) throw new Error('Spritesheet is smaller than its tile count');
  const tiles: Float32Array[] = [];
  for (let k = 0; k < count; k++) {
    const tile = new Float32Array(image.width * tileH);
    for (let y = 0; y < tileH; y++) {
      for (let x = 0; x < image.width; x++) {
        const p = ((k * tileH + y) * image.width + x) * 4;
        tile[y * image.width + x] = 0.299 * image.data[p] + 0.587 * image.data[p + 1] + 0.114 * image.data[p + 2];
      }
    }
    tiles.push(tile);
  }
  return tiles;
}

/** Mean absolute difference of two equally sized grayscale tiles (0 = identical, 255 = inverted). */
export function mad(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return a.length ? sum / a.length : 0;
}

/** Scores for a chronological run of tiles: the first tile scores Infinity (always a candidate). */
export function changeScores(tiles: Float32Array[], previous: Float32Array | null = null): number[] {
  return tiles.map((tile, i) => {
    const before = i ? tiles[i - 1] : previous;
    return before ? mad(before, tile) : Infinity;
  });
}

export interface SelectOptions { maxFrames: number; minGap: number; threshold: number; maxGap?: number; end?: number }

/**
 * Pick frames: always the first candidate, then candidates whose score >= threshold and that
 * are >= minGap s after the previous kept frame. Over the cap: keep the first plus the top
 * scores, but choose them per time bucket so the picks spread across the video.
 */
export function selectFrames(candidates: Candidate[], opts: SelectOptions): Pick[] {
  if (!candidates.length) return [];
  const sorted = [...candidates].sort((a, b) => a.t - b.t);
  const kept: Candidate[] = [sorted[0]];
  for (const c of sorted.slice(1)) {
    if (c.score >= opts.threshold && c.t - kept[kept.length - 1].t >= opts.minGap) kept.push(c);
  }
  let chosen = kept;
  if (kept.length > opts.maxFrames) {
    const [first, ...rest] = kept;
    const slots = opts.maxFrames - 1;
    const start = rest[0].t;
    const span = Math.max(1e-6, rest[rest.length - 1].t - start);
    // One bucket per slot across the time span; the best-scoring candidate of each bucket,
    // then fill any remaining slots with the best of what is left.
    const buckets = new Map<number, Candidate>();
    for (const c of rest) {
      const b = Math.min(slots - 1, Math.floor(((c.t - start) / span) * slots));
      const cur = buckets.get(b);
      if (!cur || c.score > cur.score) buckets.set(b, c);
    }
    const picked = new Set(buckets.values());
    for (const c of [...rest].sort((a, b) => b.score - a.score)) {
      if (picked.size >= slots) break;
      picked.add(c);
    }
    chosen = [first, ...[...picked].slice(0, slots)].sort((a, b) => a.t - b.t);
  }
  // Coverage: change detection alone leaves long gaps in slowly changing footage (a pan, a
  // talking head). While under the cap, split the largest gap longer than maxGap with its
  // best-scoring candidate (or the one nearest its middle when nothing changed).
  const maxGap = opts.maxGap ?? Infinity;
  const end = Math.max(sorted[sorted.length - 1].t, opts.end ?? 0);
  while (chosen.length < opts.maxFrames && Number.isFinite(maxGap)) {
    const bounds = [...chosen.map((c) => c.t), end];
    let gapAt = -1;
    let gap = 0;
    for (let i = 0; i < chosen.length; i++) if (bounds[i + 1] - bounds[i] > gap) { gap = bounds[i + 1] - bounds[i]; gapAt = i; }
    if (gap <= maxGap) break;
    const lo = bounds[gapAt];
    const hi = bounds[gapAt + 1];
    const inside = sorted.filter((c) => c.t - lo >= opts.minGap && (hi === end ? hi - c.t >= 0 : hi - c.t >= opts.minGap) && !chosen.includes(c));
    if (!inside.length) break;
    const mid = (lo + hi) / 2;
    const best = inside.reduce((a, b) => (b.score > a.score + 1 || (Math.abs(b.score - a.score) <= 1 && Math.abs(b.t - mid) < Math.abs(a.t - mid)) ? b : a));
    chosen = [...chosen, best].sort((a, b) => a.t - b.t);
  }
  return chosen.map((c, index) => ({ index, t: Math.round(c.t * 1000) / 1000, score: Number.isFinite(c.score) ? Math.round(c.score * 100) / 100 : 255 }));
}

/** Candidate windows: spritesheets cover at most 60 s each (Media Transformations limit). */
export function spriteWindows(duration: number, interval: number, window = 60): { time: number; duration: number; count: number }[] {
  const out: { time: number; duration: number; count: number }[] = [];
  for (let start = 0; start < duration - 0.05; start += window) {
    const span = Math.min(window, duration - start);
    out.push({ time: Math.floor(start), duration: Math.max(1, Math.round(span)), count: Math.max(1, Math.min(60, Math.ceil(span / interval))) });
  }
  return out;
}

/** Timestamp of tile `k` of `count` across [time, time + duration). */
export const tileTime = (w: { time: number; duration: number; count: number }, k: number) => w.time + (k * w.duration) / w.count;

/**
 * Duration in seconds from an ISO-BMFF `mvhd` box (MP4, MOV, 3GP), searched in the given
 * byte ranges (the moov box sits at the start or the end of the file). Null if absent.
 */
export function mp4Duration(...chunks: Uint8Array[]): number | null {
  for (const d of chunks) {
    for (let i = 4; i + 32 <= d.length; i++) {
      if (d[i] !== 0x6d || d[i + 1] !== 0x76 || d[i + 2] !== 0x68 || d[i + 3] !== 0x64) continue; // 'mvhd'
      const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const version = d[i + 4];
      let timescale: number, duration: number;
      if (version === 0) { timescale = view.getUint32(i + 16); duration = view.getUint32(i + 20); }
      else if (version === 1 && i + 40 <= d.length) { timescale = view.getUint32(i + 24); duration = Number(view.getBigUint64(i + 28)); }
      else continue;
      if (timescale > 0 && duration > 0 && duration !== 0xffffffff) return Math.round((duration / timescale) * 1000) / 1000;
    }
  }
  return null;
}
