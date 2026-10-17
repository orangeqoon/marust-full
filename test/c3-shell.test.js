'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeShell } = require('../host/layer1/data-plugins');
const { pickShell } = require('../host/layer1/shell-pick');
const { createRegistry } = require('../host/layer1/plugin-registry');
const { createApi } = require('../host/layer1/api');
const { createUiSettings } = require('../host/layer1/ui-settings');
const { WINDOW_ID } = require('../host/layer1/clients');
const shell = { label: 'Test', scripts: ['boot.js'], styles: ['look.css'] };
const row = (id, source) => ({ id, source, shell, isDefault: source === 'set' });
const windowCtx = { clientId: WINDOW_ID, kind: 'window', permissions: ['read','write','emergency'] };
test('shell paths reject traversal, absolute paths, wrong extension and duplicates', () => {
  for (const scripts of [['../evil.js'], ['/evil.js'], ['https://evil/x.js'], ['a.js','a.js'], ['a.html'], ['x\\a.js']]) assert.ok(normalizeShell({ ...shell, scripts }).error);
  assert.ok(normalizeShell({ ...shell, template: '../x.html' }).error);
  assert.equal(normalizeShell(shell).shell.scripts[0], 'boot.js');
});
test('default set wins; explicit user works; missing, incompatible, runtime-failed choices return to set', () => {
  const rows=[row('standard','set'),row('mine','user')];
  assert.equal(pickShell(rows,'').active.id,'standard');
  assert.equal(pickShell(rows,'mine').active.id,'mine');
  assert.equal(pickShell(rows,'gone',[{id:'gone',reason:'core-api-too-new'}]).reason,'core-api-too-new');
  assert.equal(pickShell(rows,'mine',[],['mine']).active.id,'standard');
  assert.equal(pickShell(rows,'mine',[],['mine','standard']).active,null);
});
test('registry validates both sources, missing files, API version reasons, reload and plugins.list', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'marust-c3-'));
  try {
    function put(source,id,extra={}) {
      const base=path.join(dir,source,id);fs.mkdirSync(path.join(base,'shell'),{recursive:true});
      fs.writeFileSync(path.join(base,'manifest.json'),JSON.stringify({id,name:id,version:'1.0.0',manifestVersion:2,coreApi:1,kind:'shell',tier:'basic',shell,...extra}));
      fs.writeFileSync(path.join(base,'shell/boot.js'),'');fs.writeFileSync(path.join(base,'shell/look.css'),'');
    }
    put('set','standard');put('user','mine');put('set','future',{coreApi:999});put('set','bad',{coreApi:'x'});put('set','missing');fs.unlinkSync(path.join(dir,'set/missing/shell/boot.js'));
    const reg=createRegistry({core:{STATE_DIR:dir},appRoot:dir,setDirs:[{dir:path.join(dir,'set')}],externalRoot:path.join(dir,'user'),logger() {}});
    await reg.loadAll();assert.equal(reg.dataPlugins('shell').length,2);assert.equal(reg.holdsObs('standard'),false);
    const reasons=reg.snapshot().filter(r=>r.reason).map(r=>r.reason);assert.ok(reasons.includes('shell-file-missing'));assert.ok(reasons.includes('core-api-too-new'));assert.ok(reasons.includes('bad-core-api'));reasons.forEach(r=>assert.match(r,/^[a-z0-9-]+$/));
    const settings=createUiSettings({stateDir:dir});
    const api=createApi({pluginRegistry:reg,dataPlugins:k=>reg.dataPlugins(k),uiSettings:settings,getState:()=>({plugins:reg.snapshot(),destinations:{liveCount:0},engineStatus:{connected:false}})});
    assert.equal((await api.call('ui.setShell',{id:'mine'},windowCtx)).active.id,'mine');
    assert.equal((await api.call('ui.getShell',{excluded:'mine'},windowCtx)).active.id,'standard');
    assert.equal((await api.call('ui.setShell',{id:'standard'},{kind:'native',clientId:'other',permissions:['read','write']})).ok,false);
    const listed=await api.call('plugins.list',{},windowCtx);assert.equal(listed.plugins.find(r=>r.id==='future').reason,'core-api-too-new');
    fs.unlinkSync(path.join(dir,'user/mine/shell/boot.js'));assert.equal((await reg.reload('mine')).result,'error');
    const after=await api.call('ui.getShell',{},windowCtx);
    assert.equal(after.active.id,'standard');
    assert.equal(after.wanted,'mine');
    assert.equal(after.fellBack,true);
    assert.equal(settings.getView().shell,'mine');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
function coreTables() {
  const w={};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../ui/core-strings.js'),'utf8'),{window:w});
  return w;
}
function shellAnswer(mode) {
  if (mode==='empty') return {active:null,problems:[],shells:[]};
  if (mode==='mismatch') return {active:null,problems:[{id:'future',reason:'core-api-too-new'}],shells:[],wanted:'future',fellBack:true,reason:'core-api-too-new'};
  return {active:{id:'mine',base:'/plugins/mine/shell/',scripts:['boot.js'],styles:['look.css'],template:'template.html'},problems:[]};
}
function loader(mode) {
  const elements={};const events={};const calls=[];const replaced=[];let subscriber;
  const tables=coreTables();
  const el=id=>elements[id]||(elements[id]={hidden:false,children:[],appendChild(c){this.children.push(c);},textContent:''});
  const location={href:'http://127.0.0.1:18770/?panel=home&view=dock',search:'?panel=home&view=dock',replace:x=>replaced.push(x)};
  let context;
  const api={subscribe(fn){subscriber=fn;},call(name,params){calls.push([name,params]);if(name==='hub.getState')return Promise.resolve({destinations:{liveCount:0},engineStatus:{connected:true,profileWarning:true}});if(name==='ui.getShell')return Promise.resolve(shellAnswer(mode));return Promise.resolve({ok:true});}};
  const timers=[];
  context={window:{marustApi:api,addEventListener:(n,f)=>events[n]=f,CORE_STR:tables.CORE_STR,CORE_REASONS:tables.CORE_REASONS},CORE_STR:tables.CORE_STR,CORE_REASONS:tables.CORE_REASONS,document:{hidden:false,getElementById:el,createElement:()=>({}),head:{appendChild(item){queueMicrotask(()=>{if(mode==='asset-fail')item.onerror();else {if(item.src){if(mode==='syntax-fail')events.error();else context.window.marustShell.ready();}item.onload();}});}}},location,URL,URLSearchParams,Promise,setTimeout:(f,ms)=>{timers.push([f,ms]);return timers.length;},clearTimeout(){},setInterval(){},fetch:async()=>({ok:true,text:async()=>'<main></main>'})};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../ui/fallback.js'),'utf8'),context);
  return {elements,calls,replaced,events,timers,subscriber:()=>subscriber,CORE_STR:tables.CORE_STR,CORE_REASONS:tables.CORE_REASONS};
}
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
test('core fallback uses real API names, live state, restart; normal shell becomes visible only after ready',async()=>{
  const state=loader('ok');await flush();assert.equal(state.elements['core-fallback'].hidden,true);assert.equal(state.elements['core-state'].textContent,'配信中です');
  state.elements['core-stop'].onclick();state.elements['core-restart'].onclick();await flush();
  const described=await createApi({}).call('api.describe',{},windowCtx);const methods=described.methods.map(r=>r.method);for(const [name] of state.calls)assert.ok(methods.includes(name),name);
  assert.ok(state.calls.some(r=>r[0]==='broadcast.stopAll'));assert.ok(state.calls.some(r=>r[0]==='ui.restart'));
});
test('HTTP/CSS and JavaScript initialization failure return to set via fresh page preserving queries',async()=>{
  for(const mode of ['asset-fail','syntax-fail']){const state=loader(mode);await flush();assert.ok(state.replaced.length>0,mode);const next=new URL(state.replaced[0]);assert.equal(next.searchParams.get('panel'),'home');assert.equal(next.searchParams.get('view'),'dock');assert.equal(next.searchParams.get('shell-failed'),'mine');}
});
test('empty set retains core fallback; reload clears previous failures',async()=>{
  const state=loader('empty');await flush();assert.equal(state.elements['core-fallback'].hidden,false);assert.equal(state.elements['shell-root'].hidden,true);
  assert.equal(state.elements['core-reason'].textContent,state.CORE_STR.noShell);
  assert.equal(state.elements['core-stop'].textContent,state.CORE_STR.stopAll);
  assert.equal(state.elements['core-restart'].textContent,state.CORE_STR.restart);
  state.subscriber()({name:'ui.reloadRequested',payload:{target:'all'}});assert.equal(new URL(state.replaced[0]).searchParams.has('shell-failed'),false);
});

test('HTTP shell assets and template use CSP and refuse paths outside shell', async () => {
  const http = require('node:http');
  const { createGateway } = require('../host/layer1/gateway');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'marust-c3-http-'));
  fs.mkdirSync(path.join(dir,'shell'));fs.writeFileSync(path.join(dir,'shell/boot.js'),'window.loaded=true;');fs.writeFileSync(path.join(dir,'shell/template.html'),'<main>shell</main>');fs.writeFileSync(path.join(dir,'private.js'),'PRIVATE');
  const gateway=createGateway({ receiver:{handle(){return false;}}, clients:{authenticate(){return null;},list(){return[];}}, plugins:{snapshot(){return[{id:'mine',dir,status:'data',manifest:{kind:'shell'}}];}} });
  const server=await gateway.listen(0), port=server.address().port;
  function request(url){return new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path:url,headers:{Host:'127.0.0.1:18770'}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));}).on('error',reject);});}
  try {
    assert.equal((await request('/plugins/mine/shell/boot.js')).status,200);
    assert.equal((await request('/plugin/mine/shell/boot.js')).status,200);
    const html=await request('/plugins/mine/shell/template.html');assert.equal(html.status,200);assert.match(html.headers['content-security-policy'],/script-src 'self'/);
    for(const url of ['/plugins/mine/shell/../private.js','/plugins/mine/shell/%2e%2e/private.js','/plugins/mine/private.js','/plugins/mine/shell/missing.js'])assert.equal((await request(url)).status,404,url);
  } finally { await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true}); }
});

test('core fallback words come from core-strings, not strings.js; version mismatch lists the reason', async () => {
  const fallback = fs.readFileSync(path.join(__dirname, '../ui/fallback.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../ui/hub.html'), 'utf8');
  assert.ok(html.includes('core-strings.js'));
  assert.ok(!html.includes('/ui/strings.js') && !fallback.includes('strings.js'));
  assert.ok(fallback.includes('CORE_STR') && fallback.includes('CORE_REASONS'));
  const state = loader('mismatch');
  await flush();
  assert.equal(state.elements['core-fallback'].hidden, false);
  assert.equal(state.elements['shell-root'].hidden, true);
  assert.equal(state.elements['core-problems'].children[0].textContent, 'future: ' + state.CORE_REASONS['core-api-too-new']);
  assert.equal(state.elements['core-reason'].textContent, state.CORE_STR.noShell);
});

test('developer ui.reload and plugin.reload reinsert the shell; non-dev is refused', async () => {
  const { EVENTS } = require('../host/core/events');
  assert.equal(EVENTS.UI_SHELL_CHANGED, 'ui.shellChanged');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marust-c3-reload-'));
  try {
    const base = path.join(dir, 'set', 'standard');
    fs.mkdirSync(path.join(base, 'shell'), { recursive: true });
    fs.writeFileSync(path.join(base, 'manifest.json'), JSON.stringify({ id: 'standard', name: 'standard', version: '1.0.0', manifestVersion: 2, coreApi: 1, kind: 'shell', tier: 'basic', isDefault: true, shell }));
    fs.writeFileSync(path.join(base, 'shell/boot.js'), '');
    fs.writeFileSync(path.join(base, 'shell/look.css'), '');
    const reg = createRegistry({ core: { STATE_DIR: dir }, appRoot: dir, setDirs: [{ dir: path.join(dir, 'set') }], externalRoot: path.join(dir, 'user'), logger() {} });
    await reg.loadAll();
    const settings = createUiSettings({ stateDir: dir });
    const events = [];
    const deps = {
      pluginRegistry: reg,
      dataPlugins: (k) => reg.dataPlugins(k),
      uiSettings: settings,
      bus: { publish(name, payload) { events.push({ name, payload }); } },
      getState: () => ({ plugins: reg.snapshot(), destinations: { liveCount: 0 }, engineStatus: { connected: false } })
    };
    const off = createApi(Object.assign({}, deps, { devMode: { get: () => ({ devMode: false }) } }));
    assert.equal((await off.call('ui.reload', { target: 'all' }, windowCtx)).error, 'dev-only');
    assert.equal((await off.call('plugin.reload', { id: 'standard' }, windowCtx)).error, 'dev-only');
    const on = createApi(Object.assign({}, deps, { devMode: { get: () => ({ devMode: true }) } }));
    assert.equal((await on.call('ui.reload', { target: 'all' }, windowCtx)).sent, true);
    assert.equal((await on.call('ui.reload', { target: 'plugin:standard' }, windowCtx)).sent, true);
    const reloaded = await on.call('plugin.reload', { id: 'standard' }, windowCtx);
    assert.equal(reloaded.result, 'ok');
    assert.ok(events.some((e) => e.name === 'ui.reloadRequested' && e.payload.target === 'all'));
    assert.ok(events.some((e) => e.name === 'ui.reloadRequested' && e.payload.target === 'plugin:standard'));
    assert.ok(events.some((e) => e.name === 'plugin.reloaded' && e.payload.id === 'standard'));
    const page = loader('empty');
    await flush();
    page.subscriber()({ name: 'plugin.reloaded', payload: { id: 'standard' } });
    page.subscriber()({ name: 'ui.reloadRequested', payload: { target: 'plugin:standard' } });
    assert.equal(page.replaced.length, 2);
    assert.equal(new URL(page.replaced[0]).searchParams.has('shell-failed'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
