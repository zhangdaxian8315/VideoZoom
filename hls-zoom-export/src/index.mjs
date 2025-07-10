import { mkdir, writeFile, readFile, rm, readdir, stat, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import ffmpeg from 'fluent-ffmpeg';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';

import { existsSync } from 'fs';

// ✅ 设置 ffprobe 路径（必须在任何 ffmpeg 调用前执行）
const ffprobePath = '/opt/bin/ffprobe';
if (existsSync(ffprobePath)) {
  ffmpeg.setFfprobePath(ffprobePath);
  console.log('✅ ffprobe 路径已设置:', ffprobePath);
} else {
  console.warn('⚠️ 未找到 ffprobe:', ffprobePath);
}

const {
  FFMPEG = "/opt/bin/ffmpeg",
  FFPROBE = "/opt/bin/ffprobe",
  S3_REGION,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  S3_BUCKET,
} = process.env;

// 设置 ffmpeg 和 ffprobe 路径
console.log('🔧 设置 FFmpeg 路径:', FFMPEG);
console.log('🔧 设置 FFprobe 路径:', FFPROBE);
ffmpeg.setFfmpegPath(FFMPEG);
ffmpeg.setFfprobePath(FFPROBE);

// 🔧 S3 客户端配置 - 支持本地AWS凭证和环境变量
const s3Config = {
  region: S3_REGION,
};

// 如果提供了环境变量凭证，使用它们；否则使用本地AWS凭证
if (S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY) {
  s3Config.credentials = {
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  };
  console.log('🔑 使用环境变量 AWS 凭证');
} else {
  console.log('🔑 使用本地 AWS 凭证');
}

const s3 = new S3Client(s3Config);

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
  
    // 1. 下载并构建本地 HLS - CloudFront方式
    console.log("📥 开始下载 HLS 文件...");
    await buildLocalPlaylist(spec.manifestFileUrl, segDir, playlistPath, spec.cloudFrontVideoCookie);
    console.log("✅ HLS 下载完成");
  
    // 检查下载的文件
    const files = await readdir(segDir);
    console.log("📋 下载的文件列表:", files);
  
    if (files.length > 0) {
      const playlistContent = await readFile(playlistPath, 'utf8');
      console.log("📄 Playlist 内容预览:", playlistContent.substring(0, 200) + "...");
    }
  
    // 2. 执行处理逻辑（互斥：trims 或 zooms）
    if (spec.trims && spec.trims.length > 0) {
      const useAccurateTrim = spec.accurateTrim === true || spec.accurateTrim === 'true';
      if (useAccurateTrim) {
        console.log("✂️ 开始高效 Trim 处理...");
        await processTrimFast({
          inputDir: segDir,
          outputDir,
          playlistPath,
          recordingId: spec.recordingId,
          trims: spec.trims,
          lowQuality: spec.lowQuality === 'true' ? true : false,
          spec,
        });
        console.log("✅ 高效 Trim 处理完成");
      } else {
        console.log("✂️ 开始传统 Trim 处理...");
        await processTrim({
          inputDir: segDir,
          outputDir,
          playlistPath,
          recordingId: spec.recordingId,
          trims: spec.trims,
          lowQuality: spec.lowQuality === 'true' ? true : false,
          spec,
        });
        console.log("✅ 传统 Trim 处理完成");
      }
    } else if (spec.zooms && spec.zooms.length > 0) {
      console.log("🎬 开始 Zoom 处理...");
      await processZoom({
        inputDir: segDir,
        outputDir,
        playlistPath,
        recordingId: spec.recordingId,
        zooms: spec.zooms,
        lowQuality: spec.lowQuality === 'true' ? true : false,
        spec,
      });
      console.log("✅ Zoom 处理完成");
    } else {
      console.log("📋 没有处理参数，直接拷贝原始文件...");
      await copyOriginalFiles(segDir, outputDir);
      console.log("✅ 文件拷贝完成");
    }
  
    // ✅ 构造回调 JSON
    const resultPayload = {
      status: "success",
      recordingId: spec.recordingId,
      outputMp4: `${spec.outputS3Prefix}/${spec.recordingId}.mp4`,
    };

    // 根据实际使用的功能设置不同的回调数据
    if (spec.trims && spec.trims.length > 0) {
      // Trim 功能的回调数据
      resultPayload.outputHls = `${spec.outputS3Prefix}/${spec.recordingId}_trimmed/playlist.m3u8`;
      resultPayload.trims = spec.trims;
      resultPayload.totalDuration = spec.trims.reduce((total, trim) => total + (trim.end - trim.start), 0);
    } else if (spec.zooms && spec.zooms.length > 0) {
      // Zoom 功能的回调数据
      resultPayload.outputHls = `${spec.outputS3Prefix}/${spec.recordingId}_zoomed/playlist.m3u8`;
      resultPayload.zooms = spec.zooms;
    } else {
      // 无处理功能的回调数据
      resultPayload.outputHls = `${spec.outputS3Prefix}/${spec.recordingId}/playlist.m3u8`;
    }
  
    if (spec.callbackUrl) {
      console.log("📤 准备回调成功结果:", resultPayload);
      try {
        await httpPost(spec.callbackUrl, resultPayload);
        console.log("✅ 成功回调 callbackUrl");
      } catch (callbackErr) {
        console.warn("⚠️ 回调失败:", callbackErr.message);
      }
    }
    return ok(resultPayload);
  
  } catch (err) {
    console.error("❌ 执行失败", err);

    if (spec?.callbackUrl) {
      const errorPayload = {
        status: "failed",
        recordingId: spec.recordingId,
        reason: err.message || "Unknown error",
      };
      try {
        console.log("📤 准备回调失败状态:", errorPayload);
        await httpPost(spec.callbackUrl, errorPayload);
      } catch (callbackErr) {
        console.warn("⚠️ 回调失败状态时出错:", callbackErr.message);
      }
    }
  
    return error(500, err.message);
  } finally {
    // console.log("🧹 清理临时文件...");
    // try {
    //   await rm(workDir, { recursive: true, force: true });
    // } catch (e) {
    //   console.log("⚠️ 清理 workDir 失败:", e.message);
    // }
    // try {
    //   await rm(outputDir, { recursive: true, force: true });
    // } catch (e) {
    //   console.log("⚠️ 清理 outputDir 失败:", e.message);
    // }
    // console.log("✅ 清理完成");
  }  
};

function parsePayload(raw) {
  console.log("🔍 开始解析参数...");
  const body = typeof raw?.body === 'string' ? JSON.parse(raw.body) : raw;
  console.log("📋 解析后的参数:", body);
  
  const required = [
    "recordingId", "manifestFileUrl", "callbackUrl", "zooms", "outputS3Prefix", "cloudFrontVideoCookie"
  ];
  
  for (const key of required) {
    if (!body?.[key]) {
      console.error(`❌ 缺少必需字段: ${key}`);
      throw badRequest(`Missing required field "${key}"`);
    }
  }
  
  console.log("✅ 所有必需字段检查通过");
  
  // 🔍 检查可选参数
  if (body.accurateTrim !== undefined) {
    console.log(`🎯 accurateTrim 参数: ${body.accurateTrim}`);
  }
  
  // 🔍 参数校验和互斥逻辑
  if (body.trims && Array.isArray(body.trims) && body.trims.length > 0) {
    // 如果有 trims，校验 trims 参数
    validateTrimParameters(body.trims);
    console.log("✅ Trim 参数校验通过");
    
    // 互斥逻辑：有 trims 时忽略 zooms
    if (body.zooms) {
      console.log("⚠️ 检测到 trims 和 zooms 同时存在，优先处理 trims，忽略 zooms");
      delete body.zooms;
    }
  } else if (body.zooms && Array.isArray(body.zooms)) {
    // 没有 trims 时，校验 zooms 参数
    validateZoomParameters(body.zooms);
    console.log("✅ Zoom 参数校验通过");
  }
  
  return body;
}

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

// 🔍 Trim 参数校验函数
function validateTrimParameters(trims) {
  trims.forEach((trim, index) => {
    // 校验 start 和 end 参数（时间范围）
    if (trim.start === undefined || trim.end === undefined) {
      console.error(`❌ Trim 缺少 start/end 参数 (索引: ${index})`);
      throw badRequest(`Trim must have both start and end, missing in trim at index ${index}`);
    }
    
    if (typeof trim.start !== 'number' || typeof trim.end !== 'number') {
      console.error(`❌ Trim start/end 参数类型错误: start=${trim.start}, end=${trim.end} (索引: ${index})`);
      throw badRequest(`Trim start and end must be numbers, got: start=${trim.start}, end=${trim.end} at index ${index}`);
    }
    
    if (trim.start >= trim.end) {
      console.error(`❌ Trim start 必须小于 end: start=${trim.start}, end=${trim.end} (索引: ${index})`);
      throw badRequest(`Trim start must be less than end, got: start=${trim.start}, end=${trim.end} at index ${index}`);
    }
    
    if (trim.start < 0 || trim.end < 0) {
      console.error(`❌ Trim start/end 不能为负数: start=${trim.start}, end=${trim.end} (索引: ${index})`);
      throw badRequest(`Trim start and end must be non-negative, got: start=${trim.start}, end=${trim.end} at index ${index}`);
    }
  });
}

// 🔍 Zoom 参数校验函数
function validateZoomParameters(zooms) {
  zooms.forEach((zoom, index) => {
    // 校验 start 和 end 参数（时间范围）
    if (zoom.start !== undefined && zoom.end !== undefined) {
      if (typeof zoom.start !== 'number' || typeof zoom.end !== 'number') {
        console.error(`❌ Start/End 参数类型错误: start=${zoom.start}, end=${zoom.end} (索引: ${index})`);
        throw badRequest(`Start and end must be numbers, got: start=${zoom.start}, end=${zoom.end} at index ${index}`);
      }
      if (zoom.start >= zoom.end) {
        console.error(`❌ Start 必须小于 End: start=${zoom.start}, end=${zoom.end} (索引: ${index})`);
        throw badRequest(`Start time must be less than end time, got: start=${zoom.start}, end=${zoom.end} at index ${index}`);
      }
      if (zoom.start < 0 || zoom.end < 0) {
        console.error(`❌ Start/End 不能为负数: start=${zoom.start}, end=${zoom.end} (索引: ${index})`);
        throw badRequest(`Start and end times must be non-negative, got: start=${zoom.start}, end=${zoom.end} at index ${index}`);
      }
    }
    
    // 校验 x 和 y 参数（坐标范围）
    if (zoom.x !== undefined) {
      if (typeof zoom.x !== 'number' || zoom.x < 0.0 || zoom.x > 1.0) {
        console.error(`❌ X 坐标超出范围: ${zoom.x} (索引: ${index})`);
        throw badRequest(`X coordinate must be between 0.0 and 1.0, got: ${zoom.x} at index ${index}`);
      }
    }
    
    if (zoom.y !== undefined) {
      if (typeof zoom.y !== 'number' || zoom.y < 0.0 || zoom.y > 1.0) {
        console.error(`❌ Y 坐标超出范围: ${zoom.y} (索引: ${index})`);
        throw badRequest(`Y coordinate must be between 0.0 and 1.0, got: ${zoom.y} at index ${index}`);
      }
    }
    
    // 校验 zoom 参数（放大倍数）
    if (zoom.zoom !== undefined) {
      if (typeof zoom.zoom !== 'number' || zoom.zoom < 1.0 || zoom.zoom > 4.0) {
        console.error(`❌ Zoom factor 超出范围: ${zoom.zoom} (索引: ${index})`);
        throw badRequest(`Zoom factor must be between 1.0 and 4.0, got: ${zoom.zoom} at index ${index}`);
      }
    }
    
    // 校验 zoomDuration 参数（动画时长）
    if (zoom.zoomDuration !== undefined) {
      if (typeof zoom.zoomDuration !== 'number' || zoom.zoomDuration < 0.5 || zoom.zoomDuration > 5.0) {
        console.error(`❌ Zoom duration 超出范围: ${zoom.zoomDuration} (索引: ${index})`);
        throw badRequest(`Zoom duration must be between 0.5 and 5.0 seconds, got: ${zoom.zoomDuration} at index ${index}`);
      }
    }
  });
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

// ✅ 重写后的 HLS 下载构建函数 - CloudFront方式
async function buildLocalPlaylist(manifestUrl, segDir, playlistPath, cloudFrontVideoCookie) {
  console.log("🔗 解析 manifest URL:", manifestUrl);

  const {
    Policy,
    Signature,
    "Key-Pair-Id": KeyPairId,
  } = cloudFrontVideoCookie;
  const query =
    `Policy=${encodeURIComponent(Policy)}&` +
    `Signature=${encodeURIComponent(Signature)}&` +
    `Key-Pair-Id=${encodeURIComponent(KeyPairId)}`;

  console.log("📦 CloudFront 签名信息:", { Policy: Policy.substring(0, 50) + "...", Signature: Signature.substring(0, 50) + "...", KeyPairId });

  console.log("📥 下载 m3u8 文件...");
  const signedM3u8Url = manifestUrl + (manifestUrl.includes('?') ? '&' : '?') + query;
  console.log("🔗 签名m3u8 URL:", signedM3u8Url);
  const originalM3U8 = await fetch(signedM3u8Url).then((r) => r.text());
  console.log("📄 原始 m3u8 内容:", originalM3U8.substring(0, 300) + "...");

  const baseUrl = manifestUrl.slice(
    0,
    manifestUrl.lastIndexOf("/") + 1
  );

  const localLines = [];
  let segIndex = 0;

  for (const raw of originalM3U8.split("\n")) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      localLines.push(line);
      continue;
    }

    const absolute = line.startsWith("http") ? line : baseUrl + line;
    const signed = absolute + (absolute.includes("?") ? "&" : "?") + query;
    const localName = `${String(segIndex++).padStart(5, "0")}.ts`;

    console.log(`📥 下载片段 ${segIndex}: ${absolute} -> ${localName}`);
    console.log(`🔗 签名URL: ${signed.substring(0, 100)}...`);
    await downloadFile(signed, join(segDir, localName));
    localLines.push(localName);
  }

  console.log("💾 保存本地 playlist...");
  await writeFile(playlistPath, localLines.join("\n"), "utf8");
  console.log("✅ Playlist 构建完成");
}

async function downloadFile(url, dest) {
  console.log(`📥 从 CloudFront 下载: ${url} -> ${dest}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} → ${res.status}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`✅ 下载完成: ${dest}`);
}

// 🔍 拷贝原始文件函数（无处理情况）
async function copyOriginalFiles(inputDir, outputDir) {
  const inputFiles = await readdir(inputDir);
  for (const file of inputFiles) {
    const sourcePath = join(inputDir, file);
    const destPath = join(outputDir, file);
    await cp(sourcePath, destPath);
  }
}

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

// 🔍 Trim 处理函数
async function processTrim({ inputDir, outputDir, playlistPath, recordingId, trims, lowQuality, spec }) {
  console.log("✂️ 开始多段Trim处理...");
  console.log("📊 参数:", { trims, lowQuality });

  const tempDir = `/tmp/trim_${recordingId}`;
  await mkdir(tempDir, { recursive: true });

  try {
    // 0. 先解析M3U8播放列表，确定需要哪些分片
    console.log("📋 解析M3U8播放列表，确定需要的分片...");
    const playlistContent = await readFile(playlistPath, 'utf8');
    const lines = playlistContent.split('\n');
    const segmentInfo = [];
    let currentTime = 0;
    let segmentIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXTINF:')) {
        const duration = parseFloat(line.match(/#EXTINF:([0-9]+\.?[0-9]*),/)[1]);
        const nextLine = lines[i + 1]?.trim();
        if (nextLine && nextLine.endsWith('.ts')) {
          const startTime = currentTime;
          const endTime = currentTime + duration;
          segmentInfo.push({
            index: segmentIndex,
            filename: nextLine,
            duration,
            startTime,
            endTime
          });
          currentTime = endTime;
          segmentIndex++;
        }
      }
    }

    // 1. 确定需要的分片文件
    const neededSegments = new Set();
    for (const trim of trims) {
      const overlappingSegs = segmentInfo.filter(seg => seg.endTime > trim.start && seg.startTime < trim.end);
      overlappingSegs.forEach(seg => neededSegments.add(seg.filename));
    }

    // 2. 只拷贝需要的文件到输出目录
    console.log("📋 拷贝需要的文件到输出目录...");
    const inputFiles = await readdir(inputDir);
    for (const file of inputFiles) {
      if (!file.endsWith('.ts') || neededSegments.has(file)) {
        const sourcePath = join(inputDir, file);
        const destPath = join(outputDir, file);
        await cp(sourcePath, destPath);
      }
    }
    console.log(`✅ 拷贝完成，共拷贝 ${neededSegments.size} 个分片文件`);

    // 3. 处理每个 trim 区间
    const trimmedSegments = [];
    for (let trimIndex = 0; trimIndex < trims.length; trimIndex++) {
      const { start, end } = trims[trimIndex];
      
      // 找到与trim区间重叠的分片
      const overlappingSegs = segmentInfo.filter(seg => seg.endTime > start && seg.startTime < end);
      if (overlappingSegs.length === 0) {
        console.warn(`⚠️ Trim区间 ${trimIndex} (${start}s-${end}s) 没有找到重叠的分片`);
        continue;
      }

      console.log(`✂️ 处理 Trim 区间 ${trimIndex}: ${start}s → ${end}s`);
      
      // 合并重叠分片
      const concatList = overlappingSegs.map(seg => `file '${join(inputDir, seg.filename)}'`).join('\n');
      const concatListPath = join(tempDir, `concat_list_${trimIndex}.txt`);
      await writeFile(concatListPath, concatList);
      
      const mergedInputPath = join(tempDir, `merged_input_${trimIndex}.ts`);
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(concatListPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions(['-c', 'copy'])
          .output(mergedInputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // 计算相对于合并分片的trim时间
      const firstSegStartTime = overlappingSegs[0].startTime;
      const relativeStart = Math.max(0, start - firstSegStartTime);
      const relativeEnd = end - firstSegStartTime;
      
      // 精确时间裁剪
      const duration = relativeEnd - relativeStart;
      console.log(`✂️ 时间裁剪: ${relativeStart.toFixed(3)}s → ${relativeEnd.toFixed(3)}s (${duration.toFixed(3)}s)`);
      
      const trimmedPath = join(tempDir, `trimmed_${trimIndex}.ts`);
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(mergedInputPath)
          .outputOptions([
            '-ss', relativeStart.toString(),         // ✅ 输出级裁剪（更精确）
            '-t', (relativeEnd - relativeStart).toString(),
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', lowQuality ? '23' : '18',
            '-c:a', 'aac',
            '-movflags', '+faststart'
          ])
          .output(trimmedPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });      

      trimmedSegments.push({
        path: trimmedPath,
        duration: duration
      });
      
      console.log(`✅ Trim ${trimIndex} 完成: ${duration.toFixed(3)}秒`);
    }

    // 4. 拼接所有trim片段
    const outputPlaylistPath = join(outputDir, 'playlist.m3u8');
    
    if (trimmedSegments.length > 0) {
      const finalConcatList = trimmedSegments.map(seg => `file '${seg.path}'`).join('\n');
      const finalConcatListPath = join(tempDir, 'final_concat_list.txt');
      await writeFile(finalConcatListPath, finalConcatList);
      
      const finalOutputPath = join(outputDir, 'trimmed.ts');
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(finalConcatListPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions(['-c', 'copy'])
          .output(finalOutputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // 5. 重建 playlist.m3u8
      const totalDuration = trimmedSegments.reduce((sum, seg) => sum + seg.duration, 0);
      
      const newPlaylist = [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-TARGETDURATION:' + Math.ceil(totalDuration),
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        `#EXTINF:${totalDuration.toFixed(6)},`,
        'trimmed.ts',
        '#EXT-X-ENDLIST'
      ].join('\n');
      
      await writeFile(outputPlaylistPath, newPlaylist);
      console.log('✅ Trim处理完成！');
    } else {
      // 如果没有成功的trim片段，创建一个空的playlist
      const emptyPlaylist = [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-TARGETDURATION:1',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXT-X-ENDLIST'
      ].join('\n');
      
      await writeFile(outputPlaylistPath, emptyPlaylist);
      console.log('⚠️ 没有成功的trim片段，创建空playlist');
    }

    // 上传 Trim 后的 HLS 文件夹
    const hlsOutputPrefix = `${spec.outputS3Prefix}/${spec.recordingId}_trimmed`;
    console.log('📤 开始上传HLS到S3...', hlsOutputPrefix);
    await uploadFolderToS3(outputDir, hlsOutputPrefix);
    console.log('✅ HLS上传完成:', hlsOutputPrefix);

    // 自动导出MP4
    const outputMp4 = join(outputDir, `${recordingId}.mp4`);
    await runFfmpeg(outputPlaylistPath, outputMp4);
    console.log('✅ MP4导出完成:', outputMp4);
    
    // 上传MP4到S3
    console.log('📤 开始上传MP4到S3...');
    await uploadMp4ToS3(outputMp4, spec);
    console.log('✅ MP4上传完成:', `${spec.outputS3Prefix}/${spec.recordingId}.mp4`);
  } finally {
    try { 
      await rm(tempDir, { recursive: true, force: true }); 
    } catch {}
  }
}

// 🔍 高效 Trim 处理函数 - 只对边界分片转码，中间分片直接复用
async function processTrimFast({ inputDir, outputDir, playlistPath, recordingId, trims, lowQuality, spec }) {
  console.log("⚡ 开始高效多段Trim处理...");
  console.log("📊 参数:", { trims, lowQuality });

  const tempDir = `/tmp/trim_fast_${recordingId}`;
  await mkdir(tempDir, { recursive: true });

  try {
    // 0. 先解析M3U8播放列表，确定需要哪些分片
    console.log("📋 解析M3U8播放列表，确定需要的分片...");
    const playlistContent = await readFile(playlistPath, 'utf8');
    const lines = playlistContent.split('\n');
    const segmentInfo = [];
    let currentTime = 0;
    let segmentIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXTINF:')) {
        const duration = parseFloat(line.match(/#EXTINF:([0-9]+\.?[0-9]*),/)[1]);
        const nextLine = lines[i + 1]?.trim();
        if (nextLine && nextLine.endsWith('.ts')) {
          const startTime = currentTime;
          const endTime = currentTime + duration;
          segmentInfo.push({
            index: segmentIndex,
            filename: nextLine,
            duration,
            startTime,
            endTime
          });
          currentTime = endTime;
          segmentIndex++;
        }
      }
    }

    // 1. 确定需要的分片文件并拷贝到输出目录
    const neededSegments = new Set();
    for (const trim of trims) {
      const overlappingSegs = segmentInfo.filter(seg => seg.endTime > trim.start && seg.startTime < trim.end);
      overlappingSegs.forEach(seg => neededSegments.add(seg.filename));
    }

    console.log("📋 拷贝需要的文件到输出目录...");
    const inputFiles = await readdir(inputDir);
    for (const file of inputFiles) {
      if (!file.endsWith('.ts') || neededSegments.has(file)) {
        const sourcePath = join(inputDir, file);
        const destPath = join(outputDir, file);
        await cp(sourcePath, destPath);
      }
    }
    console.log(`✅ 拷贝完成，共拷贝 ${neededSegments.size} 个分片文件`);

    // 2. 高效处理每个 trim 区间 - 新架构：输出独立TS分片
    const finalSegmentList = []; // 存储所有最终的分片信息 {filename, duration, path}
    let segmentCounter = 0; // 全局分片计数器
    
    for (let trimIndex = 0; trimIndex < trims.length; trimIndex++) {
      const { start, end } = trims[trimIndex];
      
      // 🚀 开始执行时的日志
      console.log(`🚀 正在执行精确裁剪 processTrimFast，目标区间: [${start}s, ${end}s]`);
      
      // 找到与trim区间重叠的分片
      const overlappingSegs = segmentInfo.filter(seg => seg.endTime > start && seg.startTime < end);
      if (overlappingSegs.length === 0) {
        console.warn(`⚠️ Trim区间 ${trimIndex} (${start}s-${end}s) 没有找到重叠的分片`);
        continue;
      }

      console.log(`⚡ 高效处理 Trim 区间 ${trimIndex}: ${start}s → ${end}s`);
      
      // 🔍 识别分片阶段 - 分析每个分片的处理策略
      console.log(`📋 分析区间 ${trimIndex} 中的 ${overlappingSegs.length} 个重叠分片:`);
      overlappingSegs.forEach((seg, i) => {
        const isFirst = i === 0;
        const isLast = i === overlappingSegs.length - 1;
        const segStart = Math.max(seg.startTime, start);
        const segEnd = Math.min(seg.endTime, end);
        
        if (isFirst && isLast) {
          // 只有一个分片，需要双边裁剪
          console.log(`✂️ 分片 ${seg.filename} 与起始和结束时间都重叠，将进行双边裁剪 (裁剪范围: ${(segStart - seg.startTime).toFixed(1)}s - ${(segEnd - seg.startTime).toFixed(1)}s)`);
        } else if (isFirst && seg.startTime < start) {
          // 第一个分片，需要裁剪开始部分
          console.log(`✂️ 分片 ${seg.filename} 与起始时间重叠，将进行部分裁剪 (裁剪范围: ${(segStart - seg.startTime).toFixed(1)}s - ${seg.duration.toFixed(1)}s)`);
        } else if (isLast && seg.endTime > end) {
          // 最后一个分片，需要裁剪结束部分
          console.log(`✂️ 分片 ${seg.filename} 与结束时间重叠，将进行部分裁剪 (裁剪范围: 0s - ${(segEnd - seg.startTime).toFixed(1)}s)`);
        } else {
          // 中间完整分片，直接复用
          console.log(`✅ 分片 ${seg.filename} 完全位于裁剪区间内，将直接合并`);
        }
      });

      // 🎬 处理当前区间的每个分片，生成独立的TS文件
      for (let i = 0; i < overlappingSegs.length; i++) {
        const seg = overlappingSegs[i];
        const isFirst = i === 0;
        const isLast = i === overlappingSegs.length - 1;
        
        // 判断分片的处理类型
        const segStart = Math.max(seg.startTime, start);
        const segEnd = Math.min(seg.endTime, end);
        const segDuration = segEnd - segStart;
        
        if (isFirst && isLast) {
          // 只有一个分片，需要裁剪开始和结束
          const outputFileName = `seg${String(segmentCounter++).padStart(5, '0')}_trim.ts`;
          const outputPath = join(outputDir, outputFileName);
          console.log(`🛠️ 正在裁剪分片 ${seg.filename}，裁剪范围: ${(segStart - seg.startTime).toFixed(1)}s - ${(segEnd - seg.startTime).toFixed(1)}s`);
          await new Promise((resolve, reject) => {
            ffmpeg()
              .input(join(inputDir, seg.filename))
              .outputOptions([
                '-ss', (segStart - seg.startTime).toString(),
                '-t', segDuration.toString(),
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-crf', lowQuality ? '23' : '18',
                '-c:a', 'aac',
                '-movflags', '+faststart'
              ])
              .output(outputPath)
              .on('end', () => {
                console.log(`✅ 分片 ${seg.filename} 双边裁剪完成 → ${outputFileName}`);
                resolve();
              })
              .on('error', reject)
              .run();
          });
          finalSegmentList.push({
            filename: outputFileName,
            duration: segDuration,
            path: outputPath
          });
        } else if (isFirst && seg.startTime < start) {
          // 第一个分片，需要裁剪开始部分
          const outputFileName = `seg${String(segmentCounter++).padStart(5, '0')}_trim.ts`;
          const outputPath = join(outputDir, outputFileName);
          console.log(`🛠️ 正在裁剪分片 ${seg.filename}，裁剪范围: ${(segStart - seg.startTime).toFixed(1)}s - ${seg.duration.toFixed(1)}s`);
          await new Promise((resolve, reject) => {
            ffmpeg()
              .input(join(inputDir, seg.filename))
              .outputOptions([
                '-ss', (segStart - seg.startTime).toString(),
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-crf', lowQuality ? '23' : '18',
                '-c:a', 'aac',
                '-movflags', '+faststart'
              ])
              .output(outputPath)
              .on('end', () => {
                console.log(`✅ 分片 ${seg.filename} 开始部分裁剪完成 → ${outputFileName}`);
                resolve();
              })
              .on('error', reject)
              .run();
          });
          finalSegmentList.push({
            filename: outputFileName,
            duration: segDuration,
            path: outputPath
          });
        } else if (isLast && seg.endTime > end) {
          // 最后一个分片，需要裁剪结束部分
          const outputFileName = `seg${String(segmentCounter++).padStart(5, '0')}_trim.ts`;
          const outputPath = join(outputDir, outputFileName);
          console.log(`🛠️ 正在裁剪分片 ${seg.filename}，裁剪范围: 0s - ${(segEnd - seg.startTime).toFixed(1)}s`);
          await new Promise((resolve, reject) => {
            ffmpeg()
              .input(join(inputDir, seg.filename))
              .outputOptions([
                '-t', (segEnd - seg.startTime).toString(),
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-crf', lowQuality ? '23' : '18',
                '-c:a', 'aac',
                '-movflags', '+faststart'
              ])
              .output(outputPath)
              .on('end', () => {
                console.log(`✅ 分片 ${seg.filename} 结束部分裁剪完成 → ${outputFileName}`);
                resolve();
              })
              .on('error', reject)
              .run();
          });
          finalSegmentList.push({
            filename: outputFileName,
            duration: segDuration,
            path: outputPath
          });
        } else {
          // 中间完整分片，直接复用
          const outputFileName = `seg${String(segmentCounter++).padStart(5, '0')}.ts`;
          const outputPath = join(outputDir, outputFileName);
          console.log(`🔄 分片 ${seg.filename}: 直接复用 (完全包含在区间内) → ${outputFileName}`);
          await cp(join(inputDir, seg.filename), outputPath);
          console.log(`✅ 分片 ${seg.filename} 直接复用完成 → ${outputFileName}`);
          finalSegmentList.push({
            filename: outputFileName,
            duration: segDuration,
            path: outputPath
          });
        }
      }
      
      console.log(`✅ 高效 Trim 区间 ${trimIndex} 处理完成，生成了 ${overlappingSegs.length} 个独立分片`);
    }

    // 3. 构建新的 M3U8 播放列表 - 包含所有独立分片
    const outputPlaylistPath = join(outputDir, 'playlist.m3u8');
    
    if (finalSegmentList.length > 0) {
      // 📦 显示最终的分片组织结构
      const segmentNames = finalSegmentList.map(seg => seg.filename);
      console.log(`📦 最终输出的独立分片序列: [${segmentNames.join(', ')}]`);
      
      // 🎬 计算播放列表参数
      const totalDuration = finalSegmentList.reduce((sum, seg) => sum + seg.duration, 0);
      const maxDuration = Math.max(...finalSegmentList.map(seg => seg.duration));
      
      console.log(`🎯 播放列表统计: 总时长 ${totalDuration.toFixed(2)}s，最大分片时长 ${maxDuration.toFixed(2)}s`);
      
      // 🏗️ 构建 M3U8 播放列表
      const playlistLines = [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        `#EXT-X-TARGETDURATION:${Math.ceil(maxDuration)}`,
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-INDEPENDENT-SEGMENTS'
      ];
      
      // 添加每个分片的信息
      finalSegmentList.forEach((seg, index) => {
        playlistLines.push(`#EXTINF:${seg.duration.toFixed(6)},`);
        playlistLines.push(seg.filename);
        console.log(`📄 分片 ${index + 1}: ${seg.filename} (${seg.duration.toFixed(2)}s)`);
      });
      
      playlistLines.push('#EXT-X-ENDLIST');
      
      const newPlaylist = playlistLines.join('\n');
      await writeFile(outputPlaylistPath, newPlaylist);
      
      console.log(`🎉 新架构高效Trim处理完成！`);
      console.log(`📊 输出摘要: ${finalSegmentList.length} 个独立分片，总时长 ${totalDuration.toFixed(2)}s`);
    } else {
      // 如果没有成功的trim片段，创建一个空的playlist
      const emptyPlaylist = [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-TARGETDURATION:1',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXT-X-ENDLIST'
      ].join('\n');
      
      await writeFile(outputPlaylistPath, emptyPlaylist);
      console.log('⚠️ 没有成功的trim片段，创建空playlist');
    }

    // 上传 Trim 后的 HLS 文件夹
    const hlsOutputPrefix = `${spec.outputS3Prefix}/${spec.recordingId}_trimmed`;
    console.log('📤 开始上传HLS到S3...', hlsOutputPrefix);
    await uploadFolderToS3(outputDir, hlsOutputPrefix);
    console.log('✅ HLS上传完成:', hlsOutputPrefix);

    // 4. 自动导出MP4 - 基于新的分片架构
    const outputMp4 = join(outputDir, `${recordingId}.mp4`);
    console.log('🎬 开始基于新分片架构导出MP4...');
    await runFfmpeg(outputPlaylistPath, outputMp4);
    console.log('✅ MP4导出完成:', outputMp4);
    
    // 上传MP4到S3
    console.log('📤 开始上传MP4到S3...');
    await uploadMp4ToS3(outputMp4, spec);
    console.log('✅ MP4上传完成:', `${spec.outputS3Prefix}/${spec.recordingId}.mp4`);
  } finally {
    try { 
      await rm(tempDir, { recursive: true, force: true }); 
    } catch {}
  }
}

async function processZoom({ inputDir, outputDir, playlistPath, recordingId, zooms, lowQuality, spec }) {
  console.log("🎬 开始多段Zoom处理...");
  console.log("📊 参数:", { zooms, lowQuality });

  const tempDir = `/tmp/zoom_${recordingId}`;
  await mkdir(tempDir, { recursive: true });

  try {
    // 0. 拷贝所有原始文件到输出目录
    console.log("📋 拷贝原始文件到输出目录...");
    const inputFiles = await readdir(inputDir);
    for (const file of inputFiles) {
      const sourcePath = join(inputDir, file);
      const destPath = join(outputDir, file);
      await cp(sourcePath, destPath);
    }
    console.log("✅ 原始文件拷贝完成");

    // 1. 解析M3U8播放列表，提取分片信息
    const playlistContent = await readFile(playlistPath, 'utf8');
    const lines = playlistContent.split('\n');
    const segmentInfo = [];
    let currentTime = 0;
    let segmentIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXTINF:')) {
        const duration = parseFloat(line.match(/#EXTINF:([0-9]+\.?[0-9]*),/)[1]);
        const nextLine = lines[i + 1]?.trim();
        if (nextLine && nextLine.endsWith('.ts')) {
          const startTime = currentTime;
          const endTime = currentTime + duration;
          segmentInfo.push({
            index: segmentIndex,
            filename: nextLine,
            duration,
            startTime,
            endTime
          });
          currentTime = endTime;
          segmentIndex++;
        }
      }
    }

    // 2. 计算所有zoom区间对应的分片索引范围
    const zoomSegments = zooms.map((zoom, idx) => {
      // 找到与zoom区间重叠的分片
      const segs = segmentInfo.filter(seg => seg.endTime > zoom.start && seg.startTime < zoom.end);
      if (segs.length === 0) throw new Error(`没有找到与Zoom区间重叠的分片: zoom-${idx}`);
      return {
        ...zoom,
        segs,
        segStart: segs[0].index,
        segEnd: segs[segs.length - 1].index,
        idx
      };
    });

    // 3. 处理每个zoom区间，生成zoom-i.ts
    for (const zoomSeg of zoomSegments) {
      const { segs, idx, start, end, x, y, zoom: maxZoom, zoomDuration: zoomAnimationDuration = 2.0 } = zoomSeg;
      const concatList = segs.map(seg => `file '${join(inputDir, seg.filename)}'`).join('\n');
      const concatListPath = join(tempDir, `concat_list_${idx}.txt`);
      await writeFile(concatListPath, concatList);
      const mergedInputPath = join(tempDir, `merged_input_${idx}.ts`);
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(concatListPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions(['-c', 'copy'])
          .output(mergedInputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      // 时间戳重置
      const mergedInputFixedPath = join(tempDir, `merged_input_fixed_${idx}.ts`);
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(mergedInputPath)
          .inputOptions(['-fflags', '+genpts'])
          .outputOptions(['-c', 'copy', '-avoid_negative_ts', 'make_zero', '-muxdelay', '0', '-muxpreload', '0'])
          .output(mergedInputFixedPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      // 检测参数
      const videoInfo = await getVideoInfo(mergedInputFixedPath);
      const fps = videoInfo.fps || 30;
      const origWidth = videoInfo.width || 1920;
      const origHeight = videoInfo.height || 1080;
      let preScaleWidth, width, height;
      if (lowQuality) {
        preScaleWidth = 2000;
        width = 540;
        height = Math.round(origHeight * (540 / origWidth));
      } else {
        preScaleWidth = 4000;
        width = origWidth;
        height = origHeight;
      }
      // zoom动画参数
      const zoomInTime = zoomAnimationDuration;
      const zoomOutTime = zoomAnimationDuration;
      const zoomDuration = end - start;
      const zoomOutStart = zoomDuration - zoomOutTime;
      const relZoomStart = start - segs[0].startTime;
      const relZoomEnd = end - segs[0].startTime;
      const zoomFormula = `if(lt(it,${zoomInTime}), 1+it/${zoomInTime}, if(lt(it,${zoomOutStart}), ${maxZoom}, if(lt(it,${zoomDuration}), ${maxZoom}-(it-${zoomOutStart})/${zoomOutTime}, 1)))`;
      const filterComplex = [
        `[0:v]fps=${fps},scale=${preScaleWidth}:-1,split=3[pre][zoom][post];`,
        `[zoom]trim=start=${relZoomStart}:end=${relZoomEnd},setpts=PTS-STARTPTS,`,
        `zoompan=z='${zoomFormula}':`,
        `x='${x}*iw-iw/zoom/2':`,
        `y='${y}*ih-ih/zoom/2':`,
        `d=1:fps=${fps}:s=${preScaleWidth}x${Math.floor(preScaleWidth * origHeight / origWidth)}[zoomed];`,
        `[pre]trim=end=${relZoomStart},setpts=PTS-STARTPTS[first];`,
        `[post]trim=start=${relZoomEnd},setpts=PTS-STARTPTS[last];`,
        `[first]scale=${width}:${height}:flags=lanczos,setsar=1:1[first_scaled];`,
        `[zoomed]scale=${width}:${height}:flags=lanczos,setsar=1:1[zoomed_scaled];`,
        `[last]scale=${width}:${height}:flags=lanczos,setsar=1:1[last_scaled];`,
        `[first_scaled][zoomed_scaled][last_scaled]concat=n=3:v=1:a=0[outv]`
      ].join('');
      const zoomedPath = join(outputDir, `zoom-${idx}.ts`);
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(mergedInputFixedPath)
          .outputOptions(['-filter_complex', filterComplex, '-map', '[outv]', '-map', '0:a', '-c:v', 'libx264', '-r', fps.toString(), '-c:a', 'copy'])
          .output(zoomedPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
    }

    // 4. playlist重建
    const outputPlaylistPath = join(outputDir, 'playlist.m3u8');
    // 收集头部字段
    const headerLines = [];
    for (const line of lines) {
      if (line.startsWith('#EXTINF')) break;
      headerLines.push(line);
    }
    const newLines = [...headerLines];
    let segmentIdx = 0;
    let zoomIdx = 0;
    while (segmentIdx < segmentInfo.length) {
      // 检查当前分片是否在某个zoom区间
      const zoom = zoomSegments[zoomIdx];
      if (zoom && segmentIdx === zoom.segStart) {
        // 插入zoom分片
        const zoomedPath = `zoom-${zoomIdx}.ts`;
        // 计算zoom分片实际时长
        const zoomFileInfo = await getVideoInfo(join(outputDir, zoomedPath));
        newLines.push(`#EXTINF:${zoomFileInfo.duration},`);
        newLines.push(zoomedPath);
        // 跳过被替换的原分片
        segmentIdx = zoom.segEnd + 1;
        zoomIdx++;
      } else {
        // 保留原分片
        const seg = segmentInfo[segmentIdx];
        newLines.push(`#EXTINF:${seg.duration},`);
        newLines.push(seg.filename);
        segmentIdx++;
      }
    }
    newLines.push('#EXT-X-ENDLIST');
    await writeFile(outputPlaylistPath, newLines.join('\n'));
    console.log('✅ 多段Zoom处理完成！');

    // 上传 Zoom 后的 HLS 文件夹
    const hlsOutputPrefix = `${spec.outputS3Prefix}/${spec.recordingId}_zoomed`;
    console.log('📤 开始上传HLS到S3...', hlsOutputPrefix);
    await uploadFolderToS3(outputDir, hlsOutputPrefix);
    console.log('✅ HLS上传完成:', hlsOutputPrefix);

    // 自动导出MP4
    const outputMp4 = join(outputDir, `${recordingId}.mp4`);
    await runFfmpeg(outputPlaylistPath, outputMp4);
    console.log('✅ MP4导出完成:', outputMp4);
    
    // 上传MP4到S3
    console.log('📤 开始上传MP4到S3...');
    await uploadMp4ToS3(outputMp4, spec);
    console.log('✅ MP4上传完成:', `${spec.outputS3Prefix}/${spec.recordingId}.mp4`);
  } finally {
    try { 
      await rm(tempDir, { recursive: true, force: true }); 
    } catch {}
  }
}

// 辅助函数：获取视频信息
function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, info) => {
      if (err) {
        reject(new Error(`FFprobe failed: ${err.message}`));
        return;
      }
      
      try {
        const videoStream = info.streams?.find(s => s.codec_type === 'video');
        const format = info.format;
        
        let fps = 30;
        if (videoStream?.r_frame_rate) {
          const [num, den] = videoStream.r_frame_rate.split('/');
          fps = parseFloat(num) / parseFloat(den);
        }
        
        resolve({
          width: videoStream?.width || 1920,
          height: videoStream?.height || 1080,
          fps,
          duration: parseFloat(format?.duration) || 0
        });
      } catch (e) {
        reject(new Error(`Failed to parse video info: ${e.message}`));
      }
    });
  });
}

// 辅助函数：导出MP4
async function runFfmpeg(inputM3U8, outputMp4) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputM3U8)
      .outputOptions([
        "-c copy",
        "-movflags +faststart",
        "-threads 1",
        "-max_alloc 268435456",
        "-hide_banner",
        "-loglevel error",
      ])
      .on("start", (cmd) => console.log("[ffmpeg mp4]", cmd))
      .on("error", reject)
      .on("end", resolve)
      .save(outputMp4);
  });
}

// 辅助函数：上传MP4到S3
async function uploadMp4ToS3(path, spec) {
  const data = await readFile(path);
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `${spec.outputS3Prefix}/${spec.recordingId}.mp4`,
      Body: data,
      ContentType: "video/mp4",
      ContentDisposition: `attachment; filename="${spec.recordingId}.mp4"`,
    })
  );
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