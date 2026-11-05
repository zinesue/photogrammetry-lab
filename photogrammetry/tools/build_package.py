"""Build a clean portable release. Build products and tools remain outside Pack."""
import argparse
import importlib.metadata
import zipfile
import json
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / 'work' / 'packaging'
PACK = WORK / 'public' / 'Pack'


def notices():
    parts = ['드론 사진으로 체험하는 사진측량\n오프라인 Windows 실행본\n\n아래 구성요소를 포함합니다.\n']
    base = Path(sys.base_prefix)
    files = [base / 'LICENSE.txt']
    for distribution in ('pillow', 'pyinstaller', 'pyinstaller-hooks-contrib'):
        package = importlib.metadata.distribution(distribution)
        for item in package.files or []:
            if any(word in item.name.lower() for word in ('license', 'copying')) and item.suffix.lower() in ('', '.txt', '.md'):
                files.append(Path(package.locate_file(item)))
    for path in dict.fromkeys(files):
        if path.is_file():
            parts.append('\n' + '=' * 64 + '\n' + path.name + '\n' + '=' * 64 + '\n' + path.read_text(encoding='utf-8', errors='replace'))
    target = WORK / 'NOTICE.txt'; target.write_text('\n'.join(parts), encoding='utf-8')
    return target


def main():
    parser = argparse.ArgumentParser(description='Build a Windows release with synthetic data only.')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'dist')
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    source = ROOT / 'examples' / 'synthetic'
    settings = json.loads((source / 'project.json').read_text(encoding='utf-8'))
    if settings['crs'] != 'LOCAL_SYNTHETIC_METRES':
        raise ValueError('Public builds require the synthetic example.')
    WORK.mkdir(parents=True, exist_ok=True)
    if PACK.exists() and any(PACK.iterdir()):
        raise ValueError('The public staging folder is not empty. Move it aside before rebuilding: ' + str(PACK))
    PACK.mkdir(parents=True, exist_ok=True)
    notice = notices()
    version = WORK / 'version.txt'
    version.write_text("""VSVersionInfo(
 ffi=FixedFileInfo(filevers=(1,0,0,0),prodvers=(1,0,0,0),mask=0x3f,flags=0,OS=0x40004,fileType=1,subtype=0,date=(0,0)),
 kids=[StringFileInfo([StringTable('041204b0',[
  StringStruct('FileDescription','드론 사진으로 체험하는 사진측량'),
  StringStruct('ProductName','사진측량 실습'),StringStruct('FileVersion','1.0.0'),
  StringStruct('ProductVersion','1.0.0'),StringStruct('OriginalFilename','사진측량실습.exe')])]),
  VarFileInfo([VarStruct('Translation',[1042,1200])])])""", encoding='utf-8')
    spec = WORK / 'portable.spec'
    spec.write_text(f"""# -*- mode: python ; coding: utf-8 -*-
a=Analysis([{str(ROOT/'tools/portable_app.py')!r}],pathex=[{str(ROOT)!r}],
 binaries=[],datas=[({str(ROOT/'web')!r},'web'),({str(notice)!r},'.')],
 hiddenimports=['PIL.JpegImagePlugin','PIL.PngImagePlugin'],hookspath=[],hooksconfig={{}},runtime_hooks=[],
 excludes=['numpy','matplotlib','pandas','scipy','IPython','pytest'],noarchive=False)
pyz=PYZ(a.pure)
exe=EXE(pyz,a.scripts,a.binaries,a.datas,[],name='사진측량실습',debug=False,
 bootloader_ignore_signals=False,strip=False,upx=False,console=False,
 version={str(version)!r},disable_windowed_traceback=True)
""", encoding='utf-8')
    import PyInstaller.__main__
    PyInstaller.__main__.run(['--noconfirm', '--clean', '--distpath', str(WORK/'dist'), '--workpath', str(WORK/'build'), str(spec)])
    # Use the known synthetic example regardless of the active classroom configuration.
    data = PACK / '데이터'
    data.mkdir()
    for name in ('SYNTH_A.PNG', 'SYNTH_B.PNG', 'cam.txt', 'eo.txt', 'checkpoints.json'):
        shutil.copy2(source / name, data / name)
    settings['data_directory'] = '.'
    (data / 'project.json').write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding='utf-8')
    shutil.copy2(source / 'README.md', data / 'README.md')
    shutil.copy2(WORK / 'dist/사진측량실습.exe', PACK / '사진측량실습.exe')
    shutil.copy2(ROOT / '사용안내.txt', PACK / '실행안내.txt')
    shutil.copy2(notice, PACK / 'THIRD_PARTY_NOTICES.txt')
    shutil.copy2(ROOT.parent / 'docs/CLASSROOM_DATA.md', PACK / '수업자료연결.md')
    files = [p for p in PACK.rglob('*') if p.is_file()]
    forbidden = [p for p in files if p.suffix.lower() in ('.py', '.pyc', '.log', '.tmp', '.spec') or '.cache' in p.parts or '__pycache__' in p.parts]
    if forbidden:
        raise RuntimeError(f'배포본에 불필요한 파일이 있습니다: {forbidden}')
    release = args.output_dir / 'photogrammetry-v1.0.0-windows-synthetic.zip'
    with zipfile.ZipFile(release, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(files):
            archive.write(path, path.relative_to(PACK.parent).as_posix())
    print(json.dumps({'release': str(release), 'files': len(files), 'bytes': release.stat().st_size}, ensure_ascii=False))


if __name__ == '__main__':
    main()
