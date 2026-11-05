'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const S=require('../web/spatial.js'),project=require('./fixtures/project.json');
function fixture() {
  const elements=new Map(),events={};
  function element(id) {
    if(!elements.has(id)) elements.set(id,{value:id==='heightStep'?'0.5':'',classList:{toggle(){},add(){},remove(){}},
      getContext:()=>({}),getBoundingClientRect:()=>({left:0,top:0,width:400,height:300}),setPointerCapture(){},
      addEventListener(name,handler){(events[id]??={})[name]=handler;}});
    return elements.get(id);
  }
  const q=S.project(project,'SYNTH_A',[10,5,20]),obs={image_id:'SYNTH_A',x:q[0],y:q[1]};
  const sandbox={Spatial:S,sourceProject:project,sourceObs:obs,ResizeObserver:class{observe(){}},document:{getElementById:element}};
  const source=fs.readFileSync(require('node:path').join(__dirname,'../web/app.js'),'utf8').replace(/^initialize\(\);\s*$/m,'');
  vm.runInNewContext(source+`
    globalThis.Photo=PhotoView;
    globalThis.prepare=(list,method='guided',lock=false)=>{
      project=sourceProject;session={points:[],features:[],ground_reference:null};views=list;
      matchingMethod=method;mode=lock?'building':'ground';drawingMethod=lock?'height_locked':'vertices';lockedHeight=lock?20:null;
      observations=[sourceObs,null];guideHeight=20;candidate=null;hoverCandidate=null;renderLive=()=>{};
    };
    globalThis.state=()=>({candidate,hoverCandidate});globalThis.hover=hoverAt;
  `,sandbox);
  const a=new sandbox.Photo('left',0),b=new sandbox.Photo('right',1);
  for(const [view,id] of [[a,'SYNTH_A'],[b,'SYNTH_B']]){view.id=id;view.img={};view.w=400;view.h=300;view.scale=.7;view.draw=()=>{};}
  sandbox.prepare([a,b]);
  return {a,b,events,sandbox,obs};
}
test('wheel always zooms; Shift wheel changes the guide height without zooming',()=>{
  const {a,b,events,sandbox}=fixture();
  const e={clientX:200,clientY:150,deltaY:-100,shiftKey:false,preventDefault(){}};
  const old=b.scale;events.rightCanvas.wheel(e);assert.ok(b.scale>old);assert.equal(sandbox.state().candidate,null);
  const scale=b.scale;events.rightCanvas.wheel({...e,shiftKey:true});
  assert.equal(b.scale,scale);assert.equal(sandbox.state().candidate.xyz[2],20.5);
  sandbox.prepare([a,b],'stereo');const before=b.scale;events.rightCanvas.wheel(e);assert.ok(b.scale>before);
});
test('ordinary drag pans while Shift drag adjusts only the guide',()=>{
  const {b,events,sandbox,obs}=fixture(),ev=events.rightCanvas;
  ev.pointerdown({button:0,clientX:100,clientY:100,pointerId:1,shiftKey:false});
  ev.pointermove({clientX:125,clientY:115});ev.pointerup({clientX:125,clientY:115});
  assert.deepEqual(Array.from(b.pan),[25,15]);
  const first=S.heightPoint(project,obs,'SYNTH_B',20).observations[1],last=S.heightPoint(project,obs,'SYNTH_B',40).observations[1];
  b.pan=[200-first.x*b.scale,150-first.y*b.scale];const pan=[...b.pan];
  const target=b.toScreen([last.x,last.y]);
  ev.pointerdown({button:0,clientX:200,clientY:150,pointerId:1,shiftKey:true});
  ev.pointermove({clientX:target[0],clientY:target[1]});ev.pointerup({clientX:target[0],clientY:target[1]});
  assert.deepEqual(Array.from(b.pan),pan);assert.ok(Math.abs(sandbox.state().candidate.xyz[2]-40)<1e-4);
});
test('B follows a valid offscreen roof cursor while its image scale stays fixed',()=>{
  const {a,b,sandbox,obs}=fixture();sandbox.prepare([a,b],'stereo',true);
  const scale=b.scale;sandbox.hover(obs);
  const pixel=sandbox.state().hoverCandidate.projections.SYNTH_B,p=b.toScreen(pixel);
  assert.ok(p[0]>=35&&p[0]<=365&&p[1]>=35&&p[1]<=265);assert.equal(b.scale,scale);
});
