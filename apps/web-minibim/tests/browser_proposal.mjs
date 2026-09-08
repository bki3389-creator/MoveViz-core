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
  assert.equal(await evaluate("document.querySelector('#propHeroImg').src.startsWith('data:image/jpeg')"),true,'actual geometry preview');
  await click('propView3d');
  assert.equal(await evaluate("document.querySelector('#propHeroImg').src.includes('/assets/proposal/calm.jpg')"),true,'reference is secondary explicit view');
  await click('propView3d');
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
  assert.equal(await evaluate("document.querySelector('#studioSpaceReview').getClientRects().length"),0,'studio panels do not leak into legacy editor');
  // Full author workflow uses the actual model and exactly the same stored estimate.
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Emulation.setTouchEmulationEnabled',{enabled:false});
  await send('Page.navigate',{url:base+'/?mode=pro&view=studio'});
  await until(()=>evaluate("document.body.classList.contains('studio-active') && document.querySelector('#studioFinish-floor')"),'working studio');
  await shot('studio-space.png');
  await click('studioStartDesign');
  assert.equal(await evaluate('document.body.dataset.studioStep'),'design');
  await evaluate("window._state=await import('./js/state.js'); window._original=JSON.stringify(_state.state.project); window._roomId=_state.selectedRoom().id; window._originalTotal=(await import('./js/estimate.js')).buildEstimate().total; var floor=document.querySelector('#studioFinish-floor'); floor.value='fl_hardwood'; floor.dispatchEvent(new Event('change',{bubbles:true}));");
  assert.equal(await evaluate('_state.selectedRoom().floorFinish'),'fl_hardwood','material control changes actual room');
  assert.equal(await evaluate("JSON.stringify(_state.selectedRoom().plan)===JSON.stringify(JSON.parse(_original).rooms.find(r=>r.id===_roomId).plan)"),true,'finish change preserves scan geometry');
  assert.equal(await evaluate("document.querySelector('#studioTotal').textContent===Math.round((await import('./js/estimate.js')).buildEstimate().total).toLocaleString('ko-KR')+'원'"),true,'visible cost is actual estimate');
  await click('studioUndo');
  assert.equal(await evaluate('JSON.stringify(_state.state.project)===_original'),true,'studio undo restores exact project');
  await evaluate("document.querySelector('[data-studio-style=calm]').click()");
  await shot('studio-design.png');
  await click('studioCompare');
  assert.equal(await evaluate("!document.querySelector('#studioComparison').hidden && document.querySelector('#studioBeforeImage').src!==document.querySelector('#studioAfterImage').src"),true,'actual before/after image pair');
  await evaluate("var range=document.querySelector('#studioCompareRange'); range.value=25;range.dispatchEvent(new Event('input',{bubbles:true}));");
  assert.equal(await evaluate("document.querySelector('.studio-comparison-images').style.getPropertyValue('--split')"),'25%','slider updates image split');
  const compareBox=await evaluate("(()=>{const r=document.querySelector('.studio-comparison-images').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()");
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:compareBox.x+compareBox.w*.3,y:compareBox.y+compareBox.h*.5,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:compareBox.x+compareBox.w*.7,y:compareBox.y+compareBox.h*.5,button:'left',buttons:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:compareBox.x+compareBox.w*.7,y:compareBox.y+compareBox.h*.5,button:'left',clickCount:1});
  assert.ok(Math.abs(Number(await evaluate("document.querySelector('#studioCompareRange').value"))-70)<2,'dragging the image directly updates comparison');
  await shot('studio-compare.png');await click('studioCompareClose');
  await click('studioNext');
  assert.equal(await evaluate('document.body.dataset.studioStep'),'cost');
  await evaluate("var rate=document.querySelector('#estTable .rate-in'); rate.value=Number(rate.value)+1000;rate.dispatchEvent(new Event('change',{bubbles:true}));");
  assert.equal(await evaluate("document.querySelector('#studioCostTotal').textContent===Math.round((await import('./js/estimate.js')).buildEstimate().total).toLocaleString('ko-KR')+'원'"),true,'custom estimate rates refresh studio totals');
  await shot('studio-cost.png');
  await click('studioCostProposal');await ready();
  assert.equal(await evaluate("document.querySelector('#propTotal').textContent===document.querySelector('#studioCostTotal').textContent"),true,'proposal cost matches the edited workspace');
  await click('propEdit');
  // Exercise the actual file input handler, then customize that imported room.
  const doc=await send('DOM.getDocument');
  const fileNode=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#fileIn'});
  await send('DOM.setFileInputFiles',{nodeId:fileNode.nodeId,files:[fileURLToPath(new URL('../sample/sample_studio.json',import.meta.url))]});
  await until(()=>evaluate("_state.state.project.name==='신촌 원룸' && _state.state.project.rooms.length===2"),'imported studio scan');
  await click('studioStartDesign');
  await evaluate("var floor=document.querySelector('#studioFinish-floor');floor.value='fl_hardwood';floor.dispatchEvent(new Event('change',{bubbles:true}));");
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  await evaluate('window.scrollTo(0,0)');await shot('studio-mobile.png');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'mobile studio must not overflow');
  assert.equal(await evaluate("document.querySelector('#studioFinishes').getBoundingClientRect().width>0 && document.querySelector('#view3d canvas').getBoundingClientRect().height>200"),true,'mobile model and controls both usable');
  await click('studioNext');await click('studioCostProposal');await ready();
  const customTotal=await evaluate("document.querySelector('#propTotal').textContent");
  assert.equal(await evaluate("document.querySelector('#propHeroImg').src.startsWith('data:image/jpeg')"),true,'custom project proposal defaults to real model');
  assert.equal(await evaluate("(await import('./js/estimate.js')).buildEstimate().total"),await evaluate("Number(document.querySelector('#propTotal').textContent.replace(/[^0-9]/g,''))"),'custom proposal exact cost');
  await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window._copied=text;}}});Object.defineProperty(navigator,'share',{configurable:true,value:undefined});window._copied=null;");
  await click('propShare');await until(()=>evaluate("typeof _copied==='string'&&_copied.includes('#r=')"),'custom project share');
  const customLink=await evaluate('_copied');await send('Page.navigate',{url:customLink});await ready();
  assert.equal(await evaluate("document.querySelector('#propTotal').textContent"),customTotal,'recipient gets exact custom design cost');
  assert.equal(await evaluate("(await import('./js/state.js')).state.project.rooms[0].floorFinish"),'fl_hardwood','recipient gets custom material, not preset replacement');
  assert.equal(errors.length,0,JSON.stringify(errors));
  console.log('PASS actual studio/import/materials/undo/before-after/cost/proposal/customer workflow on desktop/mobile; proposal preview/restore and legacy sample; browser errors 0');
  console.log('Screenshots: '+out);
} finally {
  if(ws?.readyState===1){try{await send('Browser.close');}catch{}ws.close();}
  if(!proc.killed)proc.kill();
}
