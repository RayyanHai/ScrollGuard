"""Build and verify the two Chrome-extension downloads using Python's standard library."""
import hashlib
import json
import os
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent.parent
RUNTIME_DIRS = ('background', 'content', 'challenge', 'dashboard', 'icons', 'lib', 'options', 'popup')


def main():
    manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    version = manifest['version']
    assert version == json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version'], 'Version mismatch'
    if os.environ.get('GITHUB_REF_TYPE') == 'tag':
        assert os.environ['GITHUB_REF_NAME'] == f'v{version}', 'Tag must match the manifest version'

    files = [ROOT / 'manifest.json', ROOT / 'README.md']
    files.extend(ROOT / 'docs' / f'INSTALL-{platform}.md' for platform in ('windows', 'macos'))
    for directory in RUNTIME_DIRS:
        files.extend(sorted(path for path in (ROOT / directory).rglob('*') if path.is_file()))
    output = ROOT / 'dist'
    output.mkdir(exist_ok=True)
    checksums = []
    for platform in ('windows', 'macos'):
        archive = output / f'scrollguard-v{version}-{platform}.zip'
        expected = {path.relative_to(ROOT).as_posix(): path.read_bytes() for path in files}
        expected['INSTALL.md'] = (ROOT / 'docs' / f'INSTALL-{platform}.md').read_bytes()
        with ZipFile(archive, 'w', ZIP_DEFLATED) as package:
            for name, data in expected.items():
                package.writestr(name, data)
        with ZipFile(archive) as package:
            assert package.testzip() is None, f'Corrupt archive: {archive.name}'
            assert set(package.namelist()) == set(expected), 'Unexpected packaged files'
            for name, data in expected.items():
                assert package.read(name) == data, f'Packaged content mismatch: {name}'
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        checksums.append(f'{digest}  {archive.name}\n')
        print(f'Verified {archive.name}: {len(expected)} files, {archive.stat().st_size} bytes')
    (output / 'SHA256SUMS.txt').write_text(''.join(checksums), encoding='utf-8')


if __name__ == '__main__':
    main()
