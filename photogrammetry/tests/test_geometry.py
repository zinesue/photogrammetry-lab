import copy
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from photogrammetry import Project
from server import export_csv, export_dxf
from project_fixture import fixture_project


class GeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.project, cls.fixture = fixture_project()
        cls.addClassCleanup(cls.fixture.cleanup)
        cls.report = json.loads((ROOT / 'tests/fixtures/observations.json').read_text())

    def synthetic(self):
        p = copy.deepcopy(self.project)
        p.f, p.cx, p.cy = 1000., 500., 400.
        identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
        p.cameras = {
            'A': {'centre': [0, 0, 100], 'rotation': identity},
            'B': {'centre': [10, 0, 100], 'rotation': identity}}
        return p

    def test_known_stereo_height_without_using_projection_helper(self):
        p = self.synthetic()
        # Manually computed pinhole observations of E=2,N=3,H=10.
        obs = [{'image_id': 'A', 'x': 500 + 1000 * 2 / 90, 'y': 400 - 1000 * 3 / 90},
               {'image_id': 'B', 'x': 500 - 1000 * 8 / 90, 'y': 400 - 1000 * 3 / 90}]
        result = p.measure(obs)
        for actual, expected in zip(result['xyz'], [2, 3, 10]):
            self.assertAlmostEqual(actual, expected, places=7)
        self.assertLess(result['reprojection_rms_px'], 1e-7)

    def test_pixel_y_increases_south_in_zero_pose(self):
        self.assertEqual(self.synthetic().project('A', [10, 20, 0]), [600., 200.])

    def test_same_image_refused(self):
        with self.assertRaises(ValueError):
            self.project.measure([{'image_id': 'SYNTH_A', 'x': 800, 'y': 600}] * 2)

    def test_parallel_rays_refused(self):
        with self.assertRaises(ValueError):
            self.synthetic().measure([{'image_id': 'A', 'x': 500, 'y': 400}, {'image_id': 'B', 'x': 500, 'y': 400}])

    def test_behind_camera_refused(self):
        with self.assertRaises(ValueError):
            self.synthetic().measure([{'image_id': 'A', 'x': 450, 'y': 400}, {'image_id': 'B', 'x': 550, 'y': 400}])

    def test_nonfinite_and_outside_image_refused(self):
        for x in [float('nan'), float('inf'), -1, self.project.width]:
            with self.assertRaises(ValueError):
                self.project.measure([{'image_id': 'SYNTH_A', 'x': x, 'y': 1000}, {'image_id': 'SYNTH_B', 'x': 1000, 'y': 1000}])

    def synthetic_observations(self, index=0):
        item = self.report['matches'][index]
        return [{'image_id': name, 'x': item[key][0], 'y': item[key][1]}
                for name, key in zip(self.report['images'], ['left', 'right'])]

    def test_synthetic_correspondences_agree_with_independent_pinhole_solution(self):
        for i in range(0, min(100, len(self.report['matches'])), 7):
            item = self.report['matches'][i]
            result = self.project.measure(self.synthetic_observations(i))
            self.assertLess(result['reprojection_rms_px'], 2)
            self.assertLess(math.dist(result['xyz'], item['xyz']), .01)

    def test_georeferenced_round_trip_at_multiple_heights(self):
        for height in [0, 15, 50, 100]:
            point = [10, 5, height]
            obs = []
            for name in ['SYNTH_A', 'SYNTH_B']:
                u, v = self.project.project(name, point)
                obs.append({'image_id': name, 'x': u, 'y': v})
            actual = self.project.measure(obs)
            self.assertLess(math.dist(actual['xyz'], point), 1e-6)

    def test_guide_contains_actual_projection(self):
        xyz = [10, 5, 20]
        u, v = self.project.project('SYNTH_A', xyz)
        observation = {'image_id': 'SYNTH_A', 'x': u, 'y': v}
        samples = self.project.guide(observation, 'SYNTH_B')
        # All generated samples and the corresponding point lie on one epipolar line.
        a, b = samples[0], samples[-1]
        q = self.project.project('SYNTH_B', xyz)
        distance = abs((b['x'] - a['x']) * (a['y'] - q[1]) - (a['x'] - q[0]) * (b['y'] - a['y'])) / math.hypot(b['x'] - a['x'], b['y'] - a['y'])
        self.assertLess(distance, 1e-6)

    def test_mismatched_point_cannot_be_saved(self):
        obs = self.synthetic_observations()
        obs[1]['y'] += 100
        self.assertFalse(self.project.measure(obs)['save_allowed'])
        with self.assertRaises(ValueError):
            self.project.normalize_session({'points': [{'id': 'P001', 'observations': obs}]})

    def session_fixture(self):
        points = [{'id': 'P001', 'kind': 'ground', 'observations': self.synthetic_observations(0)},
                  {'id': 'P002', 'kind': 'building', 'observations': self.synthetic_observations(7)},
                  {'id': 'P003', 'kind': 'building', 'observations': self.synthetic_observations(14)}]
        return self.project.normalize_session({'points': points, 'features': [{'id': 'B001', 'point_ids': ['P001', 'P002', 'P003'], 'closed': True}], 'ground_reference': 'P001'})

    def test_saved_xyz_is_recomputed_from_observations(self):
        session = self.session_fixture()
        expected = session['points'][0]['xyz'][:]
        session['points'][0]['xyz'] = [1, 2, 3]
        self.assertEqual(self.project.normalize_session(session)['points'][0]['xyz'], expected)

    def test_orphaned_features_and_duplicate_points_refused(self):
        session = self.session_fixture()
        session['features'][0]['point_ids'].append('P999')
        with self.assertRaises(ValueError):
            self.project.normalize_session(session)
        session = self.session_fixture()
        session['points'].append(session['points'][0])
        with self.assertRaises(ValueError):
            self.project.normalize_session(session)

    def test_csv_and_dxf_preserve_height_and_coordinate_order(self):
        session = self.session_fixture()
        import csv, io
        rows = list(csv.DictReader(io.StringIO(export_csv(session).decode('utf-8-sig'))))
        for row, point in zip(rows, session['points']):
            self.assertAlmostEqual(float(row['E_m']), point['xyz'][0], places=3)
            self.assertAlmostEqual(float(row['N_m']), point['xyz'][1], places=3)
            self.assertAlmostEqual(float(row['H_m']), point['xyz'][2], places=3)
        dxf = export_dxf(session).decode('ascii')
        self.assertIn('POLYLINE\r\n', dxf)
        self.assertIn('70\r\n9\r\n', dxf)
        self.assertIn(f"30\r\n{session['points'][0]['xyz'][2]:.6f}\r\n", dxf)


if __name__ == '__main__':
    unittest.main()
