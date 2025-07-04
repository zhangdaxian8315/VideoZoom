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

// async function processZoom({ inputDir, outputDir, playlistPath, recordingId, zoomStart, zoomEnd, zoomCenterX, zoomCenterY }) {
//   const inputM3U8 = playlistPath;
//   const outputZoomedTS = join(outputDir, 'zoomed.ts');
//   const outputM3U8 = join(outputDir, 'playlist.m3u8');

//   const fps = 30;
//   const zoomInTime = 2.0;
//   const zoomOutTime = 2.0;
//   const zoomDuration = zoomEnd - zoomStart;
//   const zoomOutStart = zoomDuration - zoomOutTime;

//   const zoomFormula = `if(lt(it,${zoomInTime}), 1+it/${zoomInTime}, if(lt(it,${zoomOutStart}), 2, if(lt(it,${zoomDuration}), 2-(it-${zoomOutStart})/${zoomOutTime}, 1)))`;

//   return new Promise((resolve, reject) => {
//     ffmpeg(inputM3U8)
//       .inputOptions('-fflags +genpts')
//       .outputOptions(
//         '-filter_complex',
//         `fps=${fps},zoompan=z='${zoomFormula}':x='${zoomCenterX}*iw-(iw/zoom/2)':y='${zoomCenterY}*ih-(ih/zoom/2)':d=1`
//       )
//       .videoCodec('libx264')
//       .audioCodec('aac')
//       .on('start', cmd => console.log('[ffmpeg zoom]', cmd))
//       .on('stderr', line => console.log('[ffmpeg]', line))
//       .on('end', async () => {
//         await writeFile(outputM3U8, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:${zoomDuration},\nzoomed.ts\n#EXT-X-ENDLIST`);
//         resolve();
//       })
//       .on('error', reject)
//       .save(outputZoomedTS);
//   });
// }

import { promises as fs } from 'fs';
import ffprobe from 'fluent-ffmpeg';
import { execSync } from 'child_process';

// async function processZoom({
//   inputDir,
//   outputDir,
//   playlistPath,
//   recordingId,
//   zoomStart,
//   zoomEnd,
//   zoomCenterX,
//   zoomCenterY
// }) {
//   const m3u8Text = await fs.readFile(playlistPath, 'utf-8');
//   const lines = m3u8Text.split('\n');

//   const segments = [];
//   let i = 0, currentTime = 0;
//   while (i < lines.length) {
//     if (lines[i].startsWith('#EXTINF:')) {
//       const duration = parseFloat(lines[i].split(':')[1]);
//       const filename = lines[i + 1];
//       const start = currentTime;
//       const end = currentTime + duration;
//       segments.push({ index: segments.length, filename, duration, start, end });
//       currentTime = end;
//       i += 2;
//     } else {
//       i++;
//     }
//   }

//   // 找到与 Zoom 时间段重叠的分片
//   const selected = segments.filter(seg =>
//     seg.end > zoomStart && seg.start < zoomEnd
//   );

//   if (selected.length === 0) {
//     throw new Error('❌ No overlapping segments found for zoom.');
//   }

//   const firstIdx = selected[0].index;
//   const lastIdx = selected[selected.length - 1].index;
//   const relZoomStart = zoomStart - selected[0].start;
//   const relZoomEnd = zoomEnd - selected[0].start;
//   const zoomDuration = relZoomEnd - relZoomStart;

//   // 合并 TS 文件列表
//   const concatListPath = join(outputDir, 'concat.txt');
//   const concatList = selected.map(seg => `file '${join(inputDir, seg.filename)}'`).join('\n');
//   await fs.writeFile(concatListPath, concatList);

//   const mergedTS = join(outputDir, 'merged.ts');
//   execSync(`ffmpeg -f concat -safe 0 -i ${concatListPath} -c copy ${mergedTS} -y`);

//   // 检测视频分辨率与帧率
//   const widthStr = execSync(
//     `ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 ${mergedTS}`,
//     { encoding: 'utf-8' }
//   );
  
//   const heightStr = execSync(
//     `ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 ${mergedTS}`,
//     { encoding: 'utf-8' }
//   );
  
//   const fpsStr = execSync(
//     `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 ${mergedTS}`,
//     { encoding: 'utf-8' }
//   );
//   const [num, den] = fpsStr.trim().split('/').map(Number);
//   const fps = +(num / den).toFixed(2);

//   // Zoom 动画
//   const zoomInTime = 2.0, zoomOutTime = 2.0;
//   const zoomOutStart = zoomDuration - zoomOutTime;
//   const zoomFormula = `if(lt(it,${zoomInTime}), 1+it/${zoomInTime}, if(lt(it,${zoomOutStart}), 2, if(lt(it,${zoomDuration}), 2-(it-${zoomOutStart})/${zoomOutTime}, 1)))`;
//   const zoomX = `${zoomCenterX}*iw-(iw/zoom/2)`;
//   const zoomY = `${zoomCenterY}*ih-(ih/zoom/2)`;

//   const zoomedTS = join(outputDir, 'zoomed.ts');

// // 📝 添加日志：确认源文件存在
// if (!existsSync(mergedTS)) {
//   throw new Error(`❌ 找不到合并后的 TS 文件: ${mergedTS}`);
// }

// console.log(`🔧 准备执行 FFmpeg Zoom 转码...`);
// console.log(`📥 输入文件: ${mergedTS}`);
// console.log(`📤 输出文件: ${zoomedTS}`);
// console.log(`📐 分辨率: ${widthStr.trim()}x${heightStr.trim()}, FPS: ${fpsStr.trim()}`);
// console.log(`📍 注目点: (${zoomCenterX}, ${zoomCenterY})`);
// console.log(`🎞️ 变焦动画时长: ${zoomDuration.toFixed(2)} 秒`);

// await new Promise((resolve, reject) => {
//   const stderrLog = [];

//   ffmpeg(mergedTS)
//     .videoFilters(`fps=${fps},zoompan=z='${zoomFormula}':x='${zoomX}':y='${zoomY}':d=1`)
//     .videoCodec('libx264')
//     .audioCodec('aac')
//     .outputOptions('-preset veryfast')
//     .on('start', cmd => {
//       console.log('[ffmpeg zoom command]', cmd);
//     })
//     .on('stderr', line => {
//       stderrLog.push(line);
//       console.log('[ffmpeg]', line);
//     })
//     .on('end', () => {
//       console.log('✅ FFmpeg 转码成功');
//       resolve();
//     })
//     .on('error', err => {
//       console.error('❌ FFmpeg 转码失败:', err.message);
//       console.error('❗ stderr 输出如下:');
//       console.error(stderrLog.join('\n'));
//       reject(err);
//     })
//     .save(zoomedTS);
// });


//   // 替换 playlist.m3u8 中的对应分片为 zoomed.ts
//   const newPlaylistLines = [];
//   let segmentIndex = 0;
//   for (let i = 0; i < lines.length; i++) {
//     if (lines[i].startsWith('#EXTINF:')) {
//       if (segmentIndex === firstIdx) {
//         newPlaylistLines.push(`#EXTINF:${zoomDuration.toFixed(3)},`);
//         newPlaylistLines.push('zoomed.ts');
//         i++; // skip original ts line
//         while (segmentIndex < lastIdx) {
//           i += 2;
//           segmentIndex++;
//         }
//       } else {
//         newPlaylistLines.push(lines[i]);
//         newPlaylistLines.push(lines[i + 1]);
//         i++;
//       }
//       segmentIndex++;
//     } else {
//       newPlaylistLines.push(lines[i]);
//     }
//   }

//   await fs.writeFile(join(outputDir, 'playlist.m3u8'), newPlaylistLines.join('\n'));
//   console.log('✅ Zoom process complete.');
// }

async function processZoom({ inputDir, outputDir, playlistPath, recordingId, zoomStart, zoomEnd, zoomCenterX, zoomCenterY }) {
  console.log("🎬 开始 Zoom 处理...");
  console.log("📊 参数:", { zoomStart, zoomEnd, zoomCenterX, zoomCenterY });

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
      console.log(`📋 已拷贝: ${file}`);
    }
    console.log("✅ 原始文件拷贝完成");
    // 1. 解析M3U8播放列表，提取分片信息
    console.log("📋 解析M3U8播放列表...");
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

    // 2. 找到与zoom时间段重叠的分片
    console.log("🔍 查找目标分片...");
    const targetSegments = segmentInfo.filter(seg => 
      seg.endTime > zoomStart && seg.startTime < zoomEnd
    );

    if (targetSegments.length === 0) {
      throw new Error("没有找到与Zoom时间段重叠的分片");
    }

    const segmentStart = targetSegments[0].index;
    const segmentEnd = targetSegments[targetSegments.length - 1].index;
    
    console.log(`🎯 目标分片范围: ${segmentStart} 到 ${segmentEnd} (共 ${targetSegments.length} 个分片)`);
    
    // 打印每个目标分片的实际时长
    console.log("📊 目标分片实际时长:");
    for (const seg of targetSegments) {
      const segPath = join(inputDir, seg.filename);
      const info = await getVideoInfo(segPath);
      console.log(`  ${seg.filename}: ${info.duration}s`);
    }
    
    // 详细分片信息日志
    console.log("📊 所有分片信息:");
    segmentInfo.forEach(seg => {
      console.log(`  分片${seg.index}: ${seg.startTime}s-${seg.endTime}s (${seg.duration}s) - ${seg.filename}`);
    });
    
    console.log("🎯 目标分片详细信息:");
    targetSegments.forEach(seg => {
      console.log(`  目标分片${seg.index}: ${seg.startTime}s-${seg.endTime}s (${seg.duration}s) - ${seg.filename}`);
    });
    
    console.log(`🎯 Zoom时间段: ${zoomStart}s - ${zoomEnd}s`);

    // 3. 合并目标分片
    console.log("🔗 合并目标分片...");
    const concatList = targetSegments.map(seg => 
      `file '${join(inputDir, seg.filename)}'`
    ).join('\n');
    
    const concatListPath = join(tempDir, 'concat_list.txt');
    await writeFile(concatListPath, concatList);
    
    console.log("📄 Concat文件内容:");
    console.log(concatList);

    const mergedInputPath = join(tempDir, 'merged_input.ts');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatListPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c', 'copy'])
        .output(mergedInputPath)
        .on('start', cmd => console.log('[ffmpeg concat]', cmd))
        .on('stderr', line => console.log('[ffmpeg]', line))
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // 4. 调整时间戳从0开始
    console.log("🔄 调整时间戳...");
    const mergedInputFixedPath = join(tempDir, 'merged_input_fixed.ts');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(mergedInputPath)
        .inputOptions(['-fflags', '+genpts'])
        .outputOptions(['-c', 'copy', '-avoid_negative_ts', 'make_zero', '-muxdelay', '0', '-muxpreload', '0'])
        .output(mergedInputFixedPath)
        .on('start', cmd => console.log('[ffmpeg genpts]', cmd))
        .on('stderr', line => console.log('[ffmpeg]', line))
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // 5. 检测视频参数
    console.log("🔍 检测视频参数...");
    const videoInfo = await getVideoInfo(mergedInputFixedPath);
    const fps = videoInfo.fps || 30;
    const width = videoInfo.width || 1920;
    const height = videoInfo.height || 1080;
    
    console.log(`📊 合并后文件信息: ${videoInfo.duration}s, ${width}x${height}, ${fps}fps`);

    // 6. 计算相对时间
    const firstSegmentStartTime = targetSegments[0].startTime;
    const relZoomStart = zoomStart - firstSegmentStartTime;
    const relZoomEnd = zoomEnd - firstSegmentStartTime;
    const zoomDuration = relZoomEnd - relZoomStart;
    
    console.log(`📊 时间参数: 相对zoom时间段 ${relZoomStart}s → ${relZoomEnd}s, 持续 ${zoomDuration}s`);
    console.log(`📊 时间计算详情:`);
    console.log(`  - 第一个目标分片开始时间: ${firstSegmentStartTime}s`);
    console.log(`  - 原始zoom开始时间: ${zoomStart}s`);
    console.log(`  - 原始zoom结束时间: ${zoomEnd}s`);
    console.log(`  - 相对zoom开始时间: ${relZoomStart}s`);
    console.log(`  - 相对zoom结束时间: ${relZoomEnd}s`);
    console.log(`  - Zoom持续时间: ${zoomDuration}s`);

    // 7. 设置zoom参数
    const zoomInTime = 2.0;
    const zoomOutTime = 2.0;
    const zoomOutStart = zoomDuration - zoomOutTime;
    const preScaleWidth = 4000;

    // 8. 执行zoom处理
    console.log("🎞️ 执行zoom处理...");
    const zoomedPath = join(tempDir, 'zoomed.ts');
    
    const zoomFormula = `if(lt(it,${zoomInTime}), 1+it/${zoomInTime}, if(lt(it,${zoomOutStart}), 2, if(lt(it,${zoomDuration}), 2-(it-${zoomOutStart})/${zoomOutTime}, 1)))`;
    
    const filterComplex = [
      `[0:v]fps=${fps},scale=${preScaleWidth}:-1,split=3[pre][zoom][post];`,
      `[zoom]trim=start=${relZoomStart}:end=${relZoomEnd},setpts=PTS-STARTPTS,`,
      `zoompan=z='${zoomFormula}':`,
      `x='${zoomCenterX}*iw-iw/zoom/2':`,
      `y='${zoomCenterY}*ih-ih/zoom/2':`,
      `d=1:fps=${fps}:s=${preScaleWidth}x${Math.floor(preScaleWidth * height / width)}[zoomed];`,
      `[pre]trim=end=${relZoomStart},setpts=PTS-STARTPTS[first];`,
      `[post]trim=start=${relZoomEnd},setpts=PTS-STARTPTS[last];`,
      `[first]scale=${width}:${height}:flags=lanczos,setsar=1:1[first_scaled];`,
      `[zoomed]scale=${width}:${height}:flags=lanczos,setsar=1:1[zoomed_scaled];`,
      `[last]scale=${width}:${height}:flags=lanczos,setsar=1:1[last_scaled];`,
      `[first_scaled][zoomed_scaled][last_scaled]concat=n=3:v=1:a=0[outv]`
    ].join('');

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(mergedInputFixedPath)
        .outputOptions(['-filter_complex', filterComplex, '-map', '[outv]', '-map', '0:a', '-c:v', 'libx264', '-r', fps.toString(), '-c:a', 'copy'])
        .output(zoomedPath)
        .on('start', cmd => console.log('[ffmpeg zoom]', cmd))
        .on('stderr', line => console.log('[ffmpeg]', line))
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // 9. 检测zoom文件时长
    const zoomFileInfo = await getVideoInfo(zoomedPath);
    const zoomFileDuration = zoomFileInfo.duration || zoomDuration;
    
    console.log(`📊 Zoom文件信息:`);
    console.log(`  - 期望时长: ${zoomDuration}s`);
    console.log(`  - 实际时长: ${zoomFileInfo.duration}s`);
    console.log(`  - 使用时长: ${zoomFileDuration}s`);

    // 10. 删除原始目标分片并复制zoom文件
    console.log("🗑️ 删除原始目标分片...");
    for (const seg of targetSegments) {
      const originalPath = join(outputDir, seg.filename);
      try {
        await rm(originalPath);
      } catch (e) {
        console.log(`⚠️ 删除文件失败: ${seg.filename}`);
      }
    }

    console.log("📋 复制zoom文件...");
    const outputZoomedPath = join(outputDir, 'zoomed.ts');
    await cp(zoomedPath, outputZoomedPath);

    // 11. 更新playlist.m3u8
    console.log("📝 更新playlist.m3u8...");
    await updatePlaylist(inputDir, outputDir, segmentStart, segmentEnd, zoomFileDuration);

    console.log("✅ Zoom处理完成");
  } finally {
    // 清理临时文件
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.log("⚠️ 清理临时目录失败:", e.message);
    }
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

// 辅助函数：更新播放列表
async function updatePlaylist(inputDir, outputDir, segmentStart, segmentEnd, zoomFileDuration) {
  const inputPlaylistPath = join(inputDir, 'playlist.m3u8');
  const outputPlaylistPath = join(outputDir, 'playlist.m3u8');
  
  const playlistContent = await readFile(inputPlaylistPath, 'utf8');
  const lines = playlistContent.split('\n');
  
  const newLines = [];
  let segmentIndex = 0;
  let replaced = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.startsWith('#EXTINF:')) {
      const nextLine = lines[i + 1];
      if (nextLine && nextLine.endsWith('.ts')) {
        if (segmentIndex >= segmentStart && segmentIndex <= segmentEnd) {
          // 在替换范围内，只插入一次zoom文件
          if (!replaced) {
            newLines.push('#EXTINF:' + zoomFileDuration + ',');
            newLines.push('zoomed.ts');
            replaced = true;
          }
          // 跳过原始分片
        } else {
          // 不在替换范围内，保持原样
          newLines.push(line);
          newLines.push(nextLine);
        }
        segmentIndex++;
        i++; // 跳过文件名行
      } else {
        newLines.push(line);
      }
    } else {
      newLines.push(line);
    }
  }
  
  await writeFile(outputPlaylistPath, newLines.join('\n'));
}


const ok = (body) => ({ statusCode: 200, body: JSON.stringify(body) });
const error = (c, m) => ({ statusCode: c, body: m });