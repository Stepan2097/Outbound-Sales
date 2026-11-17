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

// Власник 17.11: «весь інтерфейс має літати» — файли сторінки за адресою з релізом, кеш на рік.
test('the page names its files by release; those URLs are immutable, an older release still answers', async () => {
 const { appRelease, withRelease } = await import('../state/static-files.mjs');
 const root = await mkdtemp(join(tmpdir(), 'outbound-release-'));
 await writeFile(join(root, 'index.html'), '<link rel="stylesheet" href="/styles/a.css" /><script type="module" src="/main.js"></script><a href="/api/x">x</a><a href="https://e.com/y.js">y</a>');
 await writeFile(join(root, 'main.js'), 'import "./b.js";');
 const server = createServer(async (req, res) => { if (!await serveStaticFile(req, res, root, req.url, () => 'text/plain')) { res.writeHead(404); res.end(); } });
 await new Promise((r) => server.listen(0, '127.0.0.1', r));
 const url = `http://127.0.0.1:${server.address().port}`;
 try {
  const release = await appRelease(root);
  assert.match(release, /^[0-9a-f]{12}$/);
  const page = await (await fetch(url + '/')).text();
  assert.match(page, new RegExp(`href="/r/${release}/styles/a\\.css"`));
  assert.match(page, new RegExp(`src="/r/${release}/main\\.js"`));
  assert.match(page, /href="\/api\/x"/);
  assert.match(page, /href="https:\/\/e\.com\/y\.js"/);
  const asset = await fetch(`${url}/r/${release}/main.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control'), /immutable/);
  assert.equal(await asset.text(), 'import "./b.js";');
  const old = await fetch(`${url}/r/000000000000/main.js`);
  assert.equal(old.status, 200);
  assert.match(old.headers.get('cache-control'), /no-cache/);
  // A saved file is a new release: a server under edit never serves an old module for a year.
  await writeFile(join(root, 'main.js'), 'import "./c.js";');
  assert.notEqual(await appRelease(root), release);
  assert.equal(withRelease('<img src="/logo.svg">', 'abc'), '<img src="/r/abc/logo.svg">');
 } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); await rm(root, { recursive: true, force: true }); }
});

test('the icons come from a pinned version — «@latest» is a redirect cached for a minute on every load', async () => {
 const { readFileSync } = await import('node:fs');
 const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
 assert.doesNotMatch(html, /@latest/);
 assert.match(html, /unpkg\.com\/lucide@\d+\.\d+\.\d+\//);
});
