/**
 * Builds the static replay explorer into docs/ (served by GitHub Pages).
 *
 * Reads every cached fixture (odds + result from .cache/, populated by
 * `npm run backtest`), runs the tuned detector over each, grades every
 * flag exactly like the backtest (hit + CLV, split by regime), and writes:
 *
 *   docs/data.json   compact per-fixture series + flags + grades
 *   docs/index.html  self-contained explorer UI (no frameworks, no CDN)
 *
 * Run: npm run export:site   (then commit docs/ - GitHub Pages serves it)
 */
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();
import { detectSharpMoves } from "./detector";
import { OddsPoint } from "./types";

const MARKET_RE = new RegExp(process.env.ODDS_MARKET_REGEX || "^1X2_PARTICIPANT_RESULT$", "i");
const WINDOW_MINUTES = Number(process.env.WINDOW_MINUTES || 15);
const FLOOR = Number(process.env.PROBABILITY_THRESHOLD || 0.02);
const Z_SCORE = Number(process.env.Z_SCORE || 3);
const CLV_HORIZON_MINUTES = Number(process.env.CLV_HORIZON_MINUTES || 30);

/** [seconds, prob‰] pairs keep data.json small (~15 bytes/point). */
type PackedSeries = [number, number][];

function pack(pts: OddsPoint[], maxPoints: number): PackedSeries {
  const step = Math.max(1, Math.floor(pts.length / maxPoints));
  const out: PackedSeries = [];
  for (let i = 0; i < pts.length; i += step) {
    out.push([Math.round(pts[i].timestamp / 1000), Math.round((1000 / pts[i].decimalOdds))]);
  }
  if (pts.length) {
    const last = pts[pts.length - 1];
    out.push([Math.round(last.timestamp / 1000), Math.round(1000 / last.decimalOdds)]);
  }
  return out;
}

function main() {
  const fixtures: any[] = [];
  let totals = { pre: 0, preHit: 0, preClv: [] as number[], play: 0, playHit: 0 };

  for (const file of fs.readdirSync(".cache")) {
    const m = file.match(/^odds-(\d+)-h\d+\.json$/);
    if (!m) continue;
    const fixtureId = m[1];
    const resultFile = path.join(".cache", `result-${fixtureId}.json`);
    if (!fs.existsSync(resultFile)) continue;
    const result = JSON.parse(fs.readFileSync(resultFile, "utf-8"));
    const points: OddsPoint[] = JSON.parse(
      fs.readFileSync(path.join(".cache", file), "utf-8")
    ).filter((p: OddsPoint) => MARKET_RE.test(p.market));
    points.sort((a, b) => a.timestamp - b.timestamp);
    if (points.length === 0) continue;

    const bySel = new Map<string, OddsPoint[]>();
    for (const p of points) {
      if (!bySel.has(p.selection)) bySel.set(p.selection, []);
      bySel.get(p.selection)!.push(p);
    }
    const kickoff = points.find((p) => p.inRunning)?.timestamp;

    const flags = detectSharpMoves(points, {
      windowMs: WINDOW_MINUTES * 60_000,
      probabilityThreshold: FLOOR,
      zScore: Z_SCORE,
    }).filter((f) => f.probabilityDelta > 0);

    const gradedFlags = flags.map((f) => {
      const series = bySel.get(f.selection) ?? [];
      let ref: number | undefined;
      if (!f.inRunning) {
        const closing = series.filter((p) => !p.inRunning).pop();
        ref = closing ? 1 / closing.decimalOdds : undefined;
      } else {
        const horizon = f.windowEnd + CLV_HORIZON_MINUTES * 60_000;
        const at = series.find((p) => p.timestamp >= horizon) ?? series[series.length - 1];
        ref = at && at.timestamp > f.windowEnd ? 1 / at.decimalOdds : undefined;
      }
      const hit = f.selection === result.winningSelection;
      const clv = ref != null ? ref - f.peakProbability : undefined;
      if (f.inRunning) {
        totals.play++;
        if (hit) totals.playHit++;
      } else {
        totals.pre++;
        if (hit) totals.preHit++;
        if (clv != null) totals.preClv.push(clv);
      }
      return {
        sel: f.selection,
        t: Math.round(f.windowEnd / 1000),
        from: Math.round(f.startingProbability * 1000),
        to: Math.round(f.peakProbability * 1000),
        mins: Math.round((f.windowEnd - f.windowStart) / 6000) / 10,
        z: f.zScore ? Math.round(f.zScore * 10) / 10 : null,
        play: f.inRunning,
        hit,
        clv: clv != null ? Math.round(clv * 1000) : null,
      };
    });

    fixtures.push({
      id: fixtureId,
      label: result.label ?? fixtureId,
      winner: result.winningSelection,
      source: result.source,
      kickoff: kickoff ? Math.round(kickoff / 1000) : null,
      start: Math.round(points[0].timestamp / 1000),
      series: Object.fromEntries([...bySel.entries()].map(([sel, pts]) => [sel, pack(pts, 250)])),
      flags: gradedFlags,
    });
  }

  fixtures.sort((a, b) => a.start - b.start);
  const meanClv = totals.preClv.length
    ? totals.preClv.reduce((a, b) => a + b, 0) / totals.preClv.length
    : 0;
  const site = {
    generated: Date.now(),
    settings: `window ${WINDOW_MINUTES}min, floor ${FLOOR * 100}pp, z=${Z_SCORE}`,
    summary: {
      fixtures: fixtures.length,
      pre: totals.pre,
      preHitPct: totals.pre ? Math.round((totals.preHit / totals.pre) * 1000) / 10 : 0,
      preClvPp: Math.round(meanClv * 10000) / 100,
      play: totals.play,
      playHitPct: totals.play ? Math.round((totals.playHit / totals.play) * 1000) / 10 : 0,
    },
    fixtures,
  };

  fs.mkdirSync("docs", { recursive: true });
  fs.writeFileSync(path.join("docs", "data.json"), JSON.stringify(site));
  fs.writeFileSync(path.join("docs", "index.html"), PAGE);
  const kb = Math.round(fs.statSync(path.join("docs", "data.json")).size / 1024);
  console.log(`docs/ built: ${fixtures.length} fixtures, data.json ${kb} KB`);
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Sharp Movement Detector - World Cup 2026 Replay</title>
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
    --chip-bg:#f3f0ea; --grid:#eee9e1; --axis:#b3a996; --kickoff:#c9c1b2;
    --font-ui:'Instrument Sans',system-ui,sans-serif;
    --font-mono:'IBM Plex Mono',ui-monospace,Menlo,monospace;
  }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:13.5px/1.55 var(--font-ui); }
  .mono { font-family:var(--font-mono); }
  header { background:var(--card); border-bottom:1px solid var(--border); }
  .hwrap { max-width:1180px; margin:0 auto; padding:16px 28px; display:flex; align-items:center; gap:16px; }
  h1 { font-size:19px; font-weight:700; }
  .hsub { color:var(--dim); font-size:13px; }
  .hchip { margin-left:auto; font-family:var(--font-mono); font-size:12px; color:var(--dim);
           background:var(--chip-bg); border:1px solid var(--border); border-radius:6px; padding:5px 10px; white-space:nowrap; }
  .wrap { max-width:1180px; margin:0 auto; padding:0 28px 40px; }
  .explain { margin-top:20px; background:var(--flag-tint); border:1px solid var(--flag-border); border-radius:10px;
             padding:14px 18px; display:flex; gap:14px; align-items:baseline; color:#5c5346; }
  .explain .badge { font-family:var(--font-mono); font-size:11px; font-weight:600; letter-spacing:.04em;
                    color:var(--flag-text); white-space:nowrap; }
  .stats { display:grid; grid-template-columns:repeat(5,1fr); gap:12px; margin:16px 0; }
  .stat { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:12px 16px; }
  .stat .l { font-size:11.5px; color:var(--dim); }
  .stat b { display:block; font-family:var(--font-mono); font-size:22px; font-weight:600; margin-top:2px; }
  .stat.good b { color:var(--good); }
  .main { display:grid; grid-template-columns:300px 1fr; gap:16px; align-items:start; }
  .listcard { background:var(--card); border:1px solid var(--border); border-radius:10px; overflow:hidden;
              position:sticky; top:16px; max-height:calc(100vh - 32px); display:flex; flex-direction:column; }
  .listhead { font-size:12px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--dim);
              padding:12px 16px; border-bottom:1px solid var(--border); }
  .list { overflow-y:auto; }
  .mrow { padding:10px 16px; border-bottom:1px solid var(--hairline); cursor:pointer; border-left:3px solid transparent; }
  .mrow:hover { background:#faf6ef; }
  .mrow.sel { background:#fdf9f2; border-left-color:var(--p2); }
  .mrow.sel .t { font-weight:700; }
  .mrow .t { display:flex; align-items:center; gap:8px; }
  .mrow .t span:first-child { flex:1; }
  .mrow .d { font-family:var(--font-mono); font-size:11px; color:var(--faint); margin-top:1px; }
  .chip { font-family:var(--font-mono); font-size:11px; font-weight:600; padding:3px 9px; border-radius:6px; white-space:nowrap; }
  .chip.hit { color:var(--good); background:var(--good-bg); }
  .chip.miss { color:var(--bad); background:var(--bad-bg); }
  .chip.reg { color:var(--dim); background:var(--chip-bg); }
  .chip.fc { color:var(--flag-text); background:var(--flag-bg); padding:2px 8px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:18px; }
  .ctitle { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; margin-bottom:10px; }
  .ctitle b { font-size:17px; font-weight:700; }
  .won { font-size:12.5px; font-weight:600; color:var(--good); }
  .cmeta { margin-left:auto; font-family:var(--font-mono); font-size:12px; color:var(--faint); }
  svg { width:100%; height:260px; display:block; }
  .legend { font-size:11.5px; color:var(--dim); margin-top:8px; display:flex; gap:16px; flex-wrap:wrap; }
  .flags { display:flex; flex-direction:column; gap:10px; margin-top:16px; }
  .frow { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:11px 16px;
          display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .frow .mv { font-family:var(--font-mono); }
  .frow .clv { margin-left:auto; font-family:var(--font-mono); font-weight:600; }
  .frow .clv.up { color:var(--good); } .frow .clv.dn { color:var(--bad); }
  .frow .tm { font-family:var(--font-mono); font-size:11px; color:var(--faint); }
  .empty { border:1px dashed var(--border); border-radius:10px; padding:22px; text-align:center; color:var(--dim); background:none; }
  .seclabel { font-size:12px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--dim); margin:18px 0 0; }
  .foot { color:var(--dim); font-size:12px; margin-top:26px; line-height:1.7; }
  .foot a { color:var(--p2); }
  .foot .mono { font-size:11px; }
  @media (max-width:900px){ .main { grid-template-columns:1fr; } .listcard { position:static; max-height:300px; } .stats { grid-template-columns:repeat(2,1fr); } }
</style></head><body>
<header><div class="hwrap">
  <div><h1>Sharp Movement Detector</h1>
  <div class="hsub">World Cup 2026 replay explorer &mdash; every flagged sharp move, graded after the fact</div></div>
  <div class="hchip" id="settings"></div>
</div></header>
<div class="wrap">
  <div class="explain"><span class="badge">WHAT IS THIS?</span>
    <span>When a lot of informed money bets one way, the odds move <b>fast</b>. This tool watched every
    World Cup 2026 match, flagged those fast moves as they happened, and then checked: did the market
    keep agreeing with them? Browse any match below &mdash; amber dots are flagged moves.</span></div>
  <div class="stats" id="stats"></div>
  <div class="main">
    <div class="listcard">
      <div class="listhead" id="listhead">Matches</div>
      <div class="list" id="list"></div>
    </div>
    <div>
      <div class="card">
        <div class="ctitle" id="head"></div>
        <div id="chart"></div>
        <div class="legend" id="legend"></div>
      </div>
      <div class="seclabel">Flags in this match</div>
      <div class="flags" id="flags"></div>
    </div>
  </div>
  <div class="foot">Detector: <span class="mono" id="settings2"></span> &middot; pre-match flags graded vs the closing line,
  in-play vs the price 30min later &middot; <a href="https://github.com/santzthedon/sharp-movement-detector">github.com/santzthedon/sharp-movement-detector</a><br>
  The live agent (auto-discovery, on-chain proofs, live dashboard) runs locally with <span class="mono">npm run live</span> &mdash;
  this page replays its detector over the full cached tournament.</div>
</div>
<script>
const COLORS={part1:"#4a6da7",draw:"#9a9287",part2:"#b25a41"};
let DATA=null, idx=0;
const pctm=x=>(x/10).toFixed(1)+"%";
function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;"); }
function teams(f){
  const parts=f.label.split(/ vs? /i);
  return { part1:parts[0]||"part1", part2:parts[1]||"part2", draw:"Draw" };
}
function chart(f){
  const sels=Object.entries(f.series).filter(([,s])=>s.length>1);
  if(!sels.length) return "<div class='empty'>no series</div>";
  let t0=Infinity,t1=-Infinity,lo=1000,hi=0;
  for(const [,s] of sels){ t0=Math.min(t0,s[0][0]); t1=Math.max(t1,s[s.length-1][0]);
    for(const p of s){ lo=Math.min(lo,p[1]); hi=Math.max(hi,p[1]); } }
  const pad=Math.max(20,(hi-lo)*0.12); lo=Math.max(0,lo-pad); hi=Math.min(1000,hi+pad);
  const W=1040,H=260,dx=t1-t0||1,dy=hi-lo||1;
  const X=t=>(t-t0)/dx*W, Y=p=>H-(p-lo)/dy*H;
  let out="<svg viewBox='0 0 "+W+" "+H+"' preserveAspectRatio='none'>";
  for(const fr of [0.25,0.5,0.75]){ const v=lo+fr*dy;
    out+="<line x1='0' y1='"+Y(v).toFixed(1)+"' x2='"+W+"' y2='"+Y(v).toFixed(1)+"' stroke='#eee9e1'/>"+
         "<text x='4' y='"+(Y(v)-4).toFixed(1)+"' fill='#b3a996' font-size='11' font-family='IBM Plex Mono,monospace'>"+(v/10).toFixed(0)+"%</text>"; }
  if(f.kickoff) out+="<line x1='"+X(f.kickoff).toFixed(1)+"' y1='0' x2='"+X(f.kickoff).toFixed(1)+"' y2='"+H+"' stroke='#c9c1b2' stroke-dasharray='4 4'/>";
  for(const [sel,s] of sels){
    const d=s.map((p,i)=>(i?"L":"M")+X(p[0]).toFixed(1)+","+Y(p[1]).toFixed(1)).join("");
    out+="<path d='"+d+"' fill='none' stroke='"+(COLORS[sel]||"#1f1b16")+"' stroke-width='1.8'/>";
  }
  for(const fl of f.flags){
    out+="<circle cx='"+X(fl.t).toFixed(1)+"' cy='"+Y(fl.to).toFixed(1)+"' r='9' fill='#c58a2a' opacity='0.18'/>"+
         "<circle cx='"+X(fl.t).toFixed(1)+"' cy='"+Y(fl.to).toFixed(1)+"' r='4.5' fill='#c58a2a' stroke='#ffffff' stroke-width='1.5'/>";
  }
  return out+"</svg>";
}
function render(){
  const f=DATA.fixtures[idx], T=teams(f);
  document.querySelectorAll(".mrow").forEach((el,i)=>el.classList.toggle("sel",i===idx));
  const selEl=document.querySelectorAll(".mrow")[idx];
  if(selEl) selEl.scrollIntoView({block:"nearest"});
  const won=f.winner==="draw"?"&#10003; Draw":"&#10003; "+esc(T[f.winner]||f.winner)+" won";
  document.getElementById("head").innerHTML=
    "<b>"+esc(f.label)+"</b><span class='won'>"+won+"</span>"+
    "<span class='cmeta'>"+new Date(f.start*1000).toUTCString().slice(5,16)+" &middot; "+
    f.flags.length+" flag"+(f.flags.length===1?"":"s")+" &middot; result "+f.source+"</span>";
  document.getElementById("chart").innerHTML=chart(f);
  document.getElementById("legend").innerHTML=
    "<span style='color:#4a6da7'>&#9632; "+esc(T.part1)+"</span>"+
    "<span style='color:#9a9287'>&#9632; Draw</span>"+
    "<span style='color:#b25a41'>&#9632; "+esc(T.part2)+"</span>"+
    "<span style='color:#c58a2a'>&#9679; flagged move</span>"+
    "<span style='color:#a39a8c'>&#9482; kickoff</span>";
  document.getElementById("flags").innerHTML=f.flags.length?f.flags.map(fl=>
    "<div class='frow'><span class='chip "+(fl.hit?"hit'>HIT":"miss'>MISS")+"</span>"+
    "<span class='chip reg'>"+(fl.play?"in-play":"pre-match")+"</span>"+
    "<span><b>"+esc(T[fl.sel]||fl.sel)+"</b> moved <span class='mv'>"+pctm(fl.from)+" &rarr; "+pctm(fl.to)+"</span> in "+fl.mins+" min"+
    (fl.z?" <span class='mv'>(z="+fl.z.toFixed(1)+")</span>":"")+"</span>"+
    (fl.clv!=null?"<span class='clv "+(fl.clv>=0?"up":"dn")+"'>"+(fl.clv>=0?"+":"")+(fl.clv/10).toFixed(1)+"pp CLV</span>":"<span class='clv'></span>")+
    "<span class='tm'>"+new Date(fl.t*1000).toUTCString().slice(17,25)+" UTC</span></div>"
  ).join(""):"<div class='empty'>No sharp moves flagged in this match &mdash; most matches are quiet. That selectivity is the point.</div>";
}
async function boot(){
  DATA=await (await fetch("data.json")).json();
  const s=DATA.summary;
  document.getElementById("settings").textContent=DATA.settings;
  document.getElementById("settings2").textContent=DATA.settings;
  document.getElementById("stats").innerHTML=
    "<div class='stat'><span class='l'>fixtures analyzed</span><b>"+s.fixtures+"</b></div>"+
    "<div class='stat'><span class='l'>pre-match flags</span><b>"+s.pre+"</b></div>"+
    "<div class='stat good'><span class='l'>pre-match hit rate</span><b>"+s.preHitPct.toFixed(1)+"%</b></div>"+
    "<div class='stat good'><span class='l'>pre-match mean CLV</span><b>"+(s.preClvPp>=0?"+":"")+s.preClvPp.toFixed(2)+"pp</b></div>"+
    "<div class='stat'><span class='l'>in-play flags</span><b>"+s.play+"</b></div>";
  document.getElementById("listhead").textContent="Matches \\u00b7 "+DATA.fixtures.length;
  document.getElementById("list").innerHTML=DATA.fixtures.map((f,i)=>
    "<div class='mrow' data-i='"+i+"'><div class='t'><span>"+esc(f.label)+"</span>"+
    (f.flags.length?"<span class='chip fc'>"+f.flags.length+"</span>":"")+"</div>"+
    "<div class='d'>"+new Date(f.start*1000).toISOString().slice(0,10)+"</div></div>").join("");
  document.getElementById("list").onclick=e=>{
    const row=e.target.closest(".mrow"); if(row){ idx=Number(row.dataset.i); render(); }
  };
  document.addEventListener("keydown",e=>{
    if(e.key==="ArrowLeft"){ idx=(idx+DATA.fixtures.length-1)%DATA.fixtures.length; render(); }
    if(e.key==="ArrowRight"){ idx=(idx+1)%DATA.fixtures.length; render(); }
  });
  idx=DATA.fixtures.reduce((b,f,i)=>f.flags.length>DATA.fixtures[b].flags.length?i:b,0);
  render();
}
boot();
</script></body></html>`;

main();
