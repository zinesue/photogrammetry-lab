'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const S=require('../web/spatial.js');
const project=require('./fixtures/project.json');
const obsFor=xyz=>{const q=S.project(project,'SYNTH_A',xyz);return {image_id:'SYNTH_A',x:q[0],y:q[1]};};
test('a height-constrained point stays on A and its cursor agrees in B',()=>{
  const xyz=[10,5,20], obs=obsFor(xyz);
  const point=S.heightPoint(project,obs,'SYNTH_B',20,'height_locked');
  assert.ok(Math.hypot(...point.xyz.map((v,i)=>v-xyz[i]))<1e-7);
  const b=S.project(project,'SYNTH_B',xyz);
  assert.ok(Math.hypot(point.observations[1].x-b[0],point.observations[1].y-b[1])<1e-7);
  assert.equal(point.reprojection_rms_px,null);
  assert.equal(point.method,'height_locked');
});
test('adjusting height changes spatial position while A stays fixed',()=>{
  const obs=obsFor([10,5,20]);
  const a=S.heightPoint(project,obs,'SYNTH_B',10), b=S.heightPoint(project,obs,'SYNTH_B',30);
  assert.equal(a.xyz[2],10);assert.equal(b.xyz[2],30);
  assert.ok(Math.hypot(a.xyz[0]-b.xyz[0],a.xyz[1]-b.xyz[1])>.01);
  assert.ok(Math.hypot(...S.project(project,'SYNTH_A',a.xyz).map((v,i)=>v-[obs.x,obs.y][i]))<1e-7);
  const samples=S.guide(project,obs,'SYNTH_B'), first=samples[0], last=samples.at(-1), q=b.observations[1];
  const distance=Math.abs((last.x-first.x)*(q.y-first.y)-(last.y-first.y)*(q.x-first.x))/Math.hypot(last.x-first.x,last.y-first.y);
  assert.ok(distance<1e-7);
});
test('drag projection recovers the height on the epipolar line',()=>{
  const obs=obsFor([10,5,20]);
  for(const h of [0,20,50,100]) {
    const point=S.heightPoint(project,obs,'SYNTH_B',h), q=point.observations[1];
    assert.ok(Math.abs(S.heightForPixel(project,obs,'SYNTH_B',[q.x,q.y])-h)<1e-4);
  }
});
test('concave roofs are triangulated without filling the missing corner',()=>{
  const roof=[[0,0,5],[4,0,5],[4,1,5],[1,1,5],[1,4,5],[0,4,5]];
  for(const ring of [roof,[...roof].reverse()]) {
    const triangles=S.triangulate(ring);assert.equal(triangles.length,4);
    const area=triangles.reduce((s,ids)=>{const [a,b,c]=ids.map(i=>ring[i]);return s+Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;},0);
    assert.equal(area,7);
  }
});
test('walls end at the building-specific ground elevation',()=>{
  const points=[{id:'G1',kind:'ground',xyz:[0,0,0]},{id:'G2',kind:'ground',xyz:[0,0,2]},...[[0,0,5],[4,0,5],[4,4,5],[0,4,5]].map((xyz,i)=>({id:'P'+i,kind:'building',xyz}))];
  const scene={points,ground_reference:'G1'}, feature={closed:true,point_ids:['P0','P1','P2','P3'],ground_reference:'G2'};
  const faces=S.buildingFaces(scene,feature), walls=faces.filter(f=>f.kind==='wall');
  assert.equal(walls.length,4);assert.equal(faces.filter(f=>f.kind==='roof').length,2);
  for(const f of walls) {assert.equal(f.vertices[2][2],2);assert.equal(f.vertices[3][2],2);}
  assert.equal(S.buildingFaces(scene,{...feature,closed:false}).length,0);
  assert.equal(S.buildingFaces({...scene,ground_reference:null},{...feature,ground_reference:null}).length,0);
});

test('TIN interpolates heights inside its hull and does not extrapolate outside',()=>{
  const terrain={vertices:[[0,-440,10],[10,-440,20],[0,-430,30]],triangles:[[0,1,2]]};
  assert.equal(S.terrainAt(terrain,0,-440),10);
  assert.equal(S.terrainAt(terrain,2,-437),18);
  assert.equal(S.terrainAt(terrain,20,-420),null);
  const scene={points:[{id:'P1',kind:'ground',xyz:[0,0,1]}],terrain:{...terrain,source_points:[{id:'P1',kind:'ground',xyz:[0,0,1]}]}};
  assert.equal(S.terrainStale(scene),false);
  scene.points.push({id:'P2',kind:'ground',xyz:[5,5,3]});
  assert.equal(S.terrainStale(scene),true);
  assert.equal(scene.terrain.vertices.length,3);
});

test('all walls share the footprint minimum without subdivisions at TIN slope breaks',()=>{
  const terrain={vertices:[[0,0,0],[10,0,0],[10,10,0],[0,10,0],[5,5,8]],triangles:[[0,1,4],[1,2,4],[2,3,4],[3,0,4]]};
  const roof=[[1,5,20],[9,5,20],[9,8,20],[1,8,20]],points=[{id:'G1',kind:'ground',xyz:[0,0,2]},
    ...roof.map((xyz,i)=>({id:'P'+i,kind:'building',xyz}))];
  const scene={points,terrain,ground_reference:'G1'},feature={point_ids:['P0','P1','P2','P3'],closed:true,ground_reference:'G1'};
  assert.ok(Math.abs(S.groundAt(scene,feature,5,5)-8)<1e-8);
  assert.equal(S.groundAt(scene,feature,12,5),2,'outside the mesh the selected ground is the fallback');
  const walls=S.buildingFaces(scene,feature).filter(f=>f.kind==='wall');
  assert.equal(walls.length,4,'one wall face per roof edge, without TIN subdivisions');
  for(const wall of walls) {
    assert.ok(Math.abs(wall.vertices[2][2]-1.6)<1e-7);
    assert.ok(Math.abs(wall.vertices[3][2]-1.6)<1e-7);
  }
  const heights=S.featureHeights(scene,feature);
  assert.ok(Math.abs(heights.wall[0]-18.4)<1e-7);
  assert.equal(heights.wall[0],heights.wall[1],'a flat roof has one wall length');
});
test('footprint minimum includes interior terrain valleys but excludes unrelated low terrain',()=>{
  const terrain={vertices:[[0,0,10],[10,0,10],[10,10,10],[0,10,10],[5,5,-5],
    [100,100,-100],[110,100,-100],[100,110,-100]],triangles:[[0,1,4],[1,2,4],[2,3,4],[3,0,4],[5,6,7]]};
  const roof=[[2,2,20],[8,2,20],[8,8,20],[2,8,20]],points=roof.map((xyz,i)=>({id:'P'+i,kind:'building',xyz}));
  const scene={points,terrain},feature={point_ids:['P0','P1','P2','P3'],closed:true};
  assert.equal(S.buildingBase(scene,feature),-5);
  assert.ok(roof.every(p=>S.terrainAt(terrain,p[0],p[1])>-5),'minimum is not at a roof corner');
  assert.deepEqual(S.featureHeights(scene,feature).wall,[25,25]);
});
test('footprint boundary crossings find the minimum, including concave and reversed rings',()=>{
  const terrain={vertices:[[0,0,10],[10,0,10],[10,10,10],[0,10,10],[5,5,-10]],triangles:[[0,1,4],[1,2,4],[2,3,4],[3,0,4]]};
  const check=(roof,expected)=>{
    for(const ring of [roof,[...roof].reverse()]) {
      const points=ring.map((xyz,i)=>({id:'P'+i,kind:'building',xyz}));
      const feature={point_ids:points.map(p=>p.id),closed:true};
      assert.ok(Math.abs(S.buildingBase({points,terrain},feature)-expected)<1e-7);
    }
  };
  check([[1,6,20],[9,6,20],[9,8,20],[1,8,20]],-6);
  check([[1,1,20],[9,1,20],[9,3,20],[3,3,20],[3,9,20],[1,9,20]],-2);
});
test('a building beyond the terrain uses its selected ground, and partial overlap uses the terrain minimum',()=>{
  const terrain={vertices:[[0,0,4],[10,0,4],[0,10,4]],triangles:[[0,1,2]]};
  const points=[{id:'G1',kind:'ground',xyz:[0,0,1]},{id:'G2',kind:'ground',xyz:[0,0,2]}];
  const scene={points,terrain,ground_reference:'G1'},feature={closed:true,ground_reference:'G2'};
  assert.equal(S.buildingBase(scene,feature,[[20,20,20],[30,20,20],[20,30,20]]),2);
  assert.equal(S.buildingBase(scene,feature,[[-5,-5,20],[5,-5,20],[5,5,20],[-5,5,20]]),4);
});
test('contours intersect the TIN at exact elevations with no duplicate shared edges',()=>{
  const terrain={vertices:[[0,-440,0],[10,-440,10],[10,-430,10],[0,-430,0]],triangles:[[0,1,2],[0,2,3]]};
  const levels=S.terrainContours(terrain,2);
  assert.deepEqual(levels.map(l=>l.height),[0,2,4,6,8,10]);
  for(const level of levels) {
    const keys=new Set();
    for(const segment of level.segments) {
      const key=segment.map(p=>p.join(',')).sort().join('|');assert.ok(!keys.has(key));keys.add(key);
      for(const p of segment) {assert.equal(p[2],level.height);assert.ok(Math.abs(S.terrainAt(terrain,p[0],p[1])-p[2])<1e-7);}
    }
  }
  assert.ok(S.terrainContours(terrain,5).length<levels.length);
  assert.throws(()=>S.terrainContours(terrain,0));assert.throws(()=>S.terrainContours(terrain,NaN));
  assert.throws(()=>S.terrainContours({...terrain,vertices:terrain.vertices.map(p=>[p[0],p[1],p[2]*100])},.1),/500/);
});
test('contour plateaus show only their perimeter, and a touched vertex creates no spurious line',()=>{
  const terrain={vertices:[[0,0,5],[10,0,5],[10,10,5],[0,10,5]],triangles:[[0,1,2],[0,2,3]]};
  const levels=S.terrainContours(terrain,1);assert.equal(levels.length,1);assert.equal(levels[0].segments.length,4);
  assert.ok(levels[0].segments.every(([a,b])=>a[0]===b[0]||a[1]===b[1]));
  const pointed={vertices:[[0,0,5],[10,0,1],[0,10,1]],triangles:[[0,1,2]]};
  assert.ok(!S.terrainContours(pointed,1).some(l=>l.height===5));
  assert.deepEqual(S.terrainContours(null,1),[]);
});
