import json
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server
from project_fixture import fixture_project


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.old_session = server.SESSION
        cls.old_project,cls.old_auto=server.PROJECT,server.AUTO_REFRESH
        server.PROJECT,cls.fixture=fixture_project()
        server.AUTO_REFRESH=False
        server.SESSION = Path(cls.temp.name) / 'measurements.json'
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.base = f'http://127.0.0.1:{cls.httpd.server_port}'
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join()
        server.SESSION = cls.old_session
        server.PROJECT,server.AUTO_REFRESH=cls.old_project,cls.old_auto
        cls.fixture.cleanup()
        cls.temp.cleanup()

    def request(self, path, body=None, headers=None):
        req = urllib.request.Request(self.base + path,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Content-Type': 'application/json', **(headers or {})})
        return urllib.request.urlopen(req, timeout=4)

    def test_health_and_page(self):
        self.assertTrue(json.load(self.request('/api/health'))['ok'])
        self.assertIn('사진측량 실습', self.request('/').read().decode('utf-8'))

    def test_updated_app_resources_are_not_served_from_stale_cache(self):
        response = self.request('/')
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        page = response.read().decode('utf-8')
        import re
        script_url = re.search(r'src="(/app\.js\?v=\d+)"', page).group(1)
        script = self.request(script_url)
        self.assertEqual(script.headers['Cache-Control'], 'no-store')
        self.assertEqual(script.read(), (ROOT / 'web/app.js').read_bytes())

    def test_private_files_not_served(self):
        for path in ['/project.json', '/measurements.json', '/.deps/pyproj/__init__.py']:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request(path)
            self.assertEqual(error.exception.code, 404)

    def test_cross_origin_write_refused(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request('/api/session', {}, headers={'Origin': 'https://example.com'})
        self.assertEqual(error.exception.code, 403)

    def test_measure_save_reload_and_exports(self):
        report = json.loads((ROOT / 'tests/fixtures/observations.json').read_text())
        points = []
        for i in [0, 7, 14]:
            m = report['matches'][i]
            obs = [{'image_id': name, 'x': m[key][0], 'y': m[key][1]}
                   for name, key in zip(report['images'], ['left', 'right'])]
            result = json.load(self.request('/api/measure', {'observations': obs}))
            self.assertTrue(result['save_allowed'])
            points.append(dict(id=f'P{len(points) + 1:03}', kind='building', observations=obs))
        payload = {'points': points, 'features': [{'id': 'B001', 'point_ids': [p['id'] for p in points], 'closed': True}]}
        saved = json.load(self.request('/api/session', payload))
        restored = json.load(self.request('/api/session'))
        self.assertEqual(saved, restored)
        self.assertTrue(restored['features'][0]['closed'])
        self.assertIn('H_m', self.request('/api/export?format=csv').read().decode('utf-8-sig'))
        self.assertIn(b'POLYLINE', self.request('/api/export?format=dxf').read())
        self.assertEqual(len(json.load(self.request('/api/export?format=json'))['points']), 3)

    def test_invalid_points_are_rejected_without_saving(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request('/api/measure', {'observations': [{'image_id': 'SYNTH_A', 'x': -100, 'y': 0},
                                                          {'image_id': 'SYNTH_B', 'x': 100, 'y': 200}]})
        self.assertEqual(error.exception.code, 400)

    def test_height_point_api_save_and_reload(self):
        xyz=[10,5,20]
        u,v=server.PROJECT.project('SYNTH_A',xyz)
        payload={'observation':{'image_id':'SYNTH_A','x':u,'y':v},'target':'SYNTH_B','height':20,'method':'height_locked'}
        point=json.load(self.request('/api/height-point',payload))
        self.assertIsNone(point['reprojection_rms_px'])
        point.update(id='P001',kind='building')
        saved=json.load(self.request('/api/session',{'points':[point]}))
        restored=json.load(self.request('/api/session'))
        self.assertEqual(saved,restored)
        self.assertEqual(restored['points'][0]['method'],'height_locked')

    def test_refresh_images_reloads_additions_deletions_and_calibration(self):
        project,temp=fixture_project(['SYNTH_A','SYNTH_B'])
        original_project=server.PROJECT
        try:
            server.PROJECT=project;data=project.folder
            before=server.SESSION.read_bytes() if server.SESSION.exists() else None
            (data/'SYNTH_0.JPG').write_bytes(b'new matching photo')
            (data/'unlisted.JPG').write_bytes(b'no exterior orientation')
            result=json.load(self.request('/api/refresh-images',{}))
            self.assertEqual(result['added'],1)
            self.assertEqual({p['id'] for p in result['project']['images']},{'SYNTH_0','SYNTH_A','SYNTH_B'})
            self.assertEqual(self.request('/api/image/SYNTH_0').read(),b'new matching photo')
            self.assertEqual(server.SESSION.read_bytes() if server.SESSION.exists() else None,before)
            (data/'SYNTH_A.JPG').unlink()
            cam=data/'cam.txt';cam.write_text(cam.read_text().replace('12.0','15.0'))
            result=json.load(self.request('/api/refresh-images',{}))
            self.assertEqual({p['id'] for p in result['project']['images']},{'SYNTH_0','SYNTH_B'})
            self.assertEqual(result['project']['camera']['focal_mm'],15)
            with self.assertRaises(urllib.error.HTTPError): self.request('/api/image/SYNTH_A?thumb=1')
        finally:
            server.PROJECT=original_project;temp.cleanup()

    def test_automatic_replacement_invalidates_cache_and_preserves_old_session(self):
        project,temp=fixture_project(['SYNTH_A','SYNTH_B'])
        names=['PROJECT','ROOT','SESSION','AUTO_REFRESH','SOURCE_STAMP','LAST_SCAN']
        previous={name:getattr(server,name) for name in names}
        try:
            server.PROJECT=project;server.ROOT=project.root;server.SESSION=project.root/'measurements.json'
            server.AUTO_REFRESH=True;server.SOURCE_STAMP=server.source_stamp();server.LAST_SCAN=0
            initial=json.load(self.request('/api/project'))
            (project.folder/'SYNTH_A.JPG').unlink()
            (project.folder/'SYNTH_0.JPG').write_bytes(b'new image')
            (project.root/'.cache').mkdir()
            (project.root/'.cache/SYNTH_A.jpg').write_bytes(b'old cached image')
            server.LAST_SCAN=0
            updated=json.load(self.request('/api/project'))
            self.assertEqual({p['id'] for p in updated['images']},{'SYNTH_0','SYNTH_B'})
            self.assertNotEqual(initial['revision'],updated['revision'])
            with self.assertRaises(urllib.error.HTTPError):self.request('/api/image/SYNTH_A?thumb=1')
            old_revision=updated['images'][0]['file_revision']
            (project.folder/'SYNTH_0.JPG').write_bytes(b'replaced image contents')
            server.LAST_SCAN=0
            self.assertNotEqual(json.load(self.request('/api/project'))['images'][0]['file_revision'],old_revision)
            xyz=[0,5,20];u,v=server.PROJECT.project('SYNTH_0',xyz)
            point=json.load(self.request('/api/height-point',dict(observation=dict(image_id='SYNTH_0',x=u,y=v),target='SYNTH_B',height=20)))
            point.update(id='P001',kind='ground')
            saved=json.load(self.request('/api/session',{'points':[point]}))
            original=server.SESSION.read_bytes()
            cam=project.folder/'cam.txt';cam.write_text(cam.read_text().replace('12.0','15.0'))
            server.LAST_SCAN=0
            self.assertEqual(json.load(self.request('/api/project'))['camera']['focal_mm'],15)
            reset=json.load(self.request('/api/session'))
            self.assertEqual(reset['points'],[]);self.assertIn('보관',reset['notice'])
            self.assertEqual(server.SESSION.read_bytes(),original)
            backups=list((project.root/'work/backups').glob('*.json'))
            self.assertEqual(backups[0].read_bytes(),original)
            with self.assertRaises(urllib.error.HTTPError) as error:self.request('/api/session',saved)
            self.assertEqual(error.exception.code,409)
            for photo in project.folder.glob('*.JPG'):photo.unlink()
            server.LAST_SCAN=0
            self.assertEqual(json.load(self.request('/api/project'))['images'],[])
        finally:
            for name,value in previous.items():setattr(server,name,value)
            temp.cleanup()


if __name__ == '__main__':
    unittest.main()
