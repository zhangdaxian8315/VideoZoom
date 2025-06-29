#!/bin/bash

start_time=$(date +%s)
echo "[INFO] 脚本开始执行：$(date)"

step_start=$(date +%s)
echo "[INFO] 开始执行ffmpeg 8K缩放处理..."

ffmpeg -hide_banner -i "Boom_Test.mp4" -filter_complex "
[0:v]scale=8000:4496,split=3[pre][zoom][post];

[zoom]trim=start=3:end=11,setpts=PTS-STARTPTS,
zoompan=
  z='if(lt(it,2), 1+it/2,
     if(lt(it,6), 2,
     if(lt(it,8), 2 - (it-6)/2, 1)))':
  x='iw/2-(iw/zoom/2)':
  y='ih/2-(ih/zoom/2)':
  d=1:fps=30:s=8000x4496
[zoomed];

[pre]trim=end=3,setpts=PTS-STARTPTS[first];
[post]trim=start=11,setpts=PTS-STARTPTS[last];

[first]scale=1366:768[first_scaled];
[zoomed]scale=1366:768[zoomed_scaled];
[last]scale=1366:768[last_scaled];

[first_scaled][zoomed_scaled][last_scaled]concat=n=3:v=1:a=0[outv]
" -map "[outv]" -map 0:a -c:v libx264 -c:a copy -y Boom_Test_scaled_then_zoomed_8k_output_1366x768.mp4

step_end=$(date +%s)
echo "[INFO] ffmpeg 8K缩放处理完成，耗时 $((step_end-step_start)) 秒"

end_time=$(date +%s)
echo "[INFO] 脚本执行完毕：$(date)，总耗时 $((end_time-start_time)) 秒"
