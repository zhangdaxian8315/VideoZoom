#!/bin/bash

set -e

# 参数解析
if [ $# -lt 3 ]; then
  echo "❌ 用法: $0 <INPUT_DIR> <ZOOM_START> <ZOOM_END> [ZOOM_CENTER_X] [ZOOM_CENTER_Y] [INCREMENTAL]"
  echo "  INPUT_DIR      - HLS文件夹路径"
  echo "  ZOOM_START     - Zoom开始时间(秒)"
  echo "  ZOOM_END       - Zoom结束时间(秒)"
  echo "  ZOOM_CENTER_X  - Zoom中心点X坐标 (0.0-1.0, 默认0.5)"
  echo "  ZOOM_CENTER_Y  - Zoom中心点Y坐标 (0.0-1.0, 默认0.5)"
  echo "  INCREMENTAL    - 增量模式 (1=是, 0=否, 默认0)"
  exit 1
fi

# 必需参数
INPUT_DIR="$1"
ZOOM_START="$2"
ZOOM_END="$3"

# 可选参数 - Zoom中心点坐标和增量模式
ZOOM_CENTER_X="${4:-0.5}"
ZOOM_CENTER_Y="${5:-0.5}"
INCREMENTAL="${6:-0}"

# 基本验证
if [ ! -d "$INPUT_DIR" ]; then
  echo "❌ 错误: 输入目录不存在: $INPUT_DIR"
  exit 1
fi

# 验证Zoom中心点坐标
if (( $(echo "$ZOOM_CENTER_X < 0 || $ZOOM_CENTER_X > 1" | bc -l) )); then
  echo "❌ 错误: ZOOM_CENTER_X 必须在 0.0-1.0 范围内，当前值: $ZOOM_CENTER_X"
  exit 1
fi

if (( $(echo "$ZOOM_CENTER_Y < 0 || $ZOOM_CENTER_Y > 1" | bc -l) )); then
  echo "❌ 错误: ZOOM_CENTER_Y 必须在 0.0-1.0 范围内，当前值: $ZOOM_CENTER_Y"
  exit 1
fi

# 其他设置
OUTPUT_DIR="${INPUT_DIR}_zoomed"
TEMP_DIR="temp_hls_zoom_$(basename "$INPUT_DIR")"
M3U8_FILE="playlist.m3u8"

# 动态获取原视频分辨率
echo "🔍 检测原视频分辨率..."
ORIGINAL_WIDTH=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=width -of csv=p=0 "$INPUT_DIR/$(grep "\.ts$" "$INPUT_DIR/$M3U8_FILE" | head -1)" | head -1)
ORIGINAL_HEIGHT=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=height -of csv=p=0 "$INPUT_DIR/$(grep "\.ts$" "$INPUT_DIR/$M3U8_FILE" | head -1)" | head -1)

if [ -z "$ORIGINAL_WIDTH" ] || [ -z "$ORIGINAL_HEIGHT" ]; then
  echo "⚠️ 无法检测原视频分辨率，使用默认值"
  ORIGINAL_WIDTH=3456
  ORIGINAL_HEIGHT=2234
fi

echo "📊 检测到原视频分辨率: ${ORIGINAL_WIDTH}x${ORIGINAL_HEIGHT}"

# 检查并清理已存在的输出目录（仅在非增量模式下）
if [ "$INCREMENTAL" = "0" ] && [ -d "$OUTPUT_DIR" ]; then
  echo "🗑️ 检测到已存在的输出目录，正在删除: $OUTPUT_DIR"
  rm -rf "$OUTPUT_DIR"
elif [ "$INCREMENTAL" = "1" ] && [ -d "$OUTPUT_DIR" ]; then
  echo "📁 增量模式：使用现有输出目录: $OUTPUT_DIR"
fi

PRE_SCALE_WIDTH=8000
OUTPUT_WIDTH=$ORIGINAL_WIDTH
OUTPUT_HEIGHT=$ORIGINAL_HEIGHT

# 设置错误处理和清理功能
cleanup() {
  echo "🧹 执行清理操作..."
  if [ -n "${TEMP_DIR:-}" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
    echo "📁 已删除临时目录: $TEMP_DIR"
  fi
  # 清理可能存在的临时文件
  rm -f "temp_hls_zoom_"*/segment_info.txt 2>/dev/null || true
  rm -f "temp_hls_zoom_"*/target_segments.txt 2>/dev/null || true
}

# 设置信号处理，在脚本异常退出时自动清理
trap cleanup EXIT INT TERM

# M3U8解析和分片计算
echo "📋 解析M3U8播放列表..."
M3U8_PATH="$INPUT_DIR/$M3U8_FILE"

# 提取分片信息：时长和文件名
SEGMENT_INFO="$TEMP_DIR/segment_info.txt"
mkdir -p "$TEMP_DIR"
> "$SEGMENT_INFO"

# 解析M3U8文件，提取EXTINF和分片文件名
grep -E "^#EXTINF:|^[^#].*\.ts$" "$M3U8_PATH" | while read line; do
  if [[ $line =~ ^#EXTINF:([0-9]+\.?[0-9]*), ]]; then
    echo "DURATION:${BASH_REMATCH[1]}"
  elif [[ $line =~ \.ts$ ]]; then
    echo "FILE:$line"
  fi
done > "$SEGMENT_INFO"

# 计算每个分片的时间范围并找到目标分片
echo "🔍 计算分片时间范围，查找目标分片..."
CURRENT_TIME=0
SEGMENT_INDEX=0
TARGET_SEGMENTS_FILE="$TEMP_DIR/target_segments.txt"
> "$TARGET_SEGMENTS_FILE"

while read line; do
  if [[ $line =~ ^DURATION:(.*) ]]; then
    DURATION="${BASH_REMATCH[1]}"
    read -r next_line
    if [[ $next_line =~ ^FILE:(.*) ]]; then
      FILENAME="${BASH_REMATCH[1]}"
      
      # 计算分片时间范围
      START_TIME="$CURRENT_TIME"
      END_TIME=$(echo "$CURRENT_TIME + $DURATION" | bc -l)
      
      # 检查这个分片是否与ZOOM时间段重叠
      # 重叠条件：分片结束时间 > ZOOM_START 且 分片开始时间 < ZOOM_END
      if (( $(echo "$END_TIME > $ZOOM_START" | bc -l) )) && (( $(echo "$START_TIME < $ZOOM_END" | bc -l) )); then
        echo "$SEGMENT_INDEX" >> "$TARGET_SEGMENTS_FILE"
        echo "📌 选中分片 $SEGMENT_INDEX: $FILENAME (${START_TIME}s-${END_TIME}s) 与Zoom时间段 ${ZOOM_START}s-${ZOOM_END}s 重叠"
      fi
      
      CURRENT_TIME="$END_TIME"
      ((SEGMENT_INDEX++))
    fi
  fi
done < "$SEGMENT_INFO"

# 读取目标分片并设置范围
if [ ! -s "$TARGET_SEGMENTS_FILE" ]; then
  echo "❌ 错误: 没有找到与Zoom时间段重叠的分片"
  exit 1
fi

SEGMENT_START=$(head -1 "$TARGET_SEGMENTS_FILE")
SEGMENT_END=$(tail -1 "$TARGET_SEGMENTS_FILE")

echo "🎯 目标分片范围: $SEGMENT_START 到 $SEGMENT_END (共 $((SEGMENT_END - SEGMENT_START + 1)) 个分片)"

echo "🎬 HLS Zoom 脚本开始执行 - 动态版本"
echo "📁 输入目录: $INPUT_DIR"
echo "📁 输出目录: $OUTPUT_DIR"
echo "⏰ Zoom时间段: ${ZOOM_START}s → ${ZOOM_END}s"
echo "🎯 Zoom中心点: (${ZOOM_CENTER_X}, ${ZOOM_CENTER_Y})"
echo "⏰ 开始时间: $(date '+%Y-%m-%d %H:%M:%S')"

mkdir -p "$OUTPUT_DIR"
mkdir -p "$TEMP_DIR"

# 拷贝所有原始文件到输出目录（仅在非增量模式下）
if [ "$INCREMENTAL" = "0" ]; then
  echo "📋 拷贝原始 m3u8 和 ts 文件..."
  cp -r "$INPUT_DIR"/* "$OUTPUT_DIR/"
else
  echo "📁 增量模式：跳过文件拷贝，使用现有文件"
fi

# 提取分片文件名前缀（从第一个ts文件名中提取）
FIRST_TS_FILE=$(grep "\.ts$" "$M3U8_PATH" | head -1)
if [[ $FIRST_TS_FILE =~ ^(.+)-video-[0-9]+\.ts$ ]]; then
  FILE_PREFIX="${BASH_REMATCH[1]}"
else
  echo "❌ 错误: 无法解析分片文件名格式"
  exit 1
fi

echo "📂 检测到文件前缀: $FILE_PREFIX"

# 合并要处理的 ts 分片
echo "🔗 合并分片 $SEGMENT_START 到 $SEGMENT_END..."
CONCAT_LIST="$TEMP_DIR/concat_list.txt"
> "$CONCAT_LIST"

for i in $(seq $SEGMENT_START $SEGMENT_END); do
  SEG=$(printf "%s-video-%04d.ts" "$FILE_PREFIX" $i)
  # 使用相对路径：从临时目录看输入目录的相对位置
  echo "file '../$INPUT_DIR/$SEG'" >> "$CONCAT_LIST"
done

ffmpeg -f concat -safe 0 -i "$CONCAT_LIST" -c copy "$TEMP_DIR/merged_input.ts" -y
# ffmpeg -f concat -safe 0 -i "$CONCAT_LIST" \
#   -c:v libx264 -preset fast -crf 18 \
#   -c:a copy \
#   -avoid_negative_ts make_zero \
#   "$TEMP_DIR/merged_input.ts" -y

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

# 计算相对于合并分片的时间偏移
echo "🔄 计算动态zoom时间参数..."

# 计算第一个目标分片的开始时间
CURRENT_TIME=0
SEGMENT_INDEX=0
FIRST_SEGMENT_START_TIME=0

while read line; do
  if [[ $line =~ ^DURATION:(.*) ]]; then
    DURATION="${BASH_REMATCH[1]}"
    read -r next_line
    if [[ $next_line =~ ^FILE:(.*) ]]; then
      if [ "$SEGMENT_INDEX" -eq "$SEGMENT_START" ]; then
        FIRST_SEGMENT_START_TIME="$CURRENT_TIME"
        break
      fi
      CURRENT_TIME=$(echo "$CURRENT_TIME + $DURATION" | bc -l)
      ((SEGMENT_INDEX++))
    fi
  fi
done < "$SEGMENT_INFO"

# 计算相对时间（相对于合并后分片的开始）
REL_ZOOM_START=$(echo "$ZOOM_START - $FIRST_SEGMENT_START_TIME" | bc -l)
REL_ZOOM_END=$(echo "$ZOOM_END - $FIRST_SEGMENT_START_TIME" | bc -l)
ZOOM_DURATION=$(echo "$REL_ZOOM_END - $REL_ZOOM_START" | bc -l)

echo "📊 动态zoom参数:"
echo "   - 原始zoom时间段: ${ZOOM_START}s → ${ZOOM_END}s"
echo "   - 相对zoom时间段: ${REL_ZOOM_START}s → ${REL_ZOOM_END}s"  
echo "   - Zoom持续时间: ${ZOOM_DURATION}s"
echo "   - Zoom中心点: (${ZOOM_CENTER_X}, ${ZOOM_CENTER_Y})"
echo "   - Zoom模式: 对称放大缩小 (1x → 2x → 1x)"

# 应用 zoompan 放大动画处理（参考原始代码逻辑）
echo "🎞️ 开始 Zoom 动画处理..."
FPS_FILTER="fps=$FPS"

# 设置过渡时间（参考原始代码）
ZOOM_IN_TIME="2.0"   # 放大时间：2秒 (it=0→2)
ZOOM_OUT_TIME="2.0"  # 缩小时间：2秒 
ZOOM_OUT_START=$(echo "$ZOOM_DURATION - $ZOOM_OUT_TIME" | bc -l)

echo "🔍 动态Zoompan参数 (参考原始逻辑):"
echo "   - Zoom总时长: ${ZOOM_DURATION}s"
echo "   - 放大阶段(it: 0→${ZOOM_IN_TIME}s): 1x → 2x"
echo "   - 保持阶段(it: ${ZOOM_IN_TIME}s→${ZOOM_OUT_START}s): 2x"
echo "   - 缩小阶段(it: ${ZOOM_OUT_START}s→${ZOOM_DURATION}s): 2x → 1x"

echo "🔍 Zoompan公式 (it=时间戳/秒):"
echo "   z='if(lt(it,${ZOOM_IN_TIME}), 1+it/${ZOOM_IN_TIME},"
echo "      if(lt(it,${ZOOM_OUT_START}), 2,"
echo "      if(lt(it,${ZOOM_DURATION}), 2-(it-${ZOOM_OUT_START})/${ZOOM_OUT_TIME}, 1)))'"

# 计算Zoom中心点的绝对像素坐标（基于原始尺寸）
ZOOM_X=$(echo "$ZOOM_CENTER_X * $ORIGINAL_WIDTH" | bc -l)
ZOOM_Y=$(echo "$ZOOM_CENTER_Y * $ORIGINAL_HEIGHT" | bc -l)

echo "🔍 Zoom中心点像素坐标: (${ZOOM_X}, ${ZOOM_Y})"

ffmpeg -hide_banner -i "$TEMP_DIR/merged_input_fixed.ts" -filter_complex "
[0:v]${FPS_FILTER},scale=${PRE_SCALE_WIDTH}:-1,split=3[pre][zoom][post];

[zoom]trim=start=${REL_ZOOM_START}:end=${REL_ZOOM_END},setpts=PTS-STARTPTS,
zoompan=
  z='if(lt(it,${ZOOM_IN_TIME}), 1+it/${ZOOM_IN_TIME},
     if(lt(it,${ZOOM_OUT_START}), 2,
     if(lt(it,${ZOOM_DURATION}), 2-(it-${ZOOM_OUT_START})/${ZOOM_OUT_TIME}, 1)))':
  x='${ZOOM_X}*iw/${ORIGINAL_WIDTH}-(iw/zoom/2)':
  y='${ZOOM_Y}*ih/${ORIGINAL_HEIGHT}-(ih/zoom/2)':
  d=1:fps=$FPS:s=${PRE_SCALE_WIDTH}x$(($PRE_SCALE_WIDTH * $ORIGINAL_HEIGHT / $ORIGINAL_WIDTH))
[zoomed];

[pre]trim=end=${REL_ZOOM_START},setpts=PTS-STARTPTS[first];
[post]trim=start=${REL_ZOOM_END},setpts=PTS-STARTPTS[last];

[first]scale=${ORIGINAL_WIDTH}:${ORIGINAL_HEIGHT}:flags=lanczos,setsar=1:1[first_scaled];
[zoomed]scale=${ORIGINAL_WIDTH}:${ORIGINAL_HEIGHT}:flags=lanczos,setsar=1:1[zoomed_scaled];
[last]scale=${ORIGINAL_WIDTH}:${ORIGINAL_HEIGHT}:flags=lanczos,setsar=1:1[last_scaled];

[first_scaled][zoomed_scaled][last_scaled]concat=n=3:v=1:a=0[outv]
" -map "[outv]" -map 0:a -c:v libx264 -r $FPS -c:a copy -y "$TEMP_DIR/zoomed.ts"

# 删除原始的目标分片
echo "🗑️ 删除原始的目标分片 ($SEGMENT_START 到 $SEGMENT_END)..."
for i in $(seq $SEGMENT_START $SEGMENT_END); do
  DST=$(printf "$OUTPUT_DIR/%s-video-%04d.ts" "$FILE_PREFIX" $i)
  rm -f "$DST"
done

# 拷贝合并后的文件（而不是zoom处理后的文件）到输出目录
echo "📋 拷贝合并后的文件到输出目录..."
cp "$TEMP_DIR/zoomed.ts" "$OUTPUT_DIR/zoomed.ts"

# 检测zoom文件的实际时长
echo "🔍 检测zoom处理后的文件时长..."
ZOOM_FILE_DURATION=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$OUTPUT_DIR/zoomed.ts")
if [ -z "$ZOOM_FILE_DURATION" ]; then
  echo "⚠️ 无法检测zoom文件时长，使用原始合并时长"
  ZOOM_FILE_DURATION="$ORIGINAL_DURATION"
fi
echo "📊 Zoom文件实际时长: ${ZOOM_FILE_DURATION}s"

# 更新playlist.m3u8，智能替换被删除的分片
echo "📝 智能更新playlist.m3u8..."
TEMP_PLAYLIST="$TEMP_DIR/updated_playlist.m3u8"
ORIGINAL_PLAYLIST="$OUTPUT_DIR/playlist.m3u8"

# 解析原始playlist，提取所有分片信息
PLAYLIST_INFO="$TEMP_DIR/playlist_info.txt"
> "$PLAYLIST_INFO"

# 解析原始playlist的分片信息
SEGMENT_INDEX=0
while read line; do
  if [[ $line =~ ^#EXTINF:([0-9]+\.?[0-9]*), ]]; then
    DURATION="${BASH_REMATCH[1]}"
    echo "DURATION:$DURATION" >> "$PLAYLIST_INFO"
  elif [[ $line =~ \.ts$ ]]; then
    echo "FILE:$line" >> "$PLAYLIST_INFO"
    echo "INDEX:$SEGMENT_INDEX" >> "$PLAYLIST_INFO"
    ((SEGMENT_INDEX++))
  elif [[ $line =~ ^#EXT ]]; then
    echo "HEADER:$line" >> "$PLAYLIST_INFO"
  fi
done < "$INPUT_DIR/playlist.m3u8"

echo "📊 Playlist重建信息:"
echo "   - 替换分片范围: $SEGMENT_START → $SEGMENT_END"
echo "   - 替换为: zoomed.ts (${ZOOM_FILE_DURATION}s)"

# 重建playlist
{
  # 输出头部信息
  echo "#EXTM3U"
  echo "#EXT-X-VERSION:6"
  echo "#EXT-X-TARGETDURATION:4"
  echo "#EXT-X-MEDIA-SEQUENCE:0"
  echo "#EXT-X-INDEPENDENT-SEGMENTS"
  echo "#EXT-X-DISCONTINUITY"
  
  # 处理分片替换
  CURRENT_INDEX=0
  REPLACED=false
  
  while read line; do
    if [[ $line =~ ^DURATION:(.*) ]]; then
      DURATION="${BASH_REMATCH[1]}"
      read -r next_line
      if [[ $next_line =~ ^FILE:(.*) ]]; then
        FILENAME="${BASH_REMATCH[1]}"
        read -r index_line
        if [[ $index_line =~ ^INDEX:(.*) ]]; then
          FILE_INDEX="${BASH_REMATCH[1]}"
          
          # 判断是否在替换范围内
          if [ "$FILE_INDEX" -ge "$SEGMENT_START" ] && [ "$FILE_INDEX" -le "$SEGMENT_END" ]; then
            # 在替换范围内，只插入一次zoom文件
            if [ "$REPLACED" = false ]; then
              echo "#EXTINF:${ZOOM_FILE_DURATION},"
              echo "zoomed.ts"
              REPLACED=true
            fi
            # 跳过原始分片
          else
            # 不在替换范围内，保持原样
            echo "#EXTINF:${DURATION},"
            echo "$FILENAME"
          fi
        fi
      fi
    fi
  done < "$PLAYLIST_INFO"
  
  echo "#EXT-X-ENDLIST"
} > "$TEMP_PLAYLIST"

# 替换原playlist
cp "$TEMP_PLAYLIST" "$ORIGINAL_PLAYLIST"
echo "✅ Playlist更新完成！"

echo "🧹 自动清理临时文件..."
# 清理由 trap 自动执行

echo "✅ Zoom 动画处理完成！"
echo "📁 最终输出目录: $OUTPUT_DIR"
echo "📁 主要文件:"
echo "   - zoomed.ts (${ZOOM_FILE_DURATION}s) - Zoom处理后的文件"
echo "   - playlist.m3u8 - 更新后的播放列表"
echo "🎞️ 使用帧率: $FPS fps"
echo "🎬 播放命令：ffplay \"$OUTPUT_DIR/playlist.m3u8\"" 