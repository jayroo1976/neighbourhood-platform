// "Sleep mode": the database server is stopped overnight to save cost. The app itself scales to zero,
// so it is the always-reachable front door and can start the database on request.
import { DefaultAzureCredential } from '@azure/identity';

export type SleepState = 'up' | 'sleeping' | 'starting' | 'stopping' | 'unknown';

const sub = process.env.AZURE_SUBSCRIPTION_ID ?? '';
const rg = process.env.AZURE_RESOURCE_GROUP ?? '';
const server = process.env.PG_SERVER_NAME ?? '';
const API = '2024-08-01';

export const sleepManaged = Boolean(sub && rg && server);
const cred = sleepManaged ? new DefaultAzureCredential() : null;

function url(suffix = '') {
  return `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${server}${suffix}?api-version=${API}`;
}
async function arm(method: 'GET' | 'POST', suffix = '') {
  const token = await cred!.getToken('https://management.azure.com/.default');
  return fetch(url(suffix), { method, headers: { authorization: `Bearer ${token.token}` }, body: method === 'POST' ? '' : undefined });
}

export async function serverState(): Promise<SleepState> {
  if (!sleepManaged) return 'unknown';
  try {
    const r = await arm('GET');
    if (!r.ok) return 'unknown';
    const s = String(((await r.json()) as { properties?: { state?: string } }).properties?.state ?? '');
    if (s === 'Ready') return 'up';
    if (s === 'Stopped' || s === 'Disabled') return 'sleeping';
    if (s === 'Starting' || s === 'Updating') return 'starting';
    if (s === 'Stopping') return 'stopping';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Starts the database server if it is stopped. Returns the state after the request. */
export async function wakeServer(): Promise<SleepState> {
  const s = await serverState();
  if (s !== 'sleeping') return s;
  try {
    const r = await arm('POST', '/start');
    return r.ok || r.status === 202 ? 'starting' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const WAKE_JS = `
const msg=document.getElementById('msg'),btn=document.getElementById('go'),bar=document.getElementById('bar');
let t0=0;
async function status(){try{const r=await fetch('/api/system/status',{headers:{'X-Requested-With':'neighbourhood'}});return (await r.json()).state}catch{return 'unknown'}}
async function poll(){
  const s=await status();
  if(s==='up'){location.reload();return}
  const secs=Math.round((Date.now()-t0)/1000);
  msg.textContent=s==='starting'?'Starting up. This usually takes 3 to 5 minutes ('+secs+'s so far). This page will open by itself.':s==='stopping'?'It was just shutting down. Try again in a minute.':'Waiting for the database...';
  bar.style.width=Math.min(95,secs/3)+'%';
  setTimeout(poll,4000);
}
btn.onclick=async()=>{btn.disabled=true;t0=Date.now();msg.textContent='Sending start request...';
  try{await fetch('/api/system/wake',{method:'POST',headers:{'X-Requested-With':'neighbourhood'}})}catch{}
  poll()};
status().then(s=>{if(s==='starting'){btn.disabled=true;t0=Date.now();poll()}});
`;

export const WAKE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Neighbourhood - asleep</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4ecdc;color:#1d2a2a;font:16px/1.5 system-ui,sans-serif;padding:16px}
main{max-width:420px;background:#fffdf8;border:1px solid #e0d6bf;border-radius:14px;padding:24px;text-align:center}
h1{font:700 1.5rem Georgia,serif;color:#0f4c4c;margin:.2em 0}p{color:#667373}
button{min-height:48px;width:100%;border:0;border-radius:10px;background:#0f4c4c;color:#fff;font:600 1.05rem system-ui;cursor:pointer}button:disabled{opacity:.6}
.track{height:8px;background:#e8e2d0;border-radius:4px;margin:16px 0;overflow:hidden}#bar{height:100%;width:0;background:#c97a0a;transition:width 1s}</style></head>
<body><main><h1>The service is asleep</h1>
<p>To keep running costs down it shuts down overnight and when it is not needed. Tap the button to start it.</p>
<button id="go">Start the service</button><div class="track"><div id="bar"></div></div><p id="msg" role="status"></p></main>
<script src="/__wake.js"></script></body></html>`;
