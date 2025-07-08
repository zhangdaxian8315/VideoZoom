#!/bin/bash

set -e

# 参数设置
INPUT_DIR="01JYZZ0BN3RX7CZYM13FCSQJKA_1080p"
OUTPUT_DIR="01JYZZ0BN3RX7CZYM13FCSQJKA_1080p_zoomed"
TEMP_DIR="temp_hls_zoom"
M3U8_FILE="playlist.m3u8"

SEGMENT_START=0
SEGMENT_END=2
PRE_SCALE_WIDTH=8000
OUTPUT_WIDTH=1920
OUTPUT_HEIGHT=1080

echo "🎬 HLS Zoom 脚本开始执行"
echo "📁 输入目录: $INPUT_DIR"
echo "📁 输出目录: $OUTPUT_DIR"
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

ffmpeg -f concat -safe 0 -i "$CONCAT_LIST" -c:v libx264 -preset fast -crf 18 -r 29.25 -c:a aac -b:a 128k "$TEMP_DIR/merged_input.ts" -y


# 应用 zoompan 放大动画处理（带前期 scale 放大 + reset 时间戳）
echo "🎞️ 开始 Zoom 动画处理..."
ffmpeg -hide_banner -i "$TEMP_DIR/merged_input.ts" -filter_complex "
scale=${PRE_SCALE_WIDTH}:-1,
zoompan=
  z='if(lt(it,2), 1+it/2,
     if(lt(it,6), 2,
     if(lt(it,8), 2-(it-6)/2, 1)))':
  x='iw/2-(iw/zoom/2)':
  y='ih/2-(ih/zoom/2)':
  d=1:s=${PRE_SCALE_WIDTH}x$(($PRE_SCALE_WIDTH * 9 / 16)),
scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},
setpts=PTS-STARTPTS
" -c:v libx264 -crf 18 -preset slow -r 29.25 -c:a copy "$TEMP_DIR/zoomed-0000.ts" -y

# 删除原始的前3个分片
echo "🗑️ 删除原始的前3个分片..."
for i in $(seq $SEGMENT_START $SEGMENT_END); do
  DST=$(printf "$OUTPUT_DIR/01JYZZ0BN3RX7CZYM13FCSQJKA-video-%04d.ts" $i)
  rm -f "$DST"
done

# 拷贝合并后的文件（而不是zoom处理后的文件）到输出目录
echo "📋 拷贝合并后的文件到输出目录..."
cp "$TEMP_DIR/merged_input.ts" "$OUTPUT_DIR/merged-0000.ts"

# 不需要重命名，保持原始文件名对应关系
echo "📋 保持原始文件名对应关系..."

# 修改playlist.m3u8
echo "📝 修改playlist.m3u8..."
M3U8_PATH="$OUTPUT_DIR/$M3U8_FILE"
TEMP_M3U8="$TEMP_DIR/temp_playlist.m3u8"

# 读取原始m3u8文件，替换前3行分片为1行merged-0000.ts，保持后续分片不变
awk -v start_line=8 -v end_line=10 '
BEGIN { line_count = 0 }
{
  line_count++
  if (line_count < start_line) {
    print $0
  } else if (line_count == start_line) {
    print "#EXTINF:12.162300,"
    print "merged-0000.ts"
  } else if (line_count > end_line) {
    # 保持后续分片不变，不调整编号
    print $0
  }
}' "$M3U8_PATH" > "$TEMP_M3U8"

# 替换原文件
mv "$TEMP_M3U8" "$M3U8_PATH"

echo "🧹 清理临时文件夹..."
# rm -rf "$TEMP_DIR"

echo "✅ Zoom 动画处理完成！"
echo "📁 最终输出目录: $OUTPUT_DIR"
echo "🎬 播放命令：ffplay \"$OUTPUT_DIR/$M3U8_FILE\""
