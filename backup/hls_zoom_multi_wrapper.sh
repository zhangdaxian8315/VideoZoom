#!/bin/bash

set -e

# 检查是否安装了jq
if ! command -v jq &> /dev/null; then
    echo "❌ 错误: 需要安装jq来解析JSON配置文件"
    echo "   安装命令: brew install jq"
    exit 1
fi

# 参数解析
if [ $# -lt 2 ]; then
    echo "❌ 用法: $0 <INPUT_DIR> <CONFIG_FILE>"
    echo "  INPUT_DIR   - HLS文件夹路径"
    echo "  CONFIG_FILE - JSON配置文件路径"
    echo ""
    echo "配置文件格式示例:"
    echo '{'
    echo '  "zooms": ['
    echo '    {'
    echo '      "start": 5.0,'
    echo '      "end": 11.0,'
    echo '      "center_x": 0.5,'
    echo '      "center_y": 0.5'
    echo '    },'
    echo '    {'
    echo '      "start": 15.0,'
    echo '      "end": 25.0,'
    echo '      "center_x": 0.2,'
    echo '      "center_y": 0.8'
    echo '    }'
    echo '  ]'
    echo '}'
    exit 1
fi

INPUT_DIR="$1"
CONFIG_FILE="$2"

# 基本验证
if [ ! -d "$INPUT_DIR" ]; then
    echo "❌ 错误: 输入目录不存在: $INPUT_DIR"
    exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ 错误: 配置文件不存在: $CONFIG_FILE"
    exit 1
fi

# 验证JSON格式
if ! jq empty "$CONFIG_FILE" 2>/dev/null; then
    echo "❌ 错误: JSON配置文件格式无效"
    exit 1
fi

# 检查zooms数组
if ! jq -e '.zooms' "$CONFIG_FILE" >/dev/null 2>&1; then
    echo "❌ 错误: 配置文件中缺少 'zooms' 数组"
    exit 1
fi

# 获取zoom数量
ZOOM_COUNT=$(jq '.zooms | length' "$CONFIG_FILE")
if [ "$ZOOM_COUNT" -eq 0 ]; then
    echo "❌ 错误: zooms数组为空"
    exit 1
fi

echo "🎬 HLS 多Zoom 包装脚本开始执行"
echo "📁 输入目录: $INPUT_DIR"
echo "📄 配置文件: $CONFIG_FILE"
echo "🎯 Zoom数量: $ZOOM_COUNT"
echo "⏰ 开始时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# 验证每个zoom配置
echo "🔍 验证Zoom配置..."
for i in $(seq 0 $((ZOOM_COUNT-1))); do
    START=$(jq -r ".zooms[$i].start" "$CONFIG_FILE")
    END=$(jq -r ".zooms[$i].end" "$CONFIG_FILE")
    CENTER_X=$(jq -r ".zooms[$i].center_x" "$CONFIG_FILE")
    CENTER_Y=$(jq -r ".zooms[$i].center_y" "$CONFIG_FILE")
    
    echo "  Zoom $((i+1)): ${START}s → ${END}s, 中心点(${CENTER_X}, ${CENTER_Y})"
    
    # 验证时间
    if (( $(echo "$START >= $END" | bc -l) )); then
        echo "❌ 错误: Zoom $((i+1)) 开始时间必须小于结束时间"
        exit 1
    fi
    
    # 验证坐标
    if (( $(echo "$CENTER_X < 0 || $CENTER_X > 1" | bc -l) )); then
        echo "❌ 错误: Zoom $((i+1)) center_x 必须在 0.0-1.0 范围内"
        exit 1
    fi
    
    if (( $(echo "$CENTER_Y < 0 || $CENTER_Y > 1" | bc -l) )); then
        echo "❌ 错误: Zoom $((i+1)) center_y 必须在 0.0-1.0 范围内"
        exit 1
    fi
done

# 检查时间重叠
echo ""
echo "🔍 检查时间重叠..."
for i in $(seq 0 $((ZOOM_COUNT-1))); do
    START_I=$(jq -r ".zooms[$i].start" "$CONFIG_FILE")
    END_I=$(jq -r ".zooms[$i].end" "$CONFIG_FILE")
    
    for j in $(seq 0 $((ZOOM_COUNT-1))); do
        if [ "$i" -ge "$j" ]; then
            continue
        fi
        START_J=$(jq -r ".zooms[$j].start" "$CONFIG_FILE")
        END_J=$(jq -r ".zooms[$j].end" "$CONFIG_FILE")
        
        # 检查重叠：一个zoom的结束时间 > 另一个zoom的开始时间 且 一个zoom的开始时间 < 另一个zoom的结束时间
        if (( $(echo "$END_I > $START_J" | bc -l) )) && (( $(echo "$START_I < $END_J" | bc -l) )); then
            echo "❌ 错误: Zoom $((i+1)) 和 Zoom $((j+1)) 时间段重叠"
            echo "   Zoom $((i+1)): ${START_I}s → ${END_I}s"
            echo "   Zoom $((j+1)): ${START_J}s → ${END_J}s"
            exit 1
        fi
    done
done

echo "✅ 配置验证通过"
echo ""

# 按时间顺序排序zooms
echo "📋 按时间顺序处理Zoom..."
TEMP_SORTED_CONFIG=$(mktemp)
jq '.zooms | sort_by(.start)' "$CONFIG_FILE" > "$TEMP_SORTED_CONFIG"

# 处理每个zoom
CURRENT_INPUT_DIR="$INPUT_DIR"
CURRENT_OUTPUT_DIR=""

for i in $(seq 0 $((ZOOM_COUNT-1))); do
    START=$(jq -r ".[$i].start" "$TEMP_SORTED_CONFIG")
    END=$(jq -r ".[$i].end" "$TEMP_SORTED_CONFIG")
    CENTER_X=$(jq -r ".[$i].center_x" "$TEMP_SORTED_CONFIG")
    CENTER_Y=$(jq -r ".[$i].center_y" "$TEMP_SORTED_CONFIG")
    
    echo "🎯 处理 Zoom $((i+1)): ${START}s → ${END}s, 中心点(${CENTER_X}, ${CENTER_Y})"
    echo "📁 输入目录: $CURRENT_INPUT_DIR"
    
    # 调用单zoom脚本
    if [ -f "./hls_zoom_script_dynamic.sh" ]; then
        ./hls_zoom_script_dynamic.sh "$CURRENT_INPUT_DIR" "$START" "$END" "$CENTER_X" "$CENTER_Y"
    else
        echo "❌ 错误: 找不到单zoom脚本 hls_zoom_script_dynamic.sh"
        exit 1
    fi
    
    # 更新输入目录为当前输出目录
    CURRENT_OUTPUT_DIR="${CURRENT_INPUT_DIR}_zoomed"
    CURRENT_INPUT_DIR="$CURRENT_OUTPUT_DIR"
    
    echo "✅ Zoom $((i+1)) 处理完成"
    echo ""
done

# 清理临时文件
rm -f "$TEMP_SORTED_CONFIG"

echo "🎉 所有Zoom处理完成！"
echo "📁 最终输出目录: $CURRENT_OUTPUT_DIR"
echo "🎬 播放命令: ffplay \"$CURRENT_OUTPUT_DIR/playlist.m3u8\"" 