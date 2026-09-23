// agent-audit 监控台 v2 — 仿 GlassWire 布局:时间线图为中心 + 按进程拆解 + 告警条 + 明细表
// 用法: node D:\agent-watch\console.mjs  →  http://localhost:8420 (3 秒刷新)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSV = join(HERE, "egress.csv");
const PORT = 8420;

function parseCsv() {
  let text = "";
  try { text = readFileSync(CSV, "utf8"); } catch { return []; }
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const cols = lines[0].split(",");
  return lines.slice(1).map((l) => {
    const cells = [];
    let cur = "", inQ = false;
    for (const ch of l) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { cells.push(cur); cur = ""; continue; }
      cur += ch;
    }
    cells.push(cur);
    const row = {};
    cols.forEach((c, i) => (row[c] = cells[i] ?? ""));
    return row;
  });
}

// ---------------------------------------------------------------------------
// 基线学习(抓「偷偷上传」的核心机制):学习每个进程的日常目的地,
// 之后只对「首次出现的新目标」打标。偷偷上传几乎总是连新地方。
// baseline.json: { proc: { hostOrIp: firstSeenTs } }
import { existsSync, writeFileSync } from "node:fs";
const BASELINE = join(HERE, "baseline.json");
function loadBaseline() {
  try { return JSON.parse(readFileSync(BASELINE, "utf8")); } catch { return {}; }
}
function saveBaseline(b) {
  try { writeFileSync(BASELINE, JSON.stringify(b), "utf8"); } catch { /* 只读盘也不影响展示 */ }
}
function enrichWithBaseline(rows) {
  const b = loadBaseline();
  let dirty = false;
  for (const r of rows) {
    const key = r.host || r.remote; // 有主机名按主机名,否则按 ip:port
    if (!key) continue;
    b[r.proc] = b[r.proc] || {};
    if (b[r.proc][key] === undefined) {
      b[r.proc][key] = r.ts || "";
      dirty = true;
    }
    // 🆕 标记只落在「首见的那一行」(firstSeen === 本行时间),重放时永远保留,
    // 后续同目标的行不再标 —— 修「标记只活 3 秒」的问题
    if (b[r.proc][key] === r.ts && Object.keys(b[r.proc]).length > 3) {
      r.isNew = true;
    }
  }
  if (dirty) saveBaseline(b);
  return rows;
}

// 上传风险目的地(数据搬运的典型形态)与裸 IP 判定
const UPLOAD_RISK = [
  /pastebin\.com|transfer\.sh|0x0\.st|paste\.ee|hastebin|dpaste|ghostbin|termbin/i,
  /webhook|discord\.com\/api|api\.telegram\.org|hooks?\./i,
  /(mega\.nz|mediafire|dropbox|drive\.google|docs\.google|onedrive|4shared|wetransfer|anonfiles|filebin|gofile|catbox|litterbox)/i,
  /(s3[.-].*amazonaws|blob\.core\.windows|storage\.googleapis|oss[.-].*aliyunc|cos[.-].*myqcloud|obs[.-].*myhuaweicloud)/i,
  /webdav|ftp\./i,
];
const isUploadRisk = (host) => !!host && UPLOAD_RISK.some((re) => re.test(host));
const isRawIp = (host, remote) => !host && /^\d+\.\d+\.\d+\.\d+:/.test(remote || "");

// 本机/局域网地址:不是「未知」,是正常的本地通信
const ipOf = (remote) => (remote || "").split(":")[0] || "";
const isLocalIp = (ip) =>
  ip === "127.0.0.1" || ip === "::1" || ip.startsWith("192.168.") ||
  ip.startsWith("10.") || ip.startsWith("172.16.") || ip.startsWith("172.17.") ||
  ip.startsWith("172.18.") || ip.startsWith("172.19.") || ip.startsWith("fe80:");

// 主机名回填:同一 IP 在别处采到了域名 → 之前的裸 IP 记录补上主机名,
// 再用扩展分类器重判(修「连接先到、DNS 后到」造成的未知泛滥)
const EXT_CLASSES = [
  [/tongyi|dashscope|bigmodel|zhipu|z\.ai|qoder|anthropic|openai|minimax|moonshot|xiaomimimo/, "model-api"],
  [/aliyuncs\.com$|myqcloud|huaweicloud|amazonaws/, "cloud"],
  [/sentry|statsig|rum|log\./, "telemetry"],
  [/gvt1|pki\.goog|globalsign|sectigo/, "update"],
  [/alicdn|captcha/, "captcha"],
];
const extClassify = (host) => {
  if (!host) return null;
  for (const [re, cat] of EXT_CLASSES) if (re.test(host)) return cat;
  return null;
};

function classifyRows(rows) {
  // 1) IP → 主机名对照表(任何采到域名的行都能帮之前的裸 IP 行回填)
  const ipToHost = {};
  for (const r of rows) {
    if (r.host) {
      const ip = ipOf(r.remote);
      if (ip && !ipToHost[ip]) ipToHost[ip] = r.host;
    }
  }
  for (const r of rows) {
    if (!r.host) {
      const ip = ipOf(r.remote);
      if (ip && ipToHost[ip]) {
        r.host = ipToHost[ip];
        r.backfilled = true; // 回填的(诚实标注)
      }
    }
    // 2) 本机/局域网:明确标出,不再混进「未知」
    const ip = ipOf(r.remote);
    if (isLocalIp(ip)) {
      r.category = "local";
      if (!r.host) r.host = "本机/局域网";
    }
    // 3) 仍是 unknown 的,用扩展分类器按域名重判
    if (r.category === "unknown") {
      const ext = extClassify(r.host);
      if (ext) r.category = ext;
    }
    if (isUploadRisk(r.host)) r.uploadRisk = true;
    if (isRawIp(r.host, r.remote)) r.rawIp = true;
  }
  return rows;
}

const PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent-audit 监控台</title><style>
:root{color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:#0b0f14;color:#e8ecf3;
  font:14px/1.55 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:22px 20px 60px}
h1{font-size:18px;margin:0 0 2px}h1 .badge{font-size:12px;color:#8a97a8;font-weight:400}
.sub{color:#5d6b7e;font-size:12px;margin-bottom:14px}

/* 告警条(克制的 GlassWire 式:一条横幅,不弹窗) */
.alerts{display:flex;gap:8px;overflow:hidden;margin-bottom:14px;min-height:0}
.alerts:empty{display:none}
.alert-chip{flex:none;background:#fab21918;border:1px solid #fab21955;color:#fab219;
  border-radius:999px;padding:4px 12px;font-size:12px;white-space:nowrap}

/* 时间线主图 */
.card{background:#111721;border:1px solid rgba(255,255,255,.08);border-radius:14px;
  box-shadow:0 1px 2px rgba(0,0,0,.4),0 8px 28px rgba(0,0,0,.3)}
.graph-card{padding:16px 18px 10px;margin-bottom:14px}
.graph-head{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}
.graph-head h2{font-size:13px;margin:0;color:#9aa7b8;font-weight:600}
.graph-head .legend{margin-left:auto;display:flex;gap:14px;font-size:11.5px;color:#8a97a8}
.legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:5px;vertical-align:-1px}
#graph{width:100%;height:130px;display:block}

/* 概览行 */
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:14px}
.k{background:#111721;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px 14px;cursor:pointer}
.k:hover{background:#151d29}
.k.on{outline:2px solid #3b82f6}
.k .n{font-size:23px;font-weight:700;font-variant-numeric:tabular-nums}
.k .l{color:#8a97a8;font-size:11.5px}
.k.hot .n{color:#fab219}
.k .mini{display:flex;gap:3px;margin-top:6px;height:5px}
.k .mini i{flex:1;border-radius:2px;background:rgba(255,255,255,.1)}

/* 表 */
.toolbar{display:flex;gap:8px;margin:0 0 10px;align-items:center;flex-wrap:wrap}
.seg{display:inline-flex;background:#111721;border:1px solid rgba(255,255,255,.08);
  border-radius:10px;padding:3px;gap:2px}
.seg button{border:0;background:none;color:#9aa7b8;font:inherit;font-size:12px;
  padding:5px 11px;border-radius:7px;cursor:pointer}
.seg button.on{background:#1d4ed8;color:#fff;font-weight:600}
.tblwrap{background:#111721;border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:auto;max-height:60vh}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{position:sticky;top:0;background:#151d29;color:#8a97a8;text-align:left;font-size:11px;
  letter-spacing:.4px;padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.1);z-index:2}
td{padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.05)}
tbody tr:hover td{background:rgba(255,255,255,.03)}
.mono{font-family:ui-monospace,Consolas,monospace;color:#9aa7b8}
.dim{color:#5d6b7e}.num{font-variant-numeric:tabular-nums}
.pill{display:inline-flex;gap:5px;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
.pill .dot{width:7px;height:7px;border-radius:2px}
.empty{padding:36px;text-align:center;color:#5d6b7e}
#tick{color:#5d6b7e;font-size:11.5px;margin-left:8px}
</style></head><body><div class="wrap">
<h1>🛡 agent-audit 监控台<span class="badge">· 谁在连哪里</span><span id="tick"></span></h1>
<div class="sub">AI 工具实时出网 · egress.csv · 3 秒刷新 · 点击进程卡片可筛选</div>

<!-- 北极星横幅:页面第一行直接回答「有没有工具偷扫我的项目」 -->
<div id="canaryBanner" style="margin-bottom:14px;border-radius:14px;padding:14px 18px;
  display:flex;align-items:center;gap:12px;font-size:15px;font-weight:600;
  background:#111721;border:1px solid rgba(255,255,255,.1)">
  <span style="font-size:22px" id="canaryIcon">🐦</span>
  <div><div id="canaryText">金丝雀状态加载中…</div>
  <div style="font-size:11.5px;color:#8a97a8;font-weight:400" id="canaryWhen"></div></div>
</div>

<div class="alerts" id="alerts"></div>

<div class="card graph-card">
  <div class="graph-head"><h2>连接时间线(近 60 分钟)</h2>
    <div class="legend">
      <span><i style="background:#3987e5"></i>已知目标</span>
      <span><i style="background:#fab219"></i>未知 [!]</span>
    </div>
  </div>
  <svg id="graph" preserveAspectRatio="none" viewBox="0 0 1200 130"></svg>
</div>

<div class="row" id="kpis"></div>

<div class="toolbar">
  <div class="seg" id="seg">
    <button class="on" data-f="all">全部</button>
    <button data-f="new">🆕 新目标</button>
    <button data-f="upload">🚨 上传风险</button>
    <button data-f="unknown">未知 [!]</button>
    <button data-f="rawip">裸 IP</button>
  </div>
  <input id="q" placeholder="搜进程 / 主机 / IP…" style="flex:1;min-width:180px;background:#111721;
    border:1px solid rgba(255,255,255,.08);border-radius:10px;color:#e8ecf3;font:inherit;
    font-size:13px;padding:8px 12px">
</div>
<div class="tblwrap">
<table><thead><tr><th>时间</th><th>进程</th><th>目标</th><th>主机</th><th>分类</th></tr></thead>
<tbody id="rows"></tbody></table>
<div class="empty" id="empty" hidden>没有匹配的连接</div>
</div>

<!-- 点击行弹出的详情:发生了什么 / 凭什么标 / 怎么排查 -->
<div id="detail" hidden style="margin-top:14px;background:#111721;border:1px solid #3b82f655;
  border-radius:14px;padding:18px 20px"></div>
</div><script>
const CAT_COLOR={"model-api":"#3987e5","telemetry":"#fab219","update":"#199e70",
  "captcha":"#c98500","community":"#9085e9","local":"#5d6b7e","cloud":"#9085e9"};
const CAT_ZH={"model-api":"模型接口","telemetry":"遥测上报","update":"更新/证书",
  "captcha":"验证码","community":"社区","unknown":"未知","local":"本机/局域网","cloud":"云存储"};
const fmtT=t=>{const d=new Date(t);return isNaN(d)?"—":d.toLocaleTimeString("zh-CN",{hour12:false})};
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let curFilter="all", curProc="", curQ="";

async function refresh(){
  try{
    // 单次拉取:连接行与 DNS 行同源(修「每 3 秒双倍请求 + 死变量」)
    const all=await (await fetch("/api/egress")).json();
    const rows=all.filter(x=>x.remote&&x.remote!=="DNS");
    const dns=all.filter(x=>x.remote==="DNS").length;
    const known=rows.filter(x=>x.category!=="unknown");
    const unknown=rows.filter(x=>x.category==="unknown");
    const news=rows.filter(x=>x.isNew);
    const uploads=rows.filter(x=>x.uploadRisk);
    const rawIps=rows.filter(x=>x.rawIp);

    /* 告警条:新目标 > 上传风险 > 未知,最多 4 条 */
    const alerts=[
      ...news.slice(-2).map(x=>["🆕 新目标",esc(x.proc)+" → "+esc(x.host||x.remote),"#3987e5"]),
      ...uploads.slice(-1).map(x=>["🚨 上传风险",esc(x.proc)+" → "+esc(x.host),"#ec835a"]),
      ...unknown.filter(x=>!x.isNew).slice(-1).map(x=>["[!] 未知",esc(x.proc)+" → "+esc(x.host||x.remote),"#fab219"]),
    ];
    document.getElementById("alerts").innerHTML=alerts.slice(0,4)
      .map(([tag,txt,c])=>'<span class="alert-chip" style="background:'+c+'18;border-color:'+c+'55;color:'+c+'">'+tag+' · '+txt+"</span>").join("");

    /* 时间线:60 个 1 分钟桶,堆叠 known/unknown/dns? dns是行数(采样)不进桶 */
    const buckets=new Array(60).fill(0).map(()=>({k:0,u:0}));
    const now=Date.now();
    for(const x of rows){
      const d=new Date(x.ts); if(isNaN(d)) continue;
      const b=Math.floor((now-d.getTime())/60000);
      if(b>=0&&b<60){buckets[59-b][x.category==="unknown"?"u":"k"]++;}
    }
    const max=Math.max(1,...buckets.map(b=>b.k+b.u));
    const W=1200,H=130,bw=W/60;
    let svg='';
    buckets.forEach((b,i)=>{
      const x=i*bw,hk=b.k/max*(H-18),hu=b.u/max*(H-18);
      if(b.k)svg+='<rect x="'+(x+1)+'" y="'+(H-18-hk)+'" width="'+(bw-2)+'" height="'+hk+'" rx="2" fill="#3987e5" opacity=".9"><title>'+fmtMin(i)+':'+b.k+' 已知</title></rect>';
      if(b.u)svg+='<rect x="'+(x+1)+'" y="'+(H-18-hk-hu)+'" width="'+(bw-2)+'" height="'+hu+'" rx="2" fill="#fab219"><title>'+fmtMin(i)+':'+b.u+' 未知</title></rect>';
    });
    svg+='<line x1="0" y1="'+(H-17)+'" x2="'+W+'" y2="'+(H-17)+'" stroke="rgba(255,255,255,.15)"/>';
    [0,15,30,45].forEach(m=>{const i=59-m;svg+='<text x="'+(i*bw)+'" y="'+(H-4)+'" fill="#5d6b7e" font-size="10">-'+m+'m</text>';});
    document.getElementById("graph").innerHTML=svg;

    /* 进程卡片(点击筛选) */
    const byProc={};
    rows.forEach(x=>{(byProc[x.proc]=byProc[x.proc]||{n:0,u:0,last:0});
      byProc[x.proc].n++;if(x.category==="unknown")byProc[x.proc].u++;
      const t=new Date(x.ts).getTime();if(t>byProc[x.proc].last)byProc[x.proc].last=t;});
    const procs=Object.entries(byProc).sort((a,b)=>b[1].n-a[1].n).slice(0,7);
    const allHot=unknown.length>0;
    document.getElementById("kpis").innerHTML=
      '<div class="k'+(allHot?' hot':'')+'" data-p=""><div class="n">'+unknown.length+'</div><div class="l">未知目标 [!]</div></div>'+
      procs.map(([p,v])=>'<div class="k'+(v.u?' hot':'')+(curProc===p?' on':'')+'" data-p="'+esc(p)+'">'+
        '<div class="n">'+v.n+'</div><div class="l">'+p+(v.u?' · 未知 '+v.u:'')+'</div>'+
        '<div class="mini">'+Array.from({length:8},(_,i)=>{
          const cut=now-((8-i)*3600000);const c=rows.filter(x=>x.proc===p&&new Date(x.ts).getTime()>=cut).length;
          return '<i style="background:'+(c?(v.u?'#fab219':'#3987e5'):'rgba(255,255,255,.1)')+'"></i>';}).join('')+
        '</div></div>').join('');
    document.querySelectorAll(".k").forEach(k=>k.onclick=()=>{
      curProc=curProc===k.dataset.p?"":k.dataset.p;render(rows);});

    /* 表 */
    window.__rows=rows;render(rows);
    document.getElementById("tick").textContent="· 更新于 "+new Date().toLocaleTimeString("zh-CN",{hour12:false});
  }catch(e){document.getElementById("tick").textContent="· 刷新失败 "+e.message;}
}
function fmtMin(i){const d=new Date(Date.now()-(59-i)*60000);return d.toLocaleTimeString("zh-CN",{hour12:false}).slice(0,5);}
function render(rows){
  const list=rows.filter(x=>{
    if(curFilter==="new"&&!x.isNew)return false;
    if(curFilter==="upload"&&!x.uploadRisk)return false;
    if(curFilter==="rawip"&&!x.rawIp)return false;
    if(curFilter==="unknown"&&x.category!=="unknown")return false;
    if(curFilter==="known"&&x.category==="unknown")return false;
    if(curProc&&x.proc!==curProc)return false;
    if(curQ&&!(x.proc+" "+x.host+" "+x.remote).toLowerCase().includes(curQ))return false;
    return true;});
  document.getElementById("empty").hidden=list.length>0;
  const shown=list.slice(-300).reverse();
  window.__shown=shown;
  document.getElementById("rows").innerHTML=shown.map((x,i)=>{
    const c=CAT_COLOR[x.category]||"#898781",unk=x.category==="unknown";
    const badges=(x.isNew?'<span class="pill" style="background:#3987e522;color:#3987e5">🆕 新</span>':"")+
      (x.uploadRisk?'<span class="pill" style="background:#ec835a22;color:#ec835a">🚨 上传风险</span>':"")+
      (x.rawIp?'<span class="pill" style="background:#89878122;color:#898781">裸IP</span>':"");
    return '<tr data-i="'+i+'" style="cursor:pointer"><td class="dim num">'+fmtT(x.ts)+'</td><td class="mono">'+esc(x.proc)+
      '<span class="dim">('+esc(x.pid)+')</span></td><td class="mono">'+esc(x.remote)+'</td><td>'+
      (x.host?esc(x.host):'<span class="dim">—</span>')+'</td><td><span class="pill" style="background:'+c+'22;color:'+c+
      '"><span class="dot" style="background:'+c+'"></span>'+(unk?"[!] 未知":(CAT_ZH[x.category]||x.category))+'</span> '+badges+'</td></tr>';
  }).join("");
  document.querySelectorAll(".k").forEach(k=>k.classList.toggle("on",k.dataset.p===curProc));
}
document.getElementById("seg").addEventListener("click",e=>{
  const b=e.target.closest("button");if(!b)return;
  document.querySelectorAll("#seg button").forEach(x=>x.classList.toggle("on",x===b));
  curFilter=b.dataset.f;if(window.__rows)render(window.__rows);});
document.getElementById("q").addEventListener("input",e=>{
  curQ=e.target.value.trim().toLowerCase();if(window.__rows)render(window.__rows);});
refresh();setInterval(refresh,3000);

/* ---------- 金丝雀横幅(北极星答案,每 30 秒刷新) ---------- */
async function refreshCanary(){
  try{
    const c=await (await fetch("/api/canary")).json();
    const b=document.getElementById("canaryBanner");
    const icon=document.getElementById("canaryIcon");
    const text=document.getElementById("canaryText");
    const when=document.getElementById("canaryWhen");
    if(c.status==="CLEAN"){
      b.style.background="#0f2318";b.style.borderColor="#199e7055";
      icon.textContent="✅";text.textContent="没有工具偷扫你的项目";
      text.style.color="#5ad19a";
      when.textContent="金丝雀检查通过(含检测器自检)"+(c.when?" · "+c.when:"");
    }else if(c.status==="DIRTY"){
      b.style.background="#2a1215";b.style.borderColor="#d03b3b55";
      icon.textContent="🚨";text.textContent="发现工具扫过你的假项目!";
      text.style.color="#ff8f8f";
      when.textContent=(c.when?"· "+c.when+" · ":"")+(c.headline||"详情见 canary-result.txt");
    }else if(c.status==="SELFTEST_FAILED"){
      b.style.background="#2a1215";b.style.borderColor="#d03b3b55";
      icon.textContent="⛔";text.textContent="检测器自检失败,「干净」结论不可信";
      text.style.color="#ff8f8f";when.textContent="排查 canary-check.mjs 后重试";
    }else{
      icon.textContent="⏳";text.textContent="金丝雀尚未出结果";
      when.textContent="等监控循环跑完第一轮,或双击 检查金丝雀.cmd 立即检查";
    }
  }catch(e){document.getElementById("canaryText").textContent="金丝雀状态获取失败: "+e.message;}
}
refreshCanary();setInterval(refreshCanary,30000);

/* ---------- 行详情:发生了什么 / 凭什么标 / 怎么排查 ---------- */
const WHY = {
  uploadRisk: "该连接的目标域名命中「数据搬运目的地」特征(粘贴站/网盘/对象存储/webhook)。" +
    "正常编程通常不需要连这些地方,但偷传数据时特别常用 —— 所以这是**值得怀疑的目的地**,不是定罪。",
  isNew: "该进程第一次连接这个目标(基线账本里没有记录)。工具正常工作总去老地方;" +
    "**偷偷上传必然连新地方** —— 新目标 + 反复出现 = 高嫌疑,单次出现可能只是版本更新。",
  rawIp: "这条连接直接用 IP、没有域名(没走 DNS)。正常服务几乎都有域名;" +
    "裸 IP 直连是规避域名审计的常见手法,值得查一下这个 IP 是谁的。",
  backfilled: "这条记录抓到时还没采样到域名,系统事后根据同 IP 的后续记录补上的主机名。",
};
function showDetail(x){
  const el=document.getElementById("detail");
  el.hidden=false;
  const badges=[["uploadRisk","🚨 上传风险"],["isNew","🆕 新目标"],["rawIp","裸 IP"],["backfilled","↩ 域名回填"]]
    .filter(([k])=>x[k]);
  const cat=CAT_ZH[x.category]||x.category;
  const steps=[];
  if(x.uploadRisk||x.isNew||x.rawIp){
    steps.push("<b>① 看重复</b> —— 搜索框输入 <code>"+esc(x.host||ipOf(x.remote))+"</code>:偶尔一次(可能是更新/新功能)还是持续出现?持续且你没用它时也在传 = 悬疑升高");
    steps.push("<b>② 对时间</b> —— "+fmtT(x.ts)+" 前后你在用 "+esc(x.proc)+" 干什么?没在用却外传 = 悬疑升高");
    steps.push("<b>③ 金丝雀实锤</b> —— 在一次性仓库埋唯一标记串,看标记是否出现在该工具的云端/索引/流量里。这一步能<b>证明传的是不是你的代码</b>(README 非目标一节有完整方法)");
    steps.push("<b>④ 阻断验证</b> —— Windows 防火墙出站规则禁止 "+esc(x.proc)+".exe 联网,看工具报什么错:报错点就是它对这个通道的依赖点");
  }else{
    steps.push("此连接无嫌疑标记("+esc(cat)+")。若想复核:搜索该主机名看历史规律,或保持基线观察后续变化。");
  }
  el.innerHTML=
    '<div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">'+
    '<b style="font-size:15px">'+esc(x.proc)+' → '+esc(x.host||x.remote)+'</b>'+
    badges.map(([k,t])=>'<span class="pill" style="background:#3b82f622;color:#7aa7f7">'+t+'</span>').join("")+
    '<span class="pill" style="background:'+(CAT_COLOR[x.category]||"#898781")+'22;color:'+(CAT_COLOR[x.category]||"#898781")+'">'+esc(cat)+'</span>'+
    '<button id="detailClose" style="margin-left:auto;background:none;border:1px solid rgba(255,255,255,.15);color:#9aa7b8;border-radius:8px;padding:4px 10px;cursor:pointer">收起 ✕</button></div>'+
    '<div style="font-size:12.5px;color:#9aa7b8;margin-bottom:10px">'+
    '<b>发生了什么:</b>'+esc(x.proc)+'(PID '+esc(x.pid)+')于 '+fmtT(x.ts)+' 与 '+esc(x.host||"未知主机")+'('+esc(x.remote)+')建立了连接。'+
    '<b style="color:#5d6b7e">线上是 TLS 加密的,本工具看不到传输内容 —— 只知道「连了谁」。</b></div>'+
    (badges.length?'<div style="font-size:12.5px;color:#9aa7b8;margin-bottom:10px"><b>凭什么标记:</b><br>'+
      badges.map(([k,t])=>'· <b>'+t+'</b>:'+(WHY[k]||"")).join("<br>")+'</div>':"")+
    '<div style="font-size:12.5px;color:#c3d2e8;background:#0d1420;border-radius:10px;padding:12px 14px">'+
    '<b>怎么排查:</b><br>'+steps.join("<br><br>")+'</div>';
  const btn=el.querySelector("#detailClose");
  if(btn) btn.onclick=()=>{el.hidden=true;};
}
document.getElementById("rows").addEventListener("click",e=>{
  const tr=e.target.closest("tr");if(!tr||tr.dataset.i===undefined)return;
  const shown=window.__shown||[];
  const x=shown[+tr.dataset.i];
  if(x)showDetail(x);
});
function ipOf(r){return (r||"").split(":")[0]||""}
</script></body></html>`;

createServer((req, res) => {
  if (req.url === "/api/egress") {
    const rows = classifyRows(enrichWithBaseline(parseCsv().filter((x) => x.remote && x.remote !== "DNS")));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store" });
    res.end(JSON.stringify(rows));
    return;
  }
  // 金丝雀状态:读 canary-result.txt 的 RESULT 行 + 时间行,给页面北极星横幅
  if (req.url === "/api/canary") {
    let status = "UNKNOWN", when = "", headline = "";
    try {
      const txt = readFileSync(join(HERE, "canary-result.txt"), "utf8");
      const m = txt.match(/RESULT:(CLEAN|DIRTY|SELFTEST_FAILED)/);
      status = m ? m[1] : "PENDING";
      when = (txt.match(/金丝雀检查 · ([^\n]+)/) || [])[1] || "";
      headline = (txt.match(/结论:[^\n]+/) || [])[0] || "";
    } catch { status = "PENDING"; }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store" });
    res.end(JSON.stringify({ status, when, headline }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGE);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`agent-audit console v3 → http://localhost:${PORT}`);
});
