import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {serveStaticFile} from '../state/static-files.mjs';
import {writeFileSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';

test('static assets revalidate with content ETags, including changed releases and HEAD',async()=>{
 const root=await mkdtemp(join(tmpdir(),'outbound-static-'));
 await writeFile(join(root,'index.html'),'release one');
 const server=createServer(async(req,res)=>{
  try{if(!await serveStaticFile(req,res,root,req.url,()=> 'text/html')){res.writeHead(404);res.end();}}
  catch(e){res.writeHead(500);res.end(e.message);}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}`;
 try{
  const first=await fetch(url);assert.equal(first.status,200);assert.equal(await first.text(),'release one');
  const etag=first.headers.get('etag');assert.ok(etag);assert.match(first.headers.get('cache-control'),/no-cache/);
  for(const header of [etag,`W/${etag}`,`"other", ${etag}`,'*']){
   const cached=await fetch(url,{headers:{'if-none-match':header}});assert.equal(cached.status,304);assert.equal(await cached.text(),'');
  }
  const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(head.headers.get('etag'),etag);
  await writeFile(join(root,'index.html'),'release two changed');
  const changed=await fetch(url,{headers:{'if-none-match':etag}});assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),etag);assert.equal(await changed.text(),'release two changed');
  assert.equal((await fetch(url+'/missing.js')).status,404);
  assert.equal((await fetch(url+'/directory/')).status,404);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
});

test('static file boundary cannot serve a sibling directory',async()=>{
 const responses=[];
 const res={writeHead:()=>responses.push('headers'),end:()=>responses.push('end')};
 assert.equal(await serveStaticFile({method:'GET',headers:{}},res,'/tmp/app','/../app-secret/key',()=>''),false);
 assert.deepEqual(responses,[]);
});

test('strong validator and length describe the sent bytes even if a file changes at headers',async()=>{
 const root=await mkdtemp(join(tmpdir(),'outbound-static-race-'));
 const file=join(root,'index.html');
 try{
  for(const change of [()=>writeFileSync(file,'replacement with a different length'),()=>unlinkSync(file)]){
   const body='original asset';await writeFile(file,body);
   let headers,sent;
   const response={writeHead:(status,h)=>{assert.equal(status,200);headers=h;change();},end:b=>{sent=b;}};
   assert.equal(await serveStaticFile({method:'GET',headers:{}},response,root,'/',()=> 'text/html'),true);
   assert.equal(sent.toString(),body);
   assert.equal(headers['Content-Length'],Buffer.byteLength(body));
   assert.equal(headers.ETag,`"${createHash('sha256').update(sent).digest('hex')}"`);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
