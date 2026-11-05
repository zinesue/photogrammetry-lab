(function(root) {
  'use strict';
  const add = (a,b) => a.map((v,i)=>v+b[i]);
  const sub = (a,b) => a.map((v,i)=>v-b[i]);
  const mul = (a,s) => a.map(v=>v*s);
  const dot = (a,b) => a.reduce((s,v,i)=>s+v*b[i],0);
  const unit = a => mul(a,1/Math.hypot(...a));
  const mv = (m,v) => m.map(row=>dot(row,v));
  const camera = (p,id) => {const c=p.images.find(c=>c.id===id); if(!c) throw new Error('사진 정보를 찾을 수 없습니다.'); return c;};
  function ray(p,obs) {
    const c=camera(p,obs.image_id), k=p.camera;
    return {centre:c.centre, direction:unit(mv(c.rotation,[(obs.x-k.cx)/k.focal_px,-(obs.y-k.cy)/k.focal_px,-1]))};
  }
  function project(p,id,xyz) {
    const c=camera(p,id), k=p.camera, r=c.rotation, v=sub(xyz,c.centre);
    const q=[0,1,2].map(j=>r.reduce((s,row,i)=>s+row[j]*v[i],0));
    if(q[2]>=-1e-8) return null;
    return [k.cx-k.focal_px*q[0]/q[2],k.cy+k.focal_px*q[1]/q[2]];
  }
  function atHeight(p,obs,height) {
    const {centre,direction}=ray(p,obs);
    if(!Number.isFinite(height)||Math.abs(direction[2])<1e-10) throw new Error('표고를 계산할 수 없습니다.');
    const t=(height-centre[2])/direction[2];
    if(t<=0) throw new Error('카메라보다 낮은 표고를 지정하세요.');
    return add(centre,mul(direction,t));
  }
  function bounds(p,source,target) {
    const range=p.guide_height_range||[-100,300];
    return [range[0],Math.min(range[1],camera(p,source).centre[2]-1,camera(p,target).centre[2]-1)];
  }
  function heightPoint(p,obs,target,height,method='guided') {
    if(obs.image_id===target) throw new Error('서로 다른 사진을 선택하세요.');
    const k=p.camera, inside=q=>q&&q[0]>=0&&q[1]>=0&&q[0]<k.width&&q[1]<k.height;
    if(!inside([obs.x,obs.y])) throw new Error('사진 안의 지점을 선택하세요.');
    const [low,high]=bounds(p,obs.image_id,target);
    if(!Number.isFinite(height)||height<low||height>high) throw new Error(`표고 범위는 ${low.toFixed(1)} ~ ${high.toFixed(1)} m입니다.`);
    const xyz=atHeight(p,obs,height), q=project(p,target,xyz);
    const projections=Object.fromEntries(p.images.map(c=>[c.id,project(p,c.id,xyz)]));
    const other={image_id:target,x:q?.[0]??-1,y:q?.[1]??-1};
    const r1=ray(p,obs), r2=q?ray(p,other):null;
    const angle=r2?Math.acos(Math.max(-1,Math.min(1,dot(r1.direction,r2.direction))))*180/Math.PI:0;
    return {xyz,observations:[{...obs},other],projections,method,height_constraint_m:height,
      reprojection_rms_px:null,ray_gap_m:null,intersection_angle_deg:angle,
      baseline_m:Math.hypot(...sub(camera(p,target).centre,camera(p,obs.image_id).centre)),
      save_allowed:inside(q)&&angle>=.1};
  }
  function guide(p,obs,target) {
    const [low,high]=bounds(p,obs.image_id,target), result=[];
    for(let i=0;i<=100;i++) {const height=low+(high-low)*i/100, xyz=atHeight(p,obs,height), q=project(p,target,xyz); if(q) result.push({x:q[0],y:q[1],height});}
    return result;
  }
  function heightForPixel(p,obs,target,pixel) {
    let [low,high]=bounds(p,obs.image_id,target);
    // Ternary minimization of distance along the monotonic epipolar segment.
    const cost=h=>{const q=project(p,target,atHeight(p,obs,h)); return q?(q[0]-pixel[0])**2+(q[1]-pixel[1])**2:Infinity;};
    for(let i=0;i<48;i++){const a=low+(high-low)/3,b=high-(high-low)/3;if(cost(a)<cost(b)) high=b;else low=a;}
    return (low+high)/2;
  }
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  function triangulate(points) {
    const order=points.map((_,i)=>i);
    // Remove consecutive repeated vertices and collinear middle vertices.
    for(let changed=true;changed&&order.length>3;) {
      changed=false;
      for(let i=0;i<order.length;i++) {
        const a=points[order[(i+order.length-1)%order.length]],b=points[order[i]],c=points[order[(i+1)%order.length]];
        if(Math.hypot(b[0]-a[0],b[1]-a[1])<1e-6||Math.abs(cross(a,b,c))<1e-9){order.splice(i,1);changed=true;break;}
      }
    }
    if(order.length<3) return [];
    const origin=points[order[0]];
    const area=order.reduce((s,id,i)=>s+cross(origin,points[id],points[order[(i+1)%order.length]]),0);
    if(Math.abs(area)<1e-8) return [];
    const sign=Math.sign(area), result=[];
    const inside=(q,a,b,c)=>[cross(a,b,q),cross(b,c,q),cross(c,a,q)].every(v=>v*sign>=-1e-8);
    while(order.length>3) {
      let found=false;
      for(let i=0;i<order.length;i++) {
        const ids=[order[(i+order.length-1)%order.length],order[i],order[(i+1)%order.length]], [a,b,c]=ids.map(j=>points[j]);
        if(cross(a,b,c)*sign<=1e-9) continue;
        if(order.some(j=>!ids.includes(j)&&inside(points[j],a,b,c))) continue;
        result.push(ids);order.splice(i,1);found=true;break;
      }
      if(!found) return []; // Degenerate/self-intersecting rings have no invented cap.
    }
    result.push(order.slice());return result;
  }
  function buildingFaces(session,feature) {
    if(!feature.closed||feature.point_ids.length<3) return [];
    const byId=Object.fromEntries(session.points.map(p=>[p.id,p]));
    const roof=feature.point_ids.map(id=>byId[id]?.xyz);
    if(roof.some(p=>!p)) return [];
    const base=buildingBase(session,feature,roof), faces=[];
    if(base===null||roof.some(p=>base>=p[2])) return [];
    for(let i=0;i<roof.length;i++) {
      const a=roof[i],b=roof[(i+1)%roof.length];
      faces.push({kind:'wall',vertices:[a,b,[b[0],b[1],base],[a[0],a[1],base]]});
    }
    for(const ids of triangulate(roof)) faces.push({kind:'roof',vertices:ids.map(i=>roof[i])});
    return faces;
  }
  function terrainAt(terrain,x,y) {
    if(!terrain) return null;
    for(const ids of terrain.triangles) {
      const [a,b,c]=ids.map(i=>terrain.vertices[i]);
      const bx=b[0]-a[0],by=b[1]-a[1],cx=c[0]-a[0],cy=c[1]-a[1],px=x-a[0],py=y-a[1];
      const den=bx*cy-by*cx;if(Math.abs(den)<1e-12) continue;
      const u=(px*cy-py*cx)/den,v=(bx*py-by*px)/den;
      if(u>=-1e-8&&v>=-1e-8&&u+v<=1+1e-8) return a[2]+u*(b[2]-a[2])+v*(c[2]-a[2]);
    }
    return null;
  }
  function groundAt(session,feature,x,y) {
    const h=terrainAt(session.terrain,x,y);if(h!==null) return h;
    return referenceGround(session,feature);
  }
  function referenceGround(session,feature) {
    const explicit=session.points.find(p=>p.id===feature.ground_reference&&p.kind==='ground');
    if(explicit) return explicit.xyz[2];
    const common=session.points.find(p=>p.id===session.ground_reference&&p.kind==='ground');
    return common?.xyz[2]??null;
  }
  function buildingBase(session,feature,roof) {
    roof=roof||feature.point_ids.map(id=>session.points.find(p=>p.id===id)?.xyz).filter(Boolean);
    if(!roof.length) return null;
    const terrain=session.terrain;
    if(!terrain) return referenceGround(session,feature);
    const heights=roof.map(p=>terrainAt(terrain,p[0],p[1])).filter(h=>h!==null),tinEdges=new Map(),used=new Set();
    const inside=p=>{
      let result=false;
      for(let i=0,j=roof.length-1;i<roof.length;j=i++) {
        const a=roof[j],b=roof[i],dx=b[0]-a[0],dy=b[1]-a[1];
        if(Math.abs(cross(a,b,p))<1e-7&&p[0]>=Math.min(a[0],b[0])-1e-8&&p[0]<=Math.max(a[0],b[0])+1e-8&&p[1]>=Math.min(a[1],b[1])-1e-8&&p[1]<=Math.max(a[1],b[1])+1e-8) return true;
        if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<a[0]+dx*(p[1]-a[1])/dy) result=!result;
      }
      return result;
    };
    for(const ids of terrain.triangles) for(let i=0;i<3;i++) {
      const a=ids[i],b=ids[(i+1)%3],key=[a,b].sort((x,y)=>x-y).join(':');
      tinEdges.set(key,[terrain.vertices[a],terrain.vertices[b]]);used.add(a);
    }
    // On a piecewise planar TIN, the footprint minimum occurs at a roof-ring
    // vertex, an enclosed TIN vertex, or a crossing of the two sets of edges.
    if(feature.closed&&roof.length>=3) for(const id of used) {const p=terrain.vertices[id];if(inside(p)) heights.push(p[2]);}
    const count=feature.closed?roof.length:roof.length-1;
    for(let i=0;i<count;i++) {
      const a=roof[i],b=roof[(i+1)%roof.length],dx=b[0]-a[0],dy=b[1]-a[1],length2=dx*dx+dy*dy;
      if(length2<1e-12) continue;
      for(const [u,v] of tinEdges.values()) {
        const ex=v[0]-u[0],ey=v[1]-u[1],qx=u[0]-a[0],qy=u[1]-a[1],den=dx*ey-dy*ex;
        if(Math.abs(den)>1e-10) {
          const t=(qx*ey-qy*ex)/den,s=(qx*dy-qy*dx)/den;
          if(t>=-1e-8&&t<=1+1e-8&&s>=-1e-8&&s<=1+1e-8) heights.push(u[2]+(v[2]-u[2])*Math.max(0,Math.min(1,s)));
        } else if(Math.abs(qx*dy-qy*dx)<1e-7) {
          for(const p of [u,v]) {const t=((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length2;if(t>=-1e-8&&t<=1+1e-8) heights.push(p[2]);}
        }
      }
    }
    return heights.length?Math.min(...heights):referenceGround(session,feature);
  }
  function terrainContours(terrain,interval) {
    if(!Number.isFinite(interval)||interval<.1||interval>1000) throw new Error('등고선 간격은 0.1~1,000 m로 입력하세요.');
    if(!terrain?.vertices.length) return [];
    const heights=terrain.vertices.map(p=>p[2]),min=Math.min(...heights),max=Math.max(...heights);
    const first=Math.ceil((min-1e-8)/interval),last=Math.floor((max+1e-8)/interval);
    if(last-first+1>500) throw new Error('등고선이 너무 많습니다. 간격을 넓혀 주세요. (최대 500개 높이)');
    const result=[],key=p=>p.slice(0,2).map(v=>v.toFixed(6)).join(','),epsilon=1e-8;
    let total=0;
    for(let level=first;level<=last;level++) {
      const height=Number((level*interval).toPrecision(12)),segments=new Map(),flatEdges=new Map();
      const insert=(a,b,map,isFlat=false)=>{
        const ka=key(a),kb=key(b);if(ka===kb) return;
        const id=ka<kb?ka+'|'+kb:kb+'|'+ka,old=map.get(id);
        map.set(id,{vertices:[a,b],count:isFlat?(old?.count||0)+1:1});
      };
      for(const ids of terrain.triangles) {
        const vertices=ids.map(i=>terrain.vertices[i]),delta=vertices.map(p=>p[2]-height);
        if(delta.every(d=>d>epsilon)||delta.every(d=>d<-epsilon)) continue;
        if(delta.every(d=>Math.abs(d)<=epsilon)) {
          for(let i=0;i<3;i++) insert([...vertices[i].slice(0,2),height],[...vertices[(i+1)%3].slice(0,2),height],flatEdges,true);
          continue;
        }
        const hits=new Map();
        for(let i=0;i<3;i++) {
          const j=(i+1)%3,a=vertices[i],b=vertices[j];
          if(Math.abs(delta[i])<=epsilon) {const p=[a[0],a[1],height];hits.set(key(p),p);}
          if((delta[i]<-epsilon&&delta[j]>epsilon)||(delta[i]>epsilon&&delta[j]<-epsilon)) {
            const t=(height-a[2])/(b[2]-a[2]),p=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,height];hits.set(key(p),p);
          }
        }
        if(hits.size===2) insert(...hits.values(),segments);
      }
      // Suppress internal diagonals of flat plateaus; keep their boundary only.
      for(const [id,edge] of flatEdges) if(edge.count===1&&!segments.has(id)) segments.set(id,edge);
      if(segments.size) result.push({height,segments:[...segments.values()].map(s=>s.vertices)});
      total+=segments.size;
      if(total>100000) throw new Error('등고선이 너무 복잡합니다. 간격을 넓혀 주세요.');
    }
    return result;
  }
  function terrainStale(session) {
    if(!session.terrain) return false;
    const points=session.points.filter(p=>p.kind==='ground'), source=session.terrain.source_points;
    if(points.length!==source.length) return true;
    const byId=Object.fromEntries(points.map(p=>[p.id,p]));
    return source.some(p=>!byId[p.id]||p.xyz.some((v,j)=>Math.abs(v-byId[p.id].xyz[j])>1e-6));
  }
  function gridBounds(points) {
    const values=points.length?points:[[0,0,0]], lo=[0,1].map(j=>Math.min(...values.map(p=>p[j]))),hi=[0,1].map(j=>Math.max(...values.map(p=>p[j])));
    const span=Math.max(20,hi[0]-lo[0],hi[1]-lo[1]),step=10**Math.floor(Math.log10(span/5)),pad=Math.max(5,span*.15);
    return {low:lo.map(v=>Math.floor((v-pad)/step)*step),high:hi.map(v=>Math.ceil((v+pad)/step)*step),step};
  }
  function featureHeights(session,feature) {
    const points=feature.point_ids.map(id=>session.points.find(p=>p.id===id)?.xyz).filter(Boolean);
    if(!points.length) return null;
    const roof=points.map(p=>p[2]),low=Math.min(...roof),high=Math.max(...roof);
    const base=buildingBase(session,feature,points),wall=points.map(p=>base===null?null:p[2]-base);
    return {base,flat:high-low<=.01,roof:(low+high)/2,centre:[0,1,2].map(j=>points.reduce((s,p)=>s+p[j],0)/points.length),wall:wall.every(h=>h!==null&&h>0)?[Math.min(...wall),Math.max(...wall)]:null};
  }
  function colour(value) {
    if(Array.isArray(value)) return value;
    const hex=value.replace('#','');
    return [0,2,4,6].map((i,j)=>j===3&&hex.length<8?255:parseInt(hex.slice(i,i+2),16));
  }
  function barycentric(vertices,x,y) {
    const [a,b,c]=vertices,den=cross(a,b,c);
    if(Math.abs(den)<1e-10) return null;
    const u=((b[0]-x)*(c[1]-y)-(b[1]-y)*(c[0]-x))/den;
    const v=((c[0]-x)*(a[1]-y)-(c[1]-y)*(a[0]-x))/den,w=1-u-v;
    return u>=-1e-8&&v>=-1e-8&&w>=-1e-8?[u,v,w]:null;
  }
  function depthScene(faces,lines,project) {
    const triangles=[];
    for(const face of faces) {
      const points=face.vertices.map(project),rgba=colour(face.colour);
      for(let i=1;i+1<points.length;i++) {
        const vertices=[points[0],points[i],points[i+1]];
        triangles.push({vertices,colour:rgba,kind:face.kind,box:[Math.min(...vertices.map(p=>p[0])),Math.min(...vertices.map(p=>p[1])),Math.max(...vertices.map(p=>p[0])),Math.max(...vertices.map(p=>p[1]))]});
      }
    }
    const segments=lines.map(line=>({...line,vertices:line.vertices.map(project),colour:colour(line.colour)}));
    let low=Infinity,high=-Infinity;
    for(const item of triangles.concat(segments)) for(const p of item.vertices) {low=Math.min(low,p[2]);high=Math.max(high,p[2]);}
    if(!Number.isFinite(low)) {low=0;high=1;}
    const epsilon=Math.max(1,high-low)*1e-7;
    const surfaceAt=(x,y)=>{
      let nearest=null;
      for(const triangle of triangles) {
        if(triangle.colour[3]<255) continue;
        const box=triangle.box;if(x<box[0]-1e-8||x>box[2]+1e-8||y<box[1]-1e-8||y>box[3]+1e-8) continue;
        const weights=barycentric(triangle.vertices,x,y);if(!weights) continue;
        const depth=weights.reduce((s,w,i)=>s+w*triangle.vertices[i][2],0);
        if(!nearest||depth>nearest.depth) nearest={depth,triangle};
      }
      return nearest;
    };
    return {triangles,lines:segments,low,high,epsilon,surfaceAt,
      visible(point){const p=project(point),surface=surfaceAt(p[0],p[1]);return !surface||p[2]>=surface.depth-epsilon;}};
  }
  // CPU depth-buffer fallback for browsers without WebGL; also provides an
  // independently testable pixel renderer for intersecting terrain and walls.
  function rasterizeDepth(scene,width,height,ratio=1,target) {
    if(!target||target.width!==width||target.height!==height) target={width,height,data:new Uint8ClampedArray(width*height*4),depths:new Float64Array(width*height)};
    const {data,depths}=target;data.fill(0);depths.fill(-Infinity);
    const blend=(index,rgba)=>{
      const k=index*4,alpha=rgba[3]/255,old=data[k+3]/255,out=alpha+old*(1-alpha);
      if(!out) return;
      for(let j=0;j<3;j++) data[k+j]=(rgba[j]*alpha+data[k+j]*old*(1-alpha))/out;
      data[k+3]=out*255;
    };
    const opaque=scene.triangles.filter(t=>t.colour[3]===255),transparent=scene.triangles.filter(t=>t.colour[3]<255);
    transparent.sort((a,b)=>a.vertices.reduce((s,p)=>s+p[2],0)-b.vertices.reduce((s,p)=>s+p[2],0));
    for(const triangle of opaque.concat(transparent)) {
      const vertices=triangle.vertices.map(p=>[p[0]*ratio,p[1]*ratio,p[2]]);
      const minX=Math.max(0,Math.floor(Math.min(...vertices.map(p=>p[0])))),maxX=Math.min(width-1,Math.ceil(Math.max(...vertices.map(p=>p[0]))));
      const minY=Math.max(0,Math.floor(Math.min(...vertices.map(p=>p[1])))),maxY=Math.min(height-1,Math.ceil(Math.max(...vertices.map(p=>p[1]))));
      for(let y=minY;y<=maxY;y++) for(let x=minX;x<=maxX;x++) {
        const weights=barycentric(vertices,x+.5,y+.5);if(!weights) continue;
        const depth=weights.reduce((s,w,i)=>s+w*vertices[i][2],0),index=y*width+x;
        if(depth<depths[index]-scene.epsilon) continue;
        blend(index,triangle.colour);if(triangle.colour[3]===255) depths[index]=depth;
      }
    }
    for(const line of scene.lines) {
      const [a,b]=line.vertices.map(p=>[p[0]*ratio,p[1]*ratio,p[2]]),dx=b[0]-a[0],dy=b[1]-a[1];
      const steps=Math.max(1,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy)))),r=Math.max(.5,(line.width||1)*ratio/2);
      for(let i=0;i<=steps;i++) {
        const t=i/steps,cx=a[0]+dx*t,cy=a[1]+dy*t,depth=a[2]+(b[2]-a[2])*t;
        for(let y=Math.max(0,Math.floor(cy-r));y<=Math.min(height-1,Math.ceil(cy+r));y++) for(let x=Math.max(0,Math.floor(cx-r));x<=Math.min(width-1,Math.ceil(cx+r));x++) {
          if((x+.5-cx)**2+(y+.5-cy)**2>r*r+.5) continue;
          const index=y*width+x;if(depth<depths[index]-scene.epsilon) continue;
          blend(index,line.colour);depths[index]=Math.max(depths[index],depth);
        }
      }
    }
    return target;
  }
  const api={add,sub,mul,dot,unit,ray,project,atHeight,bounds,heightPoint,guide,heightForPixel,triangulate,buildingFaces,buildingBase,terrainAt,groundAt,terrainContours,terrainStale,gridBounds,featureHeights,depthScene,rasterizeDepth};
  if(typeof module==='object'&&module.exports) module.exports=api;else root.Spatial=api;
})(typeof globalThis==='object'?globalThis:this);
