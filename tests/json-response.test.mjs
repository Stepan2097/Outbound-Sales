import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {sendJsonResponse} from '../state/json-response.mjs';

async function response(payload,encoding){
 let headers,status;
 let finish;
 const ended=new Promise(resolve=>finish=resolve);
 const res={destroyed:false,writeHead:(s,h)=>{status=s;headers=h;},end:bytes=>finish(bytes)};
 sendJsonResponse(res,200,payload,encoding);
 assert.equal(res.statusCode,200,'status is available before async compression finishes');
 const bytes=await ended;
 return {bytes,headers,status};
}

test('large private API snapshots compress without changing their JSON shape',async()=>{
 const payload={prospects:Array.from({length:80},(_,id)=>({id,name:'Contact',draft:'Hello '.repeat(100)}))};
 const r=await response(payload,'br, gzip;q=0.8');
 assert.equal(r.status,200);
 assert.equal(r.headers['Content-Encoding'],'gzip');
 assert.equal(r.headers['Cache-Control'],'no-store');
 assert.equal(r.headers.Vary,'Accept-Encoding');
 assert.equal(r.headers['Content-Length'],r.bytes.length);
 assert.deepEqual(JSON.parse(gunzipSync(r.bytes)),payload);
 assert.ok(r.bytes.length<Buffer.byteLength(JSON.stringify(payload))/4);
});

test('small bodies and gzip exclusions remain plain JSON',async()=>{
 for(const [payload,encoding] of [[{ok:true},'gzip'],[{text:'x'.repeat(4000)},'gzip;q=0, *;q=1'],[{text:'x'.repeat(4000)},'br'],[{text:'x'.repeat(4000)},'']]){
  const r=await response(payload,encoding);
  assert.equal(r.headers['Content-Encoding'],undefined);
  assert.deepEqual(JSON.parse(r.bytes),payload);
 }
});

test('wildcard negotiation works and disconnected compressed requests do not write',async()=>{
 const payload={text:'x'.repeat(4000)};
 assert.equal((await response(payload,'*;q=0.5')).headers['Content-Encoding'],'gzip');
 sendJsonResponse({destroyed:true,writeHead:()=>assert.fail('closed response'),end:()=>assert.fail('closed response')},200,payload,'gzip');
 await new Promise(resolve=>setTimeout(resolve,20));
});
