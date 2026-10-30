#!/usr/bin/env bash
# Try selective inference in the lod-lite viewer:
#   ./test.sh        PC: copy this folder, build selinf_core (MSVC) and run test_selinf.py there; then swap it in for
#                    the running server, start selinf.py (GPU), tunnel it to 127.0.0.1:8765, open the viewer
#   ./test.sh stop   stop the PC server and the tunnel
#   ./test.sh test   Mac: fetch pybind11 + Embree headers (once), build selinf_core, run test_selinf.py
# In the viewer: alt-click (option-click) the bridge.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
LOD="${LOD:-$HOME/dev/lod-lite}"
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

if [ "${1:-}" = stop ]; then
  ssh lynceus-win "powershell -NoProfile -Command \"$kill_pc\"" || true
  pkill -f "$tunnel" || true
  echo stopped; exit 0
fi

# ---- PC: C:\Users\rokob\selinf\ holds next (staged, built, tested), code (served), deps, logs and work. Each step is
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
$root = 'C:\Users\rokob\selinf'; $py = 'C:\dev\lynceus\apps\worker\.venv\Scripts\python.exe'
$tar = "$env:SystemRoot\System32\tar.exe"; $curl = "$env:SystemRoot\System32\curl.exe"
function Check($what) { if ($LASTEXITCODE) { throw "$what failed (exit $LASTEXITCODE)" } }
function Clear-Dir([string]$p) {   # removes one of the folders test.sh owns, nothing else
  if ($p -notmatch '^C:\\Users\\rokob\\selinf\\(next|old|deps\\(pybind11|embree|python))$') { throw "refusing to remove '$p'" }
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
}
PS
# Start-Py name dir args = the former scheduled-task script: `python args` in dir as an interactive scheduled task
# (an SSH-spawned process gets no GPU, and the venv's Store Python cannot start from SSH at all); output in logs\<name>.log, then
# "__EXIT__ <code>" and "__DONE__" when it exits. A task cannot delete itself: finished ones are cleared here.
ps PS_START <<'PS'
function Start-Py([string]$Name, [string]$Dir, [string]$PyArgs) {
  Get-ScheduledTask -TaskName 'LynceusSelInf_*' -ErrorAction SilentlyContinue | Where-Object { $_.State -ne 'Running' } |
    ForEach-Object { cmd /c "schtasks /Delete /TN $($_.TaskName) /F >nul 2>nul" }
  $log = "$root\logs\$Name.log"; $bat = "$root\logs\$Name.bat"; $task = "LynceusSelInf_$Name"
  Set-Content -LiteralPath $bat -Encoding ASCII -Value (@(
    '@echo off', 'set PYTHONIOENCODING=utf-8', "cd /d $Dir", "`"$py`" -u $PyArgs > `"$log`" 2>&1",
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
function Wait-Task([string]$Name, [int]$Seconds, [string]$Why) {   # until LynceusSelInf_<Name> is not running
  for ($t = 0; (Get-ScheduledTask -TaskName "LynceusSelInf_$Name" -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Running' }); $t++) {
    if ($t -ge $Seconds) { throw "LynceusSelInf_$Name still runs after $Seconds s: $Why" }
    Start-Sleep 1
  }
}
PS
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "PC: folders, and the build's dependencies (fetched once into C:\\Users\\rokob\\selinf\\deps)"
ps STEP <<'PS'
New-Item -ItemType Directory -Force -Path $root, "$root\work", "$root\logs", "$root\deps" | Out-Null
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

echo "PC: staging this folder in C:\\Users\\rokob\\selinf\\next"
COPYFILE_DISABLE=1 tar -C "$here" --no-xattrs --exclude build --exclude __pycache__ --exclude .pytest_cache \
  --exclude 'selinf_core.*' -czf "$tmp/next.tgz" .
scp -q "$tmp/next.tgz" lynceus-win:C:/Users/rokob/selinf/next.tgz
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

echo "PC: test_selinf.py in next (the scheduled task LynceusSelInf_selinf-test)"
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

# stop the server (kill_pc; and one still loading, not yet listening) and wait for its task to end; then code -> old,
# next -> code (a rename fails whole while anything holds the folder; code then stays as it was)
echo "PC: swapping next in for code"
ps STEP <<'PS'
Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" | Where-Object { $_.CommandLine -like "*$root\code\selinf.py*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Wait-Task 'selinf' 30 'code is unchanged'
Clear-Dir "$root\old"
if (Test-Path -LiteralPath "$root\code") { Rename-Item -LiteralPath "$root\code" -NewName old }
try { Rename-Item -LiteralPath "$root\next" -NewName code } catch { if (Test-Path "$root\old") { Rename-Item "$root\old" code }; throw }
PS
pc "$PS_WAIT" "try { $kill_pc } catch { 'stop: ' + \$_ }" "$STEP" ||
  { echo "test.sh: the swap failed (above). The server is stopped and the old one is NOT restarted; the new build waits in next." >&2
    echo "  Back to the old build: if code is gone, Rename-Item C:\\Users\\rokob\\selinf\\old code; then start selinf.py from it." >&2; exit 1; }

echo "PC: starting selinf.py from code (the scheduled task LynceusSelInf_selinf)"
ps STEP <<'PS'
Start-Py 'selinf' "$root\code" "$root\code\selinf.py"
PS
pc "$PS_START" "$STEP"
pkill -f "$tunnel" || true
ssh -f -N -o ExitOnForwardFailure=yes -L "$tunnel" lynceus-win > /dev/null 2>&1   # detached: must not hold our stdout

echo "loading the survey and models on the PC..."
for _ in $(seq 60); do
  curl -s -m 3 http://127.0.0.1:8765/health && echo && break
  sleep 3
done || true
if ! curl -s -m 3 -o /dev/null http://127.0.0.1:8765/health; then
  echo "server did not come up; PC log:"; pc 'Get-Content -LiteralPath "$root\logs\selinf.log"' || true
  echo "the previous build is kept in old. To go back: ./test.sh stop; then on the PC remove C:\\Users\\rokob\\selinf\\code and run" >&2
  echo "  Rename-Item C:\\Users\\rokob\\selinf\\old code     (and start selinf.py again)" >&2
  exit 1
fi
echo "PC: the new server answers; removing the previous build (old)"
pc 'Clear-Dir "$root\old"' || echo "test.sh: old is not removed (harmless): see above" >&2

if curl -s -m 2 -o /dev/null http://127.0.0.1:8000/viewer.html; then
  open http://127.0.0.1:8000/viewer.html
else
  (cd "$LOD" && nohup uv run lod.py serve > /tmp/lod-serve.log 2>&1 &)   # opens the viewer itself
fi
echo "viewer: http://127.0.0.1:8000/viewer.html  -- alt-click the bridge"
