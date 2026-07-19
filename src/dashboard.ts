/**
 * Zero-dependency live dashboard. The watcher (live.ts) calls
 * startDashboard() with a state callback; this serves a single
 * self-contained HTML page at / and JSON at /state, which the page polls
 * every 5s. No frameworks, no build step - Google Fonts load when online
 * and fall back to system fonts offline.
 */
import * as http from "http";

export interface DashboardFixture {
  fixtureId: string;
  label: string;
  ticksInWindow: number;
  /** selection -> latest implied probability (0..1) */
  latest: Record<string, number>;
  /** selection -> downsampled [timestamp, probability] series for charting */
  series: Record<string, [number, number][]>;
}

export interface DashboardFlag {
  at: number;
  fixtureLabel: string;
  selection: string;
  from: number;
  to: number;
  minutes: number;
  zScore?: number;
  proof?: string; // e.g. "14 Merkle nodes, root ab3f..." or "pending"
}

export interface DashboardState {
  startedAt: number;
  mode: string;
  settings: string;
  pollSeconds?: number;
  fixtures: DashboardFixture[];
  flags: DashboardFlag[];
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Sharp Movement Detector - Live</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:#faf9f7; --card:#ffffff; --border:#e8e4de; --border-strong:#ddd7cd; --hairline:#f3f0ea;
    --text:#1f1b16; --dim:#7a7266; --faint:#a39a8c;
    --p1:#4a6da7; --draw:#9a9287; --p2:#b25a41;
    --flag:#c58a2a; --flag-bg:#f6e8cd; --flag-tint:#fdf6ec; --flag-border:#ecdcc0; --flag-text:#a07021;
    --good:#3d7a4e; --good-bg:#e9f2ea; --bad:#b04438; --bad-bg:#f7e9e6;
    --chip-bg:#f3f0ea; --grid:#eee9e1; --axis:#b3a996;
    --font-ui:'Instrument Sans',system-ui,sans-serif;
    --font-mono:'IBM Plex Mono',ui-monospace,Menlo,monospace;
  }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:13.5px/1.55 var(--font-ui); padding:24px 28px; max-width:1100px; margin:0 auto; }
  .mono { font-family:var(--font-mono); }
  .head { display:flex; align-items:baseline; gap:12px; margin-bottom:18px; flex-wrap:wrap; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--good); align-self:center;
         animation:pulse 2s infinite; }
  @keyframes pulse { 50% { opacity:.3; } }
  h1 { font-size:17px; font-weight:700; }
  .hsub { color:var(--dim); font-size:13px; }
  .hchip { margin-left:auto; font-family:var(--font-mono); font-size:12px; color:var(--dim);
           background:var(--chip-bg); border:1px solid var(--border); border-radius:6px; padding:5px 10px; white-space:nowrap; }
  .grid { display:grid; grid-template-columns:repeat(2,1fr); gap:14px; }
  @media (max-width:760px){ .grid { grid-template-columns:1fr; } body { padding:16px; } }
  .card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px; }
  .card h2 { font-size:14.5px; font-weight:700; display:flex; align-items:baseline; }
  .card h2 .ticks { margin-left:auto; font-family:var(--font-mono); font-size:11px; font-weight:400; color:var(--faint); }
  .probs { display:flex; gap:16px; font-family:var(--font-mono); font-size:13px; margin:8px 0; flex-wrap:wrap; }
  .c1 { color:var(--p1); } .cd { color:var(--draw); } .c2 { color:var(--p2); }
  svg { width:100%; height:90px; display:block; }
  .seclabel { font-size:12px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--dim); margin:24px 0 10px; }
  .flag { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:11px 16px;
          display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
  .chip { font-family:var(--font-mono); font-size:11px; font-weight:600; padding:3px 9px; border-radius:6px; }
  .chip.amber { color:var(--flag-text); background:var(--flag-bg); }
  .flag .mv { font-family:var(--font-mono); }
  .flag .proof { margin-left:auto; font-family:var(--font-mono); font-size:11.5px; color:var(--good); }
  .flag .tm { font-family:var(--font-mono); font-size:11px; color:var(--faint); flex-basis:100%; }
  .empty { border:1px dashed var(--border); border-radius:10px; padding:24px; text-align:center; color:var(--dim); }
</style></head><body>
<div class="head"><div class="dot"></div><h1>Live watcher</h1>
  <span class="hsub" id="mode">connecting...</span>
  <span class="hchip" id="status"></span></div>
<div class="grid" id="fixtures"></div>
<div class="seclabel">Flagged moves</div>
<div id="flags"></div>
<script>
const COLORS={part1:"#4a6da7",draw:"#9a9287",part2:"#b25a41"};
const CLS={part1:"c1",draw:"cd",part2:"c2"};
function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;"); }
function pct(x){ return (x*100).toFixed(1)+"%"; }
function teams(label){
  const p=String(label).split(/ vs? /i);
  return { part1:p[0]||"part1", part2:p[1]||"part2", draw:"Draw" };
}
function updur(t0){
  const m=Math.floor((Date.now()-t0)/60000);
  return m>=60 ? Math.floor(m/60)+"h "+(m%60)+"m" : m+"m";
}
function spark(series){
  const all=Object.entries(series).filter(([,pts])=>pts.length>1);
  if(!all.length) return "<div class='empty' style='padding:10px'>waiting for ticks...</div>";
  let t0=Infinity,t1=-Infinity,lo=1,hi=0;
  for(const [,pts] of all){
    t0=Math.min(t0,pts[0][0]); t1=Math.max(t1,pts[pts.length-1][0]);
    for(const p of pts){ lo=Math.min(lo,p[1]); hi=Math.max(hi,p[1]); }
  }
  const pad=Math.max(0.02,(hi-lo)*0.15); lo=Math.max(0,lo-pad); hi=Math.min(1,hi+pad);
  const W=460,H=90,dx=t1-t0||1,dy=hi-lo||1;
  const Y=p=>H-(p-lo)/dy*H;
  const mid=lo+dy/2;
  let out="<svg viewBox='0 0 "+W+" "+H+"' preserveAspectRatio='none'>"+
    "<line x1='0' y1='"+Y(mid).toFixed(1)+"' x2='"+W+"' y2='"+Y(mid).toFixed(1)+"' stroke='#eee9e1'/>"+
    "<text x='4' y='"+(Y(mid)-3).toFixed(1)+"' fill='#b3a996' font-size='9' font-family='IBM Plex Mono,monospace'>"+(mid*100).toFixed(0)+"%</text>";
  for(const [sel,pts] of all){
    const d=pts.map((p,i)=>(i?"L":"M")+((p[0]-t0)/dx*W).toFixed(1)+","+Y(p[1]).toFixed(1)).join("");
    out+="<path d='"+d+"' fill='none' stroke='"+(COLORS[sel]||"#1f1b16")+"' stroke-width='1.8'/>";
  }
  return out+"</svg>";
}
async function refresh(){
  try{
    const s=await (await fetch("/state")).json();
    document.getElementById("mode").textContent=s.mode+" \\u00b7 "+s.settings;
    document.getElementById("status").textContent="up "+updur(s.startedAt)+" \\u00b7 poll "+(s.pollSeconds||60)+"s";
    const fx=document.getElementById("fixtures");
    fx.innerHTML=s.fixtures.length?s.fixtures.map(f=>{
      const T=teams(f.label);
      return "<div class='card'><h2>"+esc(f.label)+"<span class='ticks'>"+f.ticksInWindow+" ticks</span></h2>"+
      "<div class='probs'>"+Object.entries(f.latest).map(([sel,p])=>
        "<span class='"+(CLS[sel]||"")+"'>"+esc(T[sel]||sel)+" "+pct(p)+"</span>").join("")+"</div>"+
      spark(f.series)+"</div>";
    }).join(""):"<div class='empty' style='grid-column:1/-1'>No fixtures in the watch window - standing by. The watcher attaches automatically before kickoff.</div>";
    const fl=document.getElementById("flags");
    fl.innerHTML=s.flags.length?s.flags.map(f=>{
      const T=teams(f.fixtureLabel);
      return "<div class='flag'><span class='chip amber'>FLAG</span>"+
      "<span><b>"+esc(f.fixtureLabel)+"</b> \\u00b7 <b>"+esc(T[f.selection]||f.selection)+"</b> "+
      "<span class='mv'>"+pct(f.from)+" \\u2192 "+pct(f.to)+"</span> over "+f.minutes.toFixed(1)+" min"+
      (f.zScore?" <span class='mv'>(z="+f.zScore.toFixed(1)+")</span>":"")+"</span>"+
      (f.proof?"<span class='proof'>\\u26d3 "+esc(f.proof)+"</span>":"")+
      "<span class='tm'>"+new Date(f.at).toLocaleTimeString()+"</span></div>";
    }).join(""):"<div class='empty'>No sharp moves flagged yet.</div>";
  }catch(e){ document.getElementById("mode").textContent="dashboard lost contact with watcher: "+e; }
}
refresh(); setInterval(refresh,5000);
</script></body></html>`;

export function startDashboard(port: number, getState: () => DashboardState): void {
  const server = http.createServer((req, res) => {
    if (req.url === "/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getState()));
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
    }
  });
  server.listen(port, () => {
    console.log(`Dashboard: http://localhost:${port}`);
  });
  server.on("error", (err: any) => {
    console.error(`Dashboard failed to start on port ${port}: ${err?.message}`);
  });
}
