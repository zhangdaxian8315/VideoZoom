#!/bin/bash

# 一键合并、转码、精准切片为自定义分辨率HLS脚本（分片结构与原始一致）
# 用法: ./hls_full_transcode_1080p.sh <原始HLS目录> <输出HLS目录> <分辨率>
# 例: ./hls_full_transcode_1080p.sh 01JYZZ0BN3RX7CZYM13FCSQJKA 01JYZZ0BN3RX7CZYM13FCSQJKA_1080p 1080p

set -e

if [ $# -lt 3 ]; then
    echo "用法: $0 <原始HLS目录> <输出HLS目录> <分辨率>"
    echo "示例: $0 01JYZZ0BN3RX7CZYM13FCSQJKA 01JYZZ0BN3RX7CZYM13FCSQJKA_720p 720p"
    echo "      $0 01JYZZ0BN3RX7CZYM13FCSQJKA 01JYZZ0BN3RX7CZYM13FCSQJKA_2k 2k"
    echo "      $0 01JYZZ0BN3RX7CZYM13FCSQJKA 01JYZZ0BN3RX7CZYM13FCSQJKA_custom 1600x900"
    exit 1
fi

SRC_DIR="$1"
OUT_DIR="$2"
RES_ARG="$3"
MERGED_MP4="merged.mp4"
MERGED_RES_MP4="merged_res.mp4"
SEGMENT_DIR="segments_tmp"

# 解析分辨率参数
case "$RES_ARG" in
    1080p)
        SCALE="1920:1080"
        ;;
    720p)
        SCALE="1280:720"
        ;;
    2k)
        SCALE="2560:1440"
        ;;
    4k)
        SCALE="3840:2160"
        ;;
    [0-9]*x[0-9]*)
        SCALE="$RES_ARG"
        ;;
    *)
        echo "不支持的分辨率参数: $RES_ARG"
        echo "支持: 1080p, 720p, 2k, 4k 或自定义如 1600x900"
        exit 1
        ;;
esac

# 2. 生成 concat_list.txt（按原始m3u8顺序）
grep .ts "$SRC_DIR/playlist.m3u8" | sed "s/^/file '/;s/$/'/" > "$SRC_DIR/concat_list.txt"

# 3. 合并ts为mp4
ffmpeg -f concat -safe 0 -i "$SRC_DIR/concat_list.txt" -c copy "$MERGED_MP4"
if [ $? -ne 0 ]; then
    echo "合并ts失败"
    exit 1
fi

# 4. 解析原始m3u8，生成精准切割点
SEGMENT_TIMES=$(awk '/#EXTINF:/ {gsub(/[^0-9.]/, "", $1); t+=$1; printf("%.3f,", t)}' "$SRC_DIR/playlist.m3u8")
SEGMENT_TIMES=${SEGMENT_TIMES%,} # 去掉最后一个逗号

# 5. 整体转码为目标分辨率mp4，强制每4秒关键帧
ffmpeg -i "$MERGED_MP4" -vf "scale=$SCALE:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1:1" \
    -c:v libx264 -preset medium -crf 23 \
    -force_key_frames "expr:gte(t,n_forced*4)" \
    -c:a aac -b:a 128k -y "$MERGED_RES_MP4"
if [ $? -ne 0 ]; then
    echo "转码失败"
    exit 1
fi

# 6. 精准切片（分片数量、时长与原始一致）
mkdir -p "$OUT_DIR"
mkdir -p "$SEGMENT_DIR"

# 获取原始文件名前缀
FIRST_TS_FILE=$(grep "\.ts$" "$SRC_DIR/playlist.m3u8" | head -1)
if [[ $FIRST_TS_FILE =~ ^(.+)-video-[0-9]+\.ts$ ]]; then
    FILE_PREFIX="${BASH_REMATCH[1]}"
else
    echo "❌ 错误: 无法解析原始文件名格式"
    exit 1
fi

echo "📂 使用原始文件名前缀: $FILE_PREFIX"

# 切片时使用原始文件名格式
ffmpeg -i "$MERGED_RES_MP4" -c copy -f segment -segment_times "$SEGMENT_TIMES" -reset_timestamps 1 "$SEGMENT_DIR/${FILE_PREFIX}-video-%04d.ts"

# 7. 生成新的playlist.m3u8（内容与原始一致，保持原始文件名格式）
awk -v dir="$SEGMENT_DIR" -v out="$OUT_DIR" -v prefix="$FILE_PREFIX" '
    BEGIN{n=0}
    /#EXTINF/ {print; getline; printf("%s-video-%04d.ts\n", prefix, n++); next}
    {print}
' "$SRC_DIR/playlist.m3u8" > "$OUT_DIR/playlist.m3u8"

# 8. 拷贝分片到输出目录
cp "$SEGMENT_DIR"/*.ts "$OUT_DIR/"

# 9. 复制字幕、缩略图等（可选）
cp "$SRC_DIR"/*.vtt "$OUT_DIR/" 2>/dev/null || true
cp "$SRC_DIR"/*.jpeg "$OUT_DIR/" 2>/dev/null || true
cp "$SRC_DIR"/*.jpg "$OUT_DIR/" 2>/dev/null || true
cp "$SRC_DIR"/*.png "$OUT_DIR/" 2>/dev/null || true

# 10. 清理中间文件
rm -rf "$MERGED_MP4" "$MERGED_RES_MP4" "$SEGMENT_DIR"

echo "\n全部完成！新的HLS在: $OUT_DIR，分辨率: $SCALE，分片结构与原始一致。" 