"""Offline Windows launcher; bundled with PyInstaller, never distributed as source."""
import argparse
import base64
import ctypes
import hashlib
import json
import os
import socket
from pathlib import Path
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

APP_NAME = '사진측량 실습'


class WindowLifetime:
    """Track browser documents independently, allowing reloads and background tabs."""
    def __init__(self, clock=time.monotonic, grace=20, startup=120, foreground_ttl=600, hidden_ttl=3600, pause=30):
        self.clock = clock; self.grace = grace; self.startup = startup
        self.foreground_ttl = foreground_ttl; self.hidden_ttl = hidden_ttl; self.pause = pause
        self.started = self.last_tick = clock(); self.empty_since = None
        self.clients = {}; self.connections = {}; self.seen = False; self.requests = 0
        self.lock = threading.RLock()

    def note(self, value):
        name, sequence, state = value.get('client_id'), value.get('sequence'), value.get('state')
        if not isinstance(name, str) or not 1 <= len(name) <= 100 or type(sequence) is not int or not 0 < sequence < 10**12 or state not in ('open', 'closed'):
            raise ValueError('실습 화면 상태가 올바르지 않습니다.')
        with self.lock:
            now = self.clock(); previous = self.clients.get(name)
            if previous and sequence <= previous['sequence']:
                return
            if previous and previous.get('networked') and name not in self.connections:
                previous['sequence'] = sequence
                return
            if not previous and len(self.clients) >= 512:
                expired = [key for key, client in self.clients.items() if not client['open']]
                if not expired:
                    raise ValueError('열린 실습 화면이 너무 많습니다.')
                del self.clients[expired[0]]
            self.clients[name] = dict(sequence=sequence, open=state == 'open', hidden=bool(value.get('hidden')), last=now,
                                      networked=bool(previous and previous.get('networked')))
            if state == 'open':
                self.seen = True; self.empty_since = None
            elif self.seen and not any(c['open'] for c in self.clients.values()):
                self.empty_since = now if self.empty_since is None else self.empty_since

    def attach(self, name):
        if not isinstance(name, str) or not 1 <= len(name) <= 100:
            raise ValueError('Invalid browser connection')
        with self.lock:
            if name not in self.clients and len(self.connections) >= 128:
                raise ValueError('Too many browser connections')
            previous = self.clients.get(name, {})
            token = object(); self.connections[name] = token
            self.clients[name] = dict(sequence=previous.get('sequence', 0), open=True, hidden=False, last=self.clock(), networked=True)
            self.seen = True; self.empty_since = None
            return token

    def detach(self, name, token):
        with self.lock:
            if self.connections.get(name) is not token:
                return
            del self.connections[name]; self.clients[name]['open'] = False
            if not self.connections and not any(c['open'] for c in self.clients.values()):
                self.empty_since = self.clock() if self.empty_since is None else self.empty_since

    def begin(self):
        with self.lock:
            self.requests += 1

    def end(self):
        with self.lock:
            self.requests -= 1

    def should_stop(self):
        with self.lock:
            now = self.clock(); gap = now - self.last_tick; self.last_tick = now
            # A suspended computer must not immediately expire every browser
            # document before its JavaScript has a chance to resume.
            if gap > self.pause:
                self.started += gap
                if self.empty_since is not None:
                    self.empty_since += gap
                for client in self.clients.values():
                    client['last'] += gap
            for name, client in self.clients.items():
                ttl = self.hidden_ttl if client['hidden'] else self.foreground_ttl
                if client['open'] and name not in self.connections and now - client['last'] > ttl:
                    client['open'] = False
            if self.connections or any(c['open'] for c in self.clients.values()):
                self.empty_since = None; return False
            if not self.seen:
                return not self.requests and now - self.started >= self.startup
            if self.empty_since is None:
                self.empty_since = now
            return not self.requests and now - self.empty_since >= self.grace


def paths(state_override=None):
    folder = Path(sys.executable).resolve().parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parents[1] / 'Pack'
    data = folder / '데이터'
    key = hashlib.sha256(str(folder).casefold().encode('utf-8')).hexdigest()[:16]
    state = Path(state_override).resolve() if state_override else Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData/Local')) / 'DronePhotogrammetryPractice' / key
    return folder, data, state


def configure(data, state):
    if not data.is_dir() or not all((data / name).is_file() for name in ('cam.txt', 'eo.txt', 'project.json')):
        raise ValueError('실행파일 옆의 데이터 폴더에서 cam.txt, eo.txt 또는 project.json을 찾을 수 없습니다. Pack 폴더 전체를 복사했는지 확인해 주세요.')
    state.mkdir(parents=True, exist_ok=True)
    os.environ['STEREO_PRACTICE_ROOT'] = str(data)
    os.environ['STEREO_PRACTICE_STATE'] = str(state)
    if not getattr(sys, 'frozen', False):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import server
    if len(server.PROJECT.public()['images']) < 2:
        raise ValueError('실습에 사용할 사진이 두 장 이상 필요합니다. 데이터 폴더의 사진 이름과 eo.txt를 확인해 주세요.')
    return server


def local_request(url, body=None):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1':
        raise ValueError('잘못된 실습 주소입니다.')
    # The launcher only calls loopback HTTP. Do not initialize an unused HTTPS
    # certificate context (which can fail in a frozen Windows environment).
    opener = urllib.request.OpenerDirector()
    opener.add_handler(urllib.request.HTTPHandler())
    opener.add_handler(urllib.request.HTTPDefaultErrorHandler())
    opener.add_handler(urllib.request.HTTPErrorProcessor())
    request = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Content-Type': 'application/json'} if body is not None else {})
    return opener.open(request, timeout=5)


class Instance:
    def __init__(self, state):
        self.state = state
        self.handle = None

    def acquire(self):
        import msvcrt
        self.handle = (self.state / 'running.lock').open('a+b')
        try:
            if os.fstat(self.handle.fileno()).st_size == 0:
                self.handle.write(b'0'); self.handle.flush()
            self.handle.seek(0)
            msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            self.handle.close(); self.handle = None
            return False

    def reopen(self):
        for _ in range(30):
            try:
                info = json.loads((self.state / 'running.json').read_text(encoding='utf-8'))
                if json.load(local_request(info['url'].split('?')[0] + 'api/health'))['app'] == 'stereo-practice':
                    webbrowser.open(info['url']); return
            except (OSError, ValueError, KeyError, urllib.error.URLError):
                time.sleep(.2)
        raise ValueError('이미 실행 중인 실습이 시작되는 중입니다. 잠시 후 실행파일을 다시 눌러 주세요.')

    def publish(self, url):
        (self.state / 'running.json').write_text(json.dumps({'url': url, 'pid': os.getpid()}), encoding='utf-8')

    def close(self):
        if self.handle:
            import msvcrt
            try:
                (self.state / 'running.json').unlink(missing_ok=True)
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
            finally:
                self.handle.close(); self.handle = None


class Runtime:
    def __init__(self, server, port=0, lifetime=None):
        self.server = server
        self.lifetime = lifetime
        self.stopping = threading.Event()
        owner = self
        class Handler(server.Handler):
            def do_GET(self):
                if not self.valid_host():
                    return super().do_GET()
                path = urllib.parse.urlsplit(self.path).path
                if path == '/api/window-connection' and owner.lifetime:
                    return self.browser_connection()
                if path == '/api/health':
                    return self.send(dict(app='stereo-practice', ok=True, window_lifecycle=owner.lifetime is not None,
                                          notices=(Path(__file__).resolve().parent/'NOTICE.txt').is_file()))
                if path == '/api/notices':
                    file = Path(__file__).resolve().parent/'NOTICE.txt'
                    if file.is_file():
                        return self.send(file.read_bytes(), 'text/plain; charset=utf-8')
                if owner.lifetime:
                    owner.lifetime.begin()
                try:
                    return super().do_GET()
                finally:
                    if owner.lifetime:
                        owner.lifetime.end()

            def browser_connection(self):
                origin = self.headers.get('Origin')
                allowed = (f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}')
                if origin not in allowed:
                    return self.send({'error': 'Local origin required'}, status=403)
                try:
                    key = self.headers.get('Sec-WebSocket-Key', '')
                    if self.headers.get('Upgrade', '').lower() != 'websocket' or self.headers.get('Sec-WebSocket-Version') != '13' or len(base64.b64decode(key, validate=True)) != 16:
                        raise ValueError('Invalid WebSocket upgrade')
                    name = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get('client_id', [''])[0]
                    token = owner.lifetime.attach(name)
                except (ValueError, TypeError):
                    return self.send({'error': 'Invalid browser connection'}, status=400)
                try:
                    self.protocol_version = 'HTTP/1.1'; self.close_connection = True
                    self.send_response(101); self.send_header('Upgrade', 'websocket'); self.send_header('Connection', 'Upgrade')
                    accept = base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode('ascii')).digest()).decode('ascii')
                    self.send_header('Sec-WebSocket-Accept', accept); self.end_headers()
                    self.connection.settimeout(2)
                    def read_exact(length):
                        result = b''
                        while len(result) < length:
                            if owner.stopping.is_set():
                                raise ConnectionError('Application stopped')
                            try:
                                chunk = self.connection.recv(length-len(result))
                            except socket.timeout:
                                self.connection.sendall(b'\x89\x00')  # control ping; browser replies even in a background tab
                                continue
                            if not chunk:
                                raise ConnectionError('Browser closed')
                            result += chunk
                        return result
                    while not owner.stopping.is_set():
                        first, second = read_exact(2); opcode = first & 15; length = second & 127
                        if first & 0x70 or not first & 0x80 or not second & 0x80 or length > 125 or opcode not in (8,9,10):
                            self.connection.sendall(b'\x88\x02\x03\xea'); break
                        mask = read_exact(4); payload = bytes(value ^ mask[i%4] for i,value in enumerate(read_exact(length)))
                        if opcode == 8:
                            self.connection.sendall(bytes((0x88, length))+payload); break
                        if opcode == 9:
                            self.connection.sendall(bytes((0x8a, length))+payload)
                except (OSError, ConnectionError):
                    pass
                finally:
                    owner.lifetime.detach(name, token)

            def do_POST(self):
                if urllib.parse.urlsplit(self.path).path == '/api/window' and owner.lifetime:
                    if not self.valid_host():
                        return self.send({'error': 'Local access only'}, status=403)
                    origin = self.headers.get('Origin')
                    if origin and origin not in (f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}'):
                        return self.send({'error': 'Local origin required'}, status=403)
                    try:
                        length = int(self.headers.get('Content-Length', '0'))
                        if not 0 < length <= 1024:
                            raise ValueError('잘못된 요청입니다.')
                        value = json.loads(self.rfile.read(length))
                        if not isinstance(value, dict):
                            raise ValueError('잘못된 요청입니다.')
                        owner.lifetime.note(value)
                        return self.send({'ok': True})
                    except (ValueError, TypeError):
                        return self.send({'error': 'Invalid window state'}, status=400)
                if owner.lifetime:
                    owner.lifetime.begin()
                try:
                    return super().do_POST()
                finally:
                    if owner.lifetime:
                        owner.lifetime.end()

        self.httpd = server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={'poll_interval': .1}, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.httpd.server_port}/'

    def close(self):
        self.stopping.set()
        self.httpd.shutdown(); self.httpd.server_close(); self.thread.join(timeout=3)


def verify(runtime, report, state):
    """Packaged smoke check, writing its report only to the requested QA path."""
    base = runtime.url
    project = json.load(local_request(base + 'api/project'))
    health = json.load(local_request(base + 'api/health'))
    for path in ('', 'app.js', 'spatial.js', 'style.css'):
        response = local_request(base + path)
        assert response.status == 200 and len(response.read()) > 100
    assert health['ok'] and len(project['images']) >= 2
    first = project['images'][0]['id']
    preview = local_request(base + 'api/image/' + urllib.parse.quote(first) + '?thumb=1').read()
    from PIL import Image
    import io
    with Image.open(io.BytesIO(preview)) as image:
        assert image.width <= 180 and image.height <= 120
    session = json.load(local_request(base + 'api/session'))
    camera = project['camera']; first_pair = None
    for other in project['images'][1:]:
        observation = dict(image_id=first, x=camera['cx'], y=camera['cy'])
        point = runtime.server.PROJECT.height_point(observation, other['id'], 20)
        if point['save_allowed']:
            first_pair = observation, other['id']; break
    assert first_pair, 'No overlapping image pair for verification'
    observation, other = first_pair
    points = []
    for i, offset in enumerate(((0, 0), (150, 0), (0, 150))):
        obs = dict(observation, x=observation['x'] + offset[0], y=observation['y'] + offset[1])
        point = json.load(local_request(base + 'api/height-point', dict(observation=obs, target=other, height=20)))
        assert point['save_allowed']; point.update(id=f'P{i+1:03}', kind='ground', label=f'P{i+1:03}')
        points.append(point)
    stereo = json.load(local_request(base + 'api/measure', {'observations': points[0]['observations']}))
    assert abs(stereo['xyz'][2] - 20) < 1e-5
    session.update(points=points, ground_reference='P001')
    session['terrain'] = json.load(local_request(base + 'api/terrain', session))
    assert len(session['terrain']['triangles']) == 1
    saved = json.load(local_request(base + 'api/session', session))
    assert len(saved['points']) == 3
    assert len(json.load(local_request(base + 'api/session'))['points']) == 3
    assert b'P001' in local_request(base + 'api/export?format=csv').read()
    assert (state / 'measurements.json').exists()
    try:
        local_request(base + 'project.json')
        raise AssertionError('Private data exposed')
    except urllib.error.HTTPError as error:
        assert error.code == 404
    result = dict(ok=True, frozen=bool(getattr(sys, 'frozen', False)), executable=sys.executable,
                  photos=len(project['images']), crs=project['crs'], thumbnail_bytes=len(preview),
                  saved_points=len(saved['points']), terrain_triangles=len(saved['terrain']['triangles']),
                  bundled_runtime=(Path(getattr(sys, '_MEIPASS', sys.base_prefix)) / 'python312.dll').exists(),
                  url=base, state=str(state), launcher_window=False)
    Path(report).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--verify'); parser.add_argument('--state-dir')
    parser.add_argument('--test-server'); parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--browser-lifetime', action='store_true')
    parser.add_argument('--quit-after', type=float, default=0)
    args = parser.parse_args()
    folder, data, state = paths(args.state_dir)
    instance = None; runtime = None
    try:
        server = configure(data, state)
        if not args.verify and not args.test_server:
            instance = Instance(state)
            if not instance.acquire():
                instance.reopen(); return 0
        lifetime = WindowLifetime() if (args.browser_lifetime or not (args.verify or args.test_server)) else None
        runtime = Runtime(server, args.port, lifetime)
        if args.verify:
            verify(runtime, args.verify, state)
        elif args.test_server:
            Path(args.test_server).write_text(json.dumps({'url': runtime.url, 'pid': os.getpid()}, ensure_ascii=False), encoding='utf-8')
            stop = Path(args.test_server).with_suffix('.stop')
            deadline = time.monotonic() + (args.quit_after or 180)
            while time.monotonic() < deadline and not stop.exists() and not (lifetime and lifetime.should_stop()):
                time.sleep(.2)
        else:
            instance.publish(runtime.url)
            if not webbrowser.open(runtime.url):
                raise ValueError('실습 화면을 열지 못했습니다. Windows의 기본 브라우저 설정을 확인해 주세요.')
            while not lifetime.should_stop():
                time.sleep(.5)
        return 0
    except Exception as error:
        if args.verify or args.test_server:
            Path(args.verify or args.test_server).write_text(json.dumps({'ok': False, 'error': str(error), 'traceback': traceback.format_exc()}, ensure_ascii=False), encoding='utf-8')
        else:
            ctypes.windll.user32.MessageBoxW(None, str(error), APP_NAME, 0x10)
        return 1
    finally:
        if runtime:
            runtime.close()
        if instance:
            instance.close()


if __name__ == '__main__':
    raise SystemExit(main())
