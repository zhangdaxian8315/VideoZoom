#!/bin/bash
set -e

echo "🎬 HLS Zoom 脚本开始执行"
echo "⏰ Zoom时间段: $1s → $2s"
echo "🎯 Zoom中心点: ($3, $4)"

# 基本设置
INPUT_DIR="."
OUTPUT_DIR="."
TEMP_DIR="temp_zoom"
M3U8_FILE="local.m3u8"

# 显示当前工作目录和文件列表
echo "📁 当前工作目录: $(pwd)"
echo "📁 当前目录文件:"
ls -la

# 创建临时目录
mkdir -p "$TEMP_DIR"

# 显示 ts 文件列表
echo "📁 ts 文件列表:"
ls -la *.ts 2>/dev/null || echo "没有找到 ts 文件"

# 清理函数
cleanup() {
  echo "🧹 执行清理操作..."
  if [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
}

trap cleanup EXIT INT TERM

# 检测视频分辨率
echo "🔍 检测视频分辨率..."

# 强制设置默认值，避免未定义错误
ORIGINAL_WIDTH=1920
ORIGINAL_HEIGHT=1080

echo "📊 初始分辨率设置: ${ORIGINAL_WIDTH}x${ORIGINAL_HEIGHT}"

FIRST_TS_FILE=$(grep "\.ts$" "$INPUT_DIR/$M3U8_FILE" | head -1)
echo "📁 第一个 ts 文件: $FIRST_TS_FILE"

if [ -n "$FIRST_TS_FILE" ] && [ -f "$INPUT_DIR/$FIRST_TS_FILE" ]; then
  echo "🔍 尝试使用 ffprobe 检测分辨率..."
  
  # 检查 ffprobe 是否可用
  if command -v ffprobe >/dev/null 2>&1; then
    echo "✅ ffprobe 命令可用"
    DETECTED_WIDTH=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=width -of csv=p=0 "$INPUT_DIR/$FIRST_TS_FILE" 2>/dev/null | head -1)
    DETECTED_HEIGHT=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=height -of csv=p=0 "$INPUT_DIR/$FIRST_TS_FILE" 2>/dev/null | head -1)
    echo "🔍 ffprobe 检测结果: WIDTH=$DETECTED_WIDTH, HEIGHT=$DETECTED_HEIGHT"
    
    if [ -n "$DETECTED_WIDTH" ] && [ -n "$DETECTED_HEIGHT" ] && [ "$DETECTED_WIDTH" != "N/A" ] && [ "$DETECTED_HEIGHT" != "N/A" ]; then
      ORIGINAL_WIDTH="$DETECTED_WIDTH"
      ORIGINAL_HEIGHT="$DETECTED_HEIGHT"
      echo "✅ 使用检测到的分辨率: ${ORIGINAL_WIDTH}x${ORIGINAL_HEIGHT}"
    else
      echo "⚠️ ffprobe 检测结果无效，使用默认值"
    fi
  else
    echo "⚠️ ffprobe 命令不可用，使用默认值"
  fi
else
  echo "⚠️ 未找到 ts 文件，使用默认值"
fi

echo "📊 最终分辨率: ${ORIGINAL_WIDTH}x${ORIGINAL_HEIGHT}"

# 合并所有 ts 文件
echo "🔗 合并所有 ts 文件..."
CONCAT_LIST="$TEMP_DIR/concat_list.txt"
> "$CONCAT_LIST"

for ts_file in $(grep "\.ts$" "$INPUT_DIR/$M3U8_FILE"); do
  echo "file '$ts_file'" >> "$CONCAT_LIST"
done

ffmpeg -f concat -safe 0 -i "$CONCAT_LIST" -c copy "$TEMP_DIR/merged.ts" -y

# 检测时长和帧率
DURATION=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$TEMP_DIR/merged.ts")
FPS=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$TEMP_DIR/merged.ts" | sed 's/\// /' | awk '{printf "%.2f", $1/$2}')

echo "📊 视频信息: 时长=${DURATION}s, 帧率=${FPS}fps"

# 计算 Zoom 中心点像素坐标（使用简单的数学运算）
ZOOM_X=$(awk "BEGIN {printf \"%.0f\", $3 * $ORIGINAL_WIDTH}")
ZOOM_Y=$(awk "BEGIN {printf \"%.0f\", $4 * $ORIGINAL_HEIGHT}")

# 应用 zoompan 效果
echo "🎞️ 应用 Zoom 效果..."
ZOOM_DURATION=$(awk "BEGIN {printf \"%.2f\", $2 - $1}")
ZOOM_IN_TIME="1.0"
ZOOM_OUT_TIME="1.0"
ZOOM_OUT_START=$(awk "BEGIN {printf \"%.2f\", $ZOOM_DURATION - $ZOOM_OUT_TIME}")

ffmpeg -i "$TEMP_DIR/merged.ts" -filter_complex "
[0:v]trim=start=$1:end=$2,setpts=PTS-STARTPTS,
zoompan=
  z='if(lt(it,${ZOOM_IN_TIME}), 1+it/${ZOOM_IN_TIME},
     if(lt(it,${ZOOM_OUT_START}), 2,
     if(lt(it,${ZOOM_DURATION}), 2-(it-${ZOOM_OUT_START})/${ZOOM_OUT_TIME}, 1)))':
  x='${ZOOM_X}-(iw/zoom/2)':
  y='${ZOOM_Y}-(ih/zoom/2)':
  d=1:fps=${FPS}:s=${ORIGINAL_WIDTH}x${ORIGINAL_HEIGHT}
[zoomed]
" -map "[zoomed]" -map 0:a -c:v libx264 -r ${FPS} -c:a copy -y "$TEMP_DIR/zoomed.ts"

# 替换原始文件
echo "📋 替换原始文件..."
cp "$TEMP_DIR/zoomed.ts" "$OUTPUT_DIR/zoomed.ts"

# 更新 m3u8 文件
echo "📝 更新 m3u8 文件..."
cat > "$OUTPUT_DIR/local.m3u8" << EOF
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:${ZOOM_DURATION},
zoomed.ts
#EXT-X-ENDLIST
EOF

echo "✅ Zoom 处理完成" 