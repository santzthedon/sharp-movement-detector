/**
 * Zero-dependency live dashboard. The watcher (live.ts) calls
 * startDashboard() with a state callback; this serves a single
 * self-contained HTML page at / and JSON at /state, which the page polls
 * every 5s. No frameworks, no CDN - everything inline, works offline.
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
  fixtures: DashboardFixture[];
  flags: DashboardFlag[];
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Sharp Movement Detector</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { --bg:#0d1117; --card:#161b22; --border:#30363d; --text:#e6edf3; --dim:#8b949e;
          --p1:#58a6ff; --draw:#8b949e; --p2:#f78166; --flag:#d29922; --good:#3fb950; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; padding:20px; }
  h1 { font-size:18px; margin-bottom:4px; }
  .sub { color:var(--dim); font-size:12px; margin-bottom:20px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(420px,1fr)); gap:14px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:14px; }
  .card h2 { font-size:14px; margin-bottom:8px; }
  .probs { display:flex; gap:14px; font-size:13px; margin-bottom:8px; }
  .p1 { color:var(--p1); } .draw { color:var(--draw); } .p2 { color:var(--p2); }
  svg { width:100%; height:110px; display:block; }
  .flags { margin-top:22px; }
  .flag { border-left:3px solid var(--flag); padding:6px 10px; margin-bottom:8px; background:var(--card);
          border-radius:0 6px 6px 0; font-size:13px; }
  .flag .meta { color:var(--dim); font-size:11px; }
  .flag .proof { color:var(--good); font-size:11px; }
  .empty { color:var(--dim); padding:30px; text-align:center; border:1px dashed var(--border); border-radius:8px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--good);
         margin-right:6px; animation:pulse 2s infinite; }
  @keyframes pulse { 50% { opacity:.3; } }
</style></head><body>
<h1><span class="dot"></span>Sharp Movement Detector</h1>
<div class="sub" id="sub">connecting...</div>
<div class="grid" id="fixtures"></div>
<div class="flags"><h2 style="font-size:14px;margin-bottom:10px">Flagged sharp moves</h2><div id="flags"></div></div>
<script>
const COLORS = { part1:"#58a6ff", draw:"#8b949e", part2:"#f78166" };
function pct(x){ return (x*100).toFixed(1)+"%"; }
function spark(series){
  const all = Object.entries(series).filter(([,pts])=>pts.length>1);
  if(!all.length) return "<div class='empty' style='padding:10px'>waiting for ticks...</div>";
  let t0=Infinity,t1=-Infinity,lo=1,hi=0;
  for(const [,pts] of all){
    t0=Math.min(t0,pts[0][0]); t1=Math.max(t1,pts[pts.length-1][0]);
    for(const p of pts){ lo=Math.min(lo,p[1]); hi=Math.max(hi,p[1]); }
  }
  const pad=Math.max(0.02,(hi-lo)*0.15); lo=Math.max(0,lo-pad); hi=Math.min(1,hi+pad);
  const W=420,H=110,dx=t1-t0||1,dy=hi-lo||1;
  const Y=p=>H-(p-lo)/dy*H;
  let out = "<svg viewBox='0 0 "+W+" "+H+"' preserveAspectRatio='none'>";
  for(const f of [0.25,0.5,0.75]){
    const v=lo+f*dy;
    out += "<line x1='0' y1='"+Y(v).toFixed(1)+"' x2='"+W+"' y2='"+Y(v).toFixed(1)+"' stroke='#21262d'/>"+
           "<text x='4' y='"+(Y(v)-3).toFixed(1)+"' fill='#484f58' font-size='9'>"+(v*100).toFixed(0)+"%</text>";
  }
  for(const [sel,pts] of all){
    const d = pts.map((p,i)=>(i?"L":"M")+((p[0]-t0)/dx*W).toFixed(1)+","+Y(p[1]).toFixed(1)).join("");
    out += "<path d='"+d+"' fill='none' stroke='"+(COLORS[sel]||"#e6edf3")+"' stroke-width='1.6'/>";
  }
  return out+"</svg>";
}
async function refresh(){
  try{
    const s = await (await fetch("/state")).json();
    document.getElementById("sub").textContent =
      s.mode+" | "+s.settings+" | up since "+new Date(s.startedAt).toLocaleTimeString();
    const fx = document.getElementById("fixtures");
    fx.innerHTML = s.fixtures.length ? s.fixtures.map(f =>
      "<div class='card'><h2>"+f.label+"</h2><div class='probs'>"+
      Object.entries(f.latest).map(([sel,p])=>"<span class='"+sel+"'>"+sel+" "+pct(p)+"</span>").join("")+
      "<span style='color:var(--dim);margin-left:auto'>"+f.ticksInWindow+" ticks</span></div>"+
      spark(f.series)+"</div>"
    ).join("") : "<div class='empty'>No fixtures in the watch window - standing by. The watcher attaches automatically before kickoff.</div>";
    const fl = document.getElementById("flags");
    fl.innerHTML = s.flags.length ? s.flags.map(f =>
      "<div class='flag'><b>"+f.fixtureLabel+"</b> &rarr; "+f.selection+" "+
      pct(f.from)+" &rarr; "+pct(f.to)+" over "+f.minutes.toFixed(1)+" min"+
      (f.zScore?" (z="+f.zScore.toFixed(1)+")":"")+
      "<div class='meta'>"+new Date(f.at).toLocaleTimeString()+"</div>"+
      (f.proof?"<div class='proof'>on-chain: "+f.proof+"</div>":"")+"</div>"
    ).join("") : "<div class='empty'>No sharp moves flagged yet.</div>";
  }catch(e){ document.getElementById("sub").textContent = "dashboard lost contact with watcher: "+e; }
}
refresh(); setInterval(refresh, 5000);
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
