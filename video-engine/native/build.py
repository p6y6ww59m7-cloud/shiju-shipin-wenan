from pathlib import Path
import subprocess
import shutil
import plistlib
import hashlib

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'dist' / '抖音视频导出助手.app'
CONTENTS = APP / 'Contents'
MACOS = CONTENTS / 'MacOS'
RES = CONTENTS / 'Resources'
MACOS.mkdir(parents=True, exist_ok=True)
RES.mkdir(parents=True, exist_ok=True)
subprocess.run(['swiftc','-parse-as-library','-O',str(ROOT/'native/VideoProbe.swift'),'-o',str(ROOT/'native/VideoProbe')],check=True)
subprocess.run(['swiftc','-parse-as-library','-O',str(ROOT/'native/AudioPrepare.swift'),'-o',str(ROOT/'native/AudioPrepare')],check=True)
subprocess.run(['swiftc','-O',str(ROOT/'native/Launcher.swift'),'-o',str(MACOS/'DouyinExporter')],check=True)
destination = RES / 'app'
destination.mkdir(exist_ok=True)
for stale in destination.glob('*.mjs'):
    stale.unlink()
for name in ['server.mjs','engine-session.mjs','browser.mjs','core.mjs','platforms.mjs','workflow.mjs','cache.mjs','proxy-discovery.mjs','downloader.mjs','transcription.mjs','package.json']:
    shutil.copy2(ROOT/name,destination/name)
shutil.copytree(ROOT/'public',destination/'public',dirs_exist_ok=True)
(destination/'native').mkdir(exist_ok=True)
shutil.copy2(ROOT/'native/VideoProbe',destination/'native/VideoProbe')
shutil.copy2(ROOT/'native/AudioPrepare',destination/'native/AudioPrepare')
shutil.copytree(ROOT/'native/vendor',destination/'native/vendor',dirs_exist_ok=True)
model_name = 'ggml-large-v3.bin'
model_source = Path.home()/'Library/Application Support/抖音视频导出助手/models'/model_name
model_hash = hashlib.sha256()
with model_source.open('rb') as source:
    for block in iter(lambda: source.read(1024*1024), b''):
        model_hash.update(block)
assert model_hash.hexdigest() == '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2', 'Speech model checksum mismatch'
model_target = destination/'native/vendor/models'/model_name
model_target.parent.mkdir(exist_ok=True)
(model_target.parent/'ggml-large-v3-turbo-q5_0.bin').unlink(missing_ok=True)
shutil.copy2(model_source,model_target)
vad_name='ggml-silero-v6.2.0.bin'
vad_source=model_source.parent/vad_name
assert hashlib.sha256(vad_source.read_bytes()).hexdigest() == '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987', 'Voice detection model checksum mismatch'
shutil.copy2(vad_source,model_target.parent/vad_name)
node = Path(shutil.which('node')).resolve()
shutil.copy2(node,RES/'node')
node_license = node.parent.parent/'LICENSE'
if node_license.exists():
    shutil.copy2(node_license,RES/'Node-LICENSE')
iconset = ROOT/'dist'/'AppIcon.iconset'
iconset.mkdir(exist_ok=True)
icon1024 = ROOT/'dist'/'AppIcon.png'
subprocess.run(['swift',str(ROOT/'native/Icon.swift'),str(icon1024)],check=True)
for size in [16,32,128,256,512]:
    for scale in [1,2]:
        target = iconset/f'icon_{size}x{size}{"@2x" if scale==2 else ""}.png'
        subprocess.run(['sips','-z',str(size*scale),str(size*scale),str(icon1024),'--out',str(target)],check=True,capture_output=True)
subprocess.run(['iconutil','-c','icns',str(iconset),'-o',str(RES/'AppIcon.icns')],check=True)
info = {'CFBundleName':'抖音视频导出助手','CFBundleDisplayName':'视频导出助手',
    'CFBundleIdentifier':'local.guanhao.douyin-exporter',
    'CFBundleVersion':'8','CFBundleShortVersionString':'1.6.1',
    'CFBundleExecutable':'DouyinExporter','CFBundlePackageType':'APPL','CFBundleIconFile':'AppIcon',
    'LSMinimumSystemVersion':'13.0','NSHighResolutionCapable':True,
    'NSAppTransportSecurity':{'NSAllowsLocalNetworking':True,'NSAllowsArbitraryLoadsInWebContent':True}}
with (CONTENTS/'Info.plist').open('wb') as f: plistlib.dump(info,f)
subprocess.run(['codesign','--force','--deep','--sign','-',str(APP)],check=True)
print(APP)
