#!/bin/bash

set -e

# 参数解析
if [ $# -lt 3 ]; then
  echo "❌ 用法: $0 <INPUT_DIR> <ZOOM_START> <ZOOM_END>"
  echo "  INPUT_DIR   - HLS文件夹路径"
  echo "  ZOOM_START  - Zoom开始时间(秒)"
  echo "  ZOOM_END    - Zoom结束时间(秒)"
  exit 1
fi

# 必需参数
INPUT_DIR="$1"
ZOOM_START="$2"
ZOOM_END="$3"

# 基本验证
if [ ! -d "$INPUT_DIR" ]; then
  echo "❌ 错误: 输入目录不存在: $INPUT_DIR"
  exit 1
fi

# 其他设置
OUTPUT_DIR="${INPUT_DIR}_zoomed"
TEMP_DIR="temp_hls_zoom_$(basename "$INPUT_DIR")"
M3U8_FILE="playlist.m3u8"

SEGMENT_START=0
SEGMENT_END=2
PRE_SCALE_WIDTH=8000
OUTPUT_WIDTH=3456
OUTPUT_HEIGHT=2234



echo "🎬 HLS Zoom 脚本开始执行 - 动态版本"
echo "📁 输入目录: $INPUT_DIR"
echo "📁 输出目录: $OUTPUT_DIR"
echo "⏰ Zoom时间段: ${ZOOM_START}s → ${ZOOM_END}s"
echo "⏰ 开始时间: $(date '+%Y-%m-%d %H:%M:%S')"

mkdir -p "$OUTPUT_DIR"
mkdir -p "$TEMP_DIR"

# 拷贝所有原始文件到输出目录
echo "📋 拷贝原始 m3u8 和 ts 文件..."
cp -r "$INPUT_DIR"/* "$OUTPUT_DIR/"

# 合并要处理的 ts 分片
echo "🔗 合并分片 $SEGMENT_START 到 $SEGMENT_END..."
CONCAT_LIST="$INPUT_DIR/concat_list.txt"
> "$CONCAT_LIST"

for i in $(seq $SEGMENT_START $SEGMENT_END); do
  SEG=$(printf "%s-video-%04d.ts" "01JYZZ0BN3RX7CZYM13FCSQJKA" $i)
  echo "file '$SEG'" >> "$CONCAT_LIST"
done

ffmpeg -f concat -safe 0 -i "$CONCAT_LIST" -c copy "$TEMP_DIR/merged_input.ts" -y

# 转码为mp4，重置时间戳从0开始
echo "🔄 转码为mp4，重置时间戳..."
ffmpeg -i "$TEMP_DIR/merged_input.ts" -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 128k -avoid_negative_ts make_zero "$TEMP_DIR/merged_input.mp4" -y
ffmpeg -fflags +genpts -i "$TEMP_DIR/merged_input.ts" \
  -c copy -avoid_negative_ts make_zero \
  -muxdelay 0 -muxpreload 0 \
  "$TEMP_DIR/merged_input_fixed.ts" -y


# 从merged_input.mp4读取FPS
echo "🔍 检测merged_input.mp4的帧率..."
DETECTED_FPS=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$TEMP_DIR/merged_input.mp4" | sed 's/\// /' | awk '{printf "%.2f", $1/$2}')
if [ -z "$DETECTED_FPS" ] || [ "$DETECTED_FPS" = "0.00" ]; then
  DETECTED_FPS="29.25"
  echo "⚠️ 无法检测到帧率，使用默认值: $DETECTED_FPS"
else
  echo "📊 检测到帧率: $DETECTED_FPS"
fi

FPS="$DETECTED_FPS"
echo "📊 使用检测到的帧率: $FPS"
# ffmpeg -f concat -safe 0 -i "$CONCAT_LIST" -c:v libx264 -preset fast -crf 18 -r 29.25 -c:a aac -b:a 128k "$TEMP_DIR/merged_input.ts" -y

# 检测首帧视频时间戳
echo "🔍 检测首帧视频时间戳..."
FIRST_FRAME_PTS=$(ffprobe -v quiet -select_streams v:0 -show_entries packet=pts_time -of csv=p=0 "$TEMP_DIR/merged_input.ts" | head -1 | sed 's/,//')
if [ -z "$FIRST_FRAME_PTS" ]; then
  FIRST_FRAME_PTS="0"
  echo "⚠️ 无法检测到首帧时间戳，使用默认值: $FIRST_FRAME_PTS"
else
  echo "📊 首帧时间戳: $FIRST_FRAME_PTS"
fi

# 检测原始时长
echo "🔍 检测原始时长..."
ORIGINAL_DURATION=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$TEMP_DIR/merged_input.ts")
if [ -z "$ORIGINAL_DURATION" ]; then
  ORIGINAL_DURATION="12.12"
  echo "⚠️ 无法检测到时长，使用默认值: $ORIGINAL_DURATION"
else
  echo "📊 原始时长: $ORIGINAL_DURATION"
fi

# 应用 zoompan 放大动画处理（带前期 scale 放大 + 动态时间戳调整）
echo "🎞️ 开始 Zoom 动画处理..."
FPS_FILTER="fps=$FPS"
ffmpeg -hide_banner -i "$TEMP_DIR/merged_input_fixed.ts" -filter_complex "
[0:v]${FPS_FILTER},scale=${PRE_SCALE_WIDTH}:-1,split=3[pre][zoom][post];

[zoom]trim=start=3:end=11,setpts=PTS-STARTPTS,
zoompan=
  z='if(lt(it,2), 1+it/2,
     if(lt(it,6), 2,
     if(lt(it,8), 2 - (it-6)/2, 1)))':
  x='iw/2-(iw/zoom/2)':
  y='ih/2-(ih/zoom/2)':
  d=1:fps=$FPS:s=${PRE_SCALE_WIDTH}x$(($PRE_SCALE_WIDTH * 2234 / 3456))
[zoomed];

[pre]trim=end=3,setpts=PTS-STARTPTS[first];
[post]trim=start=11,setpts=PTS-STARTPTS[last];

[first]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}[first_scaled];
[zoomed]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}[zoomed_scaled];
[last]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}[last_scaled];

[first_scaled][zoomed_scaled][last_scaled]concat=n=3:v=1:a=0[outv]
" -map "[outv]" -map 0:a -c:v libx264 -r $FPS -c:a copy -y "$TEMP_DIR/zoomed-0000-fixed1.ts"

# 删除原始的前3个分片
echo "🗑️ 删除原始的前3个分片..."
for i in $(seq $SEGMENT_START $SEGMENT_END); do
  DST=$(printf "$OUTPUT_DIR/01JYZZ0BN3RX7CZYM13FCSQJKA-video-%04d.ts" $i)
  rm -f "$DST"
done

# 拷贝合并后的文件（而不是zoom处理后的文件）到输出目录
echo "📋 拷贝合并后的文件到输出目录..."
cp "$TEMP_DIR/merged_input.ts" "$OUTPUT_DIR/merged-0000.ts"
cp "$TEMP_DIR/merged_input_fixed.ts" "$OUTPUT_DIR/merged-0000-fixed.ts"
cp "$TEMP_DIR/zoomed-0000-fixed1.ts" "$OUTPUT_DIR/zoomed-0000-fixed1.ts"

# 不需要重命名，保持原始文件名对应关系
echo "📋 保持原始文件名对应关系..."



# 替换原文件
# mv "$TEMP_M3U8" "$M3U8_PATH"

echo "🧹 清理临时文件夹..."
# rm -rf "$TEMP_DIR"

echo "✅ Zoom 动画处理完成！"
echo "📁 最终输出目录: $OUTPUT_DIR"
echo "📁 输出文件: temp_hls_zoom_4k/zoomed-0000.mp4"
echo "🎞️ 使用帧率: $FPS fps"
echo "🎬 播放命令：ffplay \"temp_hls_zoom_4k/zoomed-0000.mp4\"" 