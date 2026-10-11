#!/usr/bin/env bash
# CLI-driven integration check, always closes only its own browser and preview server.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/output/playwright"
PORT="${KPL_PREVIEW_PORT:-8176}"
SESSION="jdg-check-$$"
command -v npx >/dev/null 2>&1 || { echo 'npx is required'; exit 1; }
mkdir -p "$OUT"
PW=(npx --yes --package @playwright/cli playwright-cli -s="$SESSION")
SERVER=''
cleanup(){
  "${PW[@]}" close >> "$OUT/cleanup.log" 2>&1 || true
  if [[ -n "$SERVER" ]]; then kill "$SERVER" 2>/dev/null || true; fi
}
trap cleanup EXIT
SERVER=$(python3 - "$ROOT" "$PORT" <<'PY'
import subprocess,sys,pathlib,socket
root=pathlib.Path(sys.argv[1]);port=int(sys.argv[2]);s=socket.socket();s.bind(('127.0.0.1',port));s.close()
p=subprocess.Popen([sys.executable,'-m','http.server',str(port),'--bind','127.0.0.1','--directory',str(root)],stdin=subprocess.DEVNULL,stdout=open(root/'output/playwright/server.log','a'),stderr=subprocess.STDOUT,start_new_session=True)
print(p.pid)
PY
)
python3 - "$ROOT" "$PORT" <<'PY'
import sys,pathlib,json
r=pathlib.Path(sys.argv[1]);port=sys.argv[2];code=(r/'tests/browser_check.js').read_text()
code=code.replace("const ROOT='/Users/kuangqie/Documents/VibeCoding/KPL/reports/jdg-deep-research/output/playwright/';",'const ROOT='+json.dumps(str(r/'output/playwright')+'/')+';')
code=code.replace('http://127.0.0.1:8176/',f'http://127.0.0.1:{port}/')
(r/'output/playwright/browser_check.runtime.js').write_text(code)
PY
cd "$OUT"
sleep 1
"${PW[@]}" open "http://127.0.0.1:$PORT/jdg_mid_deep_research.html" > browser-open.log 2>&1
"${PW[@]}" snapshot > initial-snapshot.log 2>&1
"${PW[@]}" run-code --filename "$OUT/browser_check.runtime.js" > browser-check.log 2>&1
python3 - <<'PY'
import pathlib,json
p=pathlib.Path('browser-check.log');text=p.read_text()
assert '### Result\n' in text,text[:1000]
r=json.loads(text.split('### Result\n',1)[1].split('\n### Ran',1)[0])
assert r.get('status')=='PASS' and all(x['pass'] for x in r['checks']),r
pathlib.Path('browser-results.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n')
print('PASS:',r['totalChecks'],'browser assertions; cleanup runs immediately.')
PY
