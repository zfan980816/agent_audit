// 金丝雀检查:各 AI 工具是否偷偷扫了本机项目?
// 原理:假项目 D:\Projects\demo-inventory-sync 带唯一标记 ZCANARY-****,
// 用户从不在任何工具里打开它 —— 标记出现在任何工具的数据目录 = 偷偷扫盘实锤。
// 用法: node D:\agent-watch\canary-check.mjs   (退出码 0=干净, 1=发现)
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MARKER = "ZCANARY-7F3A9C21-D4E8";
const CANARY_DIR = "D:\\Projects\\demo-inventory-sync";

// 待检查的工具数据目录(只读扫描,找标记字节串)。
// 审计修正(2026-09-22):① Qoder 的真实活跃数据根是 D:\app\qoder-cn
// (~/.qoder-cn 已于 08-13 停更,只扫旧根 = 恒假阴性);② Cursor 还有
// CLI 转录目录 ~/.cursor;③ NTFS 大小写不敏感,ZCode app-a/app-b 同目录
// 去重;④ 上限 256MB(实测 ordos 仓 zap 87.7MB,原 80MB 会静默跳过证据文件)。
const STORES = [
  ["Qoder(活跃根)", "D:\\app\\qoder-cn"],
  ["Qoder(旧根)", join(homedir(), ".qoder-cn")],
  ["ZCode(cli)", join(homedir(), ".zcode")],
  ["ZCode(app)", join(homedir(), "AppData", "Roaming", "ZCode")],
  ["Trae", join(homedir(), "AppData", "Roaming", "Trae CN")],
  ["Trae(cli)", join(homedir(), ".trae-cn")],
  ["Kimi-Code", join(homedir(), ".kimi-code")],
  ["Codex", join(homedir(), ".codex")],
  ["Gemini", join(homedir(), ".gemini")],
  ["Cursor(桌面版)", join(homedir(), "AppData", "Roaming", "Cursor")],
  ["Cursor(CLI)", join(homedir(), ".cursor")],
];

// 二进制安全搜索:文本和二进制(zap/ldb/sqlite)都按字节匹配
function scanFile(path, found) {
  try {
    const buf = readFileSync(path);
    const s = buf.toString("latin1");
    let idx = s.indexOf(MARKER);
    while (idx !== -1) {
      found.push(`${path} @byte${idx}`);
      idx = s.indexOf(MARKER, idx + 1);
    }
  } catch { /* 锁定/权限:跳过 */ }
}

function walk(dir, found, depth = 0) {
  if (depth > 8 || found.length > 20) return; // 有界
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".git", "Cache_GPUCache"].includes(e.name)) continue;
      walk(p, found, depth + 1);
    } else {
      try {
        if (statSync(p).size > 256 * 1024 * 1024) continue; // 单文件 256MB 上限
      } catch { continue; }
      scanFile(p, found);
    }
  }
}

// 自检:假项目和标记必须还在(被误删要报出来)
if (!existsSync(CANARY_DIR)) {
  console.log(`⚠ 金丝雀项目不存在: ${CANARY_DIR}(可能被删除——请重新生成)`);
  process.exit(2);
}
const selfCount = (function count(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += count(p);
    else { try { n += (readFileSync(p).toString("latin1").match(new RegExp(MARKER, "g")) || []).length; } catch {} }
  }
  return n;
})(CANARY_DIR);

console.log(`金丝雀检查 · ${new Date().toLocaleString("zh-CN", { hour12: false })}`);
console.log(`  假项目: ${CANARY_DIR}(含 ${selfCount} 处标记,你从未在工具中打开它)\n`);

let dirty = 0, checked = 0;
for (const [name, dir] of STORES) {
  if (!existsSync(dir)) { console.log(`  · ${name}: 未安装,跳过`); continue; }
  checked++;
  const found = [];
  walk(dir, found);
  if (found.length > 0) {
    dirty++;
    console.log(`  🚨 ${name}: 发现标记 ${found.length} 处 —— 它扫过你的假项目!`);
    for (const f of found.slice(0, 5)) console.log(`      ${f}`);
  } else {
    console.log(`  ✓ ${name}: 干净`);
  }
}

console.log("");
if (dirty === 0) {
  console.log(`结论:✅ 检查了 ${checked} 个工具,没有任何工具动过你的假项目。`);
  process.exit(0);
} else {
  console.log(`结论:🚨 ${dirty} 个工具在未打开该项目的情况下扫取了它 —— 偷偷收集本机项目信息实锤。`);
  console.log(`      排查:上面对应目录里的文件即证据(含标记的位置);可截图留证。`);
  process.exit(1);
}
