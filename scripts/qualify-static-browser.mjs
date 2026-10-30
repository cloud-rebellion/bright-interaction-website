import {readFileSync,existsSync,mkdirSync,statSync,createReadStream,openSync,writeFileSync} from 'node:fs';
import {resolve,join,extname,sep} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
let root=resolve(process.argv[2]);const scratch=process.env.BUILD_SCRATCH_DIR;
if(!scratch || !root.startsWith(resolve(scratch)+sep)) throw new Error('Expected owned scratch artifact');
const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.woff':'font/woff','.xml':'application/xml','.json':'application/json'};
const server=createServer((req,res)=>{try{const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);let file=resolve(root,'.'+path);if(file!==root&&!file.startsWith(root+sep))throw new Error('escape');if(existsSync(file)&&statSync(file).isDirectory())file=join(file,'index.html');if(!existsSync(file)){res.writeHead(404);res.end('Not found');return;}res.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream','Cache-Control':'no-store'});createReadStream(file).pipe(res);}catch{res.writeHead(400);res.end('Bad request');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const profile=join(scratch,'chrome-profile');mkdirSync(profile);const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:scratch,LANG:'en_US.UTF-8'};
const child=spawn(process.env.CHROME_PATH,['--headless=new','--no-sandbox','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-gpu','--force-color-profile=srgb','about:blank'],{env,stdio:['ignore','ignore',openSync(join(scratch,'chrome.stderr'),'w')]});
let ws;const pending=new Map();let sequence=0;const blocked=new Set();const exceptions=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function call(method,params={}){const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout ${method}`));},10000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,timeout:8000});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;}
async function ready(){for(let i=0;i<100;i++){if(await evaluate('document.readyState')==='complete')break;await wait(50);}await evaluate('Promise.race([document.fonts.ready.then(()=>true),new Promise(r=>setTimeout(()=>r(false),3000))])');await wait(120);}
async function navigate(path){await call('Page.navigate',{url:origin+path});await wait(100);await ready();}
let imageBytes=0;const datasets=[];
try{
 const active=join(profile,'DevToolsActivePort');for(let i=0;i<200&&!existsSync(active);i++){if(child.exitCode!==null)throw new Error('Chrome exited before DevTools');await wait(50);}if(!existsSync(active))throw new Error('Chrome did not start');const port=Number(readFileSync(active,'utf8').split('\n')[0]);const target=await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
 ws.addEventListener('message',e=>{const m=JSON.parse(String(e.data));if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}return;}if(m.method==='Fetch.requestPaused'){const p=m.params;let allowed=false;try{allowed=new URL(p.request.url).origin===origin || p.request.url.startsWith('data:');}catch{}if(allowed)call('Fetch.continueRequest',{requestId:p.requestId}).catch(()=>{});else{try{blocked.add(new URL(p.request.url).hostname);}catch{}call('Fetch.failRequest',{requestId:p.requestId,errorReason:'BlockedByClient'}).catch(()=>{});}}if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails?.text??'runtime exception');});
 await call('Page.enable');await call('Page.addScriptToEvaluateOnNewDocument',{source:"document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';document.head.appendChild(s);},{once:true});"});await call('Runtime.enable');await call('Network.enable');await call('Network.setCacheDisabled',{cacheDisabled:true});await call('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
 for(const [label,datasetRoot] of [['baseline',process.argv[2]],...(process.argv[3]?[['candidate',process.argv[3]]]:[])]){
  root=resolve(datasetRoot);if(!root.startsWith(resolve(scratch)+sep))throw new Error('Expected owned scratch dataset');
  const snapshots=[];const exceptionStart=exceptions.length;
 for(const viewport of [{name:'desktop',width:1440,height:1000},{name:'mobile',width:390,height:844}]){
  await call('Emulation.setDeviceMetricsOverride',{width:viewport.width,height:viewport.height,deviceScaleFactor:1,mobile:viewport.name==='mobile'});
  for(const [path,lang] of [['/','en'],['/sv/','sv']]){
   await navigate(path);const metrics=await evaluate(`(()=>{const h=document.querySelector('h1'),b=h?.getBoundingClientRect(),s=h&&getComputedStyle(h);return{path:location.pathname,title:document.title,lang:document.documentElement.lang,h1:h?.innerText,anchors:document.querySelectorAll('a').length,bodyWidth:document.body.scrollWidth,viewportWidth:innerWidth,h1Box:b&&{x:b.x,y:b.y,width:b.width,height:b.height},h1Style:s&&{font:s.font,color:s.color,lineHeight:s.lineHeight},languageLinks:[...document.querySelectorAll('a')].map(a=>a.getAttribute('href')).filter(x=>x==='/'||x==='/sv'||x==='/sv/')}})()`);
   if(metrics.lang!==lang||!metrics.h1||metrics.anchors<5)throw new Error(`Invalid core page ${path}: ${JSON.stringify(metrics)}`);
   const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});imageBytes+=Buffer.from(shot.data,'base64').length;if(imageBytes>5*1024*1024)throw new Error('Qualification image budget exceeded');const screenshotPath=join(scratch,`${label}-${viewport.name}-${lang}.png`);writeFileSync(screenshotPath,Buffer.from(shot.data,'base64'));snapshots.push({viewport:viewport.name,...metrics,screenshotPath});
  }
 }
 await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await navigate('/');
 const languageLink=await evaluate(`(()=>{const a=[...document.querySelectorAll('a')].find(a=>new URL(a.href).pathname==='/sv'||new URL(a.href).pathname==='/sv/');if(!a)return false;a.click();return true;})()`);if(!languageLink)throw new Error('No Swedish language navigation');await wait(150);await ready();if(await evaluate('document.documentElement.lang')!=='sv')throw new Error('Language navigation did not reach Swedish');
 for(const path of ['/insights/','/sv/insights/','/privacy/','/sv/privacy/']){await navigate(path);if(!await evaluate('Boolean(document.querySelector("h1"))'))throw new Error(`Missing route ${path}`);}
 await navigate('/se');await wait(600);await ready();const redirect=await evaluate('({path:location.pathname,lang:document.documentElement.lang})');if(!redirect.path.startsWith('/sv')||redirect.lang!=='sv')throw new Error('Legacy Swedish redirect changed');
  datasets.push({label,snapshots,runtimeExceptions:exceptions.slice(exceptionStart)});
 }
 const differences=[];
 if(datasets.length===2){
  for(let i=0;i<datasets[0].snapshots.length;i++){
   const a=datasets[0].snapshots[i],b=datasets[1].snapshots[i];
   for(const key of ['title','lang','h1','anchors','bodyWidth','viewportWidth','h1Style','languageLinks'])if(JSON.stringify(a[key])!==JSON.stringify(b[key]))differences.push({viewport:a.viewport,lang:a.lang,key,baseline:a[key],candidate:b[key]});
   for(const key of ['x','y','width','height'])if(Math.abs(a.h1Box[key]-b.h1Box[key])>1)differences.push({viewport:a.viewport,lang:a.lang,key:'h1Box.'+key,baseline:a.h1Box[key],candidate:b.h1Box[key]});
  }
 }
 const result={result:differences.length?'DIFFERENCES_REQUIRE_REVIEW':'PASS',controller:`Bun ${Bun.version}`,origin:'loopback-only',externalRequestsBlocked:[...blocked].sort(),screenshotsBytes:imageBytes,datasets,differences,journeys:['EN/SV home desktop/mobile','actual EN-to-SV language-link navigation','EN/SV insights routes','EN/SV privacy routes','legacy /se to Swedish redirect']};
 writeFileSync(join(scratch,'browser-result.json'),JSON.stringify(result));
 console.log(JSON.stringify({result:result.result,resultFile:join(scratch,'browser-result.json')}));

}finally{
 try{if(ws?.readyState===1)await call('Browser.close');}catch{}
 if(child.exitCode===null){await Promise.race([new Promise(r=>child.once('exit',r)),wait(3000)]);if(child.exitCode===null)child.kill('SIGTERM');}
 ws?.close();await new Promise(r=>server.close(r));
}
