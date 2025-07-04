#!/bin/bash

# HLS转码为1080P脚本
# 使用方法: ./hls_transcode_1080p.sh <输入文件夹> <输出文件夹>

if [ $# -ne 2 ]; then
    echo "使用方法: $0 <输入文件夹> <输出文件夹>"
    echo "示例: $0 01JYZZ0BN3RX7CZYM13FCSQJKA 01JYZZ0BN3RX7CZYM13FCSQJKA_1080p"
    exit 1
fi

INPUT_DIR="$1"
OUTPUT_DIR="$2"

# 检查输入文件夹是否存在
if [ ! -d "$INPUT_DIR" ]; then
    echo "错误: 输入文件夹 '$INPUT_DIR' 不存在"
    exit 1
fi

# 创建输出文件夹
mkdir -p "$OUTPUT_DIR"

# 查找playlist.m3u8文件
PLAYLIST_FILE=""
if [ -f "$INPUT_DIR/playlist.m3u8" ]; then
    PLAYLIST_FILE="$INPUT_DIR/playlist.m3u8"
elif [ -f "$INPUT_DIR/playlist_merge.m3u8" ]; then
    PLAYLIST_FILE="$INPUT_DIR/playlist_merge.m3u8"
elif [ -f "$INPUT_DIR/playlist_merge_511.m3u8" ]; then
    PLAYLIST_FILE="$INPUT_DIR/playlist_merge_511.m3u8"
else
    echo "错误: 在 '$INPUT_DIR' 中找不到playlist文件"
    exit 1
fi

echo "使用playlist文件: $PLAYLIST_FILE"

# 复制音频文件（如果存在）
if [ -f "$INPUT_DIR"/*-audio.m4a ]; then
    cp "$INPUT_DIR"/*-audio.m4a "$OUTPUT_DIR/"
    echo "已复制音频文件"
fi

# 复制其他文件（缩略图、字幕等）
cp "$INPUT_DIR"/*.vtt "$OUTPUT_DIR/" 2>/dev/null || true
cp "$INPUT_DIR"/*.jpeg "$OUTPUT_DIR/" 2>/dev/null || true
cp "$INPUT_DIR"/*.jpg "$OUTPUT_DIR/" 2>/dev/null || true
cp "$INPUT_DIR"/*.png "$OUTPUT_DIR/" 2>/dev/null || true

# 获取所有TS文件
TS_FILES=$(grep "\.ts$" "$PLAYLIST_FILE" | grep -v "^#")

echo "开始转码TS文件..."

# 转码每个TS文件
for ts_file in $TS_FILES; do
    input_file="$INPUT_DIR/$ts_file"
    output_file="$OUTPUT_DIR/$ts_file"
    
    if [ -f "$input_file" ]; then
        echo "转码: $ts_file"
        
        # 使用ffmpeg转码为1080P
        # 保持宽高比，确保宽度和高度都是偶数
        ffmpeg -i "$input_file" \
               -c:v libx264 \
               -preset medium \
               -crf 23 \
               -vf "scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2" \
               -c:a copy \
               -y "$output_file"
        
        if [ $? -eq 0 ]; then
            echo "✓ 完成: $ts_file"
        else
            echo "✗ 失败: $ts_file"
        fi
    else
        echo "警告: 找不到文件 $input_file"
    fi
done

# 复制playlist文件到输出目录
cp "$PLAYLIST_FILE" "$OUTPUT_DIR/playlist.m3u8"

echo ""
echo "转码完成！"
echo "输入文件夹: $INPUT_DIR"
echo "输出文件夹: $OUTPUT_DIR"
echo ""
echo "新的1080P HLS文件已生成在: $OUTPUT_DIR" 