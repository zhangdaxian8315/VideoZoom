#!/bin/bash

./hls_zoom_script_dynamic.sh 01JYZZ0BN3RX7CZYM13FCSQJKA 3 11 0.1 0.1
./hls_zoom_script_dynamic.sh 01JYZZ0BN3RX7CZYM13FCSQJKA_zoomed 14 22.1 0.9 0.9
./hls_zoom_script_dynamic.sh 01JYZZ0BN3RX7CZYM13FCSQJKA_zoomed 25 33.1 0.5 0.5
ffplay "01JYZZ0BN3RX7CZYM13FCSQJKA_zoomed/playlist.m3u8" 