#!/usr/bin/env bash
# The whole stack runs on the PC, in C:\Users\rokob\lod-lite-selinf: selinf.py serves the viewer, its tiles and the
# clicks on the PC's 127.0.0.1:8765, behind the login LOGIN (default test:test).
#   ./test.sh               PC: copy this folder's code, build selinf_core (MSVC) and run test_selinf.py there; then swap
#                           it in for the running server, start selinf.py (GPU), tunnel it to 127.0.0.1:8765, open the viewer
#   ./test.sh data          PC: copy source/ work/ out/ (the viewer's tiles, lod.py build's inputs) into the PC folder
#   ./test.sh public on     publish the PC server on the internet (Tailscale Funnel, https on :8443); off | status
#   ./test.sh stop          stop the PC server and the tunnel
#   ./test.sh test          Mac: fetch pybind11 + Embree headers (once), build selinf_core, run test_selinf.py
# In the viewer: alt-click (option-click) the bridge.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
LOGIN="${LOGIN:-test:test}"
[[ "$LOGIN" =~ ^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$ ]] || { echo "test.sh: LOGIN is user:password, letters digits . _ -" >&2; exit 1; }
tunnel="8765:127.0.0.1:8765"
kill_pc='Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }'

if [ "${1:-}" = test ]; then
  cd "$here"
  PY="${PY:-$HOME/dev/lynceus/apps/worker/.venv/bin/python}"
  mkdir -p build
  if [ ! -d build/pybind11/include ]; then
    curl -fsSL https://github.com/pybind/pybind11/archive/refs/tags/v2.13.6.tar.gz -o build/pybind11.tar.gz
    mkdir -p build/pybind11 && tar xzf build/pybind11.tar.gz -C build/pybind11 --strip-components=1
  fi
  if [ ! -d build/embree/include ]; then
    curl -fsSL https://github.com/RenderKit/embree/releases/download/v4.4.0/embree-4.4.0.arm64.macosx.zip -o build/embree.zip
    mkdir -p build/embree && unzip -q build/embree.zip -d build/embree
  fi
  EMB="$("$PY" -c 'import embreex, os; print(os.path.dirname(embreex.__file__))')/.dylibs/libembree4.4.dylib"
  OUT="selinf_core$("$PY" -c 'import sysconfig; print(sysconfig.get_config_var("EXT_SUFFIX"))')"
  clang++ -O3 -std=c++17 -shared -undefined dynamic_lookup -ffp-contract=off -fvisibility=hidden -Wl,-headerpad_max_install_names \
    -I build/pybind11/include -I build/embree/include \
    -I "$("$PY" -c 'import sysconfig; print(sysconfig.get_paths()["include"])')" selinf.cpp "$EMB" -o "$OUT"
  install_name_tool -change /DLC/embreex/.dylibs/libembree4.4.dylib "$EMB" "$OUT"
  SELINF_REPO="${SELINF_REPO:-$HOME/dev/lynceus}" "$PY" -m pytest -q test_selinf.py
  exit
fi

if [ "${1:-}" = public ]; then   # Funnel: https://<the PC's tailnet name>:8443/ -> the PC's 127.0.0.1:8765, from anywhere
  case "${2:-status}" in
    on) ssh lynceus-win "tailscale funnel --bg --https=8443 http://127.0.0.1:8765" ;;
    off) ssh lynceus-win "tailscale funnel --https=8443 off" ;;
    status) ;;
    *) echo "usage: ./test.sh public on|off|status" >&2; exit 1 ;;
  esac
  ssh lynceus-win "tailscale funnel status"; exit
fi

if [ "${1:-}" = stop ]; then
  ssh lynceus-win "powershell -NoProfile -Command \"$kill_pc\"" || true
  pkill -f "$tunnel" || true
  echo stopped; exit 0
fi

# ---- PC: C:\Users\rokob\lod-lite-selinf\ holds the served code (its top-level files), the data (source, work, out),
# job (job_params.json, photos.json, clicks.jsonl), next (staged, built, tested), old (the previous code), deps and logs. Each step is
# PowerShell sent as -EncodedCommand (UTF-16LE base64: nothing to quote through ssh and cmd.exe); what needs cmd
# (vcvars64 + cl, a scheduled task's job) is a .bat the step writes and runs by its path, which has no spaces.
ps() { IFS= read -r -d '' "$1" || true; }   # ps NAME <<'PS' ... PS: NAME = the PowerShell text (bash 3.2-safe)
pc() {   # run PS_HEAD + the arguments (PowerShell) on the PC
  local enc
  enc="$(printf '%s\n' "$PS_HEAD" "$@" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')"
  if [ "${#enc}" -gt 8000 ]; then echo "test.sh: a PC step is ${#enc} chars, over cmd.exe's 8191" >&2; return 1; fi
  ssh -o ConnectTimeout=10 lynceus-win "powershell -NoProfile -NonInteractive -EncodedCommand $enc"
}
ps PS_HEAD <<'PS'
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
trap { "PC error: $_"; $_.InvocationInfo.PositionMessage; exit 1 }   # plain text, not -EncodedCommand's CLIXML
$root = 'C:\Users\rokob\lod-lite-selinf'; $py = 'C:\dev\lynceus\apps\worker\.venv\Scripts\python.exe'
$tar = "$env:SystemRoot\System32\tar.exe"; $curl = "$env:SystemRoot\System32\curl.exe"
function Check($what) { if ($LASTEXITCODE) { throw "$what failed (exit $LASTEXITCODE)" } }
function Clear-Dir([string]$p) {   # removes one of the folders test.sh owns, nothing else
  if ($p -notmatch '^C:\\Users\\rokob\\lod-lite-selinf\\(next|old|deps\\(pybind11|embree|python))$') { throw "refusing to remove '$p'" }
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
}
PS
# Start-Py name dir args = the former scheduled-task script: `python args` in dir as an interactive scheduled task
# (an SSH-spawned process gets no GPU, and the venv's Store Python cannot start from SSH at all); output in logs\<name>.log, then
# "__EXIT__ <code>" and "__DONE__" when it exits. A task cannot delete itself: finished ones are cleared here.
ps PS_START <<'PS'
function Start-Py([string]$Name, [string]$Dir, [string]$PyArgs) {
  Get-ScheduledTask -TaskName 'LodSelinf_*' -ErrorAction SilentlyContinue | Where-Object { $_.State -ne 'Running' } |
    ForEach-Object { cmd /c "schtasks /Delete /TN $($_.TaskName) /F >nul 2>nul" }
  $log = "$root\logs\$Name.log"; $bat = "$root\logs\$Name.bat"; $task = "LodSelinf_$Name"
  Set-Content -LiteralPath $bat -Encoding ASCII -Value (@(
    '@echo off', 'set PYTHONIOENCODING=utf-8', "set SELINF_AUTH=$auth", "cd /d $Dir", "`"$py`" -u $PyArgs > `"$log`" 2>&1",
    "echo __EXIT__ %ERRORLEVEL% >> `"$log`"", "echo __DONE__ >> `"$log`"") -join "`r`n")
  Remove-Item -LiteralPath $log -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $log) { throw "$log is in use: is $task still running?" }
  cmd /c "schtasks /Create /TN $task /TR `"$bat`" /SC ONCE /ST 00:00 /IT /F >nul 2>nul"; Check "schtasks /Create $task"
  try {
    Set-ScheduledTask -TaskName $task -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)) | Out-Null
  } catch { "warning: $task keeps schtasks' default 72 h limit (Set-ScheduledTask failed): $_" }
  cmd /c "schtasks /Run /TN $task >nul 2>nul"; Check "schtasks /Run $task"
  "started $task -> $log"
}
PS
# Wait-Task: a task's cmd.exe holds the folder it ran in (its current directory) until it ends, just after __DONE__.
ps PS_WAIT <<'PS'
function Wait-Task([string]$Name, [int]$Seconds, [string]$Why) {   # until LodSelinf_<Name> is not running
  for ($t = 0; (Get-ScheduledTask -TaskName "LodSelinf_$Name" -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Running' }); $t++) {
    if ($t -ge $Seconds) { throw "LodSelinf_$Name still runs after $Seconds s: $Why" }
    Start-Sleep 1
  }
}
PS
PS_HEAD="$PS_HEAD\$auth = '$LOGIN'"   # LOGIN is checked above: nothing to quote
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if [ "${1:-}" = data ]; then   # tar's stream straight into the PC folder: about 10 GB, no copy on either side
  pc 'New-Item -ItemType Directory -Force -Path $root | Out-Null'
  COPYFILE_DISABLE=1 tar -C "$here" --no-xattrs --exclude .DS_Store --exclude work/numba -cf - source work out |
    ssh lynceus-win "C:\Windows\System32\tar.exe -xf - -C C:/Users/rokob/lod-lite-selinf"
  for d in source work out; do
    n="$(find "$here/$d" -type f -not -name .DS_Store -not -path '*/work/numba/*' | wc -l | tr -d ' ')"
    m="$(pc "(Get-ChildItem -LiteralPath \"\$root\\$d\" -Recurse -File).Count" | tr -d '\r')"
    [ "$n" = "$m" ] || { echo "test.sh: $d has $n files here, $m on the PC" >&2; exit 1; }
    echo "$d: $n files"
  done
  exit
fi

echo "PC: folders, and the build's dependencies (fetched once into C:\\Users\\rokob\\lod-lite-selinf\\deps)"
ps STEP <<'PS'
New-Item -ItemType Directory -Force -Path $root, "$root\job", "$root\logs", "$root\deps" | Out-Null
foreach ($f in 'job_params.json', 'photos.json') {
  if (-not (Test-Path -LiteralPath "$root\job\$f")) { throw "job\$f is missing: the job's frozen parameters and photo list" }
}
if (-not (Test-Path -LiteralPath "$root\out\tileset.json")) { throw "out\tileset.json is missing: run ./test.sh data first" }
foreach ($dep in @(
    @('pybind11', 'https://github.com/pybind/pybind11/archive/refs/tags/v2.13.6.tar.gz', 1),
    @('embree', 'https://github.com/RenderKit/embree/releases/download/v4.4.0/embree-4.4.0.x64.windows.zip', 0),
    @('python', 'https://www.nuget.org/api/v2/package/python/3.11.9', 0))) {
  $name, $url, $strip = $dep; $dir = "$root\deps\$name"
  if ((Get-Content -LiteralPath "$dir.ok" -ErrorAction SilentlyContinue) -eq $url) { continue }
  "fetching $url"
  Clear-Dir $dir; New-Item -ItemType Directory -Path $dir | Out-Null
  & $curl -fsSL -o "$dir.download" $url; Check "downloading $url"
  & $tar -xf "$dir.download" -C $dir "--strip-components=$strip"; Check "unpacking $name"
  Remove-Item -LiteralPath "$dir.download"; Set-Content -LiteralPath "$dir.ok" -Value $url
}
PS
pc "$STEP"

echo "PC: staging this folder's code in C:\\Users\\rokob\\lod-lite-selinf\\next"
(cd "$here" && git ls-files -co --exclude-standard | while read -r f; do if [ -e "$f" ]; then echo "$f"; fi; done |
  COPYFILE_DISABLE=1 tar --no-xattrs -czf "$tmp/next.tgz" -T -)
scp -q "$tmp/next.tgz" lynceus-win:C:/Users/rokob/lod-lite-selinf/next.tgz
ps STEP <<'PS'
Clear-Dir "$root\next"; New-Item -ItemType Directory -Path "$root\next" | Out-Null
& $tar -xzf "$root\next.tgz" -C "$root\next"; Check 'unpacking next.tgz'
Remove-Item -LiteralPath "$root\next.tgz"
PS
pc "$STEP"

echo "PC: building selinf_core (MSVC)"
ps STEP <<'PS'
$d = "$root\deps"; $vc = 'C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat'
Set-Content -LiteralPath "$root\next\build.bat" -Encoding ASCII -Value (@(
  '@echo off', "call `"$vc`"", "cd /d $root\next",
  ("cl /nologo /O2 /std:c++17 /EHsc /bigobj /MD /LD /fp:precise /D_USE_MATH_DEFINES /I$d\pybind11\include " +
   "/I$d\embree\include /I$d\python\tools\include selinf.cpp /link /LIBPATH:$d\python\tools\libs " +
   "/LIBPATH:$d\embree\lib embree4.lib /OUT:selinf_core.cp311-win_amd64.pyd")) -join "`r`n")
& cmd /c "$root\next\build.bat"; Check 'the build'
PS
pc "$STEP" || { echo "test.sh: the PC build failed; the running server was not touched" >&2; exit 1; }

echo "PC: test_selinf.py in next (the scheduled task LodSelinf_selinf-test)"
ps STEP <<'PS'
Start-Py 'selinf-test' "$root\next" '-m pytest -q test_selinf.py'
PS
pc "$PS_START" "$STEP"
ps STEP <<'PS'
$log = "$root\logs\selinf-test.log"
for ($t = 0; -not ((Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue) -match '__DONE__'); $t += 2) {
  if ($t -ge 900) { throw "no __DONE__ in $log after 900 s (an /IT task runs only while rokob is logged on)" }
  Start-Sleep 2
}
$out = Get-Content -LiteralPath $log -Raw -Encoding UTF8; $out
if ($out -notmatch '__EXIT__ 0\b') { exit 1 }
Wait-Task 'selinf-test' 30 'next\ stays in use'
PS
pc "$PS_WAIT" "$STEP" || { echo "test.sh: the PC tests failed; the running server was not touched" >&2; exit 1; }

# stop the server (kill_pc; and one still loading, not yet listening) and wait for its task to end; then the code files
# (the folder's top-level files) -> old, next's -> the folder. The data folders are not touched.
echo "PC: swapping next's code in"
ps STEP <<'PS'
Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" | Where-Object { $_.CommandLine -like "*$root\selinf.py*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Wait-Task 'selinf' 30 'the code is unchanged'
Clear-Dir "$root\old"; New-Item -ItemType Directory -Path "$root\old" | Out-Null
Get-ChildItem -LiteralPath $root -File -Force | Move-Item -Destination "$root\old"
Get-ChildItem -LiteralPath "$root\next" -Force | Move-Item -Destination $root
Remove-Item -LiteralPath "$root\next"
PS
pc "$PS_WAIT" "try { $kill_pc } catch { 'stop: ' + \$_ }" "$STEP" ||
  { echo "test.sh: the swap failed (above). The server is stopped and NOT restarted. The previous code files are in old," >&2
    echo "  the new ones in the folder or still in next: move old's files back into C:\\Users\\rokob\\lod-lite-selinf to go back." >&2; exit 1; }

echo "PC: starting selinf.py (the scheduled task LodSelinf_selinf)"
ps STEP <<'PS'
Start-Py 'selinf' $root "$root\selinf.py"
PS
pc "$PS_START" "$STEP"
pkill -f "$tunnel" || true
ssh -f -N -o ExitOnForwardFailure=yes -L "$tunnel" lynceus-win > /dev/null 2>&1   # detached: must not hold our stdout

echo "loading the survey and models on the PC..."
for _ in $(seq 60); do
  curl -sf -m 3 -u "$LOGIN" http://127.0.0.1:8765/health && echo && break
  sleep 3
done || true
if ! curl -sf -m 3 -o /dev/null -u "$LOGIN" http://127.0.0.1:8765/health; then
  echo "server did not come up; PC log:"; pc 'Get-Content -LiteralPath "$root\logs\selinf.log"' || true
  echo "the previous code is kept in old. To go back: ./test.sh stop; then on the PC move old's files back into" >&2
  echo "  C:\\Users\\rokob\\lod-lite-selinf (replacing the new ones) and start selinf.py again" >&2
  exit 1
fi
echo "PC: the new server answers; removing the previous code (old)"
pc 'Clear-Dir "$root\old"' || echo "test.sh: old is not removed (harmless): see above" >&2

open http://127.0.0.1:8765/
echo "viewer: http://127.0.0.1:8765/ (login ${LOGIN%%:*} / ${LOGIN#*:})  -- alt-click the bridge. Public: ./test.sh public on"
