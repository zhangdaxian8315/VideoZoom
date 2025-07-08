#!/bin/bash

# HLS Zoom Export - 本地测试脚本
# 使用 AWS SAM CLI 在本地运行 Lambda 函数

echo "🚀 开始本地测试 HLS Zoom Export Lambda 函数..."

# 检查 SAM CLI 是否已安装
if ! command -v sam &> /dev/null; then
    echo "❌ SAM CLI 未安装！请先安装 SAM CLI："
    echo "   brew install aws-sam-cli"
    exit 1
fi

# 检查 AWS 凭证是否配置
if ! aws sts get-caller-identity &> /dev/null; then
    echo "❌ AWS 凭证未配置！请先配置 AWS 凭证："
    echo "   aws configure"
    exit 1
fi

echo "✅ 环境检查通过"

# 构建 SAM 应用
echo "🔨 构建 SAM 应用..."
sam build

if [ $? -ne 0 ]; then
    echo "❌ 构建失败！"
    exit 1
fi

echo "✅ 构建成功"

# 本地调用 Lambda 函数
echo "🎬 开始本地调用 Lambda 函数..."
sam local invoke HlsZoomExportFunction \
    --event events/test-event.json \
    --env-vars env.json \
    --docker-network host

echo "✅ 本地测试完成" 