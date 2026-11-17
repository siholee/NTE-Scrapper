import { _electron as electron } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { projectRoot } from '../src/paths.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = path.join(projectRoot, 'work', 'desktop-smoke-' + Date.now()); await fs.mkdir(root, { recursive: true });
const syncFolder = path.join(root, 'NOVEL');
await fs.mkdir(syncFolder);
const body = '브라우저에서 정상 표시된 시험용 본문입니다.\n\n두 번째 문단과 한글 저장을 확인합니다.';
const timestamps = [];
const server = http.createServer((req,res) => {
  if (/^\/novel\/42(?:\/\d+)?$/.test(req.url)) timestamps.push(performance.now());
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if (req.url === '/novel/42') {
    const window = { items: [1,2].map(n => ({id:String(100+n),number:n,title:'시험 회차 '+n})), hasOlder:false };
    const record = '4:' + JSON.stringify(['$', 'div', null, {initial:window}]) + '\n';
    res.end('<html><head><title>GUI 시험 - 시험 작가 | 사이트</title></head><body><h1>GUI 시험</h1><script>self.__next_f={push:()=>{}};self.__next_f.push('+JSON.stringify([1,record])+')</script></body></html>');
  } else res.end('<html><script>window.__novelTTSText='+JSON.stringify(body)+'</script><p>시험 본문</p></html>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const exe = process.env.NTE_SMOKE_EXE || path.join(projectRoot,'node_modules/electron/dist/electron.exe');
const args = process.env.NTE_SMOKE_EXE ? [] : [projectRoot];
const env={...process.env,NTE_DATA_DIR:path.join(root,'data'),NTE_TEST_USER_DATA:path.join(root,'profile')}; delete env.ELECTRON_RUN_AS_NODE;
let guiPid;
try {
  const app = await electron.launch({ executablePath: exe, args, env });
  guiPid = await app.evaluate(() => process.pid);
  const page = await app.firstWindow();
  await page.waitForSelector('#url');
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, syncFolder);
  await page.locator('#drive-select').click();
  await page.waitForFunction(folder => document.querySelector('#drive-folder').textContent === folder, syncFolder);
  await page.locator('#url').fill(`http://127.0.0.1:${server.address().port}/novel/42`);
  await page.locator('#delay').fill('20');
  await page.locator('#start').click();
  await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('전체 TXT와 EPUB 저장이 완료'),{},{timeout:65000});
  assert.equal(await page.locator('#count').textContent(),'2 / 2');
  assert.match(await page.locator('#drive-message').textContent(), /동기화 폴더에 복사됨/);
  const [epub] = await fs.readdir(syncFolder);
  assert.deepEqual(await fs.readdir(syncFolder), ['GUI 시험.epub']);
  const library = path.join(root, 'data', 'library');
  const [bookFolder] = await fs.readdir(library);
  assert.deepEqual(await fs.readFile(path.join(syncFolder, epub)), await fs.readFile(path.join(library, bookFolder, epub)));
  assert.equal(timestamps.length, 3);
  const intervals = timestamps.slice(1).map((time, i) => time - timestamps[i]);
  assert.ok(intervals.every(ms => ms >= 19_950), JSON.stringify(intervals));
  console.log('Request intervals in ms:', intervals.map(Math.round));
  await page.screenshot({path:path.join(root,'gui.png')});
  console.log('GUI URL → 확인 → 2회차 TXT/EPUB 완료:',root);
  process.kill(guiPid);
  guiPid = undefined;
  const client=new Client({name:'exe-smoke',version:'1'});
  const serverRoot = process.env.NTE_SMOKE_EXE ? path.join(path.dirname(exe), 'resources', 'app') : projectRoot;
  const transport=new StdioClientTransport({command:exe,args:[path.join(serverRoot,'src/server.js')],env:{...env,ELECTRON_RUN_AS_NODE:'1'},stderr:'pipe'});
  await Promise.race([client.connect(transport), new Promise((_,reject)=>setTimeout(()=>reject(new Error("MCP initialize timeout")),15000).unref())]); assert.equal((await client.listTools()).tools.length,9);
  const health=await client.callTool({name:'nte_health',arguments:{}}); assert.equal(health.structuredContent.ready,true);
  await client.close(); console.log('EXE MCP handshake and shared worker: OK');
} finally {
  if (guiPid) {
    try { process.kill(guiPid); } catch { /* GUI already exited. */ }
  }
  server.close();
  server.closeAllConnections();
  try { const runtime=JSON.parse(await fs.readFile(path.join(root,'data/runtime.json'),'utf8')); process.kill(runtime.pid); } catch {}
}
