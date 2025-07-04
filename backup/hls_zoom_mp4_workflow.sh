#!/bin/bash

set -e

# 帮助信息
show_help() {
  echo "🎬 HLS Zoom MP4工作流脚本"
  echo ""
  echo "用法: $0 <INPUT_DIR> <ZOOM_START> <ZOOM_END> [OUTPUT_DIR]"
  echo ""
  echo "必需参数:"
  echo "  INPUT_DIR     HLS文件夹路径 (包含.m3u8和.ts文件)"
  echo "  ZOOM_START    Zoom开始时间 (秒，例如: 10.5)"
  echo "  ZOOM_END      Zoom结束时间 (秒，例如: 20.8)"
  echo ""
  echo "可选参数:"
  echo "  OUTPUT_DIR    输出目录 (默认: INPUT_DIR_zoomed_mp4)"
  echo ""
  echo "示例:"
  echo "  $0 /path/to/hls_folder 10.0 20.0"
  echo "  $0 /path/to/hls_folder 5.5 15.8 /custom/output"
}

# 参数解析
if [ $# -lt 3 ]; then
  echo "❌ 错误: 需要至少3个参数"
  show_help
  exit 1
fi

# 必需参数
INPUT_DIR="$1"
ZOOM_START="$2"
ZOOM_END="$3"
OUTPUT_DIR="${4:-${INPUT_DIR}_zoomed_mp4}"

# 参数验证
if [ ! -d "$INPUT_DIR" ]; then
  echo "❌ 错误: 输入目录不存在: $INPUT_DIR"
  exit 1
fi

# 设置工作目录
TEMP_DIR="temp_mp4_zoom_$(basename "$INPUT_DIR")"
M3U8_FILE="playlist.m3u8"

# 视频参数设置
PRE_SCALE_WIDTH=8000
OUTPUT_WIDTH=3456
OUTPUT_HEIGHT=2234

echo "🎬 HLS Zoom MP4工作流开始执行"
echo "📁 输入目录: $INPUT_DIR"
echo "📁 输出目录: $OUTPUT_DIR"
echo "⏰ Zoom时间段: ${ZOOM_START}s → ${ZOOM_END}s"
echo "⏰ 开始时间: $(date '+%Y-%m-%d %H:%M:%S')"

mkdir -p "$OUTPUT_DIR"
mkdir -p "$TEMP_DIR"

# 第1步：全分片合并为完整MP4
echo ""
echo "🔄 第1步：合并所有TS分片为完整MP4..."

# 创建完整的concat列表
FULL_CONCAT_LIST="$TEMP_DIR/full_concat_list.txt"
> "$FULL_CONCAT_LIST"

# 从M3U8提取所有TS文件
while read ts_file; do
  if [[ $ts_file =~ \.ts$ ]]; then
    # 使用相对路径：从临时目录看输入目录的位置
    echo "file '../$INPUT_DIR/$ts_file'" >> "$FULL_CONCAT_LIST"
  fi
done < "$INPUT_DIR/$M3U8_FILE"

# 合并所有分片为完整MP4
ffmpeg -f concat -safe 0 -i "$FULL_CONCAT_LIST" \
  -c:v libx264 -preset fast -crf 18 \
  -c:a aac -b:a 128k \
  -avoid_negative_ts make_zero \
  "$TEMP_DIR/complete.mp4" -y

echo "✅ 第1步完成：生成 complete.mp4"

# 第2步：帧精确分割
echo ""
echo "🔄 第2步：按帧精确分割MP4为三个时间段..."

# 检测视频参数
VIDEO_INFO=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=r_frame_rate,nb_frames,duration -of csv=p=0 "$TEMP_DIR/complete.mp4")
FRAME_RATE=$(echo "$VIDEO_INFO" | cut -d',' -f1 | sed 's/\// /' | awk '{printf "%.6f", $1/$2}')
TOTAL_FRAMES=$(echo "$VIDEO_INFO" | cut -d',' -f2)
VIDEO_DURATION=$(echo "$VIDEO_INFO" | cut -d',' -f3)

if [ -z "$FRAME_RATE" ] || [ "$FRAME_RATE" = "0.000000" ]; then
  FRAME_RATE="29.25"
fi

echo "📊 视频参数: ${FRAME_RATE}fps, ${TOTAL_FRAMES}帧, ${VIDEO_DURATION}秒"

# 计算帧精确的分割点（四舍五入到最近的帧）
ZOOM_START_FRAME=$(echo "($ZOOM_START * $FRAME_RATE + 0.5) / 1" | bc -l | cut -d'.' -f1)
ZOOM_END_FRAME=$(echo "($ZOOM_END * $FRAME_RATE + 0.5) / 1" | bc -l | cut -d'.' -f1)
ZOOM_DURATION_FRAMES=$((ZOOM_END_FRAME - ZOOM_START_FRAME))

# 重新计算精确的时间点（基于帧对齐）
PRECISE_ZOOM_START=$(echo "scale=6; $ZOOM_START_FRAME / $FRAME_RATE" | bc -l)
PRECISE_ZOOM_DURATION=$(echo "scale=6; $ZOOM_DURATION_FRAMES / $FRAME_RATE" | bc -l)
PRECISE_ZOOM_END=$(echo "scale=6; $ZOOM_END_FRAME / $FRAME_RATE" | bc -l)

echo "🎯 帧对齐时间点: 开始=${PRECISE_ZOOM_START}s (第${ZOOM_START_FRAME}帧), 结束=${PRECISE_ZOOM_END}s (第${ZOOM_END_FRAME}帧)"

# Pre-zoom段（如果需要）
if [ "$ZOOM_START_FRAME" -gt 0 ]; then
  echo "分割 Pre-zoom: 0 → ${PRECISE_ZOOM_START}s (${ZOOM_START_FRAME}帧)"
  ffmpeg -i "$TEMP_DIR/complete.mp4" -ss 0 -t "$PRECISE_ZOOM_START" -c copy "$TEMP_DIR/pre_zoom.mp4" -y
fi

# Zoom目标段
echo "分割 Zoom-target: ${PRECISE_ZOOM_START}s → ${PRECISE_ZOOM_END}s (${ZOOM_DURATION_FRAMES}帧)"
ffmpeg -i "$TEMP_DIR/complete.mp4" -ss "$PRECISE_ZOOM_START" -t "$PRECISE_ZOOM_DURATION" -c copy "$TEMP_DIR/zoom_target.mp4" -y

# Post-zoom段
if (( $(echo "$PRECISE_ZOOM_END < $VIDEO_DURATION" | bc -l) )); then
  echo "分割 Post-zoom: ${PRECISE_ZOOM_END}s → 结束"
  ffmpeg -i "$TEMP_DIR/complete.mp4" -ss "$PRECISE_ZOOM_END" -c copy "$TEMP_DIR/post_zoom.mp4" -y
fi

echo "✅ 第2步完成：视频分割完成"

# 第3步：Zoom动画处理
echo ""
echo "🔄 第3步：Zoom动画处理..."

# 应用zoompan滤镜
ffmpeg -i "$TEMP_DIR/zoom_target.mp4" -filter_complex "
[0:v]fps=$FRAME_RATE,scale=${PRE_SCALE_WIDTH}:-1,
zoompan=
  z='if(lt(it,2*$FRAME_RATE), 1+it/(2*$FRAME_RATE),
     if(lt(it,($PRECISE_ZOOM_DURATION-2)*$FRAME_RATE), 2,
     2 - (it-($PRECISE_ZOOM_DURATION-2)*$FRAME_RATE)/(2*$FRAME_RATE)))':
  x='iw/2-(iw/zoom/2)':
  y='ih/2-(ih/zoom/2)':
  d=1:fps=$FRAME_RATE:s=${PRE_SCALE_WIDTH}x$(($PRE_SCALE_WIDTH * $OUTPUT_HEIGHT / $OUTPUT_WIDTH)),
scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}[zoomv]
" -map "[zoomv]" -map 0:a \
  -c:v libx264 -preset fast -crf 18 \
  -c:a copy \
  "$TEMP_DIR/zoom_processed.mp4" -y

echo "✅ 第3步完成：Zoom处理完成"

# 第4步：三段合并
echo ""
echo "🔄 第4步：合并视频段..."

# 创建合并列表
MERGE_LIST="$TEMP_DIR/merge_list.txt"
> "$MERGE_LIST"

if [ -f "$TEMP_DIR/pre_zoom.mp4" ]; then
  echo "file 'pre_zoom.mp4'" >> "$MERGE_LIST"
fi
echo "file 'zoom_processed.mp4'" >> "$MERGE_LIST"
if [ -f "$TEMP_DIR/post_zoom.mp4" ]; then
  echo "file 'post_zoom.mp4'" >> "$MERGE_LIST"
fi

# 合并
ffmpeg -f concat -safe 0 -i "$MERGE_LIST" -c copy "$TEMP_DIR/final_zoomed.mp4" -y

echo "✅ 第4步完成：合并完成"

# 第5步：重新分片为HLS
echo ""
# echo "🔄 第5步：生成HLS (4秒分片)..."

# ffmpeg -i "$TEMP_DIR/final_zoomed.mp4" \
#   -c:v libx264 -c:a aac -b:a 128k \
#   -f hls \
#   -hls_time 4 \
#   -hls_list_size 0 \
#   -hls_segment_filename "$OUTPUT_DIR/segment_%04d.ts" \
#   "$OUTPUT_DIR/playlist.m3u8" -y

echo "✅ 第5步完成：HLS生成完成"

echo ""
echo "🎉 全部完成！"
echo "📁 输出目录: $OUTPUT_DIR"
echo "🎬 播放命令: ffplay \"$OUTPUT_DIR/playlist.m3u8\"" 