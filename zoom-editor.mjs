import { mkdir, writeFile, readFile, rm, readdir, stat, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import ffmpeg from 'fluent-ffmpeg';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';

const {
  FFMPEG = "/opt/bin/ffmpeg",
  S3_REGION,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  S3_BUCKET,
} = process.env;

// ffmpeg.setFfmpegPath(FFMPEG);

const s3 = new S3Client({
  region: S3_REGION,
  credentials: {
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  },
});

export const handler = async (event) => {
  console.log("🚀 Lambda 开始执行");
  console.log("📝 事件参数:", JSON.stringify(event, null, 2));
  
  const spec = parsePayload(event);
  console.log("✅ 参数解析成功:", spec);
  
  const workDir = `/tmp/${spec.recordingId}`;
  const segDir = join(workDir, 'segments');
  const playlistPath = join(segDir, 'playlist.m3u8');
  const outputDir = `${workDir}_zoomed`;

  try {
    console.log("📁 创建目录...");
    await mkdir(segDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    console.log("✅ 目录创建成功");

    // 1. 下载并构建本地 HLS - 启用第一步
    console.log("📥 开始下载 HLS 文件...");
    await buildLocalPlaylist(spec.manifestFileUrl, segDir, playlistPath);
    console.log("✅ HLS 下载完成");

    // // 检查下载的文件
    const files = await readdir(segDir);
    console.log("📋 下载的文件列表:", files);
    
    if (files.length > 0) {
      const playlistContent = await readFile(playlistPath, 'utf8');
      console.log("📄 Playlist 内容预览:", playlistContent.substring(0, 200) + "...");
    }

    // 2. 执行 Zoom 处理 - 暂时注释掉
    console.log("🎬 开始 Zoom 处理...");
    await processZoom({
      inputDir: segDir,
      outputDir,
      playlistPath,
      recordingId: spec.recordingId,
      zoomStart: parseFloat(spec.zoomStart),
      zoomEnd: parseFloat(spec.zoomEnd),
      zoomCenterX: parseFloat(spec.zoomCenterX ?? 0.5),
      zoomCenterY: parseFloat(spec.zoomCenterY ?? 0.5),
    });
    console.log("✅ Zoom 处理完成");
    

    // 3. 上传整个 outputDir 文件夹到 S3 - 暂时注释掉
    console.log("📤 开始上传到 S3...");
    await uploadFolderToS3(outputDir, spec.outputS3Prefix);
    console.log("✅ S3 上传完成");

    // 4. 回调通知 - 暂时注释掉
    /*
    console.log("📞 发送回调通知...");
    await httpPost(spec.callbackUrl, { status: "COMPLETED" });
    console.log("✅ 回调发送成功");
    */

    console.log("🎉 第一步测试完成");
    return ok({ 
      message: "第一步测试 - HLS下载完成",
      recordingId: spec.recordingId,
      workDir,
      outputDir,
      downloadedFiles: files
    });
  } catch (err) {
    console.error("❌ 执行失败", err);
    // if (spec?.callbackUrl) {
    //   httpPost(spec.callbackUrl, { status: "FAILED", reason: err.message }).catch(() => {});
    // }
    return error(500, err.message);
  } finally {
    console.log("🧹 清理临时文件...");
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch (e) {
      console.log("⚠️ 清理 workDir 失败:", e.message);
    }
    try {
      await rm(outputDir, { recursive: true, force: true });
    } catch (e) {
      console.log("⚠️ 清理 outputDir 失败:", e.message);
    }
    console.log("✅ 清理完成");
  }
};

function parsePayload(raw) {
  console.log("🔍 开始解析参数...");
  const body = typeof raw?.body === 'string' ? JSON.parse(raw.body) : raw;
  console.log("📋 解析后的参数:", body);
  
  const required = [
    "recordingId", "manifestFileUrl", "callbackUrl", "zoomStart", "zoomEnd", "outputS3Prefix"
  ];
  
  for (const key of required) {
    if (!body?.[key]) {
      console.error(`❌ 缺少必需字段: ${key}`);
      throw badRequest(`Missing required field "${key}"`);
    }
  }
  
  console.log("✅ 所有必需字段检查通过");
  return body;
}

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

// ✅ 通用 S3 地址解析器：支持 s3:// 和 https:// 格式
function parseS3Url(input) {
  if (input.startsWith('s3://')) {
    const [, bucketAndKey] = input.split('s3://');
    const [bucket, ...keyParts] = bucketAndKey.split('/');
    return { bucket, key: keyParts.join('/') };
  } else if (input.startsWith('https://')) {
    const url = new URL(input);
    const bucket = url.hostname.split('.')[0]; // boom-alpha
    const key = url.pathname.slice(1); // 去掉第一个 /
    return { bucket, key };
  } else {
    throw new Error("Unsupported URL format: must be s3:// or https://");
  }
}

// ✅ 重写后的 HLS 下载构建函数
async function buildLocalPlaylist(manifestUrl, segDir, playlistPath) {
  console.log("🔗 解析 manifest URL:", manifestUrl);

  const { bucket, key } = parseS3Url(manifestUrl);
  const baseKey = key.substring(0, key.lastIndexOf('/') + 1);

  console.log("📦 S3 信息:", { bucket, key, baseKey });

  console.log("📥 下载 m3u8 文件...");
  const m3u8Response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const originalM3U8 = await m3u8Response.Body.transformToString();
  console.log("📄 原始 m3u8 内容:", originalM3U8.substring(0, 300) + "...");

  const localLines = [];
  let segIndex = 0;

  for (const raw of originalM3U8.split("\n")) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      localLines.push(line);
      continue;
    }

    const tsKey = baseKey + line;
    const localName = `${String(segIndex++).padStart(5, "0")}.ts`;

    console.log(`📥 下载片段 ${segIndex}: ${tsKey} -> ${localName}`);
    await downloadFileFromS3(bucket, tsKey, join(segDir, localName));
    localLines.push(localName);
  }

  console.log("💾 保存本地 playlist...");
  await writeFile(playlistPath, localLines.join("\n"), "utf8");
  console.log("✅ Playlist 构建完成");
}

async function downloadFileFromS3(bucket, key, dest) {
  console.log(`📥 从 S3 下载: ${bucket}/${key} -> ${dest}`);
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await mkdir(dirname(dest), { recursive: true });
  const data = Buffer.from(await response.Body.transformToByteArray());
  await writeFile(dest, data);
  console.log(`✅ 下载完成: ${dest} (${data.length} bytes)`);
}

// 以下函数暂时注释掉
/*
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
*/

async function uploadFolderToS3(folder, s3Prefix) {
  const entries = await readdir(folder);
  for (const name of entries) {
    const fullPath = join(folder, name);
    const fileData = await readFile(fullPath);
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `${s3Prefix}/${name}`,
      Body: fileData,
    }));
  }
}

async function processZoom({ inputDir, outputDir, playlistPath, recordingId, zoomStart, zoomEnd, zoomCenterX, zoomCenterY }) {
  const inputM3U8 = playlistPath;
  const outputZoomedTS = join(outputDir, 'zoomed.ts');
  const outputM3U8 = join(outputDir, 'playlist.m3u8');

  const fps = 30;
  const zoomInTime = 2.0;
  const zoomOutTime = 2.0;
  const zoomDuration = zoomEnd - zoomStart;
  const zoomOutStart = zoomDuration - zoomOutTime;

  const zoomFormula = `if(lt(it,${zoomInTime}), 1+it/${zoomInTime}, if(lt(it,${zoomOutStart}), 2, if(lt(it,${zoomDuration}), 2-(it-${zoomOutStart})/${zoomOutTime}, 1)))`;

  return new Promise((resolve, reject) => {
    ffmpeg(inputM3U8)
      .inputOptions('-fflags +genpts')
      .outputOptions(
        '-filter_complex',
        `fps=${fps},zoompan=z='${zoomFormula}':x='${zoomCenterX}*iw-(iw/zoom/2)':y='${zoomCenterY}*ih-(ih/zoom/2)':d=1`
      )
      .videoCodec('libx264')
      .audioCodec('aac')
      .on('start', cmd => console.log('[ffmpeg zoom]', cmd))
      .on('stderr', line => console.log('[ffmpeg]', line))
      .on('end', async () => {
        await writeFile(outputM3U8, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:${zoomDuration},\nzoomed.ts\n#EXT-X-ENDLIST`);
        resolve();
      })
      .on('error', reject)
      .save(outputZoomedTS);
  });
}

const ok = (body) => ({ statusCode: 200, body: JSON.stringify(body) });
const error = (c, m) => ({ statusCode: c, body: m });