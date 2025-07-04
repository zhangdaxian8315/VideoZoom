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
  S3_REGION,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  S3_BUCKET,
} = process.env;

// ffmpeg.setFfmpegPath(FFMPEG);
ffmpeg.setFfmpegPath('/opt/bin/ffmpeg');
ffmpeg.setFfprobePath('/opt/bin/ffprobe');

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
      zooms: spec.zooms,
      lowQuality: spec.lowQuality === 'true' ? true : false,
      spec,
    });
    console.log("✅ Zoom 处理完成");
    

    // 3. 上传整个 outputDir 文件夹到 S3 - 暂时注释掉
    console.log("📤 开始上传到 S3...");
    await uploadFolderToS3(outputDir, spec.outputS3Prefix);
    console.log("✅ S3 上传完成");
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
    "recordingId", "manifestFileUrl", "callbackUrl", "zooms", "outputS3Prefix"
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
      const { segs, idx, start, end, x, y, zoom: maxZoom } = zoomSeg;
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
      const zoomInTime = 2.0;
      const zoomOutTime = 2.0;
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

    // 自动导出MP4
    const outputMp4 = join(outputDir, `${recordingId}.mp4`);
    await runFfmpeg(outputPlaylistPath, outputMp4);
    console.log('✅ MP4导出完成:', outputMp4);
    
    // 上传MP4到S3
    console.log('📤 开始上传MP4到S3...');
    await uploadMp4ToS3(outputMp4, spec);
    console.log('✅ MP4上传完成:', `${spec.outputS3Prefix}/${spec.recordingId}.mp4`);
  } finally {
    try { await rm(tempDir, { recursive: true, force: true }); } catch {}
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

const ok = (body) => ({ statusCode: 200, body: JSON.stringify(body) });
const error = (c, m) => ({ statusCode: c, body: m });