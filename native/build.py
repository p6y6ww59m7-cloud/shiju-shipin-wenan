from pathlib import Path
import subprocess
import shutil
import plistlib
import os
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'build' / '拾句·视频与文案工作台.app'
CONTENTS = APP / 'Contents'
RES = CONTENTS / 'Resources'
(CONTENTS / 'MacOS').mkdir(parents=True, exist_ok=True)
RES.mkdir(exist_ok=True)
subprocess.run(['swiftc', '-O', str(ROOT / 'native/Launcher.swift'), '-o', str(CONTENTS / 'MacOS/Workbench')], check=True)
destination = RES / 'app'
destination.mkdir(exist_ok=True)
for name in ['server.mjs', 'package.json']:
    shutil.copy2(ROOT / name, destination / name)
for name in ['lib', 'dist', 'video-engine']:
    shutil.copytree(ROOT / name, destination / name, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('.build-tools', 'models', 'dist' if name == 'video-engine' else '.unused', '__pycache__', '*.pyc'))

def clone(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.unlink()
    if subprocess.run(['/bin/cp', '-c', str(source), str(target)], capture_output=True).returncode:
        shutil.copy2(source, target)

runtime = ROOT / 'video-engine'
installed = Path.home() / 'Applications/抖音视频导出助手.app/Contents/Resources/app'
for name in ['native/VideoProbe', 'native/AudioPrepare', 'native/vendor/yt-dlp', 'native/vendor/ffmpeg', 'native/vendor/whisper-cli']:
    source = runtime / name
    if not source.exists():
        source = installed / name
    if not source.exists():
        raise RuntimeError('Missing runtime resource: ' + name + '; run npm run setup:video')
    clone(source, destination / 'video-engine' / name)
models = json.loads((ROOT / 'video-engine/runtime-manifest.json').read_text())['models']
for spec in models:
    name = spec['name']
    source = Path.home() / 'Library/Application Support/抖音视频导出助手/models' / name
    if not source.exists():
        source = installed / 'native/vendor/models' / name
    if not source.exists():
        raise RuntimeError('Missing complete speech model: ' + name)
    digest = hashlib.sha256()
    with source.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    if source.stat().st_size != spec['bytes'] or digest.hexdigest() != spec['sha256']:
        raise RuntimeError('Speech model checksum mismatch: ' + name)
    clone(source, destination / 'video-engine/native/vendor/models' / name)
clone(Path(shutil.which('node')).resolve(), RES / 'node')
icon = Path.home() / 'Applications/抖音视频导出助手.app/Contents/Resources/AppIcon.icns'
if icon.exists():
    shutil.copy2(icon, RES / 'AppIcon.icns')
info = {'CFBundleName': '拾句工作台', 'CFBundleDisplayName': '拾句 · 视频与文案工作台',
        'CFBundleIdentifier': 'local.guanhao.shiju-workbench', 'CFBundleVersion': '1',
        'CFBundleShortVersionString': '2.0.0', 'CFBundleExecutable': 'Workbench',
        'CFBundlePackageType': 'APPL', 'LSMinimumSystemVersion': '13.0',
        'NSHighResolutionCapable': True, 'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True}}
if icon.exists():
    info['CFBundleIconFile'] = 'AppIcon'
with (CONTENTS / 'Info.plist').open('wb') as output:
    plistlib.dump(info, output)
subprocess.run(['codesign', '--force', '--deep', '--sign', '-', str(APP)], check=True)
print(APP)
