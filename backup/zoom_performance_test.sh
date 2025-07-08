#!/bin/bash

# Zoom性能测试脚本
# 测试不同分辨率版本在不同时间段的zoom耗时

set -e

echo "🎬 Zoom性能测试开始"
echo "=================="
echo "测试配置："
echo "- 4K版本：4-10秒zoom, 4-40秒zoom"
echo "- 1080p版本：4-10秒zoom, 4-40秒zoom" 
echo "- 720p版本：4-10秒zoom, 4-40秒zoom"
echo "=================="

# 测试结果数组
declare -a test_names
declare -a test_times

# 测试函数
run_zoom_test() {
    local input_dir="$1"
    local start_time="$2"
    local end_time="$3"
    local test_name="$4"
    
    echo "⏱️  开始测试: $test_name"
    echo "   输入: $input_dir"
    echo "   时间段: ${start_time}s-${end_time}s"
    
    # 记录开始时间
    local start_timestamp=$(date +%s.%N)
    
    # 执行zoom脚本
    ./hls_zoom_script_dynamic.sh "$input_dir" "$start_time" "$end_time" 0.5 0.5 0
    
    # 记录结束时间
    local end_timestamp=$(date +%s.%N)
    
    # 计算耗时
    local duration=$(echo "$end_timestamp - $start_timestamp" | bc -l)
    
    # 存储结果
    test_names+=("$test_name")
    test_times+=("$duration")
    
    echo "✅ 测试完成: $test_name"
    echo "⏱️  耗时: ${duration}秒"
    echo "---"
}

# 检查输入目录是否存在
check_input_dirs() {
    local dirs=("01JYZZ0BN3RX7CZYM13FCSQJKA" "01JYZZ0BN3RX7CZYM13FCSQJKA_1080p" "01JYZZ0BN3RX7CZYM13FCSQJKA_720p")
    
    for dir in "${dirs[@]}"; do
        if [ ! -d "$dir" ]; then
            echo "❌ 错误: 输入目录不存在: $dir"
            exit 1
        fi
    done
    echo "✅ 所有输入目录检查通过"
}

# 清理之前的测试输出
cleanup_previous_tests() {
    echo "🧹 清理之前的测试输出..."
    rm -rf 01JYZZ0BN3RX7CZYM13FCSQJKA_zoomed_* 2>/dev/null || true
    rm -rf 01JYZZ0BN3RX7CZYM13FCSQJKA_1080p_zoomed_* 2>/dev/null || true
    rm -rf 01JYZZ0BN3RX7CZYM13FCSQJKA_720p_zoomed_* 2>/dev/null || true
}

# 主测试流程
main() {
    echo "🔍 检查输入目录..."
    check_input_dirs
    
    echo "🧹 清理之前的测试输出..."
    cleanup_previous_tests
    
    echo "🚀 开始性能测试..."
    echo ""
    
    # 测试1: 4K版本 4-10秒
    run_zoom_test "01JYZZ0BN3RX7CZYM13FCSQJKA" 4 10 "4K_4-10s"
    
    # 测试2: 4K版本 4-40秒
    run_zoom_test "01JYZZ0BN3RX7CZYM13FCSQJKA" 4 40 "4K_4-40s"
    
    # 测试3: 1080p版本 4-10秒
    run_zoom_test "01JYZZ0BN3RX7CZYM13FCSQJKA_1080p" 4 10 "1080p_4-10s"
    
    # 测试4: 1080p版本 4-40秒
    run_zoom_test "01JYZZ0BN3RX7CZYM13FCSQJKA_1080p" 4 40 "1080p_4-40s"
    
    # 测试5: 720p版本 4-10秒
    run_zoom_test "01JYZZ0BN3RX7CZYM13FCSQJKA_720p" 4 10 "720p_4-10s"
    
    # 测试6: 720p版本 4-40秒
    run_zoom_test "01JYZZ0BN3RX7CZYM13FCSQJKA_720p" 4 40 "720p_4-40s"
    
    echo ""
    echo "📊 测试结果汇总"
    echo "================"
    printf "%-15s %-12s %-10s\n" "测试项目" "时间段" "耗时(秒)"
    echo "--------------------------------"
    
    # 显示结果
    for i in "${!test_names[@]}"; do
        local name="${test_names[$i]}"
        local time="${test_times[$i]}"
        local display_name=""
        local time_range=""
        
        case "$name" in
            "4K_4-10s")
                display_name="4K版本"
                time_range="4-10秒"
                ;;
            "4K_4-40s")
                display_name="4K版本"
                time_range="4-40秒"
                ;;
            "1080p_4-10s")
                display_name="1080p版本"
                time_range="4-10秒"
                ;;
            "1080p_4-40s")
                display_name="1080p版本"
                time_range="4-40秒"
                ;;
            "720p_4-10s")
                display_name="720p版本"
                time_range="4-10秒"
                ;;
            "720p_4-40s")
                display_name="720p版本"
                time_range="4-40秒"
                ;;
        esac
        
        printf "%-15s %-12s %-10.2f\n" "$display_name" "$time_range" "$time"
    done
    echo "--------------------------------"
    
    echo ""
    echo "📈 性能分析"
    echo "============"
    
    # 计算平均耗时
    local total_time=0
    local count=${#test_times[@]}
    for time in "${test_times[@]}"; do
        total_time=$(echo "$total_time + $time" | bc -l)
    done
    local avg_time=$(echo "$total_time / $count" | bc -l)
    echo "平均耗时: ${avg_time}秒"
    
    # 找出最快和最慢的测试
    local fastest_test=""
    local slowest_test=""
    local fastest_time=999999
    local slowest_time=0
    
    for i in "${!test_times[@]}"; do
        local time="${test_times[$i]}"
        local name="${test_names[$i]}"
        if (( $(echo "$time < $fastest_time" | bc -l) )); then
            fastest_time="$time"
            fastest_test="$name"
        fi
        if (( $(echo "$time > $slowest_time" | bc -l) )); then
            slowest_time="$time"
            slowest_test="$name"
        fi
    done
    
    echo "最快测试: $fastest_test (${fastest_time}秒)"
    echo "最慢测试: $slowest_test (${slowest_time}秒)"
    
    echo ""
    echo "✅ 所有测试完成！"
}

# 执行主函数
main "$@" 