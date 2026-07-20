import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import { fileTypeFromBuffer } from 'file-type';
import { imageSize } from 'image-size';

const exec = promisify(execFile);

/**
 * Media inspection.
 *
 * Cloudinary derived all of this server-side and handed it back on the upload response;
 * S3 stores bytes and tells us nothing. Everything the callers still depend on —
 * content type, image dimensions, video duration, poster frames — is produced here.
 */

const PROBE_TIMEOUT_MS = 20_000;
const POSTER_TIMEOUT_MS = 30_000;

/**
 * Resolve the real content type from the bytes.
 *
 * The declared type is a hint and nothing more: driver-app sends `image/jpeg` for every
 * proof photo regardless of what the camera produced. Cloudinary sniffed and silently did
 * the right thing; S3 would store the lie, so browsers would mis-render the object.
 */
export async function sniffContentType(
  buffer: Buffer,
  declared?: string | undefined,
): Promise<string> {
  const hit = await fileTypeFromBuffer(buffer);
  if (hit?.mime) return hit.mime;
  // file-type can't see text formats (CSV, SVG-as-text). Fall back to the caller's claim.
  return declared ?? 'application/octet-stream';
}

export type Dimensions = { width: number; height: number };

/** Image dimensions, or null when the buffer isn't a format `image-size` understands. */
export function imageDimensions(buffer: Buffer): Dimensions | null {
  try {
    const r = imageSize(buffer);
    if (typeof r.width !== 'number' || typeof r.height !== 'number') return null;
    return { width: r.width, height: r.height };
  } catch {
    return null;
  }
}

/** Write bytes to a scratch file. ffprobe/ffmpeg need a path, not a stream. */
export async function toTempFile(
  body: Buffer | Readable,
  extension = '.bin',
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'closetx-media-'));
  const path = join(dir, `${randomUUID()}${extension}`);
  if (Buffer.isBuffer(body)) {
    await pipeline(async function* () {
      yield body;
    }, createWriteStream(path));
  } else {
    await pipeline(body, createWriteStream(path));
  }
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export type VideoProbe = {
  durationSec: number | null;
  width: number | null;
  height: number | null;
};

/**
 * Duration + dimensions via ffprobe.
 *
 * Returns nulls rather than throwing when the file is unreadable — the caller decides
 * what an unmeasurable video means. For reels it must be fatal: the 30s cap is enforced
 * against this number, so silently accepting an unknown duration would let any length
 * through.
 */
export async function videoProbe(path: string): Promise<VideoProbe> {
  try {
    const { stdout } = await exec(
      ffprobe.path,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=width,height',
        '-of',
        'json',
        path,
      ],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    const parsed: unknown = JSON.parse(stdout);
    const root = parsed as {
      format?: { duration?: string };
      streams?: Array<{ width?: number; height?: number }>;
    };
    const rawDuration = root.format?.duration;
    const duration = rawDuration !== undefined ? Number.parseFloat(rawDuration) : NaN;
    // The first stream carrying dimensions is the video track; audio streams have none.
    const videoStream = root.streams?.find(
      (s) => typeof s.width === 'number' && typeof s.height === 'number',
    );
    return {
      durationSec: Number.isFinite(duration) ? duration : null,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
    };
  } catch {
    return { durationSec: null, width: null, height: null };
  }
}

/**
 * Extract the first frame as a JPEG.
 *
 * Replaces Cloudinary's `so_0` derived URL, which produced a poster on the fly with no
 * stored object behind it. Under S3 the poster is a real second object, so reels get a
 * genuine `thumbnailUrl` instead of a URL that only resolved while Cloudinary was serving.
 */
export async function videoPoster(path: string): Promise<Buffer | null> {
  if (ffmpegPath === null) return null;
  const dir = await mkdtemp(join(tmpdir(), 'closetx-poster-'));
  const out = join(dir, 'poster.jpg');
  try {
    await exec(
      ffmpegPath,
      ['-ss', '0', '-i', path, '-frames:v', '1', '-q:v', '3', '-y', out],
      { timeout: POSTER_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    return await readFile(out);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
