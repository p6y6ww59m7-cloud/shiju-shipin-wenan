"""Install the desktop entry and user LaunchAgent without replacing existing work data."""
from pathlib import Path
import json
import os
import plistlib
import shutil
import subprocess
import urllib.request
import time

ROOT = Path(__file__).resolve().parents[1]
HOME_DIR = Path.home()
label = 'local.shiju.copy-workbench'
domain = 'gui/' + str(os.getuid())

def running(command):
    return subprocess.run(['pgrep', '-f', command], capture_output=True, text=True).returncode == 0

if running(r'^/Users/.*/Applications/拾句·视频与文案工作台.app/Contents/MacOS/Workbench'):
    raise SystemExit('请先退出拾句工作台桌面窗口，再执行安装。数据和后台服务会保留。')
try:
    with urllib.request.urlopen('http://127.0.0.1:43828/api/state', timeout=2) as response:
        state = json.load(response)
    if state.get('activeAnalysis'):
        raise SystemExit('当前正在评分，请完成或取消后再安装。')
    with urllib.request.urlopen('http://127.0.0.1:43828/api/media/state', timeout=2) as response:
        media = json.load(response)
    if any(a.get('status') in ['queued', 'opening', 'waiting', 'downloading', 'cancelling'] or (a.get('transcriptStatus') or {}).get('status') in ['queued', 'extracting', 'recognizing', 'writing', 'cancelling'] for a in media.get('assets', [])):
        raise SystemExit('当前有视频或转写任务，请完成或取消后再安装。')
except (OSError, ValueError):
    pass

subprocess.run(['python3', str(ROOT / 'native/build.py')], check=True)
app = HOME_DIR / 'Applications/拾句·视频与文案工作台.app'
app.parent.mkdir(exist_ok=True)
subprocess.run(['ditto', str(ROOT / 'build/拾句·视频与文案工作台.app'), str(app)], check=True)
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
link = HOME_DIR / 'Desktop/拾句·视频与文案工作台.app'
if not link.exists() and not link.is_symlink():
    link.symlink_to(app)

data = ROOT / 'data'
data.mkdir(exist_ok=True)
node = shutil.which('node')
if not node:
    raise SystemExit('请安装 Node.js 22 或以上版本。')
env = {'PATH': str(HOME_DIR / '.local/bin') + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'}
codex = Path('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
if codex.exists():
    env['CODEX_CLI'] = str(codex)
if shutil.which('lark-cli'):
    env['LARK_CLI'] = shutil.which('lark-cli')
agent = {'Label': label, 'ProgramArguments': [str(Path(node).resolve()), str(ROOT / 'server.mjs')],
         'WorkingDirectory': str(ROOT), 'EnvironmentVariables': env, 'RunAtLoad': True,
         'KeepAlive': True, 'ThrottleInterval': 5,
         'StandardOutPath': str(data / 'service.log'), 'StandardErrorPath': str(data / 'service-error.log')}
agent_path = HOME_DIR / 'Library/LaunchAgents' / (label + '.plist')
agent_path.parent.mkdir(parents=True, exist_ok=True)
with agent_path.open('wb') as output:
    plistlib.dump(agent, output)
subprocess.run(['launchctl', 'bootout', domain + '/' + label], capture_output=True)
for attempt in range(30):
    loaded = subprocess.run(['launchctl', 'bootstrap', domain, str(agent_path)], capture_output=True, text=True)
    if loaded.returncode == 0:
        break
    # launchd can still be removing the previous service immediately after bootout.
    time.sleep(0.3)
else:
    raise SystemExit('后台启动未成功：' + loaded.stderr.strip())
for attempt in range(40):
    try:
        with urllib.request.urlopen('http://127.0.0.1:43828/api/health', timeout=1) as response:
            if json.load(response).get('app') == 'shiju-workbench':
                break
    except (OSError, ValueError):
        pass
    time.sleep(0.25)
else:
    raise SystemExit('后台服务未就绪，请查看 data/service-error.log。原数据未更改。')
print('已安装桌面入口：' + str(link))
print('原有工作数据继续保存在：' + str(data))
