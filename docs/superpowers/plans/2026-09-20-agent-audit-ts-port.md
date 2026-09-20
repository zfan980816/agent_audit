# agent-audit TypeScript 移植计划(v0.2.0,npm 主线)

日期:2026-09-20 · 前置:v0.1.1 已发布(fc3b9a8)
目标:把 Python 实现(164 tests,唯一已验证规格)移植为 TypeScript npm 包 `agent-audit`,
**移植即切换**:等价性验证通过后,TS 成为主线,Python 定格 v0.1.1 归档。

## 核心原则

1. **Python 是规格**:TS 实现以 `src/agentaudit/` 对应文件为逐行参照;测试从 `tests/` 逐条移植(parametrize 列表是数据,机械搬运)。
2. **等价性是切换门槛**:Task 8 的 golden diff(Python JSON vs TS JSON,逐字节)不通过不合并主线。
3. **TDD 不降级**:每任务先移植测试(红)→ 移植实现(绿)→ 全量回归 → commit。
4. 沿用 v0.1 的审查节奏:实现 → 规格审查 → 质量审查(哈库塔塔三道关)。

## 技术决策(定死,不留给实现者发挥)

| 项 | 决策 |
|---|---|
| 目录 | `npm/`(monorepo,与 Python 并存至切换) |
| 包名/bin | `agent-audit` / 命令 `agent-audit` |
| Node | >=18(原生 readline 异步迭代、fetch 不需要) |
| 语言 | TypeScript 5.x,strict,ESM(`"type": "module"`),构建产物 `dist/`(tsc) |
| 运行时依赖 | `commander`(CLI)+ `picocolors`(色)+ `cli-table3`(表格)——仅此三个 |
| 测试 | vitest,文件在 `npm/test/`,命名镜像 Python 的 `tests/test_*.py` |
| 流式解析 | `readline.createInterface({crashes: fs.createReadStream})` + `for await` → **引擎是 async**(`runAudit(): Promise<AuditResult>`),所有下游测试 await |
| 正则 | JS 字面量 + `i` 标志;Python 模式全部兼容(已核对:`\b`、字符类、`(?!...)`、`{0,400}`);**逐字搬运,不改一字** |
| JSON 等价 | `toDict()` 键名与键序必须与 Python `to_dict` 完全一致(JS 对象按插入序序列化,可控) |
| Severity | `const SEVERITY_ORDER = ["info","low","medium","high","critical"] as const`;类型 `Severity = typeof SEVERITY_ORDER[number]` |
| 严重度过滤 | 复刻 `SEVERITY_ORDER.index >= floor.index` 语义 |

## 命名映射(Python → TS)

| Python | TS |
|---|---|
| `agentaudit/events.py` | `npm/src/events.ts`(`pathBasename`、`isConfigPath`、`CONFIG_BASENAMES`) |
| `agentaudit/discovery.py` | `npm/src/discovery.ts`(`findSessionFiles`、`DataDirNotFound`→抛 `DataDirNotFoundError` 类) |
| `parsers/claude_code.py`(`iter_events`/`ParseStats`) | `npm/src/parsers/claude-code.ts`(`iterEvents` async generator/`ParseStats` class) |
| `rules/base.py`(`Finding`/`Rule`/`RegexRule`/`evidence_of`) | `npm/src/rules/base.ts`(`Finding` interface/`Rule`/`RegexRule` class/`evidenceOf`) |
| `rules/{destructive,credentials,exfiltration,bypass,unsafe}.py` | `npm/src/rules/*.ts`(类名/模式/说明文案逐字保留) |
| `rules/__init__.py`(`CATEGORY_TITLES`/`all_rules`) | `npm/src/rules/index.ts`(`CATEGORY_TITLES`/`allRules()`,每次调用新实例——E005 契约) |
| `engine.py`(`AuditResult`/`run_audit`) | `npm/src/engine.ts`(`AuditResult`/`runAudit` async;`files_failed` 容错语义保留) |
| `report.py` | `npm/src/report.ts`(`renderTerminal`/`toDict`/`shareCard`/`severityCounts`/`filterBySeverity`;终端样式求神似不求逐字节) |
| `demo.py` | `npm/src/demo.ts`(`DEMO_TOOL_CALLS` 逐条一致,输出文件逐字节一致——UTF-8 无 BOM、`\n` 换行) |
| `cli.py` | `npm/src/cli.ts`(commander;旗标全集 `--json/--severity/--session/--rules/--list-rules/--share/--demo/--version`;退出码 0/2;stderr 进度行;`--json` 时禁用 share) |

## 任务分解(9 个)

### Task T1:脚手架 + events.ts
- `npm/package.json`(name/version 0.2.0/bin/files/engines/scripts:test= vitest run, build= tsc)
- `tsconfig.json`(strict, ESM, outDir dist, moduleResolution NodeNext)
- `vitest.config.ts`
- `npm/src/events.ts` + `npm/test/events.test.ts`(移植 tests/test_events.py 全部用例,含 is_config_path/path_basename 边界)
- 冒烟:`npm test` 绿、`npm run build` 出 dist

### Task T2:discovery.ts + parsers/claude-code.ts
- 移植 3 个 discovery 测试 + 6 个 parser 测试(含坏行计数、fallback、顺序)
- readline 流式;utf-8 `replacement` 解码错误容忍(对应 Python errors="replace":流上 `stream.setEncoding('utf8')` 已含 replacement 语义,验证之)
- `iterEvents(path, stats)` async generator,逐行 try JSON.parse

### Task T3:rules/base.ts + destructive + credentials
- `RegexRule`:构造时空 pattern 抛错(v0.1 加固保留);`appliesTo` 元组过滤;evidence `m[0].slice(0,200)`
- 移植 test_rules_base + test_rules_destructive + test_rules_credentials 全部参数化用例(逐条)

### Task T4:exfiltration(E005 状态机)+ bypass(双通道)+ unsafe + 注册表
- E005:`Map<string,string>` per-session;打包→上传→清除;fire-once 语义;三次运行独立性
- B001-B005 双通道 dispatch;U003 NetworkRequest 通道
- `rules/index.ts` + 注册表测试(28 条、五类、全新实例)

### Task T5:engine.ts
- `runAudit` async;prefixes/session 过滤入参;files_failed;severity 降序稳定排序(Array.prototype.sort 稳定)
- 移植 7 个引擎测试(含 E005 跨文件、不可读文件、文件顺序)

### Task T6:report.ts
- `toDict` 键序与 Python 完全一致(summary: files, files_failed, sessions, events, lines_skipped, total, by_severity[critical..info];finding 九键)
- renderTerminal:picocolors 上色、cli-table3 表格、200 行截断、skipped/failed 尾注;**用户可控文本不做任何 markup 解释**(无 rich 注入坑,但表格单元格原样输出)
- shareCard 三行,口号 `npx agent-audit`
- 移植 6 个报告测试

### Task T7:demo.ts + cli.ts + bin
- writeDemoSession 输出与 Python 逐字节一致(对拍)
- commander CLI 全旗标;`--severity` 校验(info|low|medium|high|critical,错则 stderr+exit 2);路径不存在 stderr+exit 2;`--json` 纯 stdout;`--share` 与 `--json` 互斥
- 移植 6 个 CLI 测试(execa 调 bin 或直接调 main(argv) 函数——选后者,免子进程)

### Task T8:等价性验证(切换门槛)★
- `npm/scripts/equiv.mjs`:对同一输入文件分别跑 `uv run agentaudit <f> --json`(Python)与 `node npm/dist/cli.js <f> --json`(TS),深度比较 JSON(键序无关的结构相等 + 关键字段逐一断言)
- 语料:demo 输出 + 构造边界集(坏行/空文件/引号路径/中文命令/200+evidence/多会话/E005 跨文件) + **本机真实 ~/.claude/projects**(真实数据仅本地 diff,输出只留聚合结论)
- 全部通过 → 本任务 commit 即"切换点"

### Task T9:收尾
- 根 README 增补:npm 安装为首选项(`npx agent-audit`),Python 归档说明(v0.1.1 定格,规格参照物)
- CI 增加 node 矩阵 job(18/20 × 三平台,npm ci + npm test + npm run build);Python job 保留
- `.gitignore` 加 `npm/dist`、`node_modules`
- 打 tag `v0.2.0`(发布 npm 需用户 `npm login`,单独时点)

## 环境注意(沿用 v0.1 教训)

- C 盘满:uv/pytest 三前缀照旧;npm 缓存设 D 盘(`npm config set cache D:/npm-cache`,Task T1 做)
- 复杂内联 node -e 命令若 EPERM → 写 D:/tmp 脚本再跑
- Windows 换行:源码 LF,git autocrlf 警告无害

## 移植差异台账(T2 保真度审查确立;T8 语料须有意覆盖或避开)

已修复(5b39863):args_hint 分隔符/转义(自写 pyJsonDumps)、fallback_project 点号目录名。

接受的边界差异(真实 Claude Code 数据不会触发;构造语料时**避开或显式断言**):
- **C·BOM**:Node 流解码剥掉 UTF-8 BOM(首行正常解析),Python 保留导致跳行计数 +1
- **D·大小写**:Windows 上 Python pathlib 对 `.JSONL` 大小写不敏感且排序 casefold,TS 端大小写敏感 + 码元排序(语料全用小写 `.jsonl` 即无差异)
- **E·非标准 JSON 字面量**:`NaN/Infinity` Python json.loads 接受、JSON.parse 拒绝(计数差 1)
- **F·无 Z 时间戳**:naive 字符串 Python 按原样存、TS 按本地时区解释(真实数据恒为 Z 后缀)
- **G·非字符串 cwd**:Python 原样存(int 等)、TS 归 null
- **浮点数 args_hint**:Python `1.0` 输出 `1.0`、JS 输出 `1`(工具入参几乎全为整数/字符串)
- **H·目录 junction**:Python rglob 跟随、TS 跳过(exotic)
- **I·Unicode 词边界**:Python `\w/\b` Unicode 感知,JS 仅 ASCII——非 ASCII 字母与词字符邻接时判定可分叉(如 `caté .env` Python 漏/TS 中;证据截断点亦可偏移)。仅怪异输入触发,TS 偏向误报不漏报;T8 语料避免非 ASCII 命令字符紧邻模式锚点
- **J·`\s` 类成员差**:Python `\s` 含 `\x1c-\x1f`/`\x85`(不含 `\xa0`),JS 相反(含 ` `/`﻿`)——仅控制字符/奇 Unicode 输入的 `\s` 锚点处可分叉,同 I 族
- **K·B001 `$` 尾换行**:Python `$` 接受串尾 `\n`,JS 不——basename 内含换行的路径(B001)可分叉,exotic
- **L·µs 时间戳**:JS Date 毫秒精度,4-6 位小数秒被截断(`.123456`→`.123000`);Python 保留 6 位。真实 Claude Code 恒为毫秒级,不触发
- **M·win32 颜色**:picocolors 在 win32 无条件着色(rich 按 isatty)——T7 CLI 层须在非 TTY 时设 NO_COLOR 对齐
