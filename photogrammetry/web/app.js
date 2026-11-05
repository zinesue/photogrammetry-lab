'use strict';
const $ = id => document.getElementById(id);
const fmt = (n, digits = 2) => Number.isFinite(n) ? n.toLocaleString('en-US', {minimumFractionDigits: digits, maximumFractionDigits: digits}) : '—';
const clone = value => JSON.parse(JSON.stringify(value));
let project, session, views, model;
let mode = 'ground', observations = [null, null], candidate = null, selectedId = null;
let activeFeature = null, history = [], measureRevision = 0, guideRevision = 0;
let saveQueue = Promise.resolve(), saveRevision = 0, saveFailed = false, toastTimer;
let matchingMethod = 'stereo', drawingMethod = 'vertices', lockedHeight = null, guideHeight = 20;
let guideTouched = false, hoverCandidate = null, liveRayWindow = null;
let wallsVisible = true, raysVisible = true, wallFeatureId = null;
let terrainVisible = true, contoursVisible = true, contourInterval = 1;
let buildingHeightsVisible = false, terrainHeightsVisible = false, pointNumbersVisible = true;
let modelExpanded = false, terrainBusy = false, syncBusy = false, syncError = false;
const methodName = method => ({stereo:'직접 관측',guided:'가이드 조절',height_locked:'높이 유지'}[method] || '직접 관측');
const imageUrl = (id,thumb=false) => {
  const image=project.images.find(im=>im.id===id);
  return '/api/image/'+encodeURIComponent(id)+'?v='+encodeURIComponent(image?.file_revision||project.revision)+(thumb?'&thumb=1':'');
};
function heightDifference(point) {
  if(!point) return null;
  const [x,y,z]=point.xyz, terrainHeight=Spatial.terrainAt(session.terrain,x,y);
  if(terrainHeight!==null) return {height:terrainHeight,delta:z-terrainHeight,terrain:true};
  const reference=session.points.find(p=>p.id===session.ground_reference&&p.kind==='ground');
  return reference ? {height:reference.xyz[2],delta:z-reference.xyz[2],terrain:false,id:reference.id,outside:Boolean(session.terrain)} : null;
}

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '처리하지 못했습니다.');
  return result;
}
function startWindowLease(enabled) {
  if(!enabled) return;
  const clientId=globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let sequence=0,active=true,channel=null,retry=null;
  const notify=state=>{
    const body=JSON.stringify({client_id:clientId,sequence:++sequence,state,hidden:document.hidden});
    try {if(navigator.sendBeacon?.('/api/window',new Blob([body],{type:'application/json'}))) return;} catch(error) {}
    fetch('/api/window',{method:'POST',headers:{'Content-Type':'application/json'},body,keepalive:true}).catch(()=>{});
  };
  const connect=()=>{
    if(!active||typeof WebSocket!=='function'||channel&&channel.readyState<2) return;
    const socket=new WebSocket(`ws://${window.location.host}/api/window-connection?client_id=${encodeURIComponent(clientId)}`);
    channel=socket;
    socket.onclose=()=>{if(channel!==socket) return;channel=null;if(active) retry=setTimeout(connect,1000);};
    socket.onerror=()=>socket.close();
  };
  notify('open');connect();
  setInterval(()=>{if(active) notify('open');},15000);
  window.addEventListener('pagehide',()=>{active=false;notify('closed');clearTimeout(retry);channel?.close();channel=null;});
  window.addEventListener('pageshow',()=>{active=true;notify('open');connect();});
  document.addEventListener('visibilitychange',()=>{if(active) notify('open');});
}
function toast(message, error = false) {
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  $('toast').classList.toggle('error', error);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), error ? 6500 : 3000);
}
function checkpoint() {
  history.push({session: clone(session), activeFeature, lockedHeight});
  if (history.length > 40) history.shift();
}
function persist() {
  const snapshot = clone(session), revision = ++saveRevision;
  $('saveStatus').textContent = '저장 중…';
  $('saveStatus').classList.remove('error');
  saveQueue = saveQueue.catch(() => {}).then(() => api('/api/session', snapshot)).then(saved => {
    if (revision === saveRevision) {
      for(const key of ['project_revision','calibration_signature','source_cameras','source_images']) session[key]=saved[key];
      saveFailed = false;
      $('saveStatus').textContent = '이 컴퓨터에 저장됨';
      $('saveStatus').classList.remove('error');
    }
  }).catch(error => {
    saveFailed = true;
    $('saveStatus').textContent = '저장 실패 · 다시 시도 필요';
    $('saveStatus').classList.add('error');
    toast('저장하지 못했습니다. ' + error.message, true);
    throw error;
  });
  // Actions can continue while writes are serialized. Attach a rejection observer.
  saveQueue.catch(() => {});
  return saveQueue;
}
function currentFeature() {return session.features.find(f => f.id === activeFeature);}
function nextId(prefix, items) {return prefix + String(Math.max(0, ...items.map(p => Number(p.id.slice(1)))) + 1).padStart(3, '0');}
function lockedDrawing() {return mode === 'building' && drawingMethod === 'height_locked' && Number.isFinite(lockedHeight);}
function liveSource() {return hoverCandidate?.observations[0] || candidate?.observations[0] || observations[0];}
function guideAdjustable(index) {return index === 1 && Boolean(liveSource()) && (matchingMethod === 'guided' || lockedDrawing());}
function setRayWindow(obs, height) {
  const [low, high] = Spatial.bounds(project, obs.image_id, views[1].id);
  if (!liveRayWindow || liveRayWindow.observation.image_id !== obs.image_id || Math.hypot(liveRayWindow.observation.x - obs.x, liveRayWindow.observation.y - obs.y) > .01 || height < liveRayWindow.low || height > liveRayWindow.high) {
    liveRayWindow = {observation: {...obs}, low: Math.max(low, height - 15), high: Math.min(high, height + 15)};
  }
}
function updateHeightControls() {
  $('drawingControls').classList.toggle('hidden', mode !== 'building');
  $('methodControls').classList.toggle('building-layout', mode === 'building');
  const locking = mode === 'building' && drawingMethod === 'height_locked';
  $('groundTools').classList.toggle('hidden',mode!=='ground');
  $('lockedHeight').disabled=project.images.length<2;
  $('drawingExtras').classList.toggle('hidden', !locking);
  $('heightControls').classList.toggle('hidden', !((matchingMethod === 'guided' && observations[0]) || lockedDrawing()));
  if (document.activeElement !== $('guideHeight')) $('guideHeight').value = guideHeight.toFixed(2);
  if (document.activeElement !== $('lockedHeight')) $('lockedHeight').value = Number.isFinite(lockedHeight) ? lockedHeight.toFixed(2) : '';
  $('interactionHint').textContent = lockedDrawing() ? 'A에서 이동하면 B에도 커서가 나타납니다. A 클릭으로 꼭짓점을 추가하세요.' : matchingMethod === 'guided' ? 'A 선택 → B에서 Shift+휠·드래그로 맞추기 → Enter로 저장' : '두 사진에서 같은 지점을 선택합니다.';
}
function renderLive() {renderResult(); updateHeightControls(); views.forEach(v => v.draw()); model?.draw();}
function setGuideHeight(value, touched = true) {
  const obs = liveSource();
  if (!Number.isFinite(value)) {toast('표고를 숫자로 입력하세요.',true);updateHeightControls();return;}
  const [low, high] = Spatial.bounds(project, obs?.image_id || views[0].id, views[1].id);
  guideHeight = Math.max(low, Math.min(high, value));
  if (!obs) {if(lockedDrawing()) lockedHeight=guideHeight;renderLive();return;}
  try {
    if (lockedDrawing()) {
      lockedHeight = guideHeight;
      hoverCandidate = Spatial.heightPoint(project, obs, views[1].id, guideHeight, 'height_locked');
    } else {
      guideTouched = guideTouched || touched;
      candidate = Spatial.heightPoint(project, obs, views[1].id, guideHeight, 'guided');
      candidate.confirmed = guideTouched;
      candidate.save_allowed = candidate.save_allowed && guideTouched;
      observations = [candidate.observations[0], candidate.observations[1]];
    }
    setRayWindow(obs, guideHeight); renderLive();
  } catch (error) {toast(error.message, true);}
}
function adjustHeight(delta) {setGuideHeight((lockedDrawing() ? lockedHeight : guideHeight) + delta);}
function guideAtPixel(pixel) {
  const obs = liveSource(); if (!obs) return;
  setGuideHeight(Spatial.heightForPixel(project, obs, views[1].id, pixel), true);
}
function hoverAt(obs) {
  if (!lockedDrawing()) return;
  try {
    hoverCandidate = Spatial.heightPoint(project, obs, views[1].id, lockedHeight, 'height_locked');
    const pixel=hoverCandidate.projections[views[1].id];
    if(pixel&&hoverCandidate.save_allowed) views[1].ensureVisible(pixel);
    setRayWindow(obs, lockedHeight); renderLive();
  } catch (_) {hoverCandidate = null; renderLive();}
}

class PhotoView {
  constructor(side, index) {
    this.side = side; this.index = index;
    this.canvas = $(side + 'Canvas'); this.ctx = this.canvas.getContext('2d', {alpha: false});
    this.id = null; this.img = null; this.scale = 1; this.pan = [0, 0]; this.hint = [];
    this.pointer = null; this.drag = null; this.w = 0; this.h = 0;
    this.loadToken=0;
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    this.canvas.addEventListener('wheel', event => {
      event.preventDefault(); const p = this.position(event);
      if (guideAdjustable(this.index) && event.shiftKey) {
        adjustHeight(-Math.sign(event.deltaY) * Number($('heightStep').value)); return;
      }
      this.zoom(Math.exp(-event.deltaY * .0015), p);
    }, {passive: false});
    this.canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const p = this.position(event); this.drag = {start: p, pan: [...this.pan], moved: false, guide: guideAdjustable(this.index) && event.shiftKey};
      this.canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener('pointermove', event => {
      const p = this.position(event); this.pointer = p;
      if (this.drag) {
        const delta = [p[0] - this.drag.start[0], p[1] - this.drag.start[1]];
        if (Math.hypot(...delta) > 4) this.drag.moved = true;
        if (this.drag.guide) {guideAtPixel(this.toImage(p)); return;}
        if (this.drag.moved) this.pan = [this.drag.pan[0] + delta[0], this.drag.pan[1] + delta[1]];
      }
      if (!this.drag && this.index === 0 && this.img && lockedDrawing()) {
        const q = this.toImage(p);
        if (q[0] >= 0 && q[1] >= 0 && q[0] < project.camera.width && q[1] < project.camera.height) hoverAt({image_id:this.id,x:q[0],y:q[1]});
      }
      this.draw();
    });
    this.canvas.addEventListener('pointerup', event => {
      if (this.drag?.guide) {guideAtPixel(this.toImage(this.position(event))); this.drag = null; return;}
      if (this.drag && !this.drag.moved && this.img) {
        if(guideAdjustable(this.index)) {this.drag=null;toast('가이드 조절은 Shift+휠 또는 Shift+클릭·드래그를 사용하세요.');return;}
        const q = this.toImage(this.position(event));
        if (q[0] >= 0 && q[0] < project.camera.width && q[1] >= 0 && q[1] < project.camera.height) {
          chooseObservation(this.index, {image_id: this.id, x: q[0], y: q[1]});
        }
      }
      this.drag = null;
    });
    this.canvas.addEventListener('pointercancel', () => this.drag = null);
    this.canvas.addEventListener('lostpointercapture', () => this.drag = null);
    this.canvas.addEventListener('pointerleave', () => {this.pointer = null; this.draw();});
    $(side + 'Fit').onclick = () => this.fit();
    $(side + 'Plus').onclick = () => this.zoom(1.5);
    $(side + 'Minus').onclick = () => this.zoom(1 / 1.5);
  }
  position(event) {const r = this.canvas.getBoundingClientRect(); return [event.clientX - r.left, event.clientY - r.top];}
  toImage(p) {return [(p[0] - this.pan[0]) / this.scale, (p[1] - this.pan[1]) / this.scale];}
  toScreen(p) {return [p[0] * this.scale + this.pan[0], p[1] * this.scale + this.pan[1]];}
  resize() {
    const rect = this.canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
    const old = this.w ? this.toImage([this.w / 2, this.h / 2]) : null;
    const wasFit = !this.w || Math.abs(this.scale / this.fitScale() - 1) < .01;
    this.w = rect.width; this.h = rect.height;
    this.canvas.width = Math.round(this.w * ratio); this.canvas.height = Math.round(this.h * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (wasFit) this.fit();
    else if (old) {this.pan = [this.w / 2 - old[0] * this.scale, this.h / 2 - old[1] * this.scale]; this.draw();}
  }
  fitScale() {return project ? Math.min(this.w / project.camera.width, this.h / project.camera.height) : 1;}
  fit() {
    if (!project) return;
    this.scale = this.fitScale();
    this.pan = [(this.w - project.camera.width * this.scale) / 2, (this.h - project.camera.height * this.scale) / 2];
    this.draw();
  }
  zoom(factor, p = [this.w / 2, this.h / 2]) {
    const q = this.toImage(p);
    this.scale = Math.min(6, Math.max(this.fitScale() * .7, this.scale * factor));
    this.pan = [p[0] - q[0] * this.scale, p[1] - q[1] * this.scale];
    this.draw();
  }
  centerAt(p, scale = .7) {
    this.scale = Math.max(this.fitScale(), scale);
    this.pan = [this.w / 2 - p[0] * this.scale, this.h / 2 - p[1] * this.scale]; this.draw();
  }
  ensureVisible(pixel) {
    if(!this.img||!this.w||!this.h) return;
    const p=this.toScreen(pixel),margin=Math.min(45,this.w*.12,this.h*.12);
    for(let j=0;j<2;j++) {
      const size=j===0?this.w:this.h;
      if(p[j]<margin) this.pan[j]+=margin-p[j];
      else if(p[j]>size-margin) this.pan[j]+=size-margin-p[j];
    }
  }
  clearImage() {
    this.loadToken++;
    this.id=null;this.img=null;this.hint=[];this.pointer=null;
    $(this.side+'Loading').textContent='사진과 EO가 일치하는 영상 두 장이 필요합니다.';
    $(this.side+'Loading').classList.remove('hidden');this.draw();
  }
  async setImage(id) {
    const token=++this.loadToken;
    this.id = id; this.img = null; this.hint = []; this.pointer = null;
    $(this.side + 'Loading').classList.remove('hidden'); this.draw();
    $(this.side+'Loading').textContent='사진을 불러오는 중…';
    const img = new Image();
    const loaded = new Promise((resolve, reject) => {img.onload = resolve; img.onerror = () => reject(new Error('사진을 불러오지 못했습니다: ' + id));});
    img.src = imageUrl(id);
    try {await loaded;} catch(error) {if(token!==this.loadToken) return;throw error;}
    if (this.id !== id||token!==this.loadToken) return;
    if (img.naturalWidth !== project.camera.width || img.naturalHeight !== project.camera.height) {
      $(this.side + 'Loading').textContent = '영상 크기가 내부표정요소와 다릅니다.';
      throw new Error('영상 크기와 cam.txt가 일치하지 않습니다.');
    }
    this.img = img; this.fit(); $(this.side + 'Loading').classList.add('hidden');
  }
  marker(pixel, text, color, large = false) {
    const c = this.ctx, [x, y] = this.toScreen(pixel);
    if (x < -40 || y < -40 || x > this.w + 40 || y > this.h + 40) return;
    c.save(); c.strokeStyle = color; c.lineWidth = large ? 1.5 : 1.2;
    c.beginPath(); c.arc(x, y, large ? 8 : 4, 0, Math.PI * 2); c.stroke();
    if (large) {c.beginPath(); c.moveTo(x - 15, y); c.lineTo(x - 3, y); c.moveTo(x + 3, y); c.lineTo(x + 15, y); c.moveTo(x, y - 15); c.lineTo(x, y - 3); c.moveTo(x, y + 3); c.lineTo(x, y + 15); c.stroke();}
    c.font = '10px "Segoe UI", "Malgun Gothic", sans-serif';
    const tw = c.measureText(text).width;
    c.fillStyle = '#173c33dd'; c.fillRect(x + 10, y - 19, tw + 10, 17);
    c.fillStyle = '#fff'; c.fillText(text, x + 15, y - 7); c.restore();
  }
  draw() {
    const c = this.ctx; if (!c || !this.w) return;
    c.clearRect(0, 0, this.w, this.h); c.fillStyle = '#263733'; c.fillRect(0, 0, this.w, this.h);
    $(this.side + 'Zoom').textContent = Math.round(this.scale * 100) + '%';
    if (!this.img) return;
    c.drawImage(this.img, this.pan[0], this.pan[1], project.camera.width * this.scale, project.camera.height * this.scale);
    c.save();
    if (this.hint.length > 1) {
      c.strokeStyle = '#ffbd60'; c.lineWidth = 1.5; c.setLineDash([7, 5]); c.beginPath();
      this.hint.forEach((p, i) => {const q = this.toScreen([p.x, p.y]); if (i) c.lineTo(...q); else c.moveTo(...q);});
      c.stroke(); c.setLineDash([]);
    }
    for (const feature of session?.features || []) {
      const pixels = feature.point_ids.map(id => session.points.find(p => p.id === id)?.projections[this.id]);
      if (pixels.some(p => !p)) continue;
      c.beginPath(); pixels.forEach((p, i) => {const q = this.toScreen(p); i ? c.lineTo(...q) : c.moveTo(...q);});
      if (feature.closed) c.closePath();
      c.strokeStyle = '#72e0ce'; c.lineWidth = 1.5; c.stroke();
    }
    for (const p of session?.points || []) {
      const pixel = p.projections[this.id];
      if (pixel) this.marker(pixel, p.id, p.id === selectedId ? '#fff3ac' : p.kind === 'ground' ? '#a1e9a1' : '#72e0ce', p.id === selectedId);
    }
    const obs = observations[this.index];
    if (obs?.image_id === this.id) this.marker([obs.x, obs.y], this.index === 0 ? 'A 선택' : 'B 선택', this.index === 0 ? '#8ff4d5' : '#ffc36d', true);
    const ghost = hoverCandidate || (candidate?.method === 'guided' ? candidate : null);
    if (ghost?.projections[this.id]) this.marker(ghost.projections[this.id], `${ghost.method === 'height_locked' ? '높이 유지' : '후보'} ${fmt(ghost.xyz[2])} m`, '#ffd47d', true);
    c.restore();
    if (this.pointer && !this.drag?.moved) this.loupe();
  }
  loupe() {
    const p = this.toImage(this.pointer);
    if (p[0] < 0 || p[1] < 0 || p[0] >= project.camera.width || p[1] >= project.camera.height) return;
    const c = this.ctx, size = 112, x = this.w - size - 12, y = 12;
    if (this.pointer[0] > x - 10 && this.pointer[1] < y + size + 15) return;
    c.save(); c.fillStyle = '#203a30'; c.fillRect(x - 2, y - 2, size + 4, size + 22);
    c.beginPath(); c.rect(x, y, size, size); c.clip();
    c.drawImage(this.img, p[0] - 28, p[1] - 28, 56, 56, x, y, size, size);
    c.strokeStyle = '#ffdc81'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(x + size / 2 - 15, y + size / 2); c.lineTo(x + size / 2 + 15, y + size / 2); c.moveTo(x + size / 2, y + size / 2 - 15); c.lineTo(x + size / 2, y + size / 2 + 15); c.stroke(); c.restore();
    c.fillStyle = '#d9e5d9'; c.font = '9px "Segoe UI", sans-serif'; c.fillText('정밀 확인 · 원본 200%', x + 8, y + size + 14);
  }
}

class ModelRenderer {
  initialize() {
    if(!document.createElement) return;
    this.canvas=document.createElement('canvas');
    try {
      const gl=this.failed?null:this.canvas.getContext('webgl',{alpha:true,antialias:true,preserveDrawingBuffer:true});
      if(!gl) throw new Error('Use CPU renderer');
      const shader=(type,source)=>{
        const item=gl.createShader(type);gl.shaderSource(item,source);gl.compileShader(item);
        if(!gl.getShaderParameter(item,gl.COMPILE_STATUS)) throw new Error('Shader unavailable');
        return item;
      };
      const vertex=shader(gl.VERTEX_SHADER,'attribute vec3 position; attribute vec4 colour; varying vec4 rgba; void main(){gl_Position=vec4(position,1.0);rgba=colour;}');
      const fragment=shader(gl.FRAGMENT_SHADER,'precision mediump float; varying vec4 rgba; void main(){gl_FragColor=rgba;}');
      const program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error('Renderer unavailable');
      gl.useProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);
      this.gl=gl;this.program=program;this.buffer=gl.createBuffer();
      this.position=gl.getAttribLocation(program,'position');this.colour=gl.getAttribLocation(program,'colour');
      this.canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();this.failed=true;this.gl=null;this.canvas=null;});
    } catch(error) {
      this.failed=true;this.gl=null;this.canvas=document.createElement('canvas');this.context=this.canvas.getContext('2d');
    }
  }
  render(context,scene,width,height,ratio) {
    if(!this.canvas) this.initialize();
    if(!this.canvas||!context.drawImage) return;
    const w=Math.round(width*ratio),h=Math.round(height*ratio);
    if(this.canvas.width!==w||this.canvas.height!==h) {this.canvas.width=w;this.canvas.height=h;this.bitmap=null;}
    const gl=this.gl;
    if(gl) {
      gl.viewport(0,0,w,h);gl.clearColor(0,0,0,0);gl.clearDepth(1);gl.depthMask(true);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.program);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
      gl.enableVertexAttribArray(this.position);gl.vertexAttribPointer(this.position,3,gl.FLOAT,false,28,0);
      gl.enableVertexAttribArray(this.colour);gl.vertexAttribPointer(this.colour,4,gl.FLOAT,false,28,12);
      const span=Math.max(1,scene.high-scene.low),near=scene.low-span*.1,range=span*1.2;
      const batch=(items,mode)=>{
        const values=[];
        for(const item of items) for(const p of item.vertices) values.push(p[0]/width*2-1,1-p[1]/height*2,1-(p[2]-near)/range*2,...item.colour.map(v=>v/255));
        if(!values.length) return;
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(values),gl.DYNAMIC_DRAW);gl.drawArrays(mode,0,values.length/7);
      };
      gl.enable(gl.POLYGON_OFFSET_FILL);gl.polygonOffset(1,1);
      batch(scene.triangles.filter(t=>t.colour[3]===255),gl.TRIANGLES);
      gl.depthMask(false);
      const transparent=scene.triangles.filter(t=>t.colour[3]<255).sort((a,b)=>a.vertices.reduce((s,p)=>s+p[2],0)-b.vertices.reduce((s,p)=>s+p[2],0));
      batch(transparent,gl.TRIANGLES);gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.depthMask(true);
      for(const lineWidth of new Set(scene.lines.map(l=>l.width||1))) {
        gl.lineWidth(lineWidth*ratio);batch(scene.lines.filter(l=>(l.width||1)===lineWidth),gl.LINES);
      }
      gl.depthMask(true);
    } else {
      this.pixels=Spatial.rasterizeDepth(scene,w,h,ratio,this.pixels);
      if(!this.bitmap) this.bitmap=this.context.createImageData(w,h);
      this.bitmap.data.set(this.pixels.data);this.context.putImageData(this.bitmap,0,0);
    }
    context.drawImage(this.canvas,0,0,width,height);
  }
}

class ModelView {
  constructor() {
    this.canvas = $('modelCanvas'); this.ctx = this.canvas.getContext('2d');
    this.yaw = -.55; this.pitch = .65; this.zoom = 1; this.drag = null;
    this.pan = [0, 0]; this.frame = null; this.manualFrame = null;
    this.renderer=new ModelRenderer();
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    this.canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.button !== 1) return;
      e.preventDefault(); this.holdFrame();
      this.drag = {x:e.clientX,y:e.clientY,yaw:this.yaw,pitch:this.pitch,pan:[...this.pan],moving:e.shiftKey || e.button === 1};
      this.canvas.classList.toggle('is-panning', this.drag.moving);
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', e => {
      if (!this.drag) return;
      const dx=e.clientX-this.drag.x, dy=e.clientY-this.drag.y;
      if (this.drag.moving) this.pan=[this.drag.pan[0]+dx,this.drag.pan[1]+dy];
      else {
        this.yaw=this.drag.yaw+dx*.009;
        this.pitch=Math.max(-Math.PI/2,Math.min(Math.PI/2,this.drag.pitch+dy*.006));
        this.buttons(false);
      }
      this.draw();
    });
    const endDrag = () => {this.drag=null;this.canvas.classList.toggle('is-panning',false);};
    for (const event of ['pointerup','pointercancel','lostpointercapture']) this.canvas.addEventListener(event,endDrag);
    this.canvas.addEventListener('wheel', e => {e.preventDefault();this.holdFrame();this.zoom=Math.max(.25,Math.min(8,this.zoom*Math.exp(-e.deltaY*.001)));this.draw();}, {passive:false});
    $('isometricBtn').onclick = () => {this.yaw = -.55; this.pitch = .65; this.draw(); this.buttons(false);};
    $('topViewBtn').onclick = () => {this.yaw = 0; this.pitch = Math.PI / 2; this.draw(); this.buttons(true);};
    $('modelFit').onclick = () => {this.zoom=1;this.pan=[0,0];this.manualFrame=null;this.draw();};
  }
  holdFrame() {if (!this.manualFrame && this.frame) this.manualFrame={centre:[...this.frame.centre],span:this.frame.span};}
  buttons(top) {$('isometricBtn').classList.toggle('active', !top); $('topViewBtn').classList.toggle('active', top);}
  resize() {
    const rect = this.canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
    this.w = rect.width; this.h = rect.height;
    this.canvas.width = Math.round(this.w * ratio); this.canvas.height = Math.round(this.h * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0); this.draw();
  }
  contours() {
    if(this.contourCache?.terrain!==session.terrain||this.contourCache?.interval!==contourInterval) {
      const cache={terrain:session.terrain,interval:contourInterval,levels:[],error:''};
      try {cache.levels=Spatial.terrainContours(session.terrain,contourInterval);} catch(error) {cache.error=error.message;}
      this.contourCache=cache;
    }
    $('contourStatus').textContent=contoursVisible?this.contourCache.error:'';
    $('contourStatus').classList.toggle('hidden',!contoursVisible||!this.contourCache.error);
    return this.contourCache.levels;
  }
  draw() {
    if (!this.w || !session) return;
    const c = this.ctx; c.clearRect(0, 0, this.w, this.h);
    const live = hoverCandidate || candidate;
    let rayPath = null;
    if (raysVisible && live && liveRayWindow && project) {
      rayPath = [liveRayWindow.low, liveRayWindow.high].map(h=>Spatial.atHeight(project,liveRayWindow.observation,h));
    }
    const faces = wallsVisible ? session.features.flatMap(f=>Spatial.buildingFaces(session,f)) : [];
    const terrain=(terrainVisible||contoursVisible)?session.terrain:null;
    const terrainFaces=terrainVisible&&terrain?terrain.triangles.map(ids=>({kind:'terrain',vertices:ids.map(i=>terrain.vertices[i])})):[];
    const contours=this.contours();
    const pts = session.points.map(p => p.xyz);
    for (const face of faces) pts.push(...face.vertices);
    if(terrain) pts.push(...terrain.vertices);
    // Fixed ray endpoints keep the viewport stable while only the candidate height moves.
    if (rayPath) pts.push(...rayPath); else if (live) pts.push(live.xyz);
    $('modelEmpty').classList.toggle('hidden', pts.length > 0);
    const min = [0, 1, 2].map(j => pts.length ? Math.min(...pts.map(p => p[j])) : 0);
    const max = [0, 1, 2].map(j => pts.length ? Math.max(...pts.map(p => p[j])) : 0);
    const groundValues=session.points.filter(p=>p.kind==='ground').map(p=>p.xyz[2]);
    if(terrain) groundValues.push(...terrain.vertices.map(p=>p[2]));
    const groundH = groundValues.length?Math.min(...groundValues):min[2];
    const centre = this.manualFrame?.centre || [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (Math.min(groundH, min[2]) + max[2]) / 2];
    const span = this.manualFrame?.span || Math.max(20, max[0] - min[0], max[1] - min[1], max[2] - groundH);
    this.frame={centre:[...centre],span};
    const s = Math.min(this.w * .62, this.h * .65) / span * this.zoom;
    const transform = point => {
      const [e, n, h] = point.map((v, j) => v - centre[j]);
      const x = Math.cos(this.yaw) * e - Math.sin(this.yaw) * n;
      const depth = Math.sin(this.yaw) * e + Math.cos(this.yaw) * n;
      // Canvas y grows downwards; north/depth must project upwards when viewed from above.
      return [this.w / 2 + this.pan[0] + x * s, this.h / 2 + this.pan[1] - depth * Math.sin(this.pitch) * s - h * Math.cos(this.pitch) * s];
    };
    const line = (a, b, color, width = 1, dash = []) => {c.strokeStyle = color; c.lineWidth = width; c.setLineDash(dash); c.beginPath(); c.moveTo(...transform(a)); c.lineTo(...transform(b)); c.stroke(); c.setLineDash([]);};
    const gridPoints=session.points.map(p=>p.xyz).concat(terrain?.vertices||[]);
    if(!gridPoints.length&&rayPath) gridPoints.push(...rayPath);
    else if(!gridPoints.length&&live) gridPoints.push(live.xyz);
    const grid=Spatial.gridBounds(gridPoints),step=grid.step;
    this.gridExtent=grid;
    for(let x=grid.low[0];x<=grid.high[0]+step*.01;x+=step) line([x,grid.low[1],groundH],[x,grid.high[1],groundH],'#e1e9de');
    for(let y=grid.low[1];y<=grid.high[1]+step*.01;y+=step) line([grid.low[0],y,groundH],[grid.high[0],y,groundH],'#e1e9de');
    const byId = Object.fromEntries(session.points.map(p => [p.id, p]));
    const featureByPoint=Object.fromEntries(session.features.flatMap(f=>f.point_ids.map(id=>[id,f])));
    const heightByFeature=Object.fromEntries(session.features.map(f=>[f.id,Spatial.featureHeights(session,f)]));
    const towardsViewer = p => {
      const e=p[0]-centre[0], n=p[1]-centre[1], h=p[2]-centre[2];
      return -(Math.sin(this.yaw)*e+Math.cos(this.yaw)*n)*Math.cos(this.pitch)+h*Math.sin(this.pitch);
    };
    const renderFaces=terrainFaces.concat(faces),segments=[];
    const segment=(a,b,colour,width=1)=>segments.push({vertices:[a,b],colour,width});
    for (const face of renderFaces) {
      if(face.kind==='terrain') {
        const z=face.vertices.reduce((s,p)=>s+p[2],0)/face.vertices.length;
        const t=Math.max(0,Math.min(1,(z-min[2])/Math.max(1,max[2]-min[2])));
        face.colour=[Math.round(165+t*40),Math.round(191+t*11),Math.round(129+t*21),255];
      } else if(face.kind==='roof') face.colour='#b6d9c6';
      else {const edge=Spatial.sub(face.vertices[1],face.vertices[0]),light=Math.max(0,Math.min(1,.5+edge[0]/(Math.hypot(edge[0],edge[1])||1)*.25));face.colour=[Math.round(155+light*40),Math.round(188+light*31),Math.round(170+light*33),255];}
      face.vertices.forEach((p,i)=>segment(p,face.vertices[(i+1)%face.vertices.length],'#6c9f8c88',.8));
    }
    if(contoursVisible) for(const level of contours) for(const edge of level.segments) segment(...edge,'#7e713b',1.2);
    for(const f of session.features) {
      const points=f.point_ids.map(id=>byId[id]?.xyz).filter(Boolean);if(points.length<2) continue;
      const count=f.closed?points.length:points.length-1;
      for(let i=0;i<count;i++) segment(points[i],points[(i+1)%points.length],'#249b8a',2);
      if(f.closed&&(!wallsVisible||!Spatial.buildingFaces(session,f).length)) for(const ids of Spatial.triangulate(points)) renderFaces.push({kind:'outline',vertices:ids.map(i=>points[i]),colour:'#36998718'});
    }
    if(!wallsVisible) for(const p of session.points.filter(p=>p.kind==='building')) {
      const feature=featureByPoint[p.id],base=feature?heightByFeature[feature.id]?.base:Spatial.groundAt(session,{},p.xyz[0],p.xyz[1]);
      if(base===null) continue;
      const a=p.xyz,b=[p.xyz[0],p.xyz[1],base],length=Math.hypot(...Spatial.sub(transform(a),transform(b)));
      for(let start=0;start<length;start+=7) segment(Spatial.add(a,Spatial.mul(Spatial.sub(b,a),start/length)),Spatial.add(a,Spatial.mul(Spatial.sub(b,a),Math.min(length,start+3)/length)),'#b8ccc0');
    }
    // A depth buffer resolves each pixel against both surfaces. This preserves
    // terrain above a buried wall while exposing that wall from underneath.
    this.scene=Spatial.depthScene(renderFaces,segments,p=>[...transform(p),towardsViewer(p)]);
    this.renderer.render(c,this.scene,this.w,this.h,this.canvas.width/this.w);
    const labelBoxes=[];
    const annotate=(text,q,color) => {
      c.font='10px "Segoe UI","Malgun Gothic",sans-serif';
      const width=(c.measureText?c.measureText(text).width:text.length*5.5)+10;
      const x=Math.max(8,Math.min(this.w-width-8,q[0]+7));let y=Math.max(52,Math.min(this.h-25,q[1]-7));
      for(let k=0;k<16;k++) {
        const offset=k===0?0:Math.ceil(k/2)*17*(k%2?-1:1), trial=Math.max(52,Math.min(this.h-25,q[1]-7+offset));
        if(!labelBoxes.some(b=>x<b.x+b.w&&x+width>b.x&&trial-12<b.y+4&&trial+4>b.y-12)) {y=trial;break;}
      }
      labelBoxes.push({x,y,w:width});
      if(Math.abs(y-(q[1]-7))>12) {c.strokeStyle='#8da594';c.lineWidth=.6;c.beginPath();c.moveTo(q[0],q[1]);c.lineTo(x+3,y-4);c.stroke();}
      if(c.fillRect) {c.fillStyle='#f8fbf3e8';c.fillRect(x,y-12,width,16);}
      c.fillStyle=color;c.fillText(text,x+4,y);
    };
    const drawPoint=p=>{
      if(!this.scene.visible(p.xyz)) return;
      const q = transform(p.xyz);
      const feature=featureByPoint[p.id];
      c.beginPath(); c.arc(q[0], q[1], p.id === selectedId ? 5 : 3.5, 0, Math.PI * 2);
      c.fillStyle = p.id === selectedId ? '#e2a341' : p.kind === 'ground' ? '#739b65' : '#178e7d'; c.fill();
      const flat=feature&&heightByFeature[feature.id]?.flat;
      const showHeight=p.kind==='ground'?terrainHeightsVisible:buildingHeightsVisible&&!flat;
      if(showHeight) annotate(`${pointNumbersVisible?p.id+' · ':''}${p.kind==='ground'?'지면 높이':'지붕 높이'} ${fmt(p.xyz[2])} m`,q,'#47614d');
      else if(pointNumbersVisible) {c.font='10px "Segoe UI",sans-serif';c.fillStyle='#5d7c69';c.fillText(p.id,q[0]+7,q[1]-5);}
    };
    const drawBuildingHeights=()=>{if(buildingHeightsVisible) for(const f of session.features) {
      const heights=heightByFeature[f.id];if(!heights?.flat) continue;
      if(!this.scene.visible(heights.centre)) continue;
      const q=transform(heights.centre),wall=heights.wall;
      let label=`${f.label} · 지붕 높이 ${fmt(heights.roof)} m`;
      annotate(label,[q[0],q[1]-8],'#304e40');
      if(wall&&f.closed) {
        label=Math.abs(wall[1]-wall[0])<=.01?`벽면 길이 ${fmt(wall[0])} m`:`벽면 길이 ${fmt(wall[0])}~${fmt(wall[1])} m`;
        annotate(label,[q[0],q[1]+9],'#304e40');
      }
    }};
    for(const p of session.points) drawPoint(p);
    if(contoursVisible&&terrainHeightsVisible) for(const level of contours) {
      const visible=level.segments.filter(edge=>this.scene.visible(Spatial.mul(Spatial.add(...edge),.5)));if(!visible.length) continue;
      const edge=visible.reduce((longest,s)=>Math.hypot(...Spatial.sub(...s))>Math.hypot(...Spatial.sub(...longest))?s:longest);
      annotate(`등고선 ${fmt(level.height)} m`,transform(Spatial.mul(Spatial.add(...edge),.5)),'#76642f');
    }
    drawBuildingHeights();
    if (rayPath && live) {
      line(rayPath[0],rayPath[1],'#4e91b2',1.5,[4,4]);
      const aCamera=project.images.find(im=>im.id===live.observations[0].image_id);
      const bCamera=project.images.find(im=>im.id===live.observations[1].image_id);
      const clipped = camera => {
        const delta=Spatial.sub(camera.centre,live.xyz), h=Math.min(live.xyz[2]+12,liveRayWindow.high);
        return Spatial.add(live.xyz,Spatial.mul(delta,(h-live.xyz[2])/delta[2]));
      };
      const a=clipped(aCamera), b=clipped(bCamera);
      line(a,live.xyz,'#4e91b2',2); line(b,live.xyz,'#df9b35',2);
      const qa=transform(a), qb=transform(b);c.font='9px "Segoe UI","Malgun Gothic",sans-serif';
      c.fillStyle='#4e91b2';c.fillText('A 카메라 쪽',qa[0]-65,qa[1]-9);
      c.fillStyle='#b77d27';c.fillText('B 카메라 쪽',qb[0]+7,qb[1]-2);
      const comparison=heightDifference(live);
      if(comparison) {
        const h=comparison.height;
        line(live.xyz,[live.xyz[0],live.xyz[1],h],'#ba9c5c',1,[3,4]);
        const m=transform([live.xyz[0],live.xyz[1],(live.xyz[2]+h)/2]);c.fillStyle='#9d7b38';
        c.fillText(`${comparison.terrain?'지형':'기준 지면점'} 대비 ΔH ${fmt(comparison.delta)} m`,m[0]+8,m[1]);
      }
      c.fillStyle='#b48a3c';c.fillText(`후보 표고 ${fmt(live.xyz[2])} m`,12,this.h-12);
    }
    $('rayLegend').classList.toggle('hidden', !rayPath);
    if (live) {
      const q = transform(live.xyz); c.beginPath(); c.arc(q[0], q[1], 5, 0, Math.PI * 2); c.strokeStyle = '#d9a444'; c.lineWidth = 2; c.stroke();
      const draft = currentFeature();
      if (mode === 'building' && draft?.point_ids.length) line(byId[draft.point_ids.at(-1)].xyz, live.xyz, '#d9a444', 1.5, [4, 4]);
    }
    c.font = '10px "Segoe UI", sans-serif'; c.fillStyle = '#95a48f';
    c.fillText('격자 ' + fmt(step, 0) + ' m', 15, 19);
    const north = [-Math.sin(this.yaw), -Math.cos(this.yaw) * Math.sin(this.pitch)];
    c.strokeStyle = '#91a98e'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(this.w - 35, 40); c.lineTo(this.w - 35 + north[0] * 23, 40 + north[1] * 23); c.stroke();
    c.fillText('N', this.w - 38 + north[0] * 33, 43 + north[1] * 33);
    const buildingCount = session.features.filter(f => f.point_ids.length >= 2).length;
    let summary = buildingCount ? `건물 선 ${buildingCount}개` : '건물 모서리를 연결해 보세요.';
    if (buildingCount) {
      let length = 0, area = 0;
      for (const f of session.features) {
        const points = f.point_ids.map(id => byId[id].xyz);
        for (let i = 1; i < points.length + (f.closed ? 1 : 0); i++) length += Math.hypot(...points[i % points.length].map((v, j) => v - points[i - 1][j]));
        if (f.closed) {
          const origin = points[0]; let twice = 0;
          for (let i = 0; i < points.length; i++) {const a = points[i], b = points[(i + 1) % points.length]; twice += (a[0] - origin[0]) * (b[1] - origin[1]) - (b[0] - origin[0]) * (a[1] - origin[1]);}
          area += Math.abs(twice) / 2;
        }
      }
      const boxes = session.features.filter(f=>Spatial.buildingFaces(session,f).length).length;
      summary += ` · 수평 면적 ${fmt(area)} m² · ${wallsVisible ? `벽면 ${boxes}개` : '벽면 숨김'}`;
      if(wallsVisible && !boxes) summary += ' (지면 점과 닫힌 외곽선 필요)';
    }
    $('buildingSummary').textContent = summary;
  }
}

function clearCandidate(render = true) {
  observations = [null, null]; candidate = null; hoverCandidate = null; selectedId = null;
  liveRayWindow = null; guideTouched = false; measureRevision++; guideRevision++;
  views?.forEach(v => {v.hint = [];});
  if (render) renderAll();
}
async function chooseObservation(index, obs) {
  if(!views[0].id||!views[1].id) return toast('사진과 EO가 일치하는 서로 다른 사진 두 장이 필요합니다.',true);
  if (index === 0 && lockedDrawing()) {
    clearCandidate(false);
    try {
      candidate = Spatial.heightPoint(project, obs, views[1].id, lockedHeight, 'height_locked');
      observations = candidate.observations;
      if (candidate.save_allowed) savePoint(); else renderAll();
    } catch (error) {toast(error.message, true);}
    return;
  }
  if (matchingMethod === 'guided') {
    if (index === 1) {if (!observations[0]) toast('먼저 A 사진에서 지점을 선택하세요.'); else guideAtPixel([obs.x,obs.y]); return;}
    clearCandidate(false); observations[0] = obs;
    views[1].hint = Spatial.guide(project, obs, views[1].id);
    setGuideHeight(guideHeight, false); renderAll(); return;
  }
  guideRevision++;
  hoverCandidate = null; liveRayWindow = null;
  views.forEach(v => v.hint = []);
  observations[index] = obs; candidate = null; selectedId = null;
  const revision = ++measureRevision;
  renderAll();
  if (observations.every(Boolean)) {
    $('stepText').textContent = '두 관측으로 공간 좌표를 계산하는 중…';
    try {
      const result = await api('/api/measure', {observations});
      if (revision !== measureRevision) return;
      candidate = {...result, method:'stereo'}; guideHeight = result.xyz[2]; renderAll();
    } catch (error) {if (revision === measureRevision) {toast(error.message, true); $('stepText').textContent = error.message;}}
  } else {
    const guideVersion = ++guideRevision, target = 1 - index;
    try {
      const result = await api('/api/guide', {observation: obs, target: views[target].id});
      if (guideVersion !== guideRevision) return;
      views[target].hint = result.samples; views[target].draw();
    } catch (error) {if (guideVersion === guideRevision) toast(error.message, true);}
  }
}
function setMode(value) {
  mode = value; clearCandidate(false);
  $('groundMode').classList.toggle('active', value === 'ground'); $('buildingMode').classList.toggle('active', value === 'building');
  $('buildingTools').classList.toggle('hidden', value !== 'building'); renderAll();
}
async function changePhoto(index, value) {
  const previous = views[index].id;
  if(value===previous&&views[index].img) return;
  if (value === views[1 - index].id && !previous) return toast('서로 다른 사진 두 장이 필요합니다.');
  clearCandidate(false); renderAll();
  try {
    const tasks=[views[index].setImage(value)];
    if(value===views[1-index].id) tasks.push(views[1-index].setImage(previous));
    $('leftImage').value=views[0].id||'';$('rightImage').value=views[1].id||'';
    renderFilmstrip();await Promise.all(tasks);renderAll();
  } catch (error) {toast(error.message, true);}
}
function renderFilmstrip() {
  $('photoCount').textContent = `사진 ${project.images.length}장`;
  $('filmstripItems').replaceChildren();
  for (const image of project.images) {
    const button = document.createElement('button'); button.className = 'filmstrip-item';
    const selected = views.map((v, i) => v.id === image.id ? ['A', 'B'][i] : '').filter(Boolean).join(' · ');
    button.classList.toggle('selected', Boolean(selected)); button.title = image.filename + ' · 좌클릭 A / 우클릭 B';
    const img = document.createElement('img'); img.loading='lazy';img.decoding='async';img.src = imageUrl(image.id,true); img.alt = image.filename;
    const label = document.createElement('span'); label.textContent = image.id;
    button.append(img, label);
    if (selected) {const badge = document.createElement('b'); badge.textContent = selected; button.append(badge);}
    button.onclick = () => changePhoto(0,image.id);
    button.oncontextmenu = event => {event.preventDefault();changePhoto(1,image.id);};
    $('filmstripItems').append(button);
  }
}
function photoSelectors() {
  for(const [index,side] of ['left','right'].entries()) {
    const select=$(side+'Image');select.replaceChildren();
    if(!views[index].id) {const o=document.createElement('option');o.value='';o.textContent='사진 없음';select.append(o);}
    for(const image of project.images) {const o=document.createElement('option');o.value=image.id;o.textContent=image.filename;select.append(o);}
    select.value=views[index].id||'';
  }
  document.querySelectorAll('.viewer-resolution').forEach(el=>el.textContent=`${fmt(project.camera.width,0)} × ${fmt(project.camera.height,0)}`);
}
function showDataNotice(message) {$('dataNotice').textContent=message||'';$('dataNotice').classList.toggle('hidden',!message);}
async function syncProject() {
  if(syncBusy||!views||document.hidden) return;syncBusy=true;
  try {
    const updated=await api('/api/project');if(updated.revision===project.revision) {if(syncError) {showDataNotice(session.notice);syncError=false;}return;}
    await saveQueue.catch(()=>{});
    const restored=await api('/api/session'), old=project;
    let keep=JSON.stringify(old.camera)===JSON.stringify(updated.camera)&&JSON.stringify(old.guide_height_range)===JSON.stringify(updated.guide_height_range)&&!restored.notice;
    for(const view of views) {
      const a=old.images.find(im=>im.id===view.id),b=updated.images.find(im=>im.id===view.id);
      if(!a||!b||a.file_revision!==b.file_revision||JSON.stringify([a.centre,a.rotation])!==JSON.stringify([b.centre,b.rotation])) keep=false;
    }
    project=updated;session=restored;history=[];renderCoordinateBadge();
    if(!keep) {activeFeature=null;lockedHeight=null;clearCandidate(false);model.manualFrame=null;model.pan=[0,0];model.zoom=1;}
    if(keep) {
      for(const point of [candidate,hoverCandidate].filter(Boolean)) point.projections=Object.fromEntries(project.images.map(im=>[im.id,Spatial.project(project,im.id,point.xyz)]));
    }
    const ids=project.images.map(im=>im.id),pair=[...views.map(v=>v.id)];
    for(let i=0;i<2;i++) if(!ids.includes(pair[i])||pair[i]===pair[1-i]) pair[i]=ids.find(id=>id!==pair[1-i])||null;
    const tasks=[];
    for(let i=0;i<2;i++) {
      if(!pair[i]) views[i].clearImage();
      else if(!keep||views[i].id!==pair[i]) tasks.push(views[i].setImage(pair[i]));
    }
    photoSelectors();renderFilmstrip();showDataNotice(restored.notice);renderAll();await Promise.all(tasks);renderAll();syncError=false;saveFailed=false;$('saveStatus').classList.remove('error');
    $('saveStatus').textContent=session.points.length?'이 컴퓨터에 저장됨':'저장된 점 없음';
    toast('사진과 표정요소를 현재 자료로 갱신했습니다.');
  } catch(error) {syncError=true;showDataNotice('자료를 갱신하지 못했습니다. 파일 교체를 마친 뒤 다시 확인합니다. '+error.message);}
  finally {syncBusy=false;}
}
function renderTerrainControls() {
  const count=session.points.filter(p=>p.kind==='ground').length,terrain=session.terrain,stale=Spatial.terrainStale(session);
  $('makeTerrain').disabled=terrainBusy||count<3;
  $('makeTerrain').textContent=terrainBusy?'지형 생성 중…':terrain?'지형 갱신':'지형 만들기';
  $('terrainHint').textContent=`지면 ${count}점${count<3?' · 3개 이상 필요':''}`;
  $('terrainStatus').textContent=terrain?`지면 ${terrain.source_points.length}점으로 생성 · 삼각형 ${terrain.triangles.length}개${stale?' · 점이 변경되었습니다. 지형 갱신을 누르세요.':''}`:'지면 점을 찍고 ‘지형 만들기’를 누르세요.';
  $('terrainStatus').classList.toggle('stale',stale);
}
async function makeTerrain() {
  if(terrainBusy) return;terrainBusy=true;renderTerrainControls();
  try {
    const mesh=await api('/api/terrain',clone(session));
    checkpoint();session.terrain=mesh;terrainVisible=true;$('showTerrain').checked=true;renderAll();await persist();
    toast('지면 점 사이를 보간한 지형을 만들었습니다.');
  } catch(error) {toast(error.message,true);}
  finally {terrainBusy=false;renderTerrainControls();}
}
function expandModel(expanded=!modelExpanded) {
  modelExpanded=expanded;$('modelCard').classList.toggle('expanded',expanded);document.body.classList.toggle('model-expanded',expanded);
  $('expandModel').textContent=expanded?'닫기':'크게';$('expandModel').setAttribute('aria-expanded',String(expanded));
}
function renderResult() {
  const chosen = hoverCandidate || candidate || session.points.find(p => p.id === selectedId);
  $('resultTitle').textContent = (chosen?.kind || mode) === 'building' ? '건물 점의 표고' : '지면의 표고';
  $('heightValue').textContent = chosen ? fmt(chosen.xyz[2]) : '—';
  $('easting').textContent = chosen ? fmt(chosen.xyz[0], 3) : '—'; $('northing').textContent = chosen ? fmt(chosen.xyz[1], 3) : '—';
  const constrained = chosen && ['guided','height_locked'].includes(chosen.method);
  $('qualityLabel').textContent = '사진과의 일치도';
  $('reprojection').textContent = constrained ? '— (독립 관측 없음)' : chosen ? fmt(chosen.reprojection_rms_px) + ' px' : '—';
  $('pointMethodValue').textContent=chosen?methodName(chosen.method):'—';
  const comparison=heightDifference(chosen);
  $('relativeHeightLabel').textContent=comparison?.terrain?'바로 아래 지형과의 높이 차이':comparison?`기준 지면점 ${comparison.id}과의 높이 차이`:'지형 / 기준 지면점과의 높이 차이';
  $('relativeHeight').textContent=comparison?fmt(comparison.delta)+' m':'—';
  $('relativeHeight').title=comparison?.outside?'지형 범위 밖이므로 선택한 기준 지면점과 비교합니다.':'';
  const badge = $('qualityBadge'); badge.className = 'quality';
  if (constrained) {
    badge.classList.add(chosen.save_allowed ? 'warn' : 'neutral');
    badge.textContent = !chosen.save_allowed && chosen.method === 'height_locked' ? 'B 범위 밖' : chosen.method === 'height_locked' ? '높이 유지' : chosen.confirmed === false ? '높이 맞추기' : '눈으로 확인';
    $('qualityText').textContent = chosen.method === 'height_locked' ? '지정한 지붕 표고를 유지해 생성한 점입니다. B 사진의 커서로 위치를 확인하세요.' : 'B 커서를 같은 지점에 맞추고 저장하세요. 표고로 연동한 점에는 독립적인 재투영오차를 표시하지 않습니다.';
  } else if (chosen) {
    const error = chosen.reprojection_rms_px;
    badge.classList.add(error <= 1 ? 'good' : error <= project.max_save_reprojection_px ? 'warn' : 'bad');
    badge.textContent = error <= 1 ? '잘 일치함' : error <= project.max_save_reprojection_px ? '다시 확인' : '저장 불가';
    $('qualityText').textContent = error <= 1 ? '사진의 관측 위치와 계산한 점이 잘 일치합니다. 절대 높이 정확도와는 다릅니다.' : error <= project.max_save_reprojection_px ? '사진을 더 확대해 두 점이 같은 위치인지 확인하세요.' : '대응점 오차가 5px를 넘습니다. 같은 지점을 다시 선택하세요.';
  } else {badge.classList.add('neutral'); badge.textContent = '선택 대기'; $('qualityText').textContent = '두 사진에서 같은 지점을 선택하면 계산됩니다.';}
  $('savePoint').disabled = !candidate?.save_allowed;
  $('savePoint').replaceChildren(document.createTextNode(mode === 'ground' ? '지면 점 저장 ' : '건물 모서리 저장 '));
  const key = document.createElement('kbd'); key.textContent = 'Enter'; $('savePoint').append(key);
  if (lockedDrawing()) {$('stepNumber').textContent = '3'; $('stepText').textContent = chosen?.save_allowed === false ? '현재 후보가 B 사진 밖에 있습니다. A의 다른 지점 또는 다른 사진 쌍을 선택하세요.' : `표고 ${fmt(lockedHeight)} m 유지 중 · A에서 클릭할 때마다 모서리가 저장됩니다.`;}
  else if (candidate?.method === 'guided') {$('stepNumber').textContent = '2'; $('stepText').textContent = candidate.save_allowed ? 'B 커서가 같은 지점인지 확인하고 Enter로 저장하세요.' : candidate.confirmed === false ? 'B에서 Shift+휠 또는 Shift+클릭·드래그로 맞추세요. 휠은 사진 확대·축소입니다.' : '현재 후보가 B 사진 밖입니다. 높이 또는 A 지점을 조절하세요.';}
  else if (candidate) {$('stepNumber').textContent = '3'; $('stepText').textContent = candidate.save_allowed ? '표고를 확인하고 점을 저장하세요. 다시 클릭하면 관측 위치를 수정합니다.' : '두 사진의 같은 지점을 다시 선택하세요.';}
  else if (observations[0] && !observations[1]) {$('stepNumber').textContent = '2'; $('stepText').textContent = '오른쪽 사진의 주황색 선에서 같은 지점을 선택하세요.';}
  else if (observations[1] && !observations[0]) {$('stepNumber').textContent = '2'; $('stepText').textContent = '왼쪽 사진의 주황색 선에서 같은 지점을 선택하세요.';}
  else {$('stepNumber').textContent = '1'; $('stepText').textContent = selectedId ? `${selectedId} 관측 기록을 보고 있습니다. 사진을 클릭하면 새 점을 측정합니다.` : '왼쪽 사진에서 높이를 알고 싶은 지점을 선택하세요.';}
  observations.forEach((obs, i) => {const stored = selectedId ? chosen?.observations.find(o => o.image_id === views[i].id) : null; const value = hoverCandidate?.observations[i] || obs || stored; $(i === 0 ? 'leftObs' : 'rightObs').textContent = value ? `u ${fmt(value.x, 1)} · v ${fmt(value.y, 1)} px` : '선택한 점 없음';});
}
function renderPoints() {
  $('pointCount').textContent = session.points.length;
  $('pointsEmpty').classList.toggle('hidden', session.points.length > 0);
  $('pointRows').replaceChildren();
  for (const point of [...session.points].reverse()) {
    const row = document.createElement('tr'); row.className = 'point-row'; row.classList.toggle('selected', selectedId === point.id);
    const id = document.createElement('td'); id.textContent = point.id;
    const feature=session.features.find(f=>f.point_ids.includes(point.id));
    const kind = document.createElement('td'), chip = document.createElement('span'); chip.className = 'kind-chip ' + point.kind; chip.textContent = point.kind === 'ground' ? '지면' : feature?.label||'건물'; kind.append(chip);
    const z = document.createElement('td'); z.textContent = fmt(point.xyz[2]);
    const error = document.createElement('td'); error.textContent=Number.isFinite(point.reprojection_rms_px)?fmt(point.reprojection_rms_px):'—';
    if(!Number.isFinite(point.reprojection_rms_px)) error.title='B 위치가 계산으로 연동된 점입니다. 독립적인 관측 일치도를 계산할 수 없습니다.';
    const method=document.createElement('td');method.textContent=methodName(point.method);
    const action = document.createElement('td'), remove = document.createElement('button'); remove.className = 'remove-point'; remove.title = point.id + ' 삭제'; remove.textContent = '×';
    remove.onclick = event => {event.stopPropagation(); deletePoint(point.id);}; action.append(remove);
    row.append(id, kind, z, error, method, action); row.onclick = () => selectStored(point); $('pointRows').append(row);
  }
  const referenceSelect = $('groundReference'); referenceSelect.replaceChildren();
  const empty = document.createElement('option'); empty.value = ''; empty.textContent = session.points.some(p => p.kind === 'ground') ? '기준 지면 선택' : '지면 점을 먼저 저장하세요'; referenceSelect.append(empty);
  for (const point of session.points.filter(p => p.kind === 'ground')) {const option = document.createElement('option'); option.value = point.id; option.textContent = `${point.id} · 표고 ${fmt(point.xyz[2])} m`; referenceSelect.append(option);}
  referenceSelect.value = session.ground_reference || '';
  $('recordSummary').textContent = `지면 ${session.points.filter(p => p.kind === 'ground').length}점 · 건물 ${session.features.filter(f => f.point_ids.length > 1).length}개`;
  $('undoBtn').disabled = !history.length && !observations.some(Boolean);
  const draft = currentFeature();
  $('draftLabel').textContent = draft ? `${draft.label} · ${draft.point_ids.length}점` : '새 건물 준비';
  $('closeBuilding').disabled = !draft || draft.point_ids.length < 3;
  $('finishBuilding').disabled = !draft || draft.point_ids.length < 2;
  renderWallControls();
}
function renderWallControls() {
  const select = $('wallBuilding'); select.replaceChildren();
  if (!session.features.length) {const o=document.createElement('option');o.value='';o.textContent='건물 없음';select.append(o);}
  for (const f of session.features) {const o=document.createElement('option');o.value=f.id;o.textContent=f.label;select.append(o);}
  if (!session.features.some(f=>f.id===wallFeatureId)) wallFeatureId=activeFeature || session.features[0]?.id || null;
  select.value=wallFeatureId || '';
  const f=session.features.find(f=>f.id===wallFeatureId), ground=$('wallGround');ground.replaceChildren();
  const common=document.createElement('option');common.value='';common.textContent=session.ground_reference ? `공통 지면 ${session.ground_reference}` : '기준 지면 선택';ground.append(common);
  for(const p of session.points.filter(p=>p.kind==='ground')) {const o=document.createElement('option');o.value=p.id;o.textContent=`${p.id} · ${fmt(p.xyz[2])} m`;ground.append(o);}
  ground.value=f?.ground_reference || '';ground.disabled=!f;
  ground.title='건물 범위와 겹치는 지형의 최저 높이를 우선합니다. 겹치는 지형이 없으면 선택한 기준 지면을 사용합니다.';
  ground.setAttribute('aria-label','겹치는 지형이 없는 건물의 기준 지면');
}
function renderAll() {if (!session || !views) return; renderPoints(); renderResult(); updateHeightControls();renderTerrainControls(); views.forEach(v => v.draw()); model?.draw();}

function savePoint() {
  if (!candidate?.save_allowed) return;
  checkpoint();
  const point = {...clone(candidate), id: nextId('P', session.points), kind: mode}; point.label = point.id;
  session.points.push(point);
  if (mode === 'building') {
    let feature = currentFeature();
    if (!feature) {const id=nextId('B',session.features);feature = {id, label: `건물 ${Number(id.slice(1))}`, point_ids: [], closed: false}; session.features.push(feature); activeFeature = feature.id;}
    feature.point_ids.push(point.id);
    wallFeatureId = feature.id;
    if (drawingMethod === 'height_locked' && !Number.isFinite(lockedHeight)) lockedHeight = point.xyz[2];
  } else if (!session.ground_reference) session.ground_reference = point.id;
  guideHeight = point.xyz[2];
  clearCandidate(false); selectedId = point.id; renderAll(); persist();
  toast(`${point.id} · 표고 ${fmt(point.xyz[2])} m 추가됨`);
}
function finishFeature(closed) {
  const draft = currentFeature(); if (!draft || draft.point_ids.length < (closed ? 3 : 2)) return;
  if (closed && !Spatial.triangulate(draft.point_ids.map(id=>session.points.find(p=>p.id===id).xyz)).length) return toast('외곽선이 겹치거나 한 줄로 놓여 있습니다. 모서리 순서를 확인하세요.',true);
  checkpoint(); draft.closed = closed; activeFeature = null; lockedHeight = null; clearCandidate(); persist(); toast(closed ? '건물 외곽선을 닫았습니다.' : '건물 선을 저장했습니다.');
}
function undo() {
  if (observations.some(Boolean)) return clearCandidate();
  const previous = history.pop(); if (!previous) return;
  session = previous.session; activeFeature = previous.activeFeature; lockedHeight = previous.lockedHeight ?? null; clearCandidate(); persist(); toast('마지막 작업을 되돌렸습니다.');
}
function deletePoint(id) {
  checkpoint(); session.points = session.points.filter(p => p.id !== id);
  for (const feature of session.features) {feature.point_ids = feature.point_ids.filter(pid => pid !== id); if (feature.point_ids.length < 3) feature.closed = false;}
  for (const feature of session.features) if (feature.ground_reference === id) delete feature.ground_reference;
  session.features = session.features.filter(f => f.point_ids.length);
  if (!currentFeature()) activeFeature = null;
  if (session.ground_reference === id) session.ground_reference = session.points.find(p => p.kind === 'ground')?.id || null;
  clearCandidate(); persist(); toast(id + ' 삭제됨 · 되돌리기로 복원할 수 있습니다.');
}
async function selectStored(point) {
  if(point.observations.some(o=>!project.images.some(im=>im.id===o.image_id))) return toast('이 점을 관측한 사진이 현재 자료 폴더에 없습니다. 좌표는 기록에 보관되어 있습니다.',true);
  clearCandidate(false); selectedId = point.id;
  if (point.kind === 'building') {const f = session.features.find(f => f.point_ids.includes(point.id)); if (f) wallFeatureId=f.id; if (f && !f.closed) activeFeature = f.id;}
  const tasks = point.observations.map(async (obs, i) => {$(i === 0 ? 'leftImage' : 'rightImage').value = obs.image_id; if (views[i].id !== obs.image_id) await views[i].setImage(obs.image_id); views[i].centerAt([obs.x, obs.y]);});
  try {await Promise.all(tasks); renderAll(); renderFilmstrip();} catch (error) {toast(error.message, true);}
}

function renderCoordinateBadge() {
  const badge = $('coordinateBadge');
  badge.textContent = project.crs === 'LOCAL_SYNTHETIC_METRES'
    ? '가상 예제 · 실제 촬영 위치 없음 · 단위 m'
    : `${project.crs} · 단위 m · ${project.height_reference}`;
}
function showInfo() {
  const dl = document.createElement('dl');
  const values = [['영상', `${project.images.length}장 · ${project.camera.width} × ${project.camera.height} px`], ['초점거리', `${project.camera.focal_mm} mm (${fmt(project.camera.focal_px, 3)} px)`], ['픽셀 크기', `${project.camera.pixel_mm} mm`], ['주점', `u ${project.camera.cx}, v ${project.camera.cy}${project.camera.principal_point_assumed ? ' · 영상 중심 가정' : ''}`], ['영상 처리', '왜곡보정 영상 · 추가 왜곡보정 없음'], ['좌표계', `${project.crs} · 파일 X=E, Y=N`], ['높이 기준', project.height_reference], ['자세각', '제공 OPK · 각도 degree · 대응점으로 해석 점검'], ['추가 EO 행', `사진이 없는 ${project.missing_images}개 행은 제외`]];
  for (const [label, value] of values) {const div = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; div.append(dt, dd); dl.append(div);}
  $('projectInfo').replaceChildren(dl); $('infoDialog').showModal();
}
async function download(format) {
  try {await saveQueue; if (saveFailed) await persist(); const link = document.createElement('a'); link.href = '/api/export?format=' + format; link.download = 'survey.' + format; link.click();}
  catch (error) {toast('저장이 완료되지 않아 내보내기를 멈췄습니다. ' + error.message, true);}
}

async function initialize() {
  try {
    let health;
    [project, session, health] = await Promise.all([api('/api/project'), api('/api/session'),api('/api/health')]);
    renderCoordinateBadge();
    startWindowLease(health.window_lifecycle);
    $('licenseLink').classList.toggle('hidden',!health.notices);
    guideHeight = session.points.find(p=>p.id===session.ground_reference)?.xyz[2] ?? 20;
    views = [new PhotoView('left', 0), new PhotoView('right', 1)]; model = new ModelView();
    const pair = project.default_pair;
    for (const [i, side] of ['left', 'right'].entries()) {
      const select = $(side + 'Image');
      for (const image of project.images) {const option = document.createElement('option'); option.value = image.id; option.textContent = image.filename; select.append(option);}
      select.value = pair[i]; select.onchange = () => changePhoto(i, select.value);
      document.querySelectorAll('.viewer-resolution')[i].textContent = `${fmt(project.camera.width, 0)} × ${fmt(project.camera.height, 0)}`;
    }
    $('groundMode').onclick = () => setMode('ground'); $('buildingMode').onclick = () => setMode('building');
    $('pointMethod').onchange = () => {matchingMethod=$('pointMethod').value;clearCandidate();};
    $('drawingMethod').onchange = () => {
      const point=candidate || session.points.find(p=>p.id===selectedId);
      drawingMethod=$('drawingMethod').value;
      if(drawingMethod==='height_locked' && point?.kind==='building') {lockedHeight=point.xyz[2];guideHeight=lockedHeight;}
      clearCandidate();
    };
    $('guideHeight').onchange = () => setGuideHeight($('guideHeight').valueAsNumber);
    $('heightDown').onclick = () => adjustHeight(-Number($('heightStep').value));
    $('heightUp').onclick = () => adjustHeight(Number($('heightStep').value));
    $('lockedHeight').onchange = () => {
      const value=$('lockedHeight').value.trim(), height=Number(value);
      const [low,high]=Spatial.bounds(project,views[0].id,views[1].id);
      if(!value || !Number.isFinite(height) || height<low || height>high) {toast('유효한 범위의 유지 표고를 입력하세요.',true);updateHeightControls();return;}
      lockedHeight=height;guideHeight=height;clearCandidate();
    };
    $('useHeight').onclick = () => {
      const point=candidate || session.points.find(p=>p.id===selectedId);
      if(!point) return toast('먼저 지붕 점을 맞추거나 저장된 지붕 점을 선택하세요.');
      lockedHeight=point.xyz[2];guideHeight=lockedHeight;clearCandidate();toast(`표고 ${fmt(lockedHeight)} m를 유지합니다.`);
    };
    $('resetHeight').onclick = () => {lockedHeight=null;clearCandidate();toast('다음 모서리를 A·B에서 다시 맞춰 높이를 설정하세요.');};
    $('showWalls').onchange = () => {wallsVisible=$('showWalls').checked;model.draw();};
    $('showRays').onchange = () => {raysVisible=$('showRays').checked;model.draw();};
    $('showTerrain').onchange=()=>{terrainVisible=$('showTerrain').checked;model.draw();};
    $('showContours').onchange=()=>{contoursVisible=$('showContours').checked;model.draw();};
    $('showBuildingHeights').onchange=()=>{buildingHeightsVisible=$('showBuildingHeights').checked;model.draw();};
    $('showTerrainHeights').onchange=()=>{terrainHeightsVisible=$('showTerrainHeights').checked;model.draw();};
    $('showPointNumbers').onchange=()=>{pointNumbersVisible=$('showPointNumbers').checked;model.draw();};
    $('contourInterval').onchange=()=>{
      const interval=Number($('contourInterval').value);
      try {Spatial.terrainContours(session.terrain,interval);contourInterval=interval;model.draw();}
      catch(error) {$('contourInterval').value=contourInterval;toast(error.message,true);}
    };
    $('makeTerrain').onclick=makeTerrain;$('expandModel').onclick=()=>expandModel();
    $('wallBuilding').onchange = () => {wallFeatureId=$('wallBuilding').value;renderWallControls();};
    $('wallGround').onchange = () => {
      const f=session.features.find(f=>f.id===wallFeatureId);if(!f)return;
      checkpoint(); if($('wallGround').value) f.ground_reference=$('wallGround').value;else delete f.ground_reference;
      renderAll();persist();
    };
    $('clearCandidate').onclick = () => clearCandidate(); $('savePoint').onclick = savePoint; $('undoBtn').onclick = undo;
    $('closeBuilding').onclick = () => finishFeature(true); $('finishBuilding').onclick = () => finishFeature(false);
    $('newBuilding').onclick = () => {activeFeature = null; lockedHeight=null; clearCandidate(); toast('다음에 저장하는 점부터 새 건물이 됩니다.');};
    $('groundReference').onchange = () => {checkpoint(); session.ground_reference = $('groundReference').value || null; renderAll(); persist();};
    $('helpBtn').onclick = () => $('helpDialog').showModal(); $('infoBtn').onclick = showInfo; $('exportBtn').onclick = () => $('exportDialog').showModal();
    document.querySelectorAll('.dialog-close').forEach(b => b.onclick = () => b.closest('dialog').close());
    document.querySelectorAll('[data-format]').forEach(b => b.onclick = () => download(b.dataset.format));
    $('resetBtn').onclick = () => $('resetDialog').showModal(); $('cancelReset').onclick = () => $('resetDialog').close();
    $('confirmReset').onclick = () => {checkpoint(); session.points = []; session.features = []; session.ground_reference = null;session.terrain=null; activeFeature = null; lockedHeight=null; clearCandidate(); persist(); $('resetDialog').close(); toast('새 실습을 시작했습니다.');};
    $('importSession').onchange = async event => {
      const file = event.target.files[0]; if (!file) return;
      try {
        await saveQueue;
        if (file.size > 4_000_000) throw new Error('기록 파일이 너무 큽니다.');
        const value = JSON.parse(await file.text());
        if (value.crs && value.crs !== project.crs) throw new Error('좌표계가 현재 실습 자료와 다릅니다.');
        if (!Array.isArray(value.points) || !Array.isArray(value.features)) throw new Error('실습 기록 JSON이 아닙니다.');
        const loaded = await api('/api/session', value); checkpoint(); session = loaded; activeFeature = null; lockedHeight=null; wallFeatureId=null; clearCandidate();
        $('saveStatus').textContent = '이 컴퓨터에 저장됨'; $('saveStatus').classList.remove('error'); saveFailed = false; $('exportDialog').close(); toast('실습 기록을 불러왔습니다.');
      } catch (error) {toast(error.message, true);} finally {event.target.value = '';}
    };
    document.addEventListener('keydown', event => {
      if(event.key==='Escape'&&modelExpanded) {event.preventDefault();expandModel(false);return;}
      if (document.querySelector('dialog[open]') || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
      if (event.key === 'Enter') {event.preventDefault(); savePoint();}
      if (event.key === 'Escape') clearCandidate();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {event.preventDefault(); undo();}
      if (event.key.toLowerCase() === 'f') {if(modelExpanded) $('modelFit').click();else views.forEach(v => v.fit());}
      if (['ArrowUp','ArrowDown'].includes(event.key) && guideAdjustable(1)) {event.preventDefault();adjustHeight((event.key==='ArrowUp'?1:-1)*Number($('heightStep').value));}
    });
    window.addEventListener('beforeunload', event => {if (saveFailed || $('saveStatus').textContent === '저장 중…') {event.preventDefault(); event.returnValue = '';}});
    $('saveStatus').textContent = session.points.length ? '이 컴퓨터에 저장됨' : '저장된 점 없음';
    const loads = views.map((v, i) => pair[i]?v.setImage(pair[i]):v.clearImage());photoSelectors(); renderAll(); renderFilmstrip();showDataNotice(session.notice);
    await Promise.all(loads).catch(error=>toast(error.message,true)); renderAll();
    setInterval(syncProject,3000);
    window.addEventListener('focus',syncProject);document.addEventListener('visibilitychange',()=>{if(!document.hidden) syncProject();});
  } catch (error) {toast('프로그램을 시작하지 못했습니다. ' + error.message, true); $('stepText').textContent = error.message;}
}
initialize();
