import copy
import math
import random
import unittest
from project_fixture import fixture_project
from terrain import build_terrain


class TerrainTests(unittest.TestCase):
    def points(self, coords):
        return [dict(id=f'P{i+1:03}',kind='ground',xyz=xyz) for i,xyz in enumerate(coords)]

    def test_square_and_centre_cover_convex_hull_once(self):
        points=self.points([[0,-440,10],[10,-440,11],[10,-430,12],
                            [0,-430,11],[5,-435,11]])
        mesh=build_terrain(points)
        self.assertEqual(len(mesh['triangles']),4)
        area=0
        for ids in mesh['triangles']:
            a,b,c=[mesh['vertices'][i] for i in ids]
            area+=abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2
        self.assertAlmostEqual(area,100)
        self.assertEqual({i for t in mesh['triangles'] for i in t},set(range(5)))

    def test_duplicate_xy_are_combined_and_collinear_points_refused(self):
        points=self.points([[0,0,10],[0,0,12],[10,0,11],[0,10,11]])
        self.assertEqual(build_terrain(points)['vertices'][0],[0,0,11])
        for coords in [[[0,0,1],[10,0,2]],[[0,0,1],[10,0,2],[20,0,3]]]:
            with self.assertRaises(ValueError):build_terrain(self.points(coords))

    def test_scattered_points_cover_their_convex_hull_without_missing_vertices(self):
        rng=random.Random(23)
        coords=[[0+rng.random()*200,-440+rng.random()*150,20+rng.random()*5] for _ in range(100)]
        mesh=build_terrain(self.points(coords));xy=sorted((p[0],p[1]) for p in coords)
        cross=lambda a,b,c:(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
        chains=[]
        for values in [xy,list(reversed(xy))]:
            chain=[]
            for p in values:
                while len(chain)>=2 and cross(chain[-2],chain[-1],p)<=0:chain.pop()
                chain.append(p)
            chains.extend(chain[:-1])
        origin=chains[0]
        hull_area=abs(sum(cross(origin,chains[i],chains[(i+1)%len(chains)]) for i in range(len(chains))))/2
        triangle_area=sum(abs(cross(*[mesh['vertices'][i] for i in face]))/2 for face in mesh['triangles'])
        self.assertAlmostEqual(triangle_area,hull_area,places=5)
        self.assertEqual({i for t in mesh['triangles'] for i in t},set(range(100)))

    def test_saved_snapshot_does_not_change_when_ground_points_change(self):
        p,temp=fixture_project();self.addCleanup(temp.cleanup)
        def point(index,xyz):
            u,v=p.project('SYNTH_A',xyz)
            m=p.height_point(dict(image_id='SYNTH_A',x=u,y=v),'SYNTH_B',xyz[2])
            return dict(id=f'P{index:03}',kind='ground',**m)
        points=[point(i+1,xyz) for i,xyz in enumerate([[0,0,20],[20,0,21],
                    [20,20,22],[0,20,21]])]
        session=p.normalize_session({'points':points})
        session['terrain']=build_terrain(session['points'])
        snapshot=copy.deepcopy(session['terrain'])
        session['points'].append(point(5,[10,10,30]))
        saved=p.normalize_session(session)
        self.assertEqual(saved['terrain'],snapshot)
        saved['points']=saved['points'][1:]
        self.assertEqual(p.normalize_session(saved)['terrain'],snapshot)
        fresh=build_terrain(saved['points'])
        self.assertNotEqual(fresh['vertices'],snapshot['vertices'])
        saved['terrain']['triangles'][0][0]=10000
        with self.assertRaises(ValueError):p.normalize_session(saved)

if __name__=='__main__':unittest.main()
