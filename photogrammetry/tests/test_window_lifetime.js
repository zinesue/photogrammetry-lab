'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture(beacon=true) {
  const messages=[],requests=[],events=new Map(),documentEvents=new Map(),timers=[],sockets=[],retries=[];
  const sandbox={
    crypto:{randomUUID:()=> 'browser-document'},
    navigator:{sendBeacon(url,blob){messages.push({url,...JSON.parse(blob.parts.join(''))});return beacon;}},
    Blob:class {constructor(parts){this.parts=parts;}},
    window:{location:{host:'127.0.0.1:1234'},addEventListener(name,callback){events.set(name,callback);}},
    document:{hidden:false,addEventListener(name,callback){documentEvents.set(name,callback);}},
    setInterval(callback,delay){timers.push({callback,delay});},
    setTimeout(callback){retries.push(callback);return retries.length;},clearTimeout(){},
    WebSocket:class {constructor(url){this.url=url;this.readyState=1;sockets.push(this);}close(){this.readyState=3;this.onclose?.();}},
    fetch(url,options){requests.push({url,...options});return Promise.resolve({});}
  };
  const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8').replace(/^initialize\(\);\s*$/m,'');
  vm.runInNewContext(source+'\nglobalThis.startLease=startWindowLease;',sandbox);
  return {sandbox,messages,requests,events,documentEvents,timers,sockets,retries};
}
test('portable window registration, close and restored pages use increasing sequence numbers',()=>{
  const f=fixture();f.sandbox.startLease(true);
  assert.equal(f.messages[0].state,'open');assert.equal(f.timers[0].delay,15000);
  f.timers[0].callback();f.events.get('pagehide')();
  assert.equal(f.sockets[0].readyState,3);
  assert.equal(f.messages.at(-1).state,'closed');const count=f.messages.length;
  f.timers[0].callback();assert.equal(f.messages.length,count,'no late interval after close');
  f.events.get('pageshow')();assert.equal(f.messages.at(-1).state,'open');
  assert.equal(f.sockets.length,2);
  f.sandbox.document.hidden=true;f.documentEvents.get('visibilitychange')();
  assert.equal(f.messages.at(-1).hidden,true);
  assert.deepEqual(f.messages.map(m=>m.sequence),[1,2,3,4,5]);
});
test('a dropped browser connection reconnects without opening any launcher window',()=>{
  const f=fixture();f.sandbox.startLease(true);f.sockets[0].close();
  assert.equal(f.retries.length,1);f.retries[0]();assert.equal(f.sockets.length,2);
  assert.ok(f.sockets[1].url.startsWith('ws://127.0.0.1:1234/api/window-connection?'));
});
test('unavailable sendBeacon falls back to a keepalive request and source mode starts no lease',()=>{
  const f=fixture(false);f.sandbox.startLease(false);assert.equal(f.messages.length,0);
  f.sandbox.startLease(true);f.events.get('pagehide')();
  assert.equal(f.requests.length,2);assert.equal(f.requests[1].keepalive,true);
  assert.equal(JSON.parse(f.requests[1].body).state,'closed');
});
