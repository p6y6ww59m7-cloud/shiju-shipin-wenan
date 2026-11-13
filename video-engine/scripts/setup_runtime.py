#!/usr/bin/env python3
"""Restore the pinned native speech runtime and verified model files on macOS."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
import venv

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / 'runtime-manifest.json').read_text())
TOOLS = ROOT / '.build-tools'
MODEL_DIR = Path(os.environ.get('DOUYIN_EXPORT_DATA', str(Path.home() / 'Library/Application Support/抖音视频导出助手'))) / 'models'


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def digest(file):
    result = hashlib.sha256()
    with file.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def valid_model(file, model):
    return file.is_file() and file.stat().st_size == model['bytes'] and digest(file) == model['sha256']


def get_cmake():
    installed = shutil.which('cmake')
    if installed:
        return Path(installed)
    environment = TOOLS / 'cmake-env'
    candidate = environment / 'bin/cmake'
    if not candidate.exists():
        venv.create(environment, with_pip=True)
        run([environment / 'bin/python', '-m', 'pip', 'install', 'cmake==' + MANIFEST['cmakeFallbackVersion']])
    return candidate


def build_engine(force=False):
    binary = ROOT / 'native/vendor/whisper-cli'
    if binary.exists() and not force:
        run([binary, '--version'])
        print('Native speech engine is present; use --rebuild to rebuild it.', flush=True)
        return
    source = TOOLS / 'whisper.cpp'
    spec = MANIFEST['whisper']
    if not source.exists():
        run(['git', 'clone', '--depth', '1', '--branch', spec['version'], spec['repository'], source])
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != spec['commit']:
        raise RuntimeError('whisper.cpp checkout differs from the pinned commit; use a clean .build-tools/whisper.cpp directory.')
    cmake = get_cmake()
    build = TOOLS / 'whisper-build'
    run([cmake, '-S', source, '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF',
         '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=ON', '-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON'])
    run([cmake, '--build', build, '--config', 'Release', '--target', 'whisper-cli', '-j', min(os.cpu_count() or 4, 8)])
    binary.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(build / 'bin/whisper-cli', binary)
    shutil.copy2(source / 'LICENSE', binary.parent / 'whisper-LICENSE')


def setup_downloaders(verify_only=False):
    for spec in MANIFEST['downloadTools']:
        destination = ROOT / 'native/vendor' / spec['name']
        if valid_model(destination, spec):
            print(spec['name'] + ': SHA256 verified.', flush=True)
            continue
        if verify_only:
            raise RuntimeError('Missing or invalid download engine: ' + spec['name'])
        pending = destination.with_suffix('.part')
        run(['curl', '-fL', '--retry', '3', '--connect-timeout', '20', '--max-time', '600', spec['url'], '-o', pending])
        if not valid_model(pending, spec):
            pending.unlink(missing_ok=True)
            raise RuntimeError('Download engine checksum mismatch: ' + spec['name'])
        pending.chmod(0o755)
        pending.replace(destination)


def download_model(model, workers):
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    destination = MODEL_DIR / model['name']
    if valid_model(destination, model):
        print(model['name'] + ': verified existing SHA256.', flush=True)
        return
    parts = TOOLS / ('download-' + model['name'])
    parts.mkdir(parents=True, exist_ok=True)
    size = model['bytes']
    chunk_size = 8 * 1024 * 1024
    ranges = [(start, min(start + chunk_size, size) - 1) for start in range(0, size, chunk_size)]

    def fetch(bounds):
        start, end = bounds
        length = end - start + 1
        part = parts / str(start)
        if part.exists() and part.stat().st_size == length:
            return length
        # Incomplete files are never mistaken for completed chunks.
        pending = part.with_suffix('.part')
        for trial in range(6):
            command = ['curl', '--http1.1', '-L', '--fail', '--silent', '--show-error',
                       '--connect-timeout', '15', '--max-time', '120', '--speed-time', '25', '--speed-limit', '20000',
                       '--range', f'{start}-{end}', '--max-filesize', str(length), '--output', str(pending), model['url']]
            result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if result.returncode == 0 and pending.exists() and pending.stat().st_size == length:
                pending.replace(part)
                return length
            time.sleep(min(trial + 1, 5))
        raise RuntimeError('Download failed: ' + model['name'] + ' at byte ' + str(start))

    print('Downloading ' + model['name'] + f' ({size / 1024 / 1024:.1f} MiB)', flush=True)
    completed = 0
    last = -5
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        for future in concurrent.futures.as_completed([executor.submit(fetch, bounds) for bounds in ranges]):
            completed += future.result()
            percent = completed * 100 // size
            if percent >= last + 5 or completed == size:
                print(f'{model["name"]}: {percent}%', flush=True)
                last = percent
    temporary = destination.with_suffix('.assembling')
    with temporary.open('wb') as out:
        for start, _ in ranges:
            with (parts / str(start)).open('rb') as source:
                shutil.copyfileobj(source, out, length=1024 * 1024)
    if not valid_model(temporary, model):
        temporary.unlink(missing_ok=True)
        raise RuntimeError('Model SHA256 mismatch. Download cache was retained for diagnosis; remove its download-* directory before retrying.')
    temporary.replace(destination)
    shutil.rmtree(parts)
    print(model['name'] + ': SHA256 verified.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-only', action='store_true', help='Check existing engine, helpers and model hashes without installing anything.')
    parser.add_argument('--rebuild', action='store_true', help='Rebuild whisper-cli from the pinned source commit.')
    parser.add_argument('--no-models', action='store_true', help='Build the engine and helpers without downloading model weights.')
    parser.add_argument('--workers', type=int, default=8, choices=range(1, 17), metavar='1..16')
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        parser.error('This desktop application requires macOS.')
    if args.verify_only:
        setup_downloaders(True)
        for relative in ['native/vendor/whisper-cli', 'native/AudioPrepare', 'native/VideoProbe']:
            if not (ROOT / relative).is_file():
                raise RuntimeError('Missing runtime file: ' + relative)
        for model in MANIFEST['models']:
            if not valid_model(MODEL_DIR / model['name'], model):
                raise RuntimeError('Missing or invalid model: ' + model['name'])
        print('Runtime and both model hashes verified.', flush=True)
        return
    for command in ['git', 'swiftc', 'curl']:
        if not shutil.which(command):
            parser.error('Required tool missing: ' + command + '. Install Xcode Command Line Tools first.')
    TOOLS.mkdir(exist_ok=True)
    setup_downloaders()
    build_engine(args.rebuild)
    for name in ['AudioPrepare', 'VideoProbe']:
        run(['swiftc', '-parse-as-library', '-O', ROOT / f'native/{name}.swift', '-o', ROOT / f'native/{name}'])
    if not args.no_models:
        for model in MANIFEST['models']:
            download_model(model, args.workers)
    print('Setup completed. Run npm test, then npm run build:mac.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
