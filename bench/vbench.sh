#!/bin/bash
# vbench.sh -- the Mac side of the PC's voxel bench (C:\Users\rokob\voxel-bench on lynceus-win; bench/README.md)
#   vbench.sh push VARIANT FILE...          copy files into variants\VARIANT\ (e.g. your damage.js, viewer.html)
#   vbench.sh run JOB LOCALDIR BENCHARGS... queue "bench.py --out JOB BENCHARGS", wait, copy out\JOB\ to LOCALDIR/JOB/
#   vbench.sh cmd JOB 'cmd line'            queue any cmd line (cwd = the bench folder, %PY% = its python), wait, print log
#   vbench.sh status                        runner alive?, queue, running
# Jobs run ONE AT A TIME on the PC (fair GPU timings): expect to wait behind other jobs. JOB: letters, digits, -_ only.
set -euo pipefail
PC=lynceus-win; R='C:/Users/rokob/voxel-bench'; W='C:\Users\rokob\voxel-bench'
ensure() {  # (re)start the runner if its heartbeat is stale
  local age; age=$(ssh $PC "powershell -NoProfile -Command \"if (Test-Path $W\\runner.alive) { [int]((Get-Date).ToUniversalTime() - [DateTime]'1970-01-01').TotalSeconds - [int][double](Get-Content $W\\runner.alive) } else { 9999 }\"" | tr -d '\r')
  if [ "${age:-9999}" -gt 20 ]; then ssh $PC 'schtasks /run /tn VoxelBench' > /dev/null; sleep 4; fi
}
queue() {  # JOB CMDLINE: write the job, wait for done\JOB.exit, print the log
  local job=$1 line=$2 tmp; tmp=$(mktemp)
  ssh $PC "del /q $W\\done\\$job.exit $W\\done\\$job.log 2>nul" || true
  printf '%s\r\n' "$line" > "$tmp"; scp -q "$tmp" "$PC:$R/queue/$job.cmd"; rm -f "$tmp"
  ensure
  local n=0
  until ssh $PC "if exist $W\\done\\$job.exit (exit 0) else (exit 1)" 2>/dev/null; do
    sleep 10; n=$((n+1)); [ $((n % 30)) -eq 0 ] && echo "[vbench] still waiting for $job ($((n/6)) min; other jobs may be ahead)" >&2
  done
  ssh $PC "type $W\\done\\$job.log & echo. & echo [exit] & type $W\\done\\$job.exit"
}
case "${1:-}" in
  push) v=$2; shift 2; ssh $PC "if not exist $W\\variants\\$v mkdir $W\\variants\\$v"; for f in "$@"; do scp -q "$f" "$PC:$R/variants/$v/$(basename "$f")"; done; echo "pushed to variants\\$v: $*" ;;
  run) job=$2 dest=$3; shift 3; queue "$job" "%PY% -u bench.py --out $job $*"; mkdir -p "$dest"; scp -q -r "$PC:$R/out/$job" "$dest/" && echo "results in $dest/$job/" ;;
  cmd) queue "$2" "$3" ;;
  status) ensure; ssh $PC "dir /b $W\\queue $W\\running 2>nul & type $W\\runner.alive" ;;
  *) sed -n 2,8p "$0"; exit 1 ;;
esac
