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
  const outputDir = `${workDir}_Edited`;

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
  
    // 2. 执行处理逻辑（支持：只裁剪、只缩放、根据配置选择处理顺序）
    let hasTrimmed = false;
    let hasZoomed = false;
    let hasBackgrounded = false;
    let currentInputDir = segDir;
    let currentPlaylistPath = playlistPath;
    let finalOutputDir = outputDir; // 最终输出目录
    
    // 🔧 根据时间线配置决定处理顺序
    if (spec.useOriginalTimeline) {
      // 🎯 使用原始时间线：先缩放后裁剪
      console.log("🎯 使用原始时间线：先缩放后裁剪");
      
      // 第一步：如果有zooms，先执行缩放（在原始时间轴上）
      if (spec.zooms && spec.zooms.length > 0) {
        console.log("🎬 开始 Zoom 处理（原始时间轴）...");
        
        // 为缩放步骤创建独立的临时目录
        const zoomOutputDir = hasTrimmed 
          ? `/tmp/${spec.recordingId}_zoomed` 
          : finalOutputDir; // 如果只有缩放，直接输出到最终目录
        
        if (zoomOutputDir !== finalOutputDir) {
          await mkdir(zoomOutputDir, { recursive: true });
        }
        
        // 🔍 分片分割预处理：检测重叠并执行分割
        let finalZoomInputDir = currentInputDir;
        let finalZoomPlaylistPath = currentPlaylistPath;
        
        if (spec.zooms && spec.zooms.length > 0) {
          console.log("🔍 开始分片分割预处理...");
          
          // 1. 检测重叠和计算分割点
          const segmentInfo = await parseM3U8Segments(currentPlaylistPath);
          const splitPoints = detectOverlappingAndCalculateSplitPoints(spec.zooms, segmentInfo);
          
          // 2. 如果有分割点，执行分片分割
          if (splitPoints.length > 0) {
            console.log("⚠️ 检测到需要分割的分片，开始执行分片分割...");
            
            // 创建分割输出目录
            const splitOutputDir = `/tmp/${spec.recordingId}_split`;
            await mkdir(splitOutputDir, { recursive: true });
            
            // 执行分片分割
            const splitResult = await splitSegmentsForZoom({
              inputDir: currentInputDir,
              outputDir: splitOutputDir,
              playlistPath: currentPlaylistPath,
              recordingId: spec.recordingId,
              splitPoints: splitPoints,
              lowQuality: spec.lowQuality === 'true' ? true : false,
              spec: spec,
            });
            
            // 更新输入路径
            finalZoomInputDir = splitResult.inputDir;
            finalZoomPlaylistPath = splitResult.playlistPath;
            
            console.log("✅ 分片分割完成，使用分割后的播放列表");
          } else {
            console.log("✅ 无需分割，使用原始播放列表");
          }
        }
        
        await processZoom({
          inputDir: finalZoomInputDir,
          outputDir: zoomOutputDir,
          playlistPath: finalZoomPlaylistPath,
          recordingId: spec.recordingId,
          zooms: spec.zooms,
          lowQuality: spec.lowQuality === 'true' ? true : false,
          spec,
        });
        console.log("✅ Zoom 处理完成");
        
        // 更新输入目录和播放列表路径，为后续裁剪做准备
        hasZoomed = true;
        currentInputDir = zoomOutputDir;
        currentPlaylistPath = join(zoomOutputDir, 'playlist.m3u8');
      }
      
      // 第二步：如果有trims，执行裁剪（基于缩放后的结果或原始文件）
      if (spec.trims && spec.trims.length > 0) {
        console.log("✂️ 开始 Trim 处理...");
        
        // 为裁剪步骤创建独立的临时目录
        const trimOutputDir = hasZoomed 
          ? `/tmp/${spec.recordingId}_trimmed` 
          : finalOutputDir; // 如果只有裁剪，直接输出到最终目录
        
        if (trimOutputDir !== finalOutputDir) {
          await mkdir(trimOutputDir, { recursive: true });
        }
        
        await processTrimFast({
          inputDir: currentInputDir,
          outputDir: trimOutputDir,
          playlistPath: currentPlaylistPath,
          recordingId: spec.recordingId,
          trims: spec.trims,
          lowQuality: spec.lowQuality === 'true' ? true : false,
          spec,
        });
        console.log("✅ Trim 处理完成");

        hasTrimmed = true;
        
        // 更新裁剪后的路径，为后续步骤做准备
        currentInputDir = trimOutputDir;
        currentPlaylistPath = join(trimOutputDir, 'playlist.m3u8');
        
        // 如果是先缩放再裁剪，需要将最终结果复制到最终目录
        if (hasZoomed) {
          // 注意：文件复制和目录清理已移到所有步骤完成后
          console.log("✅ 缩放和裁剪处理完成，等待背景处理...");
        }
      }

      // 🎨 第三步：背景处理（基于缩放或裁剪后的结果）
      if (spec.backgroundImage || spec.backgroundAudio || spec.aiNarrationAudio) {
        console.log("🎨 开始背景处理...");
        
        // 为背景处理创建独立的临时目录
        const backgroundOutputDir = (hasZoomed || hasTrimmed) 
          ? `/tmp/${spec.recordingId}_background` 
          : finalOutputDir; // 如果前面都没有处理，直接输出到最终目录
        
        if (backgroundOutputDir !== finalOutputDir) {
          await mkdir(backgroundOutputDir, { recursive: true });
        }
        
        await processBackground({
          inputDir: currentInputDir,  // 使用前面步骤的输出
          outputDir: backgroundOutputDir, // 输出到背景处理目录
          playlistPath: currentPlaylistPath,
          recordingId: spec.recordingId,
          backgroundConfig: {
            backgroundImage: spec.backgroundImage,
            backgroundAudio: spec.backgroundAudio,
            aiNarrationAudio: spec.aiNarrationAudio
          },
          lowQuality: spec.lowQuality === 'true' ? true : false,
          spec
        });
        console.log("✅ 背景处理完成");
        
        // 更新当前输入目录和播放列表路径
        hasBackgrounded = true;
        currentInputDir = backgroundOutputDir;
        currentPlaylistPath = join(backgroundOutputDir, 'playlist.m3u8');
      }
      
      // 🎯 第四步：文件操作（复制/清理 或 直接拷贝原始文件）
      if (hasZoomed || hasTrimmed || hasBackgrounded) {
        console.log("🔄 所有处理步骤完成，开始复制最终结果...");
        
        // 确定源目录：按优先级选择最后一步的输出目录
        let sourceDir;
        if (hasBackgrounded) {
          sourceDir = currentInputDir; // 背景处理输出目录
          console.log(`📁 从背景处理输出目录复制: ${sourceDir}`);
        } else if (hasTrimmed && typeof trimOutputDir !== 'undefined') {
          sourceDir = trimOutputDir; // 裁剪输出目录
          console.log(`📁 从裁剪输出目录复制: ${sourceDir}`);
        } else if (hasZoomed && typeof zoomOutputDir !== 'undefined') {
          sourceDir = zoomOutputDir; // 缩放输出目录
          console.log(`📁 从缩放输出目录复制: ${sourceDir}`);
        } else {
          // 兜底方案：使用当前输入目录
          sourceDir = currentInputDir;
          console.log(`📁 使用兜底方案，从当前输入目录复制: ${sourceDir}`);
        }
        
        // 复制最终结果到输出目录
        await copyFinalResultToOutputDir(sourceDir, finalOutputDir);
        console.log("✅ 最终结果复制完成");
        
        // 清理所有临时目录
        console.log("🧹 开始清理临时目录...");
        try {
          if (hasZoomed && typeof zoomOutputDir !== 'undefined') {
            await rm(zoomOutputDir, { recursive: true, force: true });
            console.log(`✅ 清理缩放临时目录: ${zoomOutputDir}`);
          }
        } catch (e) {
          console.warn(`⚠️ 清理缩放临时目录失败: ${e.message}`);
        }
        
        try {
          if (hasTrimmed && typeof trimOutputDir !== 'undefined') {
            await rm(trimOutputDir, { recursive: true, force: true });
            console.log(`✅ 清理裁剪临时目录: ${trimOutputDir}`);
          }
        } catch (e) {
          console.warn(`⚠️ 清理裁剪临时目录失败: ${e.message}`);
        }
        
        try {
          if (hasBackgrounded && typeof backgroundOutputDir !== 'undefined') {
            await rm(backgroundOutputDir, { recursive: true, force: true });
            console.log(`✅ 清理背景处理临时目录: ${backgroundOutputDir}`);
          }
        } catch (e) {
          console.warn(`⚠️ 清理背景处理临时目录失败: ${e.message}`);
        }
        
        console.log("✅ 所有临时目录清理完成");
      } else {
        // 如果没有任何处理步骤，直接拷贝原始文件
        console.log("📋 没有处理参数，直接拷贝原始文件...");
        await copyOriginalFiles(segDir, finalOutputDir);
        console.log("✅ 文件拷贝完成");
      }
      
    } else {
      // 🎯 使用新时间线：先裁剪后缩放（保持原有逻辑）
      console.log("🎯 使用新时间线：先裁剪后缩放");
      
      // 第一步：如果有trims，先执行裁剪
      if (spec.trims && spec.trims.length > 0) {
        console.log("✂️ 开始 Trim 处理...");
        
        // 为裁剪步骤创建独立的临时目录
        const trimOutputDir = spec.zooms && spec.zooms.length > 0 
          ? `/tmp/${spec.recordingId}_trimmed` 
          : finalOutputDir; // 如果只有裁剪，直接输出到最终目录
        
        if (trimOutputDir !== finalOutputDir) {
          await mkdir(trimOutputDir, { recursive: true });
        }
        
        await processTrimFast({
          inputDir: currentInputDir,
          outputDir: trimOutputDir,
          playlistPath: currentPlaylistPath,
          recordingId: spec.recordingId,
          trims: spec.trims,
          lowQuality: spec.lowQuality === 'true' ? true : false,
          spec,
        });
        console.log("✅ Trim 处理完成");
        
        // 更新输入目录和播放列表路径，为后续缩放做准备
        hasTrimmed = true;
        currentInputDir = trimOutputDir;
        currentPlaylistPath = join(trimOutputDir, 'playlist.m3u8');
      }
      
      // 第二步：如果有zooms，执行缩放（基于裁剪后的结果或原始文件）
      if (spec.zooms && spec.zooms.length > 0) {
        console.log("🎬 开始 Zoom 处理...");
        
        // 为缩放步骤创建独立的临时目录
        const zoomOutputDir = hasTrimmed 
          ? `/tmp/${spec.recordingId}_zoomed` 
          : finalOutputDir; // 如果只有缩放，直接输出到最终目录
        
        if (zoomOutputDir !== finalOutputDir) {
          await mkdir(zoomOutputDir, { recursive: true });
        }
        
        // 🔍 分片分割预处理：检测重叠并执行分割
        let finalZoomInputDir = currentInputDir;
        let finalZoomPlaylistPath = currentPlaylistPath;
        
        if (spec.zooms && spec.zooms.length > 0) {
          console.log("🔍 开始分片分割预处理...");
          
          // 1. 检测重叠和计算分割点
          const segmentInfo = await parseM3U8Segments(currentPlaylistPath);
          const splitPoints = detectOverlappingAndCalculateSplitPoints(spec.zooms, segmentInfo);
          
          // 2. 如果有分割点，执行分片分割
          if (splitPoints.length > 0) {
            console.log("⚠️ 检测到需要分割的分片，开始执行分片分割...");
            
            // 创建分割输出目录
            const splitOutputDir = `/tmp/${spec.recordingId}_split`;
            await mkdir(splitOutputDir, { recursive: true });
            
            // 执行分片分割
            const splitResult = await splitSegmentsForZoom({
              inputDir: currentInputDir,
              outputDir: splitOutputDir,
              playlistPath: currentPlaylistPath,
              recordingId: spec.recordingId,
              splitPoints: splitPoints,
              lowQuality: spec.lowQuality === 'true' ? true : false,
              spec: spec,
            });
            
            // 更新输入路径
            finalZoomInputDir = splitResult.inputDir;
            finalZoomPlaylistPath = splitResult.playlistPath;
            
            console.log("✅ 分片分割完成，使用分割后的播放列表");
          } else {
            console.log("✅ 无需分割，使用原始播放列表");
          }
        }
        
        await processZoom({
          inputDir: finalZoomInputDir,
          outputDir: zoomOutputDir,
          playlistPath: finalZoomPlaylistPath,
          recordingId: spec.recordingId,
          zooms: spec.zooms,
          lowQuality: spec.lowQuality === 'true' ? true : false,
          spec,
        });
        console.log("✅ Zoom 处理完成");
        
        // 如果是先裁剪再缩放，需要将最终结果复制到最终目录
        if (hasTrimmed) {
          console.log("🔄 将最终结果复制到最终目录...");
          await copyFinalResultToOutputDir(zoomOutputDir, finalOutputDir);
          console.log("✅ 最终结果复制完成");
          
          // 清理临时目录
          console.log("🧹 清理临时目录...");
          try {
            await rm(trimOutputDir, { recursive: true, force: true });
            console.log(`✅ 清理临时目录: ${trimOutputDir}`);
          } catch (e) {
            console.warn(`⚠️ 清理临时目录失败: ${e.message}`);
          }
          try {
            await rm(zoomOutputDir, { recursive: true, force: true });
            console.log(`✅ 清理临时目录: ${zoomOutputDir}`);
          } catch (e) {
            console.warn(`⚠️ 清理临时目录失败: ${e.message}`);
          }
        }
      } else if (!hasTrimmed) {
        // 如果既没有trims也没有zooms，直接拷贝原始文件
        console.log("📋 没有处理参数，直接拷贝原始文件...");
        await copyOriginalFiles(segDir, finalOutputDir);
        console.log("✅ 文件拷贝完成");
      }
    }
    
    // 📤 统一上传所有文件到S3
    console.log("📤 开始统一上传流程...");
    const uploadResult = await uploadAllToS3(finalOutputDir, spec);
    console.log("✅ 统一上传流程完成");
  
    // ✅ 构造回调 JSON
    const resultPayload = {
      status: "success",
      recordingId: spec.recordingId,
      outputMp4: `${spec.outputS3Prefix}/${spec.recordingId}.mp4`,
    };

    // 根据实际使用的功能设置不同的回调数据
    if (spec.trims && spec.trims.length > 0 && spec.zooms && spec.zooms.length > 0) {
      // 根据时间线配置描述处理顺序
      const processingOrder = spec.useOriginalTimeline ? '先缩放后裁剪' : '先裁剪后缩放';
      console.log(`📋 处理顺序: ${processingOrder}`);
      
      resultPayload.outputHls = uploadResult.hlsPrefix + '/playlist.m3u8';
      resultPayload.trims = spec.trims;
      resultPayload.zooms = spec.zooms;
      resultPayload.totalDuration = spec.trims.reduce((total, trim) => total + (trim.end - trim.start), 0);
      resultPayload.processingOrder = processingOrder;
      resultPayload.useOriginalTimeline = spec.useOriginalTimeline;
    } else if (spec.trims && spec.trims.length > 0) {
      // 只裁剪功能的回调数据
      resultPayload.outputHls = uploadResult.hlsPrefix + '/playlist.m3u8';
      resultPayload.trims = spec.trims;
      resultPayload.totalDuration = spec.trims.reduce((total, trim) => total + (trim.end - trim.start), 0);
    } else if (spec.zooms && spec.zooms.length > 0) {
      // 只缩放功能的回调数据
      resultPayload.outputHls = uploadResult.hlsPrefix + '/playlist.m3u8';
      resultPayload.zooms = spec.zooms;
    } else {
      // 无处理功能的回调数据
      resultPayload.outputHls = uploadResult.hlsPrefix + '/playlist.m3u8';
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
    "recordingId", "manifestFileUrl", "callbackUrl", "outputS3Prefix", "cloudFrontVideoCookie"
  ];
  
  for (const key of required) {
    if (!body?.[key]) {
      console.error(`❌ 缺少必需字段: ${key}`);
      throw badRequest(`Missing required field "${key}"`);
    }
  }
  
  console.log("✅ 所有必需字段检查通过");
  
  // 🔧 解析时间线配置开关（默认使用原始时间线）
  const useOriginalTimeline = body.useOriginalTimeline !== undefined ? body.useOriginalTimeline : true;
  console.log(`🔧 时间线配置: useOriginalTimeline = ${useOriginalTimeline}`);
  console.log(`📋 处理顺序: ${useOriginalTimeline ? '先缩放后裁剪（原始时间线）' : '先裁剪后缩放（新时间线）'}`);
  
  // 🔍 参数校验逻辑（支持先裁剪再缩放）
  if (body.trims && Array.isArray(body.trims) && body.trims.length > 0) {
    // 校验 trims 参数
    validateTrimParameters(body.trims);
    console.log("✅ Trim 参数校验通过");
  }
  
  if (body.zooms && Array.isArray(body.zooms) && body.zooms.length > 0) {
    // 校验 zooms 参数
    validateZoomParameters(body.zooms);
    console.log("✅ Zoom 参数校验通过");
  }
  
  // 🎨 背景相关参数校验（可选）
  if (body.backgroundImage) {
    validateBackgroundImageParameters(body.backgroundImage);
    console.log("✅ 背景图片参数校验通过");
  }
  
  if (body.backgroundAudio) {
    validateBackgroundAudioParameters(body.backgroundAudio);
    console.log("✅ 背景音频参数校验通过");
  }
  
  if (body.aiNarrationAudio) {
    validateAiNarrationAudioParameters(body.aiNarrationAudio);
    console.log("✅ AI旁白音频参数校验通过");
  }
  
  // 将配置开关添加到返回的对象中
  return {
    ...body,
    useOriginalTimeline
  };
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

// 🎨 背景图片参数校验函数
function validateBackgroundImageParameters(backgroundImage) {
  if (!backgroundImage.url || typeof backgroundImage.url !== 'string') {
    throw badRequest('Background image must have a valid URL');
  }
  
  if (backgroundImage.padding !== undefined) {
    if (typeof backgroundImage.padding !== 'number' || backgroundImage.padding <= 0 || backgroundImage.padding >= 0.5) {
      throw badRequest('Background image padding must be a positive number');
    }
  }
}

// 🎵 背景音频参数校验函数
function validateBackgroundAudioParameters(backgroundAudio) {
  if (!backgroundAudio.url || typeof backgroundAudio.url !== 'string') {
    throw badRequest('Background audio must have a valid URL');
  }
  
  if (backgroundAudio.volume !== undefined) {
    if (typeof backgroundAudio.volume !== 'number' || backgroundAudio.volume < 0 || backgroundAudio.volume > 1) {
      throw badRequest('Background audio volume must be between 0 and 1');
    }
  }
}

// 🗣️ AI旁白音频参数校验函数
function validateAiNarrationAudioParameters(aiNarrationAudio) {
  if (!aiNarrationAudio.url || typeof aiNarrationAudio.url !== 'string') {
    throw badRequest('AI narration audio must have a valid URL');
  }
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

// 🔍 拷贝最终结果到输出目录
async function copyFinalResultToOutputDir(sourceDir, destDir) {
  console.log(`📋 将最终结果从 ${sourceDir} 复制到 ${destDir}...`);
  
  // 确保目标目录存在
  await mkdir(destDir, { recursive: true });
  
  // 读取源目录中的所有文件
  const sourceFiles = await readdir(sourceDir);
  
  // 复制所有文件
  for (const file of sourceFiles) {
    const sourcePath = join(sourceDir, file);
    const destPath = join(destDir, file);
    
    // 检查源路径和目标路径是否不同
    if (sourcePath !== destPath) {
      await cp(sourcePath, destPath);
      console.log(`✅ 复制文件: ${file}`);
    } else {
      console.log(`⚠️ 跳过自复制: ${file}`);
    }
  }
  
  console.log(`🎯 最终结果复制完成，共复制 ${sourceFiles.length} 个文件`);
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

// 🔍 高效 Trim 处理函数 - 只对边界分片转码，中间分片直接复用
async function processTrimFast({ inputDir, outputDir, playlistPath, recordingId, trims, lowQuality, spec }) {
  console.log("⚡ 开始高效多段Trim处理...");
  console.log("📊 参数:", { trims, lowQuality });

  const tempDir = `/tmp/trim_fast_${recordingId}`;
  await mkdir(tempDir, { recursive: true });

  try {
    // 0. 先解析M3U8播放列表，确定需要哪些分片
    const segmentInfo = await parseM3U8Segments(playlistPath);

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
    const finalSegmentList = await processAllTrimIntervals({
      trims,
      segmentInfo,
      inputDir,
      outputDir,
      lowQuality
    });

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

    // 🔧 两阶段封装：解决播放不连续问题
    try {
      // 第一步：生成concat列表文件
      console.log('📝 第一步：生成concat列表文件...');
      const concatListPath = await generateConcatList(outputPlaylistPath, outputDir);
      
      // 第二步：合并成连续的MP4文件
      console.log('🎬 第二步：合并分片为连续MP4...');
      const mergedMp4Path = join(outputDir, 'merged_continuous.mp4');
      
      await mergeMP4WithTimestampOptimization(concatListPath, mergedMp4Path);
      
      // 第三步：将连续MP4重新切分成标准TS分片
      console.log('✂️ 第三步：重新切分为标准HLS分片...');
      const finalPlaylistPath = join(outputDir, 'final_playlist.m3u8');
      
      await convertMP4ToHLS(mergedMp4Path, finalPlaylistPath, outputDir);

      // 🧹 清理无用的原始TS文件（保留final_playlist.m3u8中的标准HLS分片）
      console.log('🧹 清理无用的原始TS文件...');
      await cleanupUnusedTSFilesFromFinalPlaylist(finalPlaylistPath, outputDir);
      console.log('✅ 原始TS文件清理完成');
      
      // 第四步：重命名最终播放列表
      console.log('🔄 第四步：重命名最终播放列表...');
      await rm(outputPlaylistPath, { force: true }); // 删除旧的playlist.m3u8
      await cp(finalPlaylistPath, outputPlaylistPath); // 复制final_playlist.m3u8为playlist.m3u8
      await rm(finalPlaylistPath, { force: true }); // 删除final_playlist.m3u8
      
      // 清理临时文件
      await rm(mergedMp4Path, { force: true });
      await rm(concatListPath, { force: true });
      
      console.log('🎉 两阶段封装完成！播放连续性已优化');
      
    } catch (error) {
      console.warn('⚠️ 两阶段封装失败，回退到原始流程:', error.message);
    }

    // 上传 Trim 后的 HLS 文件夹
    // const hlsOutputPrefix = `${spec.outputS3Prefix}/${spec.recordingId}_trimmed`;
    // console.log('📤 开始上传HLS到S3...', hlsOutputPrefix);
    // await uploadFolderToS3(outputDir, hlsOutputPrefix);
    // console.log('✅ HLS上传完成:', hlsOutputPrefix);

    // // 4. 自动导出MP4
    // const outputMp4 = join(outputDir, `${recordingId}.mp4`);
    // console.log('🎬 开始导出MP4...');
    // const concatListPath = await generateConcatList(outputPlaylistPath, outputDir);
    
    // await runFfmpeg(concatListPath, outputMp4);
    // console.log('✅ MP4导出完成:', outputMp4);
    
    // // 上传MP4到S3
    // console.log('📤 开始上传MP4到S3...');
    // await uploadMp4ToS3(outputMp4, spec);
    // console.log('✅ MP4上传完成:', `${spec.outputS3Prefix}/${spec.recordingId}.mp4`);
  } finally {
    try { 
      await rm(tempDir, { recursive: true, force: true }); 
    } catch {}
  }
}

// 🔧 封装函数：处理所有trim区间
async function processAllTrimIntervals({
  trims,
  segmentInfo,
  inputDir,
  outputDir,
  lowQuality
}) {
  console.log(`🚀 开始处理 ${trims.length} 个trim区间...`);
  
  const finalSegmentList = []; // 存储所有最终的分片信息 {filename, duration, path}
  const segmentCounter = { value: 0 }; // 全局分片计数器（使用对象以保持引用）
  
  for (let trimIndex = 0; trimIndex < trims.length; trimIndex++) {
    await processSingleTrimInterval({
      trimIndex,
      trim: trims[trimIndex],
      segmentInfo,
      inputDir,
      outputDir,
      segmentCounter,
      finalSegmentList,
      lowQuality
    });
  }
  
  console.log(`✅ 所有trim区间处理完成，共生成 ${finalSegmentList.length} 个分片`);
  return finalSegmentList;
}

// 🔧 封装函数：处理单个trim区间
async function processSingleTrimInterval({
  trimIndex,
  trim,
  segmentInfo,
  inputDir,
  outputDir,
  segmentCounter,
  finalSegmentList,
  lowQuality
}) {
  const { start, end } = trim;
  
  // 🚀 开始执行时的日志
  console.log(`🚀 正在执行精确裁剪 processTrimFast，目标区间: [${start}s, ${end}s]`);
  
  // 找到与trim区间重叠的分片
  const overlappingSegs = segmentInfo.filter(seg => seg.endTime > start && seg.startTime < end);
  if (overlappingSegs.length === 0) {
    console.warn(`⚠️ Trim区间 ${trimIndex} (${start}s-${end}s) 没有找到重叠的分片`);
    return segmentCounter.value;
  }

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
      const outputFileName = `seg${String(segmentCounter.value++).padStart(5, '0')}_trim.ts`;
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
      const outputFileName = `seg${String(segmentCounter.value++).padStart(5, '0')}_trim.ts`;
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
      const outputFileName = `seg${String(segmentCounter.value++).padStart(5, '0')}_trim.ts`;
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
      const outputFileName = `seg${String(segmentCounter.value++).padStart(5, '0')}.ts`;
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
  return segmentCounter.value;
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
    const segmentInfo = await parseM3U8Segments(playlistPath);

    zooms.sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));

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
      // const zoomFormula = `if(lt(it,${zoomInTime}), 1+it/${zoomInTime}, if(lt(it,${zoomOutStart}), ${maxZoom}, if(lt(it,${zoomDuration}), ${maxZoom}-(it-${zoomOutStart})/${zoomOutTime}, 1)))`;
      const zoomFormula = `if(lt(it,${zoomInTime}),
        1 + (${maxZoom}-1)*it/${zoomInTime},
        if(lt(it,${zoomOutStart}),
          ${maxZoom},
          if(lt(it,${zoomDuration}),
            ${maxZoom} - (${maxZoom}-1)*(it-${zoomOutStart})/${zoomOutTime},
            1
          )
        )
      )`;

      let preW = preScaleWidth;
      let preH = Math.round(preW * origHeight / origWidth);
      if (preW % 2) preW--;
      if (preH % 2) preH--;

      const filterComplex = [
        `[0:v]fps=${fps},scale=${preW}:-1,split=3[pre][zoom][post];`,

        `[zoom]trim=start=${relZoomStart}:end=${relZoomEnd},setpts=PTS-STARTPTS,` +
        `zoompan=` +
          `z='${zoomFormula}':` +
          // ★ 锚点缩放：让锚点在输出像素位置保持不变（无 pad、无 clamp、无黑边）
          `x='(1 - 1/(${zoomFormula})) * (${x}) * iw':` +
          `y='(1 - 1/(${zoomFormula})) * (${y}) * ih':` +
          `d=1:fps=${fps}:s=${preW}x${preH}[zoomed];`,

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
    const playlistContent = await readFile(playlistPath, 'utf8');
    const lines = playlistContent.split('\n');
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

// 辅助函数：从playlist.m3u8生成concat_list.txt
async function generateConcatList(playlistPath, outputDir) {
  const playlistContent = await readFile(playlistPath, 'utf8');
  const lines = playlistContent.split('\n');
  const tsFiles = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXTINF')) {
      const nextLine = lines[i + 1]?.trim();
      if (nextLine && nextLine.endsWith('.ts')) {
        tsFiles.push(nextLine);
      }
    }
  }
  
  // 生成concat文件内容
  const concatContent = tsFiles.map(filename => `file '${filename}'`).join('\n');
  const concatListPath = join(outputDir, 'concat_list.txt');
  
  await writeFile(concatListPath, concatContent);
  
  console.log(`📝 生成concat列表文件: ${concatListPath}`);
  console.log(`📋 包含 ${tsFiles.length} 个分片文件:`);
  tsFiles.forEach((file, index) => {
    console.log(`   ${index + 1}. ${file}`);
  });
  
  return concatListPath;
}

// 辅助函数：导出MP4 - 使用concat模式
async function runFfmpeg(concatListPath, outputMp4) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatListPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions([
        "-c copy",
        "-movflags +faststart",
        "-threads 1",
        "-max_alloc 268435456",
        "-hide_banner",
        "-loglevel error",
      ])
      .on("start", (cmd) => console.log("[ffmpeg concat mp4]", cmd))
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

// 🔧 封装函数：解析M3U8播放列表，提取分片信息
async function parseM3U8Segments(playlistPath) {
  console.log("📋 解析M3U8播放列表，提取分片信息...");
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
  
  console.log(`✅ 解析完成，共找到 ${segmentInfo.length} 个分片`);
  return segmentInfo;
}

// 🔧 封装函数：合并MP4并做时间戳优化
async function mergeMP4WithTimestampOptimization(concatListPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatListPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions([
        '-c', 'copy',
        '-fflags', '+genpts',
        '-avoid_negative_ts', 'make_zero'
      ])
      .output(outputPath)
      .on('start', (cmd) => console.log('[ffmpeg merge]', cmd))
      .on('end', () => {
        console.log('✅ MP4合并完成，时间戳已连续化');
        resolve();
      })
      .on('error', reject)
      .run();
  });
}

// 🔧 封装函数：MP4切分HLS
async function convertMP4ToHLS(inputMP4Path, outputPlaylistPath, outputDir) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(inputMP4Path)
      .outputOptions([
        '-c', 'copy',
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', join(outputDir, 'segment_%03d.ts'),
        '-hls_playlist_type', 'vod'
      ])
      .output(outputPlaylistPath)
      .on('start', (cmd) => console.log('[ffmpeg hls]', cmd))
      .on('end', () => {
        console.log('✅ HLS重新切分完成，播放连续性已优化');
        resolve();
      })
      .on('error', reject)
      .run();
  });
}

// 🧹 清理无用的原始TS文件（基于final_playlist.m3u8）
async function cleanupUnusedTSFilesFromFinalPlaylist(finalPlaylistPath, outputDir) {
  console.log('🔍 分析final_playlist.m3u8文件:', finalPlaylistPath);
  
  // 读取final_playlist.m3u8文件内容
  const playlistContent = await readFile(finalPlaylistPath, 'utf8');
  console.log('📋 final_playlist.m3u8内容:', playlistContent.substring(0, 200) + '...');
  
  // 提取需要保留的TS文件名
  const keepFiles = [];
  const lines = playlistContent.split('\n');
  for (const line of lines) {
    const trimmedLine = line.trim();
    // 查找以.ts结尾的文件名行
    if (trimmedLine && !trimmedLine.startsWith('#') && trimmedLine.endsWith('.ts')) {
      keepFiles.push(trimmedLine);
    }
  }
  
  console.log(`📝 需要保留的标准HLS分片: [${keepFiles.join(', ')}]`);
  
  // 扫描输出目录中的所有文件
  const outputFiles = await readdir(outputDir);
  const tsFiles = outputFiles.filter(file => file.endsWith('.ts'));
  
  console.log(`📁 输出目录中的TS文件: [${tsFiles.join(', ')}]`);
  
  // 删除不在保留列表中的TS文件
  let deletedCount = 0;
  for (const file of tsFiles) {
    if (!keepFiles.includes(file)) {
      const fullPath = join(outputDir, file);
      console.log(`🗑️ 删除无用的原始TS文件: ${file}`);
      await rm(fullPath, { force: true });
      deletedCount++;
    } else {
      console.log(`✅ 保留标准HLS分片: ${file}`);
    }
  }
  
  console.log(`🎯 清理完成: 删除了 ${deletedCount} 个无用文件，保留了 ${keepFiles.length} 个标准HLS分片`);
}

// 📤 统一上传函数：使用现有函数组合上传所有文件到S3
async function uploadAllToS3(outputDir, spec) {
  console.log(`📤 开始统一上传到S3，使用_Edited后缀`);
  
  // 使用_Edited后缀的S3前缀路径
  const s3Prefix = `${spec.outputS3Prefix}/${spec.recordingId}_Edited`;
  
  console.log(`🎯 S3上传前缀: ${s3Prefix}`);
  
  try {
    // 🧹 清理无用文件：仅保留playlist.m3u8中引用的TS分片
    console.log('🧹 开始清理无用文件...');
    const playlistPath = join(outputDir, 'playlist.m3u8');
    await cleanupUnusedTSFilesFromFinalPlaylist(playlistPath, outputDir);
    
    // 📋 输出最终上传清单
    const files = await readdir(outputDir);
    const hlsFiles = files.filter(file => file.endsWith('.ts') || file.endsWith('.m3u8'));
    const tsCount = hlsFiles.filter(file => file.endsWith('.ts')).length;
    console.log(`📋 最终上传清单: playlist.m3u8 + ${tsCount} 个 TS 分片 + MP4`);
    
    // 1. 上传所有HLS文件（TS分片和playlist.m3u8）
    console.log('📤 开始上传HLS文件到S3...');
    await uploadFolderToS3(outputDir, s3Prefix);
    console.log(`🎉 HLS文件上传完成: ${s3Prefix}`);
    
    // 2. 生成并上传MP4文件
    console.log('🎬 开始生成MP4文件...');
    const outputMp4 = join(outputDir, `${spec.recordingId}.mp4`);
    
    // 生成concat列表文件
    console.log('📝 生成concat列表文件...');
    const concatListPath = await generateConcatList(playlistPath, outputDir);
    
    // 执行MP4导出
    console.log('🔄 执行MP4导出...');
    await runFfmpeg(concatListPath, outputMp4);
    console.log('✅ MP4文件生成完成');
    
    // 上传MP4文件
    console.log('📤 开始上传MP4文件到S3...');
    await uploadMp4ToS3(outputMp4, spec);
    console.log(`✅ MP4文件上传成功: ${spec.outputS3Prefix}/${spec.recordingId}.mp4`);
    
    // 3. 清理临时文件
    console.log('🧹 清理临时文件...');
    try {
      await rm(concatListPath, { force: true });
      console.log('✅ 清理concat列表文件完成');
    } catch (e) {
      console.warn('⚠️ 清理concat列表文件失败:', e.message);
    }
    
    console.log(`🎉 统一上传完成！`);
    console.log(`📊 上传摘要:`);
    console.log(`   - HLS前缀: s3://${S3_BUCKET}/${s3Prefix}/`);
    console.log(`   - MP4路径: s3://${S3_BUCKET}/${spec.outputS3Prefix}/${spec.recordingId}.mp4`);
    
    return {
      hlsPrefix: s3Prefix,
      mp4Key: `${spec.outputS3Prefix}/${spec.recordingId}.mp4`
    };
    
  } catch (error) {
    console.error('❌ 统一上传失败:', error);
    throw error;
  }
}

const ok = (body) => ({ statusCode: 200, body: JSON.stringify(body) });
const error = (c, m) => ({ statusCode: c, body: m });

// 🔍 检测重叠和计算分割点函数
function detectOverlappingAndCalculateSplitPoints(zooms, segmentInfo) {
  console.log("🔍 开始检测缩放区间重叠和计算分割点...");
  console.log("📊 缩放区间:", zooms);
  console.log("📊 分片信息:", segmentInfo);
  
  const splitPoints = [];
  
  // 遍历所有分片，检测是否有多个缩放区间命中同一分片
  for (let segIndex = 0; segIndex < segmentInfo.length; segIndex++) {
    const segment = segmentInfo[segIndex];
    const segmentStart = segment.startTime;
    const segmentEnd = segment.endTime;
    
    // 🔧 添加数据类型检查日志
    console.log(`🔍 分片 ${segIndex} 数据类型检查:`);
    console.log(`   - segment.startTime: ${segmentStart} (类型: ${typeof segmentStart})`);
    console.log(`   - segment.endTime: ${segmentEnd} (类型: ${typeof segmentEnd})`);
    console.log(`   - segment:`, segment);
    
    // 找到命中当前分片的所有缩放区间
    const overlappingZooms = zooms.filter(zoom => {
      const hasOverlap = zoom.end > segmentStart && zoom.start < segmentEnd;
      console.log(`   - zoom [${zoom.start}-${zoom.end}]: ${hasOverlap ? '命中' : '未命中'}`);
      return hasOverlap;
    });
    
    console.log(`🔍 分片 ${segIndex} [${segmentStart}s-${segmentEnd}s]: 命中 ${overlappingZooms.length} 个缩放区间`);
    
    // 如果只有一个缩放区间命中，不需要分割
    if (overlappingZooms.length <= 1) {
      continue;
    }
    
    // 如果有多个缩放区间命中同一分片，需要计算分割点
    console.log(`⚠️ 检测到分片 ${segIndex} 被多个缩放区间命中，需要分割`);
    
    // 收集所有缩放区间的边界点
    const boundaryPoints = [];
    overlappingZooms.forEach((zoom, zoomIndex) => {
      console.log(`   🔍 分析缩放区间 ${zoomIndex}: [${zoom.start}s-${zoom.end}s]`);
      
      // 只考虑在分片范围内的边界点
      if (zoom.start > segmentStart && zoom.start < segmentEnd) {
        console.log(`     ✅ 添加zoom.start: ${zoom.start}s (在分片范围内)`);
        boundaryPoints.push(zoom.start);
      } else {
        console.log(`     ❌ 跳过zoom.start: ${zoom.start}s (不在分片范围内)`);
      }
      
      if (zoom.end > segmentStart && zoom.end < segmentEnd) {
        console.log(`     ✅ 添加zoom.end: ${zoom.end}s (在分片范围内)`);
        boundaryPoints.push(zoom.end);
      } else {
        console.log(`     ❌ 跳过zoom.end: ${zoom.end}s (不在分片范围内)`);
      }
    });
    
    // 去重并排序
    const uniqueBoundaryPoints = [...new Set(boundaryPoints)].sort((a, b) => a - b);
    console.log(`📍 分片 ${segIndex} 的边界点: [${uniqueBoundaryPoints.join(', ')}]`);
    console.log(`📍 边界点数据类型检查:`, uniqueBoundaryPoints.map(p => ({ value: p, type: typeof p })));
    
    // 计算分割点（选择相邻边界点的中间点）
    for (let i = 0; i < uniqueBoundaryPoints.length - 1; i++) {
      const currentPoint = uniqueBoundaryPoints[i];
      const nextPoint = uniqueBoundaryPoints[i + 1];
      
      // 🔧 添加分割点计算日志
      console.log(`   🔧 计算分割点 ${i + 1}:`);
      console.log(`     - currentPoint: ${currentPoint} (类型: ${typeof currentPoint})`);
      console.log(`     - nextPoint: ${nextPoint} (类型: ${typeof nextPoint})`);
      console.log(`     - 计算: (${currentPoint} + ${nextPoint}) / 2`);
      
      const splitPoint = (currentPoint + nextPoint) / 2;
      
      console.log(`     - 结果: ${splitPoint} (类型: ${typeof splitPoint})`);
      console.log(`     - 是否为NaN: ${isNaN(splitPoint)}`);
      
      // 确保分割点在分片范围内
      if (splitPoint > segmentStart && splitPoint < segmentEnd) {
        const splitPointInfo = {
          segmentIndex: segIndex,
          time: splitPoint,
          reason: `分割分片 ${segIndex}，在 ${currentPoint}s 和 ${nextPoint}s 之间选择中间点 ${splitPoint.toFixed(2)}s`
        };
        
        console.log(`     ✅ 添加分割点:`, splitPointInfo);
        splitPoints.push(splitPointInfo);
      } else {
        console.log(`     ❌ 分割点 ${splitPoint}s 不在分片范围内 [${segmentStart}s-${segmentEnd}s]`);
      }
    }
  }
  
  // 🔧 添加最终结果检查日志
  console.log("🎯 分割点计算完成");
  console.log("📊 最终分割点列表:", splitPoints);
  console.log("📊 分割点数据类型检查:", splitPoints.map(p => ({ 
    segmentIndex: p.segmentIndex, 
    time: p.time, 
    timeType: typeof p.time,
    isNaN: isNaN(p.time)
  })));
  
  return splitPoints;
}

// ✂️ 分割函数：将分割点转换为裁剪片段并执行分割
async function splitSegmentsForZoom({ inputDir, outputDir, playlistPath, recordingId, splitPoints, lowQuality, spec }) {
  console.log("✂️ 开始执行分片分割...");
  console.log("📊 输入分割点:", splitPoints);
  
  if (!splitPoints || splitPoints.length === 0) {
    console.log("✅ 无需分割，直接返回原始路径");
    return { inputDir, playlistPath };
  }
  
  // 🔧 调用新的分片分割函数，不调用trim函数
  console.log("🔄 调用新的分片分割函数...");
  
  const result = await splitOverlappingSegments({
    inputDir: inputDir,
    outputDir: outputDir,
    playlistPath: playlistPath,
    recordingId: recordingId,
    splitPoints: splitPoints,
    lowQuality: lowQuality,
    spec: spec,
  });
  
  console.log("✅ 分片分割完成");
  
  return result;
}

// ✂️ 新的分片分割函数：直接分割重叠分片，不调用trim函数
async function splitOverlappingSegments({
  inputDir, 
  outputDir, 
  playlistPath, 
  recordingId, 
  splitPoints, 
  lowQuality,
  spec
}) {
  console.log("✂️ 开始执行分片分割...");
  console.log("📊 输入分割点:", splitPoints);
  
  if (!splitPoints || splitPoints.length === 0) {
    console.log("✅ 无需分割，直接返回原始路径");
    return { inputDir, playlistPath };
  }
  
  // 1. 解析播放列表获取分片信息
  const segmentInfo = await parseM3U8Segments(playlistPath);
  
  // 2. 复制不需要分割的分片
  console.log(" 复制不需要分割的分片...");
  for (const segment of segmentInfo) {
    const inputFile = join(inputDir, segment.filename);
    const outputFile = join(outputDir, segment.filename);
    
    // 检查这个分片是否需要分割
    const needsSplit = splitPoints.some(point => 
      point.segmentIndex === segment.index
    );
    
    if (!needsSplit) {
      // 不需要分割，直接复制
      await cp(inputFile, outputFile);
      console.log(`✅ 复制分片: ${segment.filename}`);
    }
  }
  
  // 3. 分割需要处理的分片
  console.log("✂️ 开始分割重叠的分片...");
  const newSegments = [];
  let newSegmentIndex = 0;
  
  for (const segment of segmentInfo) {
    const needsSplit = splitPoints.some(point => 
      point.segmentIndex === segment.index
    );
    
    if (!needsSplit) {
      // 不需要分割的分片，保持原样
      newSegments.push({
        ...segment,
        newIndex: newSegmentIndex++,
        newFilename: segment.filename
      });
      continue;
    }
    
    // 需要分割的分片
    console.log(`⚠️ 分割分片 ${segment.index}: ${segment.filename}`);
    
    // 获取当前分片的分割点，按时间排序
    const segmentSplitPoints = splitPoints
      .filter(point => point.segmentIndex === segment.index)
      .map(point => point.time)  // 🔧 关键修复：只提取 time 值，不要整个对象
      .sort((a, b) => a - b);
    
    // 添加分片开始时间作为第一个分割点
    const allSplitPoints = [segment.startTime, ...segmentSplitPoints, segment.endTime];
    
    // 🔧 添加详细的调试日志
    console.log(`🔍 分片 ${segment.index} 的分割点构建:`);
    console.log(`   - segment.startTime: ${segment.startTime} (类型: ${typeof segment.startTime})`);
    console.log(`   - segment.endTime: ${segment.endTime} (类型: ${typeof segment.endTime})`);
    console.log(`   - segmentSplitPoints:`, segmentSplitPoints);
    console.log(`   - segmentSplitPoints 类型: ${typeof segmentSplitPoints}`);
    console.log(`   - segmentSplitPoints 长度: ${segmentSplitPoints.length}`);
    console.log(`   - segmentSplitPoints 每个元素类型:`, segmentSplitPoints.map((item, idx) => ({ 
      index: idx, 
      value: item, 
      type: typeof item,
      isObject: typeof item === 'object' && item !== null
    })));
    console.log(`   - 展开后的 segmentSplitPoints:`, ...segmentSplitPoints);
    console.log(`   - allSplitPoints 最终结果:`, allSplitPoints);
    console.log(`   - allSplitPoints 每个元素详情:`, allSplitPoints.map((item, idx) => ({ 
      index: idx, 
      value: item, 
      type: typeof item,
      isNaN: typeof item === 'number' ? isNaN(item) : 'N/A'
    })));
    
    // 分割成多个子分片
    for (let i = 0; i < allSplitPoints.length - 1; i++) {
      const startTime = allSplitPoints[i];
      const endTime = allSplitPoints[i + 1];
      const duration = endTime - startTime;
      
      // 🔧 添加详细的调试日志
      console.log(`   🔧 子分片 ${i + 1} 计算:`);
      console.log(`     - startTime: ${startTime} (类型: ${typeof startTime})`);
      console.log(`     - endTime: ${endTime} (类型: ${typeof endTime})`);
      console.log(`     - duration = ${endTime} - ${startTime} = ${duration}`);
      console.log(`     - duration类型: ${typeof duration}`);
      console.log(`     - duration是否为NaN: ${isNaN(duration)}`);
      console.log(`     - duration是否有效: ${duration > 0}`);
      
      // 跳过0时长的分片
      if (duration <= 0) {
        console.log(`     ❌ 跳过无效时长分片: duration = ${duration}`);
        continue;
      }
      
      // 计算相对于分片开始的时间
      const relativeStartTime = startTime - segment.startTime;
      console.log(`     - 相对开始时间: ${startTime} - ${segment.startTime} = ${relativeStartTime}`);
      console.log(`     - 相对开始时间类型: ${typeof relativeStartTime}`);
      console.log(`     - 相对开始时间是否为NaN: ${isNaN(relativeStartTime)}`);
      
      // 生成新的文件名
      const newFilename = `${segment.filename.replace('.ts', '')}_part${i + 1}.ts`;
      const outputFile = join(outputDir, newFilename);
      
      console.log(`     - 输出文件: ${outputFile}`);
      console.log(`     - 准备调用splitSingleSegment...`);
      
      // 执行分割（重新编码，确保关键帧对齐）
      await splitSingleSegment(
        join(inputDir, segment.filename),  // 输入文件
        outputFile,                         // 输出文件
        relativeStartTime,                  // 相对开始时间
        duration,                           // 持续时间
        lowQuality                          // 质量参数
      );
      
      // 添加到新分片列表
      newSegments.push({
        index: segment.index,
        startTime: startTime,
        endTime: endTime,
        duration: duration,
        filename: newFilename,
        newIndex: newSegmentIndex++,
        newFilename: newFilename
      });
      
      console.log(`✅ 生成子分片: ${newFilename} (${startTime}s - ${endTime}s)`);
    }
  }
  
  // 4. 构建新的播放列表
  console.log("📝 构建新的播放列表...");
  const newPlaylistLines = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...newSegments.map(s => s.duration)))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-INDEPENDENT-SEGMENTS'
  ];
  
  // 按时间顺序添加分片
  newSegments.sort((a, b) => a.startTime - b.startTime);
  
  for (const segment of newSegments) {
    newPlaylistLines.push(`#EXTINF:${segment.duration.toFixed(6)},`);
    newPlaylistLines.push(segment.filename);
  }
  
  newPlaylistLines.push('#EXT-X-ENDLIST');
  
  // 5. 写入新的播放列表
  const newPlaylistPath = join(outputDir, 'playlist.m3u8');
  await writeFile(newPlaylistPath, newPlaylistLines.join('\n'), 'utf8');
  
  console.log("✅ 分片分割完成");
  console.log(` 分割结果: 原始 ${segmentInfo.length} 个分片 -> 新 ${newSegments.length} 个分片`);
  
  return {
    inputDir: outputDir,
    playlistPath: newPlaylistPath,
    segmentMapping: {
      original: segmentInfo,
      split: newSegments
    }
  };
}

// 🎬 分割单个分片文件的辅助函数
async function splitSingleSegment(inputFile, outputFile, startTime, duration, lowQuality) {
  return new Promise((resolve, reject) => {
    console.log(`✂️ 分割分片: ${inputFile} -> ${outputFile}`);
    console.log(`⏰ 分割参数: start=${startTime}s, duration=${duration}s`);
    
    ffmpeg()
      .input(inputFile)
      .outputOptions([
        '-ss', startTime.toString(),                    // 开始时间
        '-t', duration.toString(),                      // 持续时间
        '-c:v', 'libx264',                             // 视频编码器
        '-preset', 'ultrafast',                         // 编码预设（快速）
        '-crf', lowQuality ? '23' : '18',              // 质量参数
        '-c:a', 'aac',                                 // 音频编码器
        '-movflags', '+faststart',                      // 快速启动
        '-avoid_negative_ts', 'make_zero',              // 避免负时间戳
        '-y'                                            // 覆盖输出文件
      ])
      .output(outputFile)
      .on('start', (cmd) => console.log(`[ffmpeg split] ${cmd}`))
      .on('end', () => {
        console.log(`✅ 分片分割完成: ${outputFile}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`❌ 分片分割失败: ${err.message}`);
        reject(err);
      })
      .run();
  });
}

// 🎨 背景处理函数：添加背景图片、背景音频和AI旁白
async function processBackground({ inputDir, outputDir, playlistPath, recordingId, backgroundConfig, lowQuality, spec }) {
  console.log("🎨 开始背景处理...");
  console.log("📊 背景配置:", backgroundConfig);
  
  try {
    // 1. 下载背景资源
    const downloadedAssets = await downloadBackgroundAssets(backgroundConfig, outputDir);
    console.log("✅ 背景资源下载完成");
    
    // 2. 构建FFmpeg滤镜图
    const ffmpegPlan = await buildBackgroundGraph(playlistPath, downloadedAssets, backgroundConfig, lowQuality);
    console.log("✅ FFmpeg滤镜图构建完成");
    
    // 3. 执行FFmpeg处理
    await runBackgroundFfmpeg(ffmpegPlan, outputDir, recordingId);
    console.log("✅ 背景处理完成");
    
  } catch (error) {
    console.error("❌ 背景处理失败:", error);
    throw error;
  }
}

// 📥 下载背景资源
async function downloadBackgroundAssets(backgroundConfig, outputDir) {
  const assets = {};
  
  if (backgroundConfig.backgroundImage?.url) {
    console.log("📥 下载背景图片...");
    const bgImagePath = join(outputDir, 'background.mp4');
    await downloadBackgroundFile(backgroundConfig.backgroundImage.url, bgImagePath);
    assets.bgImage = bgImagePath;
    
    // 检查文件大小
    try {
      const stats = await stat(bgImagePath);
      console.log(`📊 背景图片文件大小: ${stats.size} bytes`);
    } catch (e) {
      console.warn(`⚠️ 无法获取背景图片文件大小: ${e.message}`);
    }
  }
  
  if (backgroundConfig.backgroundAudio?.url) {
    console.log("📥 下载背景音乐...");
    const bgAudioPath = join(outputDir, 'background.mp3');
    await downloadBackgroundFile(backgroundConfig.backgroundAudio.url, bgAudioPath);
    assets.bgAudio = bgAudioPath;
    
    // 检查文件大小
    try {
      const stats = await stat(bgAudioPath);
      console.log(`📊 背景音乐文件大小: ${stats.size} bytes`);
    } catch (e) {
      console.warn(`⚠️ 无法获取背景音乐文件大小: ${e.message}`);
    }
  }
  
  if (backgroundConfig.aiNarrationAudio?.url) {
    console.log("📥 下载AI旁白...");
    const aiAudioPath = join(outputDir, 'ai_narration.mp3');
    await downloadBackgroundFile(backgroundConfig.aiNarrationAudio.url, aiAudioPath);
    assets.aiAudio = aiAudioPath;
    
    // 检查文件大小
    try {
      const stats = await stat(aiAudioPath);
      console.log(`📊 AI旁白文件大小: ${stats.size} bytes`);
    } catch (e) {
      console.warn(`⚠️ 无法获取AI旁白文件大小: ${e.message}`);
    }
  }
  
  return assets;
}

// 📥 下载单个背景文件
async function downloadBackgroundFile(url, destPath) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`下载失败: ${response.status} ${response.statusText}`);
    }
    
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(destPath, buffer);
    console.log(`✅ 下载完成: ${destPath}`);
  } catch (error) {
    console.error(`❌ 下载失败 ${url}:`, error.message);
    throw error;
  }
}

// 🎬 构建背景处理的FFmpeg滤镜图
async function buildBackgroundGraph(playlistPath, assets, backgroundConfig, lowQuality) {
  const inputs = [playlistPath]; // 输入0：HLS播放列表（主视频）
  const filters = [];
  const maps = [];
  const perInputOptionsByIndex = {}; // 记录输入级选项（比如 -stream_loop -1）

  // ★ 开关：是否“以主视频为主”（true=主视频固定尺寸；false=背景固定尺寸<现有逻辑>）
  const FIX_MAIN_VIDEO = true; // TODO: 暂时写死；后续可从payload/配置传入

  // ---- 读取并规整 padding ----
  let padding = backgroundConfig?.backgroundImage?.padding;
  if (!(typeof padding === 'number') || padding <= 0 || padding >= 0.5) padding = 0.05; // 0~0.5

  let videoStream = "0:v";
  const audioStreams = [];

  // ---- 主视频尺寸 ----
  const mainInfo = await getVideoInfo(playlistPath);
  const fw = mainInfo?.width  || 1920;
  const fh = mainInfo?.height || 1080;

  // 1) 处理背景图片/视频
  if (assets.bgImage) {
    const bgIndex = inputs.length;
    inputs.push(assets.bgImage);

    // 背景信息（判断是否视频 + 尺寸）
    let isVideo = false;
    let bgW = 1920, bgH = 1080;
    try {
      const info = await getBackgroundFileInfo(assets.bgImage);
      isVideo = !!info?.isVideo;
      if (info?.width > 0 && info?.height > 0) { bgW = info.width; bgH = info.height; }
    } catch (e) {
      console.warn('⚠️ 背景类型/尺寸检测失败，使用 1920x1080：', e?.message || e);
    }

    const even = (n) => Math.max(2, Math.round(n / 2) * 2); // 就近取偶，避免留白误差

    if (FIX_MAIN_VIDEO) {
      // ======================
      // 模式B：以主视频为主（主视频不缩放；背景去适配 + 预留 padding）
      const mainAR = fw / fh;
      const bgAR   = bgW / bgH;
    
      // 就近取偶，避免编码器报奇数尺寸
      const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    
      let canvasW, canvasH, posX, posY;
    
      if (mainAR >= bgAR) {
        // 主视频更“扁” → 以横向为基准：左右各留 padding
        canvasW = even(fw / (1 - 2 * padding));
        canvasH = even(canvasW / bgAR);
    
        console.log("📐 模式B：横向为基准");
      } else {
        // 主视频更“竖” → 以纵向为基准：上下各留 padding
        canvasH = even(fh / (1 - 2 * padding));
        canvasW = even(canvasH * bgAR);
    
        console.log("📐 模式B：纵向为基准");
      }
    
      // 主视频不缩放，直接居中贴到画布上
      posX = Math.round((canvasW - fw) / 2);
      posY = Math.round((canvasH - fh) / 2);
    
      // ---- 打印详细尺寸信息 ----
      console.log("📊 尺寸信息:", {
        mainVideo: { fw, fh, AR: mainAR.toFixed(4) },
        background: { bgW, bgH, AR: bgAR.toFixed(4) },
        canvas: { canvasW, canvasH },
        overlayPos: { posX, posY },
        padding
      });
    
      // 背景缩放到“画布尺寸”
      const bgPrep = isVideo
        ? `[${bgIndex}:v]setpts=PTS-STARTPTS,setsar=1,scale=${canvasW}:${canvasH}[bg]`
        : `[${bgIndex}:v]loop=loop=-1:size=1:start=0,setsar=1,scale=${canvasW}:${canvasH}[bg]`;
    
      // 主视频不缩放，只做时间与 SAR 归一
      const fgPrep = `[${videoStream}]setpts=PTS-STARTPTS,setsar=1[inner]`;
    
      filters.push(
        bgPrep + ';' +
        fgPrep + ';' +
        `[bg][inner]overlay=${posX}:${posY}:shortest=1[vout]`
      );
      videoStream = 'vout';
    
      // 背景为视频则无限循环
      if (isVideo) perInputOptionsByIndex[bgIndex] = ['-stream_loop', '-1'];
    } else {
      // ======================
      // 模式A：以背景为主（你现有逻辑：背景尺寸固定；主视频缩放贴边 + padding）
      const mainAR = fw / fh;
      const bgAR   = bgW / bgH;
      let outW, outH, posX, posY;

      if (mainAR >= bgAR) {
        // 主更宽 → 按宽贴边
        const boxW = bgW * (1 - 2 * padding);
        const scale = boxW / fw;
        outW = even(boxW);
        outH = even(fh * scale);
        posX = Math.round(bgW * padding);
        posY = Math.round((bgH - outH) / 2);
      } else {
        // 主更高 → 按高贴边
        const boxH = bgH * (1 - 2 * padding);
        const scale = boxH / fh;
        outH = even(boxH);
        outW = even(fw * scale);
        posX = Math.round((bgW - outW) / 2);
        posY = Math.round(bgH * padding);
      }

      const bgPrep = isVideo
        ? `[${bgIndex}:v]setpts=PTS-STARTPTS,setsar=1[bg]`
        : `[${bgIndex}:v]loop=loop=-1:size=1:start=0,setsar=1[bg]`;

      const fgPrep = `[${videoStream}]setpts=PTS-STARTPTS,setsar=1,scale=${outW}:${outH}[inner]`;

      filters.push(
        bgPrep + ';' +
        fgPrep + ';' +
        `[bg][inner]overlay=${posX}:${posY}:shortest=1[vout]`
      );
      videoStream = 'vout';

      if (isVideo) perInputOptionsByIndex[bgIndex] = ['-stream_loop', '-1'];
    }
  }

  // 2) 音频（原样保留）
  const wantOriginal = !assets.aiAudio;
  if (wantOriginal) audioStreams.push("0:a");

  if (assets.bgAudio) {
    inputs.push(assets.bgAudio);
    const bgAudioIndex = inputs.length - 1;
    const volume = backgroundConfig.backgroundAudio?.volume ?? 0.5;
    filters.push(`[${bgAudioIndex}:a]volume=${volume}[bgm]`);
    audioStreams.push("bgm");
  }

  if (assets.aiAudio) {
    inputs.push(assets.aiAudio);
    const aiAudioIndex = inputs.length - 1;
    audioStreams.push(`${aiAudioIndex}:a`);
  }

  // 3) 混音（原样）
  let finalAudio = "";
  if (audioStreams.length === 1) {
    finalAudio = audioStreams[0];
  } else if (audioStreams.length > 1) {
    const amixInputs = audioStreams.map(s => `[${s}]`).join("");
    filters.push(`${amixInputs}amix=inputs=${audioStreams.length}:duration=first:dropout_transition=2[aout]`);
    finalAudio = "aout";
  }

  // 4) 映射（原样）
  maps.push(`-map ${videoStream.includes(":") ? videoStream : `[${videoStream}]`}`);
  if (finalAudio) maps.push(`-map ${finalAudio.includes(":") ? finalAudio : `[${finalAudio}]`}`);

  return { inputs, filters: filters.join(";"), maps, perInputOptionsByIndex };
}

// 🎬 执行背景处理的FFmpeg命令
async function runBackgroundFfmpeg(plan, outputDir, recordingId) {
  await mkdir(outputDir, { recursive: true });

  return new Promise((resolve, reject) => {
    let cmd = ffmpeg();

    // ★ 添加输入文件（逐个），若该索引有输入级选项，则立刻贴在它后面
    plan.inputs.forEach((input, idx) => {
      cmd = cmd.input(input);
      const opts = plan.perInputOptionsByIndex?.[idx];
      if (opts && opts.length) {
        cmd = cmd.inputOptions(opts);   // ← 这行会把选项贴到“刚刚添加”的这个输入上
      }
    });

    // 添加复杂滤镜
    if (plan.filters) {
      cmd = cmd.complexFilter(plan.filters);
    }

    // 视频编码器
    const videoCodec = plan.filters.includes("[vout]")
      ? ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23"]
      : ["-c:v", "copy"];

    cmd
      .outputOptions([
        ...plan.maps,
        ...videoCodec,
        "-c:a", "aac",
        "-shortest",                 // ★ 保险：防止音频把时长拖长
        "-f", "hls",
        "-hls_time", "4",
        `-hls_segment_filename`, `${outputDir}/${recordingId}-%04d.ts`,
        "-hls_playlist_type", "event",
        "-hide_banner",
        "-loglevel", "error",
      ])
      .on("start", (command) => console.log(`[ffmpeg background] ${command}`))
      .on("end", () => {
        console.log("✅ 背景处理FFmpeg执行完成");
        resolve();
      })
      .on("error", (err) => {
        console.error("❌ 背景处理FFmpeg执行失败:", err.message);
        reject(err);
      })
      .save(`${outputDir}/playlist.m3u8`);
  });
}

// 🔍 检测背景文件类型（图片还是视频）
function getBackgroundFileInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, info) => {
      if (err) {
        reject(new Error(`FFprobe failed: ${err.message}`));
        return;
      }
      
      try {
        const videoStream = info.streams?.find(s => s.codec_type === 'video');
        const audioStream = info.streams?.find(s => s.codec_type === 'audio');
        const duration = parseFloat(info.format?.duration || 0);
        
        resolve({
          hasVideo: !!videoStream,
          hasAudio: !!audioStream,
          isVideo: !!videoStream && duration > 0.1,  // 有持续时间才是视频
          isImage: !!videoStream && duration <= 0.1, // 没有持续时间是图片
          duration: duration,
          width: videoStream?.width || 0,
          height: videoStream?.height || 0,
          codecName: videoStream?.codec_name || ''
        });
      } catch (e) {
        reject(new Error(`Failed to parse background file info: ${e.message}`));
      }
    });
  });
}