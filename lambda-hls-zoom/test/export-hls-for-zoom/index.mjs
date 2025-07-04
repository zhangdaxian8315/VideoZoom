/*─────────────────────────────────────────────────────────────────────────────┐
│  Export-To-MP4 Lambda                                                       │
│  – Downloads an HLS recording, converts it to a single MP4 (-movflags       │
│    +faststart for progressive download), uploads to S3, then calls back     │
│    to your backend.                                                         │
└─────────────────────────────────────────────────────────────────────────────*/

import ffmpeg from "fluent-ffmpeg";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import https from "node:https";
import { URL } from "node:url";

const {
  FFMPEG = "/opt/bin/ffmpeg",
  S3_REGION,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  S3_BUCKET,
} = process.env;

ffmpeg.setFfmpegPath(FFMPEG);

const s3 = new S3Client({
  region: S3_REGION,
  credentials: {
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  },
});

/*──────────────────────────────  MAIN  ──────────────────────────────────────*/
export const handler = async (event) => {
  const spec = parsePayload(event);
  const workDir = `/tmp/${spec.recordingId}`;
  const segDir = join(workDir, "segments");
  const playlist = join(segDir, "local.m3u8");
  const outputMp4 = join(workDir, `${spec.recordingId}.mp4`);

  try {
    await mkdir(segDir, { recursive: true });

    /* 1 ─ Download segments & build signed local playlist */
    await buildLocalPlaylist(spec, segDir, playlist);

    /* 2 ─ Run FFmpeg → MP4 */
    await runFfmpeg(playlist, outputMp4);

    /* 3 ─ Upload MP4 to S3 (Content-Disposition = attachment) */
    await uploadMp4ToS3(outputMp4, spec);

    /* 4 ─ Notify backend */
    await httpPost(spec.callbackUrl, { status: "COMPLETED" });

    return ok({ uploaded: true });
  } catch (err) {
    console.error("❌ mp4 export failed", err);
    if (spec?.callbackUrl) {
      httpPost(spec.callbackUrl, {
        status: "FAILED",
        reason: err.message,
      }).catch(() => {});
    }
    return error(500, err.message);
  } finally {
    rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
};

/*─────────────────────────  HELPERS  ────────────────────────────────────────*/
function parsePayload(raw) {
  const body = typeof raw?.body === "string" ? JSON.parse(raw.body) : raw;
  const required = [
    "recordingId",
    "exportFileKey", // e.g. "exports/rec-1234/video.mp4"
    "manifestFileUrl",
    "callbackUrl",
  ];
  for (const key of required)
    if (!body?.[key]) throw badRequest(`Missing required field "${key}"`);
  return body;
}
function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

/*──────────  Build local playlist from S3 ───────*/
async function buildLocalPlaylist(spec, segDir, playlistPath) {
  // Parse S3 URL to get bucket and key
  const s3Url = spec.manifestFileUrl;
  let bucket, key;
  
  if (s3Url.startsWith('s3://')) {
    const parts = s3Url.replace('s3://', '').split('/');
    bucket = parts[0];
    key = parts.slice(1).join('/');
  } else if (s3Url.includes('s3.amazonaws.com')) {
    const url = new URL(s3Url);
    const pathParts = url.pathname.split('/');
    bucket = pathParts[1];
    key = pathParts.slice(2).join('/');
  } else {
    throw new Error('Unsupported URL format. Use s3:// or https://s3.amazonaws.com format');
  }

  // Download m3u8 file from S3
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const m3u8Response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const originalM3U8 = await m3u8Response.Body.transformToString();
  
  // Get base path for ts files
  const baseKey = key.substring(0, key.lastIndexOf('/') + 1);

  const localLines = [];
  let segIndex = 0;

  for (const raw of originalM3U8.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      localLines.push(line);
      continue;
    }
    
    // Download ts file from S3
    const tsKey = baseKey + line;
    const local = `${String(segIndex++).padStart(5, "0")}.ts`;
    await downloadFileFromS3(bucket, tsKey, join(segDir, local));
    localLines.push(local);
  }
  await writeFile(playlistPath, localLines.join("\n"), "utf8");
}

/*───────────────  FFmpeg: HLS → progressive MP4  ────────────────────────────*/
async function runFfmpeg(inputM3U8, outputMp4) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputM3U8)
      /* copy video & audio codecs if possible; re-mux only */
      .outputOptions([
        "-c copy",
        "-movflags +faststart", // ↓ move moov atom to front for streaming
        "-threads 1",
        "-max_alloc 268435456",
        "-hide_banner",
        "-loglevel error",
      ])
      .on("start", (cmd) => console.log("[ffmpeg]", cmd))
      .on("error", reject)
      .on("end", resolve)
      .save(outputMp4);
  });
}

/*───────────────  S3 upload helper  ─────────────────────────────────────────*/
async function uploadMp4ToS3(path, spec) {
  const data = await readFile(path);
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: spec.exportFileKey,
      Body: data,
      ContentType: "video/mp4",
      /* trigger browser "Save As…" instead of inline playback            */
      ContentDisposition: `attachment; filename="${spec.recordingId}.mp4"`,
    })
  );
}

/*───────────────  Utilities (download + callback + responses)  ──────────────*/
async function downloadFileFromS3(bucket, key, dest) {
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await response.Body.transformToByteArray()));
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} → ${res.status}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}
function httpPost(urlStr, payload) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload));
    const u = new URL(urlStr);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        protocol: u.protocol,
        method: "POST",
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": data.length,
        },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () =>
          res.statusCode && res.statusCode >= 200 && res.statusCode < 400
            ? resolve()
            : reject(new Error(`callback → ${res.statusCode}`))
        );
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
const ok = (body) => ({ statusCode: 200, body: JSON.stringify(body) });
const error = (c, m) => ({ statusCode: c, body: m });
