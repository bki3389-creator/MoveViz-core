// Headless Chrome integration smoke. Start serve.py first; no npm dependencies.
// node apps/web-minibim/tests/browser_proposal.mjs [http://localhost:8899]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://localhost:8899';
const out = fileURLToPath(new URL('./.out/proposal-smoke/', import.meta.url));
await fs.mkdir(out, {recursive:true});
const profile = await fs.mkdtemp(path.join(out,'chrome-'));
const chrome = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync);
assert(chrome, 'Set CHROME_PATH to a Chromium browser executable');
assert((await fetch(base)).ok, 'Start apps/web-minibim/serve.py before this smoke test');
const proc = spawn(chrome,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','about:blank'], {windowsHide:true,stdio:'ignore'});
let ws, seq=0; const waiting=new Map(); const errors=[];
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function until(check, label, timeout=20000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await sleep(100);}
  throw new Error('Timed out: '+label);
}
function send(method,params={}) { return new Promise((resolve,reject)=>{
  const id=++seq;const timer=setTimeout(()=>{waiting.delete(id);reject(new Error('CDP timeout '+method));},30000);
  waiting.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});
  ws.send(JSON.stringify({id,method,params}));
}); }
async function evaluate(expression) {
  const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,replMode:true});
  if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
  return r.result?.value;
}
const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
async function ready() { await until(()=>evaluate("document.body.classList.contains('proposal-open') && document.querySelectorAll('[data-style]').length===2 && document.querySelector('#propHeroImg').complete && document.querySelector('#propHeroImg').naturalWidth>0"),'proposal and hero image'); }
async function shot(name) { const r=await send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(out,name),Buffer.from(r.data,'base64')); }
try {
  let port;
  await until(async()=>{try {port=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];return !!port;}catch{return false;}},'Chrome port');
  const targets=await(await fetch(`http://localhost:${port}/json/list`)).json();
  ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=waiting.get(m.id);waiting.delete(m.id);if(p)m.error?p.reject(m.error):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);else if(m.method==='Log.entryAdded' && m.params.entry.level==='error')errors.push(m.params.entry);};
  await send('Page.enable');await send('Runtime.enable');await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:base+'/?mode=pro&view=proposal'}); await ready();
  await evaluate("window._state = await import('./js/state.js'); window._before = JSON.stringify(_state.state.project); window._baseEstimate = (await import('./js/estimate.js')).buildEstimate().total;");
  await shot('desktop-warm.png');
  await evaluate("document.querySelector('[data-style=calm]').click()"); await ready();
  assert.equal(await evaluate('JSON.stringify(_state.state.project)===_before'),true,'preview must not mutate project');
  const calmTotal=await evaluate("document.querySelector('#propTotal').textContent");
  assert.notEqual(calmTotal,await evaluate("Math.round(_baseEstimate).toLocaleString('ko-KR')+'원'"),'calm estimate should reflect changed materials');
  await shot('desktop-calm.png');
  await click('propView3d');
  assert.equal(await evaluate("document.querySelector('#propHeroImg').src.startsWith('data:image/jpeg')"),true,'actual geometry preview');
  assert.equal(await evaluate('JSON.stringify(_state.state.project)===_before'),true,'render must not mutate project');
  await fs.writeFile(path.join(out,'geometry-calm.jpg'),Buffer.from((await evaluate("document.querySelector('#propHeroImg').src")).split(',')[1],'base64'));
  await shot('model-calm.png');
  await click('propCurrent'); await shot('model-baseline.png');
  await fs.writeFile(path.join(out,'geometry-baseline.jpg'),Buffer.from((await evaluate("document.querySelector('#propHeroImg').src")).split(',')[1],'base64'));
  await evaluate("document.querySelector('[data-style=calm]').click()");
  await click('propApply');
  assert.equal(await evaluate('_state.state.project.proposal.selectedStyle'),'calm');
  assert.equal(await evaluate("Math.round((await import('./js/estimate.js')).buildEstimate().total).toLocaleString('ko-KR')+'원'"),calmTotal,'applied estimate matches preview');
  assert.equal(await evaluate('_state.undo()'),true,'whole proposal can undo');
  assert.equal(await evaluate('JSON.stringify(_state.state.project)===_before'),true,'undo restores exact project');
  await evaluate("document.querySelector('[data-style=calm]').click()");
  await click('propApply');
  await evaluate("window._roomCount=_state.state.project.rooms.length; _state.loadJSONText(JSON.stringify(_state.state.project.rooms[0].plan),'new scan.json');");
  assert.equal(await evaluate('_state.undo()'),false,'import bounds history so old proposal undo cannot delete new scan');
  assert.equal(await evaluate('_state.state.project.rooms.length===_roomCount+1'),true,'imported room retained');
  await evaluate('_state.loadJSONText(_before,"restore fixture")');
  await evaluate("document.querySelector('[data-style=calm]').click()");
  await click('propApply');
  await click('propCurrent'); await click('propApply');
  assert.equal(await evaluate('(await import("./js/estimate.js")).buildEstimate().total'),await evaluate('_baseEstimate'),'restore baseline costs');
  await evaluate("document.querySelector('[data-style=calm]').click(); window._beforeShare=JSON.stringify(_state.state.project); Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window._copied=text;}}});");
  await click('propShare'); await until(()=>evaluate("typeof _copied==='string' && _copied.includes('#r=')"),'share link');
  assert.equal(await evaluate('JSON.stringify(_state.state.project)===_beforeShare'),true,'sharing comparison must not apply');
  const shared=await evaluate('_copied');
  await send('Page.navigate',{url:shared});await ready();
  assert.equal(await evaluate('document.body.classList.contains("customer")'),true);
  assert.equal(await evaluate('document.querySelector("#propTotal").textContent'),calmTotal,'customer cost matches selected share');
  await evaluate("window._state=await import('./js/state.js'); window._sent=JSON.stringify(_state.state.project); window._saved=localStorage.getItem('minibim.project'); Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window._copied=text;}}});");
  await evaluate("document.querySelector('[data-style=warm]').click()");await click('propApply');
  assert.equal(await evaluate('JSON.stringify(_state.state.project)===_sent'),true,'customer choice must not alter sent report');
  assert.equal(await evaluate("_copied.includes('상담 희망안: 따뜻한 오크')"),true,'customer copies consultation text');
  assert.equal(await evaluate("localStorage.getItem('minibim.project')===_saved"),true,'customer must preserve local autosave');
  await evaluate("document.querySelector('.proposal-brand').click()");
  assert.equal(await evaluate('location.href'),shared,'brand must preserve report hash');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  await evaluate("window.scrollTo(0,0)");await shot('mobile-customer.png');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'mobile must not overflow horizontally');
  await click('propEdit');
  assert.equal(await evaluate('document.body.classList.contains("proposal-open")'),false,'workspace reachable');
  assert.equal(await evaluate('document.querySelector("#inspector").inert'),true,'customer inspector read-only');
  assert.equal(await evaluate('document.querySelector("#estTable").inert'),true,'customer prices cannot be reached by keyboard');
  await click('btnProposal');assert.equal(await evaluate('document.body.classList.contains("proposal-open")'),true,'return to proposal');
  await send('Page.navigate',{url:base+'/?sample&mode=pro&tab=2d'});
  await until(()=>evaluate("document.querySelectorAll('#roomList .room-card').length===3"),'legacy sample');
  assert.equal(await evaluate('document.body.classList.contains("proposal-open")'),false,'legacy sample path preserved');
  assert.equal(errors.length,0,JSON.stringify(errors));
  console.log('PASS proposal desktop/mobile, preview purity, model renders, apply/undo/restore, share/customer, legacy sample; browser errors 0');
  console.log('Screenshots: '+out);
} finally {
  if(ws?.readyState===1){try{await send('Browser.close');}catch{}ws.close();}
  if(!proc.killed)proc.kill();
}
