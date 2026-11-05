'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../web/spatial.js');
const ground=[150,185,90,255],wall=[80,160,135,255];
const terrain=[{kind:'terrain',vertices:[[0,0,0],[10,0,10],[10,10,10]],colour:ground},
  {kind:'terrain',vertices:[[0,0,0],[10,10,10],[0,10,0]],colour:ground}];
const building={kind:'wall',vertices:[[2,5,12],[8,5,12],[8,5,2],[2,5,2]],colour:wall};
const view=pitch=>p=>[20+p[0]*3,60-(p[1]*Math.sin(pitch)+p[2]*Math.cos(pitch))*3,-p[1]*Math.cos(pitch)+p[2]*Math.sin(pitch)];
function pixel(image,p) {const i=(Math.floor(p[1])*image.width+Math.floor(p[0]))*4;return Array.from(image.data.slice(i,i+4));}
test('intersection pixels show a buried wall from underneath and terrain from above, independent of drawing order',()=>{
  for(const pitch of [-.7,.7]) for(const faces of [[...terrain,building],[building,...terrain]]) {
    const project=view(pitch),scene=S.depthScene(faces,[],project),image=S.rasterizeDepth(scene,100,100);
    const below=[5,5,3],above=[5,5,7];
    assert.equal(scene.surfaceAt(...project(below)).triangle.kind,pitch<0?'wall':'terrain');
    assert.equal(scene.visible(below),pitch<0);
    assert.equal(scene.visible(above),pitch>0);
    assert.deepEqual(pixel(image,project(below)),pitch<0?wall:ground);
    assert.deepEqual(pixel(image,project(above)),pitch<0?ground:wall);
  }
});
test('terrain edges and contours cannot punch through a nearer wall',()=>{
  const project=view(.7),line={vertices:[[5,0,5],[5,10,5]],colour:[220,20,20,255],width:1};
  const scene=S.depthScene([...terrain,building],[line],project),image=S.rasterizeDepth(scene,100,100);
  const point=[5,5,7];assert.deepEqual(pixel(image,project(point)),wall);
});
test('depth fallback clears and reuses buffers, honours pixel density and clips degenerate faces',()=>{
  const project=view(-.7),scene=S.depthScene([...terrain,building],[],project);
  const image=S.rasterizeDepth(scene,200,200,2);
  const point=project([5,5,3]).map(v=>v*2);assert.deepEqual(pixel(image,point),wall);
  const empty=S.depthScene([{kind:'wall',vertices:[[0,0,0],[0,0,0],[0,0,0]],colour:wall}],[],p=>p);
  assert.equal(empty.visible([0,0,0]),true);
  const cleared=S.rasterizeDepth(empty,200,200,2,image);assert.equal(cleared,image);
  assert.equal(cleared.data.some(v=>v!==0),false);
});
test('the application renders correct intersection pixels when WebGL is unavailable',()=>{
  const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
  const sandbox={Spatial:S,document:{createElement(){
    const context={createImageData(width,height){return {width,height,data:new Uint8ClampedArray(width*height*4)};},putImageData(image){this.image=image;}};
    return {width:0,height:0,getContext(kind){return kind==='2d'?context:null;}};
  }}};
  const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8').replace(/^initialize\(\);\s*$/m,'');
  vm.runInNewContext(source+'\nglobalThis.Renderer=ModelRenderer;',sandbox);
  const renderer=new sandbox.Renderer(),project=view(-.7),scene=S.depthScene([...terrain,building],[],project);
  let image=null;const target={drawImage(canvas){image=canvas.getContext('2d').image;}};
  renderer.render(target,scene,100,100,1);
  assert.equal(renderer.gl,null);assert.deepEqual(pixel(image,project([5,5,3])),wall);
  renderer.render(target,scene,100,100,2);
  assert.equal(image.width,200);assert.equal(image.height,200);
  assert.deepEqual(pixel(image,project([5,5,3]).map(v=>v*2)),wall);
});
