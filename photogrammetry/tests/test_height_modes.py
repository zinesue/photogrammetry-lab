import json
import math
import sys
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from photogrammetry import Project
from server import export_csv
from project_fixture import fixture_project


class HeightModeTests(unittest.TestCase):
    def setUp(self):
        self.project,self.fixture=fixture_project()
        self.addCleanup(self.fixture.cleanup)
        self.xyz=[10,5,20]
        u,v=self.project.project('SYNTH_A',self.xyz)
        self.obs={'image_id':'SYNTH_A','x':u,'y':v}

    def test_height_point_geometry_and_provenance(self):
        for method in ['guided','height_locked']:
            point=self.project.height_point(self.obs,'SYNTH_B',20,method)
            self.assertLess(math.dist(point['xyz'],self.xyz),1e-7)
            self.assertIsNone(point['reprojection_rms_px'])
            self.assertIsNone(point['ray_gap_m'])
            self.assertEqual(point['method'],method)

    def test_import_recomputes_generated_positions_without_trusting_xyz(self):
        p=self.project.height_point(self.obs,'SYNTH_B',20,'height_locked')
        p.update(id='P001',kind='building',xyz=[1,2,3])
        p['observations'][1].update(x=0,y=0)
        session=self.project.normalize_session({'points':[p]})
        self.assertLess(math.dist(session['points'][0]['xyz'],self.xyz),1e-7)
        self.assertEqual(session['points'][0]['height_constraint_m'],20)
        self.assertIn('height_locked',export_csv(session).decode('utf-8-sig'))
        self.assertIsNone(session['points'][0]['reprojection_rms_px'])

    def test_invalid_height_and_same_camera_rejected(self):
        for h in [float('nan'),float('inf'),-1000,1000]:
            with self.assertRaises(ValueError):
                self.project.height_point(self.obs,'SYNTH_B',h)
        with self.assertRaises(ValueError):
            self.project.height_point(self.obs,'SYNTH_A',20)

    def test_legacy_session_remains_compatible_and_building_ground_is_preserved(self):
        legacy=json.loads((ROOT/'tests/fixtures/legacy-session.json').read_text(encoding='utf-8'))
        result=self.project.normalize_session(legacy)
        self.assertEqual(len(result['points']),len(legacy['points']))
        self.assertEqual(result['features'][0]['point_ids'],legacy['features'][0]['point_ids'])
        for before,after in zip(legacy['points'],result['points']):
            self.assertLess(math.dist(before['xyz'],after['xyz']),1e-6)
        ground=next(p['id'] for p in result['points'] if p['kind']=='ground')
        result['features'][0]['ground_reference']=ground
        normalized=self.project.normalize_session(result)
        self.assertEqual(normalized['features'][0]['ground_reference'],ground)


if __name__=='__main__':unittest.main()
