#!/bin/bash

start_time=$(date +%s)
echo "[INFO] 脚本开始执行：$(date)"

step_start=$(date +%s)
echo "[INFO] 开始执行 ffmpeg 60fps 原始分辨率缩放处理..."

ffmpeg -hide_banner -i "Boom_Test.mp4" -filter_complex "
[0:v]split=3[pre][zoom][post];

[zoom]trim=start=3:end=11,setpts=PTS-STARTPTS,
zoompan=
  z='if(lt(it,2), 1+it/2,
     if(lt(it,6), 2,
     if(lt(it,8), 2 - (it-6)/2, 1)))':
  x='iw/2-(iw/zoom/2)':
  y='ih/2-(ih/zoom/2)':
  d=2:fps=60:s=1366x768
[zoomed];

[pre]trim=end=3,setpts=PTS-STARTPTS[first];
[post]trim=start=11,setpts=PTS-STARTPTS[last];

[first][zoomed][last]concat=n=3:v=1:a=0[concatted];
[concatted]fps=60[outv_final]
" -map "[outv_final]" -map 0:a -c:v libx264 -r 60 -c:a copy -y Boom_Test_zoom_fixed_60fps.mp4

step_end=$(date +%s)
echo "[INFO] ffmpeg 60fps 原始分辨率缩放处理完成，耗时 $((step_end - step_start)) 秒"

end_time=$(date +%s)
echo "[INFO] 脚本执行完毕：$(date)，总耗时 $((end_time - start_time)) 秒"
