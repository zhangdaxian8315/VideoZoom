#!/bin/bash

# 输入文件
INPUT1="merged-0000.ts"
INPUT2="zoomed-0000.ts"

# 输出 CSV
OUTPUT1="merged_gop_frames.csv"
OUTPUT2="zoomed_gop_frames.csv"

echo "🎬 提取 GOP 帧信息..."

# 提取 merged-0000.ts 的帧信息
ffprobe -v error -select_streams v:0 -show_frames -print_format csv \
-show_entries frame=pkt_pts_time,pict_type,interlaced_frame,coded_picture_number \
"$INPUT1" > "$OUTPUT1"

# 提取 zoomed-0000.ts 的帧信息
ffprobe -v error -select_streams v:0 -show_frames -print_format csv \
-show_entries frame=pkt_pts_time,pict_type,interlaced_frame,coded_picture_number \
"$INPUT2" > "$OUTPUT2"

echo "✅ 提取完成！"
echo "📄 输出文件: $OUTPUT1, $OUTPUT2"
