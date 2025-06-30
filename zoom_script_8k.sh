#!/bin/bash

# 默认FPS为60，可以通过参数修改为30
FPS=${1:-60}
# 默认使用普通fps，可以通过第二个参数选择minterpolate插帧
INTERPOLATE=${2:-false}

start_time=$(date +%s)
echo "[INFO] 脚本开始执行：$(date)"
echo "[INFO] 使用FPS: $FPS"
echo "[INFO] 使用插帧: $INTERPOLATE"

step_start=$(date +%s)

# 根据插帧参数选择不同的处理方式
if [ "$INTERPOLATE" = "true" ]; then
    echo "[INFO] 开始执行ffmpeg 8K + ${FPS}帧 (minterpolate插帧) 缩放处理..."
    FPS_FILTER="minterpolate=fps=$FPS"
    OUTPUT_SUFFIX="_mint"
else
    echo "[INFO] 开始执行ffmpeg 8K + ${FPS}帧 (普通fps) 缩放处理..."
    FPS_FILTER="fps=$FPS"
    OUTPUT_SUFFIX=""
fi

ffmpeg -hide_banner -i "Boom_Test.mp4" -filter_complex "
[0:v]${FPS_FILTER},scale=8000:4496,split=3[pre][zoom][post];

[zoom]trim=start=3:end=11,setpts=PTS-STARTPTS,
zoompan=
  z='if(lt(it,2), 1+it/2,
     if(lt(it,6), 2,
     if(lt(it,8), 2 - (it-6)/2, 1)))':
  x='iw/2-(iw/zoom/2)':
  y='ih/2-(ih/zoom/2)':
  d=1:fps=$FPS:s=8000x4496
[zoomed];

[pre]trim=end=3,setpts=PTS-STARTPTS[first];
[post]trim=start=11,setpts=PTS-STARTPTS[last];

[first]scale=1366:768[first_scaled];
[zoomed]scale=1366:768[zoomed_scaled];
[last]scale=1366:768[last_scaled];

[first_scaled][zoomed_scaled][last_scaled]concat=n=3:v=1:a=0[outv]
" -map "[outv]" -map 0:a -c:v libx264 -r $FPS -c:a copy -y Boom_Test_scaled_then_zoomed_8k_output_1366x768_${FPS}fps${OUTPUT_SUFFIX}.mp4

step_end=$(date +%s)
echo "[INFO] ffmpeg 8K + ${FPS}帧缩放处理完成，耗时 $((step_end-step_start)) 秒"

end_time=$(date +%s)
echo "[INFO] 脚本执行完毕：$(date)，总耗时 $((end_time-start_time)) 秒"
