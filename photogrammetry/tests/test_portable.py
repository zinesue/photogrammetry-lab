import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tools.portable_app import Instance, Runtime, WindowLifetime, local_request, paths


class PortableTests(unittest.TestCase):
    def test_frozen_package_finds_adjacent_data_after_moving(self):
        with tempfile.TemporaryDirectory() as folder:
            executable = Path(folder)/'다른 컴퓨터 사본'/'사진측량실습.exe'
            state = Path(folder)/'검사용 기록'
            with patch.object(sys, 'frozen', True, create=True), patch.object(sys, 'executable', str(executable)):
                package, data, actual_state = paths(state)
            self.assertEqual(package, executable.parent.resolve())
            self.assertEqual(data, package/'데이터')
            self.assertEqual(actual_state, state.resolve())

    @unittest.skipUnless(sys.platform == 'win32', 'Windows instance locking')
    def test_second_launch_reuses_only_a_live_instance_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            first, second = Instance(state), Instance(state)
            try:
                self.assertTrue(first.acquire())
                first.publish('http://127.0.0.1:12345/')
                self.assertFalse(second.acquire())
                first.close()
                self.assertFalse((state/'running.json').exists())
                self.assertTrue(second.acquire())
            finally:
                first.close(); second.close()

    def test_launcher_never_requests_external_addresses(self):
        for url in ('https://example.com/', 'http://192.168.0.1/', 'file:///C:/test'):
            with self.assertRaises(ValueError):
                local_request(url)

    def lifetime(self, **options):
        self.now = 0
        return WindowLifetime(clock=lambda: self.now, grace=5, startup=15, foreground_ttl=30, hidden_ttl=120, pause=10000, **options)

    def note(self, lifetime, name, sequence, state='open', hidden=False):
        lifetime.note(dict(client_id=name, sequence=sequence, state=state, hidden=hidden))

    def test_last_window_close_waits_for_reload_and_other_tabs(self):
        lifetime = self.lifetime()
        self.note(lifetime, 'first', 1); self.note(lifetime, 'second', 1)
        self.note(lifetime, 'first', 2, 'closed'); self.now = 10
        self.assertFalse(lifetime.should_stop())
        self.note(lifetime, 'second', 2, 'closed'); self.now = 14
        self.assertFalse(lifetime.should_stop())
        self.note(lifetime, 'reload', 1); self.now = 25
        self.assertFalse(lifetime.should_stop())
        self.note(lifetime, 'reload', 2, 'closed'); self.now = 30
        self.assertTrue(lifetime.should_stop())

    def test_late_heartbeat_cannot_reopen_an_already_closed_window(self):
        lifetime = self.lifetime(); self.note(lifetime, 'tab', 1)
        self.note(lifetime, 'tab', 3, 'closed'); self.note(lifetime, 'tab', 2)
        self.now = 5; self.assertTrue(lifetime.should_stop())

    def test_background_tabs_stay_alive_and_pending_saves_finish_before_exit(self):
        lifetime = self.lifetime(); self.note(lifetime, 'tab', 1, hidden=True)
        self.now = 60; self.assertFalse(lifetime.should_stop())
        self.note(lifetime, 'tab', 2, 'closed'); lifetime.begin()
        self.now = 66; self.assertFalse(lifetime.should_stop())
        lifetime.end(); self.assertTrue(lifetime.should_stop())

    def test_missing_browser_start_and_crashed_tabs_eventually_release_the_process(self):
        lifetime = self.lifetime(); self.now = 15
        self.assertTrue(lifetime.should_stop())
        self.now = 0; lifetime = self.lifetime(); self.note(lifetime, 'crashed', 1)
        self.now = 31; self.assertFalse(lifetime.should_stop())
        self.now = 36; self.assertTrue(lifetime.should_stop())

    def test_computer_resume_gives_the_browser_time_to_reconnect(self):
        self.now = 0
        lifetime = WindowLifetime(clock=lambda: self.now, grace=5, foreground_ttl=30, pause=3)
        self.note(lifetime, 'tab', 1); self.now = 3600
        self.assertFalse(lifetime.should_stop())
        self.note(lifetime, 'tab', 2, 'closed'); self.now += 2
        self.assertFalse(lifetime.should_stop())
        self.now += 3; self.assertTrue(lifetime.should_stop())

    def test_window_endpoint_checks_origin_and_accepts_real_close_notifications(self):
        import server
        import urllib.error
        import urllib.request
        import json
        lifetime = self.lifetime(); runtime = Runtime(server, lifetime=lifetime)
        try:
            health = json.load(local_request(runtime.url+'api/health'))
            self.assertTrue(health['window_lifecycle'])
            value = dict(client_id='browser', sequence=1, state='open', hidden=False)
            local_request(runtime.url+'api/window', value).close()
            request = urllib.request.Request(runtime.url+'api/window', data=json.dumps(dict(value, sequence=2, state='closed')).encode(), headers={'Origin':'https://example.com','Content-Type':'application/json'})
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(request)
            self.assertEqual(error.exception.code, 403)
            self.now = 6; self.assertFalse(lifetime.should_stop())
            local_request(runtime.url+'api/window', dict(value, sequence=2, state='closed')).close()
            self.now = 11; self.assertTrue(lifetime.should_stop())
        finally:
            runtime.close()

    def test_socket_disconnect_closes_a_tab_even_if_the_browser_skips_pagehide(self):
        import server
        import socket
        import time
        import urllib.parse
        lifetime = self.lifetime(); runtime = Runtime(server, lifetime=lifetime)
        channel = None
        try:
            port = urllib.parse.urlsplit(runtime.url).port
            channel = socket.create_connection(('127.0.0.1', port), timeout=2)
            request = (f'GET /api/window-connection?client_id=tab HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n'
                       f'Origin: http://127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                       'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: MTIzNDU2Nzg5MGFiY2RlZg==\r\n\r\n')
            channel.sendall(request.encode())
            self.assertIn(b'101 Switching Protocols', channel.recv(4096))
            self.assertTrue(lifetime.connections)
            self.now = 200; self.assertFalse(lifetime.should_stop(), 'live connection outlasts heartbeat timeout')
            channel.shutdown(socket.SHUT_RDWR); channel.close(); channel = None
            deadline = time.monotonic()+2
            while lifetime.connections and time.monotonic()<deadline:
                time.sleep(.01)
            self.assertFalse(lifetime.connections)
            self.note(lifetime, 'tab', 10)
            self.now = 205; self.assertTrue(lifetime.should_stop(), 'late heartbeat must not resurrect the closed socket')
        finally:
            if channel:
                channel.close()
            runtime.close()


if __name__ == '__main__':
    unittest.main()
