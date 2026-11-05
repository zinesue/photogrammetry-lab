"""Loopback-only local app. The original survey data are read-only."""
import argparse
import csv
import io
import hashlib
import json
import mimetypes
import os
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit, parse_qs

from photogrammetry import Project

WEB_ROOT = Path(__file__).resolve().parent / 'web'
ROOT = Path(os.environ.get('STEREO_PRACTICE_ROOT', Path(__file__).resolve().parent)).resolve()
STATE_ROOT = Path(os.environ['STEREO_PRACTICE_STATE']).resolve() if os.environ.get('STEREO_PRACTICE_STATE') else None
PROJECT = Project(ROOT)
SESSION = (STATE_ROOT or ROOT) / 'measurements.json'
LOCK = threading.RLock()
AUTO_REFRESH = True
LAST_SCAN = 0


def source_stamp():
    settings = json.loads((ROOT/'project.json').read_text(encoding='utf-8-sig'))
    folder = (ROOT/settings['data_directory']).resolve()
    if not folder.is_relative_to(ROOT):
        raise ValueError('자료 폴더는 작업 폴더 안에 있어야 합니다.')
    files = [ROOT/'project.json',folder/'cam.txt',folder/'eo.txt']
    files.extend(sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in ('.jpg','.jpeg','.png')))
    return tuple((str(p),p.stat().st_size,p.stat().st_mtime_ns) for p in files)


SOURCE_STAMP = source_stamp()


def refresh_project(force=False):
    global PROJECT, SOURCE_STAMP, LAST_SCAN
    if not AUTO_REFRESH:
        return
    with LOCK:
        if not force and time.monotonic()-LAST_SCAN < 1:
            return
        LAST_SCAN = time.monotonic()
        stamp = source_stamp()
        if stamp != SOURCE_STAMP:
            replacement = Project(ROOT)
            PROJECT, SOURCE_STAMP = replacement, stamp


def archive_session(data):
    folder = STATE_ROOT/'backups' if STATE_ROOT else ROOT/'work'/'backups'
    folder.mkdir(parents=True,exist_ok=True)
    target = folder/('measurements-'+hashlib.sha256(data).hexdigest()[:16]+'.json')
    if not target.exists():
        target.write_bytes(data)
    return target.name


def write_session(result):
    SESSION.parent.mkdir(parents=True, exist_ok=True)
    temp = SESSION.with_suffix('.tmp')
    temp.write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    os.replace(temp,SESSION)


def load_session():
    with LOCK:
        if SESSION.exists():
            data = SESSION.read_bytes()
            value = json.loads(data.decode('utf-8-sig'))
            try:
                if not PROJECT.session_compatible(value):
                    raise ValueError('촬영 자료가 교체되었습니다.')
                result = PROJECT.normalize_session(value)
            except (ValueError,KeyError,TypeError,OverflowError):
                backup = archive_session(data)
                result = PROJECT.normalize_session({})
                result['notice'] = ('자료가 교체되어 새 실습을 준비했습니다. 이전 기록은 자동 백업했습니다.' if STATE_ROOT else
                                    f'자료가 교체되어 새 실습을 준비했습니다. 이전 기록은 work/backups/{backup}에 보관했습니다.')
                return result
            if value.get('version',0) < 3:
                archive_session(data)
                write_session(result)
            return result
        return PROJECT.normalize_session({})


def image_file(camera, thumb):
    path = camera.get('path')
    if not path or not path.is_file():
        raise ValueError('현재 자료 폴더에 없는 사진입니다.')
    if not thumb:
        return path
    cache_id = hashlib.sha256(camera['id'].encode('utf-8')).hexdigest()[:16]
    preview = (STATE_ROOT or ROOT)/'.cache'/(cache_id+'-'+camera['file_revision']+'.jpg')
    if not preview.exists():
        try:
            from PIL import Image
        except ImportError:
            return path
        preview.parent.mkdir(parents=True,exist_ok=True)
        with LOCK:
            if not preview.exists():
                with Image.open(path) as im:
                    im.draft('RGB',(240,160))
                    im.thumbnail((180,120))
                    im.convert('RGB').save(preview,'JPEG',quality=78)
    return preview


def export_csv(session):
    handle = io.StringIO(newline='')
    writer = csv.writer(handle)
    writer.writerow(['point_id', 'label', 'kind', 'E_m', 'N_m', 'H_m', 'reprojection_rms_px',
                     'ray_gap_m', 'intersection_angle_deg', 'image_1', 'u_1_px', 'v_1_px',
                     'image_2', 'u_2_px', 'v_2_px', 'CRS', 'height_reference', 'method', 'height_constraint_m',
                     'building_id','building_name','creation_method'])
    for p in session['points']:
        obs = p['observations']
        safe_label = p['label']
        if safe_label.startswith(('=', '+', '-', '@')):
            safe_label = "'" + safe_label
        building = next((f for f in session['features'] if p['id'] in f['point_ids']),{})
        building_name = building.get('label','')
        if building_name.startswith(('=','+','-','@')):
            building_name = "'"+building_name
        writer.writerow([p['id'], safe_label, p['kind'], *[f'{v:.4f}' for v in p['xyz']],
                         f"{p['reprojection_rms_px']:.4f}" if p['reprojection_rms_px'] is not None else '',
                         f"{p['ray_gap_m']:.4f}" if p['ray_gap_m'] is not None else '',
                         f"{p['intersection_angle_deg']:.4f}",
                         *[item for o in obs for item in (o['image_id'], f"{o['x']:.4f}", f"{o['y']:.4f}")],
                         session['crs'], session['height_reference'], p.get('method', 'stereo'), p.get('height_constraint_m', ''),
                         building.get('id',''),building_name,
                         {'stereo':'직접 관측','guided':'가이드 조절','height_locked':'높이 유지'}[p.get('method','stereo')]])
    return ('\ufeff' + handle.getvalue()).encode('utf-8')


def export_dxf(session):
    lines = []

    def emit(*args):
        for arg in args:
            lines.append(str(arg))

    emit(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1021',
         9, '$INSUNITS', 70, 6, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES')
    points = {p['id']: p for p in session['points']}
    for p in points.values():
        layer = 'GROUND' if p['kind'] == 'ground' else 'BUILDING_POINTS'
        e, n, h = p['xyz']
        emit(0, 'POINT', 8, layer, 10, f'{e:.6f}', 20, f'{n:.6f}', 30, f'{h:.6f}')
        emit(0, 'TEXT', 8, 'LABELS', 10, f'{e:.6f}', 20, f'{n:.6f}', 30, f'{h:.6f}',
             40, .8, 1, p['id'])
    for f in session['features']:
        if len(f['point_ids']) < 2:
            continue
        emit(0, 'POLYLINE', 8, 'BUILDINGS', 66, 1, 10, 0, 20, 0, 30, 0,
             70, 9 if f['closed'] else 8)
        for pid in f['point_ids']:
            e, n, h = points[pid]['xyz']
            emit(0, 'VERTEX', 8, 'BUILDINGS', 10, f'{e:.6f}', 20, f'{n:.6f}', 30, f'{h:.6f}', 70, 32)
        emit(0, 'SEQEND', 8, 'BUILDINGS')
    emit(0, 'ENDSEC', 0, 'EOF')
    return ('\r\n'.join(lines) + '\r\n').encode('ascii')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send(self, data, content_type='application/json; charset=utf-8', status=200, filename=None):
        if not isinstance(data, bytes):
            data = json.dumps(data, ensure_ascii=False, allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        app_resource = any(kind in content_type for kind in ('json', 'text/html', 'javascript', 'text/css'))
        self.send_header('Cache-Control', 'no-store' if app_resource else 'private, max-age=3600')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', f"default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self' ws://127.0.0.1:{self.server.server_port}; object-src 'none'; frame-ancestors 'none'")
        if filename:
            self.send_header('Content-Disposition', 'attachment; filename="' + filename + '"')
        self.end_headers()
        self.wfile.write(data)

    def valid_host(self):
        return self.headers.get('Host', '').split(':')[0] in ('127.0.0.1', 'localhost')

    def do_GET(self):
        if not self.valid_host():
            return self.send({'error': 'Local access only'}, status=403)
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        try:
            if path == '/api/health':
                return self.send(dict(app='stereo-practice', ok=True))
            if path.startswith('/api/'):
                refresh_project()
            if path == '/api/project':
                return self.send(PROJECT.public())
            if path == '/api/session':
                return self.send(load_session())
            if path.startswith('/api/image/'):
                name = path.removeprefix('/api/image/')
                camera = PROJECT.camera(name)
                thumb = parse_qs(parsed.query).get('thumb') == ['1']
                file = image_file(camera,thumb)
                return self.send(file.read_bytes(), mimetypes.guess_type(file)[0] or 'image/jpeg')
            if path == '/api/export':
                fmt = parse_qs(parsed.query).get('format', ['json'])[0]
                session = load_session()
                if fmt == 'csv':
                    return self.send(export_csv(session), 'text/csv; charset=utf-8', filename='survey_points_E_N_H.csv')
                if fmt == 'dxf':
                    return self.send(export_dxf(session), 'application/dxf', filename='survey_3d_E_N_H.dxf')
                if fmt == 'json':
                    return self.send(session, filename='survey_session.json')
                raise ValueError('지원하지 않는 내보내기 형식입니다.')
            static = {'/': 'index.html', '/app.js': 'app.js', '/spatial.js': 'spatial.js', '/style.css': 'style.css'}
            if path in static:
                file = WEB_ROOT / static[path]
                data = file.read_bytes()
                if path == '/':
                    version = (WEB_ROOT / 'app.js').stat().st_mtime_ns
                    data = data.replace(b'src="/app.js"', f'src="/app.js?v={version}"'.encode('ascii'))
                    spatial_version = (WEB_ROOT / 'spatial.js').stat().st_mtime_ns
                    data = data.replace(b'src="/spatial.js"', f'src="/spatial.js?v={spatial_version}"'.encode('ascii'))
                return self.send(data, mimetypes.guess_type(file)[0] + '; charset=utf-8')
            return self.send({'error': 'Not found'}, status=404)
        except (ValueError, KeyError, TypeError) as error:
            return self.send({'error': str(error)}, status=400)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            return self.send({'error': '자료를 읽는 중 오류가 발생했습니다. 파일과 설정을 확인하세요.'}, status=500)

    def do_POST(self):
        global PROJECT
        if not self.valid_host():
            return self.send({'error': 'Local access only'}, status=403)
        origin = self.headers.get('Origin')
        if origin and origin not in (f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}'):
            return self.send({'error': 'Local origin required'}, status=403)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > 4_000_000:
                raise ValueError('요청 크기가 올바르지 않습니다.')
            value = json.loads(self.rfile.read(length))
            if not isinstance(value,dict):
                raise ValueError('요청 자료는 객체 형식이어야 합니다.')
            refresh_project()
            if self.path == '/api/refresh-images':
                with LOCK:
                    refreshed = PROJECT.refreshed_images()
                    added = len(refreshed.public()['images']) - len(PROJECT.public()['images'])
                    PROJECT = refreshed
                return self.send(dict(project=refreshed.public(), added=added))
            if self.path in ('/api/measure','/api/guide','/api/height-point'):
                obs = value.get('observations', [value.get('observation',{})])
                names = [o.get('image_id') for o in obs]
                if value.get('target'):
                    names.append(value['target'])
                if any(not PROJECT.camera(name).get('path') for name in names):
                    raise ValueError('현재 폴더에 있는 사진을 선택하세요.')
            if self.path in ('/api/session','/api/terrain') and value.get('project_revision') not in (None,PROJECT.revision):
                return self.send({'error':'촬영 자료가 변경되었습니다. 화면이 갱신된 뒤 다시 작업하세요.'},status=409)
            if self.path == '/api/measure':
                return self.send(PROJECT.measure(value['observations']))
            if self.path == '/api/guide':
                return self.send(dict(samples=PROJECT.guide(value['observation'], value['target'])))
            if self.path == '/api/height-point':
                return self.send(PROJECT.height_point(value['observation'], value['target'], value['height'], value.get('method', 'guided')))
            if self.path == '/api/session':
                with LOCK:
                    if not PROJECT.session_compatible(value):
                        raise ValueError('현재 촬영 자료와 다른 실습 기록입니다.')
                    result = PROJECT.normalize_session(value)
                    if SESSION.exists():
                        old_data = SESSION.read_bytes()
                        if not PROJECT.session_compatible(json.loads(old_data.decode('utf-8-sig'))):
                            archive_session(old_data)
                    write_session(result)
                return self.send(result)
            if self.path == '/api/terrain':
                from terrain import build_terrain
                normalized = PROJECT.normalize_session(value)
                return self.send(build_terrain(normalized['points']))
            return self.send({'error': 'Not found'}, status=404)
        except (ValueError, KeyError, TypeError, OverflowError) as error:
            return self.send({'error': str(error)}, status=400)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            return self.send({'error': '계산 또는 저장 중 오류가 발생했습니다.'}, status=500)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8768)
    parser.add_argument('--open', action='store_true')
    args = parser.parse_args()
    try:
        httpd = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    except OSError:
        # Never stop an unrelated process occupying this port.
        raise SystemExit('Port already in use. Choose another --port.')
    if args.open:
        version = (WEB_ROOT / 'app.js').stat().st_mtime_ns
        url = f'http://127.0.0.1:{httpd.server_port}/?v={version}'
        threading.Timer(.6, lambda: webbrowser.open(url)).start()
    print(f'Local photogrammetry app: http://127.0.0.1:{httpd.server_port}', flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == '__main__':
    main()
