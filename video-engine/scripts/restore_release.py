#!/usr/bin/env python3
"""Verify and restore a split application backup downloaded from GitHub Releases."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=Path(__file__).resolve().parent, help='Directory containing release-manifest.json and all zip.part* files.')
    parser.add_argument('--output', type=Path, help='Destination directory. Defaults to ./restored-app; does not replace an installed application.')
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    directory = args.directory.resolve()
    manifest = json.loads((directory / 'release-manifest.json').read_text())
    pieces = []
    for item in manifest['parts']:
        if Path(item['name']).name != item['name']:
            raise ValueError('Invalid part filename')
        file = directory / item['name']
        if file.stat().st_size != item['bytes']:
            raise ValueError('Incomplete part: ' + item['name'])
        digest = hashlib.sha256()
        with file.open('rb') as source:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(block)
        if digest.hexdigest() != item['sha256']:
            raise ValueError('SHA256 mismatch: ' + item['name'])
        pieces.append(file)
        print('Verified ' + item['name'], flush=True)
    if args.verify_only:
        return
    output = (args.output or directory / 'restored-app').resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError('Choose an empty output directory; existing files are never overwritten.')
    output.mkdir(parents=True, exist_ok=True)
    archive = directory / (Path(manifest['archive']).name + '.restoring')
    with archive.open('xb') as target:
        for file in pieces:
            with file.open('rb') as source:
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    target.write(block)
    try:
        subprocess.run(['/usr/bin/ditto', '-x', '-k', str(archive), str(output)], check=True)
        app = output / manifest['application']
        subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    finally:
        archive.unlink(missing_ok=True)
    print('Restored application: ' + str(app), flush=True)
    print('The backup is restored to a separate folder; your installed application and user data were not changed.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
