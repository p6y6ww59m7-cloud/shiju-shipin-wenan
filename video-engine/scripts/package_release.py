#!/usr/bin/env python3
"""Create restorable split release assets without adding binaries to Git history."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / 'package.json').read_text())['version']
OUTPUT = ROOT / '.build-tools/github-release'
APP = ROOT / 'dist/抖音视频导出助手.app'
NAME = f'douyin-exporter-v{VERSION}-macos-arm64'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chunk-mib', type=int, default=1536, help='Size of each release part in MiB (16..1536).')
    parser.add_argument('--reuse-archive', action='store_true', help='Split the already generated archive for this version without compressing the app again.')
    args = parser.parse_args()
    if not 16 <= args.chunk_mib <= 1536:
        parser.error('--chunk-mib must be between 16 and 1536')
    chunk = args.chunk_mib * 1024 * 1024
    OUTPUT.mkdir(parents=True, exist_ok=True)
    archive = OUTPUT / (NAME + '.zip')
    if not args.reuse_archive:
        subprocess.run(['/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(APP), str(archive)], check=True)
    elif not archive.is_file():
        parser.error('No archive for this version; omit --reuse-archive to create it first.')
    pieces = []
    with archive.open('rb') as source:
        i = 1
        while True:
            block = source.read(1024 * 1024)
            if not block:
                break
            piece = OUTPUT / f'{NAME}.zip.part{i:02}'
            digest = hashlib.sha256()
            count = 0
            with piece.open('wb') as target:
                while block and count < chunk:
                    target.write(block)
                    digest.update(block)
                    count += len(block)
                    if count == chunk:
                        break
                    block = source.read(min(1024 * 1024, chunk - count))
            pieces.append({'name': piece.name, 'bytes': count, 'sha256': digest.hexdigest()})
            print(f'{piece.name}: {count} bytes', flush=True)
            i += 1
    manifest = {'version': VERSION, 'archive': archive.name, 'application': APP.name, 'chunkBytes': chunk,
                'platform': 'macOS arm64', 'testedHardware': 'Apple M5 Max', 'parts': pieces}
    (OUTPUT / 'release-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    shutil.copy2(ROOT / 'scripts/restore_release.py', OUTPUT / 'restore_release.py')
    (OUTPUT / 'SHA256SUMS.txt').write_text(''.join(p['sha256'] + '  ' + p['name'] + '\n' for p in pieces))
    print('Split release assets ready in ' + str(OUTPUT), flush=True)


if __name__ == '__main__':
    main()
