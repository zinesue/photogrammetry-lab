'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual ModelView drawing code with a recording canvas.
// No HTTP calls, browser session, or stored measurements are changed.
function fixture() {
  const labels = new Map(), paths = [], arcs = [], events = new Map(), paint = [];
  let currentPath = [];
  const context = {
    clearRect() {labels.clear(); paths.length = 0; arcs.length = 0;paint.length=0;},
    setTransform() {}, setLineDash() {}, fill() {paint.push({kind:'fill',style:this.fillStyle,path:currentPath.slice()});}, closePath() {}, arc(x,y,r) {arcs.push([x,y,r]);},
    beginPath() {currentPath = [];},
    moveTo(x, y) {currentPath.push([x, y]);},
    lineTo(x, y) {currentPath.push([x, y]);},
    stroke() {paths.push(currentPath.slice());paint.push({kind:'stroke',style:this.strokeStyle,path:currentPath.slice()});},
    fillText(text, x, y) {labels.set(text, [x, y]);},
  };
  const elements = new Map();
  const canvas = {
    getContext: () => context,
    getBoundingClientRect: () => ({width: 800, height: 360}),
    addEventListener(name, handler) {events.set(name,handler);},
    setPointerCapture() {}, classList:{toggle() {}},
  };
  elements.set('modelCanvas', canvas);
  const sandbox = {
    Spatial: require('../web/spatial.js'),
    window: {devicePixelRatio: 1},
    ResizeObserver: class {observe() {}},
    document: {createTextNode: text=>({textContent:text}),createElement: ()=>({getContext:()=>null}),getElementById(id) {
      if (!elements.has(id)) elements.set(id, {classList: {toggle() {},add() {}}, textContent: '',replaceChildren() {},append() {}});
      return elements.get(id);
    }},
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  vm.runInNewContext(source.replace(/^initialize\(\);\s*$/m, '') + `
    globalThis.testModelView = ModelView;
    globalThis.setTestPoints = points => {
      session = {points, features: [], ground_reference: null};
    };
    globalThis.setTestLive = (point, window, sourceProject) => {
      candidate = point; liveRayWindow = window; project = sourceProject;
      views = point.observations.map(obs=>({id:obs.image_id}));
    };
    globalThis.renderTestResult = renderResult;
    globalThis.setTestSession = value => session=value;
    globalThis.setTestOptions = value => {
      terrainVisible=value.terrain??true; contoursVisible=value.contours??false;
      contourInterval=value.interval??1; buildingHeightsVisible=value.buildingHeights??false;
      terrainHeightsVisible=value.terrainHeights??false; pointNumbersVisible=value.numbers??true;
    };
  `, sandbox);
  const points = [
    {id: 'P001', kind: 'building', xyz: [0, -440, 20]},
    {id: 'P002', kind: 'building', xyz: [10, -440, 20]},
    {id: 'P003', kind: 'building', xyz: [0, -430, 20]},
    {id: 'P004', kind: 'building', xyz: [0, -440, 25]},
  ];
  sandbox.setTestPoints(points);
  const model = new sandbox.testModelView();
  model.resize();
  return {model, labels, paths, arcs, elements, sandbox, events,paint};
}

test('top view puts east to the right and north upwards', () => {
  const {labels, elements} = fixture();
  elements.get('topViewBtn').onclick();
  assert.ok(labels.get('P002')[0] > labels.get('P001')[0]);
  assert.ok(labels.get('P003')[1] < labels.get('P001')[1]);
  assert.ok(Math.abs(labels.get('P004')[1] - labels.get('P001')[1]) < 1e-8);
});

test('rotating an elevated view preserves the above-ground handedness', () => {
  const {model, labels} = fixture();
  for (const yaw of [-Math.PI, -1.5, -.55, 0, 1.5, Math.PI]) {
    for (const pitch of [.08, .65, Math.PI / 2]) {
      model.yaw = yaw; model.pitch = pitch; model.draw();
      const a = labels.get('P001'), b = labels.get('P002'), c = labels.get('P003');
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      assert.ok(cross < 0, `mirrored view at yaw=${yaw}, pitch=${pitch}`);
    }
  }
});

test('height rises on screen while the north indicator follows actual north', () => {
  const {model, labels, paths} = fixture();
  for (const yaw of [-2, -.55, 0, 2]) for(const pitch of [-.65,.65]) {
    model.yaw = yaw; model.pitch = pitch; model.draw();
    assert.ok(labels.get('P004')[1] < labels.get('P001')[1]);
    const origin = labels.get('P001'), north = labels.get('P003');
    const [base, tip] = paths.at(-1);
    const a = [north[0] - origin[0], north[1] - origin[1]];
    const b = [tip[0] - base[0], tip[1] - base[1]];
    assert.ok(a[0] * b[0] + a[1] * b[1] > 0);
    assert.ok(Math.abs(a[0] * b[1] - a[1] * b[0]) < 1e-7);
  }
});

test('the candidate visibly moves up while the ray-based frame stays fixed', () => {
  const {model, paths, arcs, sandbox} = fixture();
  const Spatial = require('../web/spatial.js'), p = require('./fixtures/project.json');
  const pixel = Spatial.project(p,'SYNTH_A',[10,5,20]);
  const obs = {image_id:'SYNTH_A',x:pixel[0],y:pixel[1]}, window = {observation:obs,low:5,high:35};
  sandbox.setTestPoints([]);
  sandbox.setTestLive(Spatial.heightPoint(p,obs,'SYNTH_B',20),window,p);model.draw();
  const a=[...arcs.at(-1)], grid=JSON.stringify(paths[0]);
  sandbox.setTestLive(Spatial.heightPoint(p,obs,'SYNTH_B',25),window,p);model.draw();
  const b=arcs.at(-1);
  assert.ok(b[1]<a[1]-1,'changing height must move the candidate on the screen');
  assert.equal(JSON.stringify(paths[0]),grid,'automatic framing must not follow the moving point');
});

test('live delta height follows the terrain under the moving candidate, even with terrain hidden',()=>{
  const {model,labels,elements,sandbox}=fixture(),S=require('../web/spatial.js'),p=require('./fixtures/project.json');
  const pixel=S.project(p,'SYNTH_A',[10,5,30]),obs={image_id:'SYNTH_A',x:pixel[0],y:pixel[1]};
  const scene={points:[{id:'G1',kind:'ground',xyz:[0,-40,2]}],features:[],ground_reference:'G1',
    terrain:{vertices:[[0,-40,10],[100,-40,20],[0,60,30]],triangles:[[0,1,2]]}};
  sandbox.setTestSession(scene);
  for(const height of [15,30,40]) {
    const point=S.heightPoint(p,obs,'SYNTH_B',height),[x,y,z]=point.xyz;
    const ground=10+x*.1+(y+40)*.2,delta=z-ground;
    sandbox.setTestLive(point,{observation:obs,low:5,high:50},p);
    sandbox.setTestOptions({terrain:false,contours:false});model.draw();sandbox.renderTestResult();
    assert.ok(labels.has(`지형 대비 ΔH ${delta.toFixed(2)} m`));
    assert.equal(elements.get('relativeHeight').textContent,delta.toFixed(2)+' m');
    assert.equal(elements.get('relativeHeightLabel').textContent,'바로 아래 지형과의 높이 차이');
    assert.ok(![...labels.keys()].some(t=>t.startsWith('기준 지면점 대비 ΔH')));
  }
  scene.ground_reference=null;model.draw();
  assert.ok([...labels.keys()].some(t=>t.startsWith('지형 대비 ΔH')),'terrain comparison does not require a reference ground point');
});

test('live delta height falls back to the selected ground only outside the terrain or without a terrain',()=>{
  const {model,labels,elements,sandbox}=fixture(),S=require('../web/spatial.js'),p=require('./fixtures/project.json');
  const pixel=S.project(p,'SYNTH_A',[10,5,30]),obs={image_id:'SYNTH_A',x:pixel[0],y:pixel[1]};
  const scene={points:[{id:'G1',kind:'ground',xyz:[0,-40,2]}],features:[],ground_reference:'G1',
    terrain:{vertices:[[0,0,10],[10,0,20],[0,10,30]],triangles:[[0,1,2]]}};
  sandbox.setTestSession(scene);sandbox.setTestOptions({terrain:false,contours:false});
  sandbox.setTestLive(S.heightPoint(p,obs,'SYNTH_B',30),{observation:obs,low:15,high:45},p);
  model.draw();sandbox.renderTestResult();
  assert.ok(labels.has('기준 지면점 대비 ΔH 28.00 m'));
  assert.match(elements.get('relativeHeight').title,/지형 범위 밖/);
  assert.equal(elements.get('relativeHeightLabel').textContent,'기준 지면점 G1과의 높이 차이');
  scene.terrain=null;model.draw();sandbox.renderTestResult();
  assert.ok(labels.has('기준 지면점 대비 ΔH 28.00 m'));
  assert.equal(elements.get('relativeHeight').title,'');
  scene.ground_reference=null;model.draw();sandbox.renderTestResult();
  assert.ok(![...labels.keys()].some(t=>t.includes('ΔH')));
  assert.equal(elements.get('relativeHeight').textContent,'—');
});

test('Shift drag moves geometry together without rotating and whole-view restores framing', () => {
  const {model,labels,elements,events,sandbox}=fixture();
  const before=Array.from(labels.get('P001')), yaw=model.yaw, pitch=model.pitch;
  events.get('pointerdown')({button:0,shiftKey:true,clientX:100,clientY:100,pointerId:1,preventDefault(){}});
  events.get('pointermove')({clientX:175,clientY:65});
  events.get('pointerup')();
  assert.deepEqual(Array.from(labels.get('P001')),[before[0]+75,before[1]-35]);
  assert.equal(model.yaw,yaw);assert.equal(model.pitch,pitch);
  const held=Array.from(model.manualFrame.centre);
  sandbox.setTestPoints([{id:'P001',kind:'building',xyz:[0,-440,20]},
    {id:'P002',kind:'building',xyz:[500,-440,20]}]);
  model.draw();
  assert.deepEqual(Array.from(model.frame.centre),held,'new geometry must not recenter a manually moved view');
  assert.deepEqual(Array.from(labels.get('P001')),[before[0]+75,before[1]-35]);
  elements.get('modelFit').onclick();
  assert.equal(model.manualFrame,null);assert.deepEqual(Array.from(model.pan),[0,0]);
  assert.ok(model.frame.span>=500);
});

test('ordinary dragging still rotates and wheel zoom keeps the chosen frame', () => {
  const {model,events}=fixture();
  const before=model.yaw;
  events.get('pointerdown')({button:0,shiftKey:false,clientX:100,clientY:100,pointerId:1,preventDefault(){}});
  events.get('pointermove')({clientX:150,clientY:110});
  events.get('lostpointercapture')();
  assert.ok(model.yaw>before);assert.equal(model.drag,null);
  assert.deepEqual(Array.from(model.pan),[0,0]);
  const frame=JSON.stringify(model.manualFrame);
  events.get('wheel')({deltaY:-200,preventDefault(){}});
  assert.ok(model.zoom>1);assert.equal(JSON.stringify(model.manualFrame),frame);
});

test('vertical dragging crosses the horizon to view from below, and presets restore the view',()=>{
  const {model,labels,events,elements}=fixture();
  const down=e=>events.get('pointerdown')({button:0,shiftKey:false,clientX:100,clientY:e,pointerId:1,preventDefault(){}});
  down(300);events.get('pointermove')({clientX:100,clientY:50});events.get('pointerup')();
  assert.ok(model.pitch<0,'upward dragging must continue below the horizon');
  const a=labels.get('P001'),b=labels.get('P002'),c=labels.get('P003');
  assert.ok((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])>0,'looking up must show the actual underside orientation');
  assert.ok(labels.get('P004')[1]<a[1],'higher points still project upward from below');
  down(300);events.get('pointermove')({clientX:100,clientY:-1000});events.get('pointerup')();
  assert.equal(model.pitch,-Math.PI/2);
  down(0);events.get('pointermove')({clientX:100,clientY:1000});events.get('pointerup')();
  assert.equal(model.pitch,Math.PI/2);
  elements.get('isometricBtn').onclick();assert.equal(model.pitch,.65);assert.equal(model.yaw,-.55);
  elements.get('topViewBtn').onclick();assert.equal(model.pitch,Math.PI/2);assert.equal(model.yaw,0);
});

test('grid covers new ground points even after the user fixes the camera', () => {
  const {model,sandbox}=fixture();model.holdFrame();
  const old=model.gridExtent.high[0];
  sandbox.setTestPoints([{id:'P001',kind:'ground',xyz:[0,-440,20]},
    {id:'P002',kind:'ground',xyz:[300,-440,20]}]);model.draw();
  assert.ok(model.gridExtent.high[0]>old);assert.ok(model.gridExtent.high[0]>=300);
});

test('terrain and flat-roof wall-height labels can be shown independently', () => {
  const {model,labels,paths,sandbox}=fixture();
  const points=[{id:'P001',kind:'ground',xyz:[0,0,10]},
    {id:'P002',kind:'building',xyz:[0,0,20]}, {id:'P003',kind:'building',xyz:[10,0,20]},
    {id:'P004',kind:'building',xyz:[0,10,20]}];
  sandbox.setTestSession({points,features:[{id:'B001',label:'건물 1',point_ids:['P002','P003','P004'],closed:true}],ground_reference:'P001',
    terrain:{vertices:[[0,0,10],[10,0,10],[0,10,10]],triangles:[[0,1,2]],source_points:[points[0]]}});
  sandbox.setTestOptions({terrain:true,buildingHeights:true});model.draw();
  assert.ok([...labels.keys()].some(label=>label.includes('벽면 길이 10.00 m')));
  assert.ok([...labels.keys()].some(label=>label.includes('지붕 높이 20.00 m')));
  assert.ok(![...labels.keys()].some(label=>label.includes('지면 높이')));
  const withTerrain=model.scene.triangles.length;
  sandbox.setTestOptions({terrain:false,terrainHeights:true});model.draw();
  assert.ok(![...labels.keys()].some(label=>label.includes('벽면 길이')));
  assert.ok([...labels.keys()].some(label=>label.includes('P001 · 지면 높이 10.00 m')));
  assert.ok(model.scene.triangles.length<withTerrain);
});

function layeredScene() {
  const points=[{id:'G1',kind:'ground',xyz:[0,0,0]},
    ...[[2,2,20],[8,2,20],[8,8,20],[2,8,20]].map((xyz,i)=>({id:'P'+i,kind:'building',xyz}))];
  return {points,ground_reference:'G1',features:[{id:'B1',label:'건물 1',point_ids:['P0','P1','P2','P3'],closed:true}],
    terrain:{vertices:[[0,0,0],[10,0,10],[10,10,10],[0,10,0]],triangles:[[0,1,2],[0,2,3]],source_points:[points[0]]}};
}
test('buried walls are exposed from below and hidden from above by actual surface depth',()=>{
  const {model,sandbox}=fixture();sandbox.setTestSession(layeredScene());
  sandbox.setTestOptions({contours:true,interval:2});model.yaw=0;
  model.pitch=-1.1;model.draw();
  assert.equal(model.scene.visible([7,2,4]),true,'below-ground wall is in front of the terrain when looking up');
  assert.equal(model.scene.visible([7,2,8]),false,'above-ground wall is behind terrain when looking up');
  model.pitch=1.1;model.draw();
  assert.equal(model.scene.visible([7,2,4]),false,'terrain hides the same buried wall from above');
  assert.equal(model.scene.visible([7,2,8]),true,'above-ground wall remains visible from above');
  assert.equal(model.scene.triangles.filter(t=>t.kind==='terrain').length,2);
  assert.equal(model.scene.triangles.filter(t=>t.kind==='wall').length,8);
});

test('hiding terrain while looking up leaves the building surface visible',()=>{
  const {model,sandbox}=fixture();sandbox.setTestSession(layeredScene());
  sandbox.setTestOptions({terrain:false,contours:false});model.pitch=-.65;model.draw();
  assert.equal(model.scene.triangles.filter(t=>t.kind==='wall').length,8);
  assert.equal(model.scene.triangles.length,10,'only four walls and two roof triangles');
  assert.equal(model.scene.lines.filter(l=>l.colour.join(',')==='126,113,59,255').length,0);
});
test('contours toggle independently, their interval changes, and labels hide point numbers',()=>{
  const {model,sandbox,labels}=fixture();sandbox.setTestSession(layeredScene());
  sandbox.setTestOptions({terrain:false,contours:true,interval:2,terrainHeights:true,numbers:false});model.draw();
  const contourCount=()=>model.scene.lines.filter(l=>l.colour.join(',')==='126,113,59,255').length;
  const dense=contourCount();
  assert.ok(dense>0);assert.ok([...labels.keys()].some(t=>t.includes('등고선 2.00 m')));
  assert.ok([...labels.keys()].some(t=>t==='지면 높이 0.00 m'));
  assert.ok(![...labels.keys()].some(t=>/^(G1|P[0-3])/.test(t)));
  sandbox.setTestOptions({terrain:false,contours:true,interval:5});model.draw();
  assert.ok(contourCount()<dense);
  sandbox.setTestOptions({terrain:false,contours:false,numbers:false});model.draw();
  assert.equal(contourCount(),0);
  assert.ok(![...labels.keys()].some(t=>/^(G1|P[0-3])/.test(t)));
});
