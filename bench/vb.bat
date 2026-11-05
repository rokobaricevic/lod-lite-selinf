@echo off
rem VoxelBench (interactive session): the bench queue runner + its server
cd /d C:\Users\rokob\voxel-bench
.venv\Scripts\python.exe -u runner.py > runner.log 2>&1
