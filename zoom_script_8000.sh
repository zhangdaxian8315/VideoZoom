#!/bin/bash

ffmpeg -i "Boom_Test.mp4" -filter_complex "
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

[first][zoomed][last]concat=n=3:v=1:a=0[outv]
" -map "[outv]" -map 0:a -c:v libx264 -c:a copy -y Boom_Test_scaled_then_zoomed_8000.mp4 