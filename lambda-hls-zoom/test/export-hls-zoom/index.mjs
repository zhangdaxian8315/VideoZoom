/*─────────────────────────────────────────────────────────────────────────────┐
│  HLS Zoom Lambda Function                                                   │
│  – Downloads HLS, applies zoom effect, converts to MP4, uploads to S3      │
└─────────────────────────────────────────────────────────────────────────────*/

import ffmpeg from "fluent-ffmpeg";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import https from "node:https";
import { URL } from "node:url";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const {
  FFMPEG = "/opt/bin/ffmpeg",
  S3_BUCKET,
} = process.env;

ffmpeg.setFfmpegPath(FFMPEG);

/*──────────────────────────────  MAIN  ──────────────────────────────────────*/
export const handler = async (event) => {
  const spec = parsePayload(event);
  
  // 动态创建 S3 客户端
  const s3Client = new S3Client({
    region: spec.awsCredentials?.region || 'us-east-1',
    credentials: spec.awsCredentials ? {
      accessKeyId: spec.awsCredentials.accessKeyId,
      secretAccessKey: spec.awsCredentials.secretAccessKey,
    } : undefined,
  });
  
  const workDir = `/tmp/${spec.recordingId}`;
  const paths = assetPaths(workDir);

  try {
    await mkdir(workDir, { recursive: true });

    /* 1 ─ Download HLS segments from S3 */
    console.log("📥 开始下载 HLS 文件...");
    await buildLocalPlaylist(spec, paths, s3Client);
    console.log("✅ HLS 文件下载完成");

    /* 2 ─ Build dynamic FFmpeg plan & execute */
    if (spec.zoomConfig?.enableZoom) {
      console.log("🎬 开始应用 Zoom 效果...");
      const plan = buildZoomGraph(spec.zoomConfig, paths);
      await runZoomFfmpeg(plan, paths, spec.recordingId);
      console.log("✅ Zoom 效果应用完成");
    } else {
      console.log("⏭️ 跳过 Zoom 效果处理，直接转换...");
      await runSimpleFfmpeg(paths, spec.recordingId);
    }

    /* 3 ─ Upload MP4 to S3 */
    console.log("📤 开始上传到 S3...");
    await uploadMp4ToS3(paths.outputMp4, spec, s3Client);
    console.log("✅ 文件上传完成");

    /* 4 ─ Notify backend */
    console.log("📞 发送回调通知...");
    await httpPost(spec.callbackUrl, { status: "COMPLETED" });
    console.log("✅ 回调通知发送完成");

    return ok({ 
      uploaded: true,
      recordingId: spec.recordingId,
      outputKey: spec.exportFileKey,
      zoomApplied: spec.zoomConfig?.enableZoom || false
    });
  } catch (err) {
    console.error("❌ HLS zoom processing failed", err);
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
    "exportFileKey",
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

/*────────────────  HELPERS – WORKDIR PATHS OBJECT  ─────────────────────────*/
function assetPaths(base) {
  return {
    workDir: base,
    segDir: join(base, "segments"),
    localPlaylist: join(base, "segments", "local.m3u8"),
    outputMp4: join(base, `${base.split('/').pop()}.mp4`),
  };
}

/*──────────────  BUILD LOCAL PLAYLIST FROM S3  ─────────────────────────────*/
async function buildLocalPlaylist(spec, paths, s3Client) {
  console.log("📂 解析 S3 路径...");
  
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

  console.log(`📂 解析 S3 路径: bucket=${bucket}, key=${key}`);

  // Download m3u8 file from S3
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const m3u8Response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const originalM3U8 = await m3u8Response.Body.transformToString();
  
  // Get base path for ts files
  const baseKey = key.substring(0, key.lastIndexOf('/') + 1);

  await mkdir(paths.segDir, { recursive: true });

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
    console.log(`📥 下载: ${tsKey} → ${local}`);
    await downloadFileFromS3(bucket, tsKey, join(paths.segDir, local), s3Client);
    localLines.push(local);
  }
  await writeFile(paths.localPlaylist, localLines.join("\n"), "utf8");
  console.log(`📝 创建本地播放列表: ${paths.localPlaylist}`);
}

/*────────────────────────  ZOOM GRAPH BUILDER  ─────────────────────────────*/
function buildZoomGraph(zoomConfig, paths) {
  const { startTime, endTime, centerX = 0.5, centerY = 0.5 } = zoomConfig;
  
  console.log("🎬 构建 Zoom 滤镜计划...");
  console.log(`⏰ Zoom时间段: ${startTime}s → ${endTime}s`);
  console.log(`🎯 Zoom中心点: (${centerX}, ${centerY})`);

  // 使用默认分辨率，实际会在运行时检测
  const width = 1920;
  const height = 1080;
  const zoomX = Math.round(centerX * width);
  const zoomY = Math.round(centerY * height);
  const zoomDuration = endTime - startTime;

  console.log(`📊 Zoom参数: 分辨率=${width}x${height}, 中心点=(${zoomX},${zoomY}), 时长=${zoomDuration}s`);

  // 构建 zoompan 滤镜
  const zoomFilter = `[0:v]trim=start=${startTime}:end=${endTime},setpts=PTS-STARTPTS,zoompan=z='if(lt(it,1),1+it,if(lt(it,${zoomDuration-1}),2,2-(it-${zoomDuration-1})))':x='${zoomX}-(iw/zoom/2)':y='${zoomY}-(ih/zoom/2)':d=1:fps=30:s=${width}x${height}[zoomed]`;

  return {
    input: paths.localPlaylist,
    filter: zoomFilter,
    output: paths.outputMp4
  };
}

/*──────────────────────────────  ZOOM FFMPEG  ───────────────────────────────*/
async function runZoomFfmpeg(plan, paths, recordingId) {
  console.log("🎞️ 执行 Zoom FFmpeg 处理...");
  
  return new Promise((resolve, reject) => {
    ffmpeg(plan.input)
      .complexFilter(plan.filter)
      .outputOptions([
        "-map", "[zoomed]",
        "-map", "0:a",
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-c:a", "copy",
        "-movflags", "+faststart",
        "-threads", "1",
        "-max_alloc", "268435456",
        "-hide_banner",
        "-loglevel", "error",
      ])
      .on("start", (cmd) => console.log("[ffmpeg zoom]", cmd))
      .on("error", (err) => {
        console.error("❌ Zoom FFmpeg 执行失败:", err);
        reject(err);
      })
      .on("end", () => {
        console.log("✅ Zoom FFmpeg 处理完成");
        resolve();
      })
      .save(plan.output);
  });
}

/*──────────────────────────────  SIMPLE FFMPEG  ─────────────────────────────*/
async function runSimpleFfmpeg(paths, recordingId) {
  console.log("🔄 执行简单 FFmpeg 转换...");
  
  return new Promise((resolve, reject) => {
    ffmpeg(paths.localPlaylist)
      .outputOptions([
        "-c", "copy",
        "-movflags", "+faststart",
        "-threads", "1",
        "-max_alloc", "268435456",
        "-hide_banner",
        "-loglevel", "error",
      ])
      .on("start", (cmd) => console.log("[ffmpeg simple]", cmd))
      .on("error", (err) => {
        console.error("❌ 简单 FFmpeg 执行失败:", err);
        reject(err);
      })
      .on("end", () => {
        console.log("✅ 简单 FFmpeg 转换完成");
        resolve();
      })
      .save(paths.outputMp4);
  });
}

/*───────────────  S3 UPLOAD HELPER  ─────────────────────────────────────────*/
async function uploadMp4ToS3(path, spec, s3Client) {
  const data = await readFile(path);
  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: spec.exportFileKey,
      Body: data,
      ContentType: "video/mp4",
      ContentDisposition: `attachment; filename="${spec.recordingId}.mp4"`,
    })
  );
}

/*───────────────  UTILITIES  ────────────────────────────────────────────────*/
async function downloadFileFromS3(bucket, key, dest, s3Client) {
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await response.Body.transformToByteArray()));
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