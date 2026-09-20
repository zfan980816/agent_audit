# ZCode 本地取证报告（read-only spike）

- 日期: 2026-09-20
- 范围: 本机（Windows 11）已安装的 ZCode（Z.ai 桌面端 agentic IDE）
- 方法: 纯只读取证。未向 ZCode 任何目录写入；SQLite 通过拷贝副本只读打开（Cookies 除外，被运行中进程独占锁）；leveldb 只做二进制 strings/grep；抓取内容均截断、密钥/令牌一律不落文本。
- 核心问题: **ZCode 是否在后台收集/上传用户源码？**

## 结论先行（TL;DR）

1. **未发现"后台静默上传源码"的通道。** 遥测链路为阿里云 ARMS RUM + OTel APM，载荷为性能/产品元数据（标量字段：耗时、RSS、tool 名、退出码、字节数等），未发现 prompt/文件内容字段；崩溃转储 `uploadToServer:false` 明确不上传；会话/工具调用记录落在本地 SQLite（当前 0 行）。
2. **源码确实会离开本机，但走的是"模型 API 通道"（产品功能性上传）**：对话/Agent 任务的 prompt + 代码上下文发往 LLM 端点（`zcode.z.ai/api/v1/zcode-plan/anthropic`、`open.bigmodel.cn/api/anthropic` 等）。这是设计使然，不是后台偷传。另有 opt-in 的会话分享（share_url）、off-peak 云端任务、onboarding 问卷（`uploadState:"pending"`）。
3. **遥测开关：无用户可见的关闭选项。** RUM 初始化为硬编码 `enable:!0`、`sessionConfig.sampleRate:1`（100% 采样）；`setting.json` 中没有任何 telemetry 隐私键。仅有 env 级注入口（`ZCODE_TELEMETRY_*`/`OTEL_*`/`ZCODE_MODEL_TELEMETRY_ENABLED`）。
4. **Canary 基线 = 0 命中**（4 棵数据树、ASCII+UTF-16LE 双编码），方法学验证通过，可作为打开 canary 仓库后的对照基线。

## 1. 布局地图

### 安装目录 `D:\app\ZCode`（用户实际安装，Electron NSIS 安装）
```
D:\app\ZCode\
  ZCode.exe                      (222 MB, Electron)
  .zcode-install-manifest        (安装文件清单)
  resources\
    app.asar                     (326,893,098 B ≈ 312 MB，未解包，仅二进制 grep)
    app-update.yml               (updater: generic → http://localhost:8081 → 实际自动更新不可用/被覆盖)
    config\default.json          (反馈表单 zhipu-ai.feishu.cn、社区链接)
    config\provider\zcode-builtin.json  (188 KB，模型 provider 注册表)
    glm\zcode.cjs                (14,796,490 B，CLI agent 主 bundle)
    glm\.node-bundle-meta.json   (source: apps/zcode-cli/packages/cli/dist/zcode.cjs → **opencode 血统**)
    glm\packages\                (15 个 agent 插件: browser-use, computer-use, pdf, spreadsheets...)
    tools\{ripgrep\rg.exe, ugrep\ugrep.exe, cua-helper\}
```

### 数据目录（三处，注意大小写是两个不同 profile！）
```
C:\Users\31838\AppData\Roaming\ZCode     (21MB)  ← 旧/首次 profile，today 20:44 仍有活动
C:\Users\31838\AppData\Roaming\zcode     (21MB)  ← 活动 profile（_arms_session 时间戳更新）
  两者结构相同: rum-electron-store\ZGVmYXVsdA.json + session\{Cache, Code Cache, IndexedDB,
  Local Storage\leveldb, Network\Cookies(sqlite), Partitions\zcode-embedded-browser,
  Preferences, Session Storage, GPUCache...}；**无 logs/ 目录**

C:\Users\31838\.zcode                    (34MB)  ← CLI/agent 主目录（等价 ~/.claude）
  cli\db\db.sqlite(+wal)      ← 会话/消息/parts/todo/tool_usage 主库（opencode 式 schema）
  cli\log\zcode-2026-09-20.jsonl       ← CLI 结构化日志(traceId/spanId/sessionId)
  cli\plugins\{cache, data, marketplaces}   ← 官方插件缓存 zcode-plugins-official/*
  v2\bot-config.v3.json / bot-state.v3.json (bots: [])
  v2\cache\content-bundles\             ← 服务端下发的营销/配额 HTML bundle
  v2\certs\zcode-network-ca.key/.pem    ← **运行时自签 CA（含私钥, node-forge 2048 位）**
  v2\crash\live\                        ← Crashpad 目录（本地留存）
  v2\credentials.json                   ← bigmodel OAuth token + zcodejwttoken + api-key（仅清点键名，值未读取落盘）
  v2\logs\2026-09-20.log                ← 桌面端主日志（perf flush、rpc:call）
  v2\onboarding-record.json             ← 问卷记录, uploadState:"pending"
  v2\provider_config.json
  v2\runtime\provider\windows-x86_64\3.14.0\endpoint-*/  ← 服务端刷新的 provider 注册表副本
  v2\setting.json                       ← 桌面设置（**无 telemetry 开关键**）
  v2\tasks-index.sqlite(+wal)           ← 任务/自动化/off-peak 任务索引
  v2\telemetry-state.json               ← {deviceMid, lastDailyActiveDate}
  workspace\default\                    (空)
```
版本: `3.14.0`（`app_version=3.14.0` 出现在 API URL；runtime 目录同名）。

## 2. 遥测存储（rum-electron-store）实证

### 2.1 本地留存内容（极小）
`ZGVmYXVsdA.json`（117 B，"default" base64 文件名），两个 profile 内容一致：
```json
{"_arms_session":"<uuid>-1-<start_ms>-<last_ms>","_arms_uid":"uid_***"}
```
- 只有会话身份（ARMS RUM 的 session/uid），**没有事件队列** → 事件即产即传（内存 flush），不在本地落盘。
- `telemetry-state.json`（~/.zcode/v2）: `deviceMid`（持久设备 ID）+ `lastDailyActiveDate`。

### 2.2 客户端配置（从 app.asar 反解出的 RUM init，逐字）
```js
Ns.init({enable:!0, version:X, endpoint:nc, env:Bs, autoInject:!0,
  browserCollectors:{...Kf},
  app:{name:vr, version:X, env:Bs, type:"electron", framework:"react"},
  user:{name:BT},
  sessionConfig:{sampleRate:1},          // 100% 会话采样
  spaMode:!1, parseViewName:qf,
  collectors:{jsError:!0, consoleError:!0, crash:!0, application:!0, api:!0, rpc:!0},
  tracing:{enable:!0, sample: Bs==="prod" ? .1 : 1},   // prod 10% 追踪采样
  beforeReport: /* 过滤 console.error 噪声, 附 deviceMid/process path */})
```
- 上报端点（`nc`）: `https://proj-xtrace-7e235817c9b9381c22d8b743908d469f-cn-beijing.cn-beijing.log.aliyuncs.com/rum/web/v2?workspace=default-cms-1936221977589032-cn-beijing&service_id=j2c03hoppk@***`
- `collectors.api:!0` → ARMS 会记录应用出站 HTTP 的**元数据**（URL/耗时/状态码），即模型调用域名会出现在遥测里（元数据级）。
- SDK: `@arms/rum-electron`（阿里云 ARMS 官方 Electron SDK），本地配置键 `arms_rum2_local_config`，`enable` 缺省 true、`sampling` 缺省 100。

### 2.3 事件字段（实测 schema，zod 反解）
- **ARMS 自定义事件** (`armsCustomEventPayloadSchema`): `{name, group, value?:number, properties?: record<string, string|number|boolean|undefined>}` — 仅标量，无嵌套对象 → 结构上无法携带文件/代码内容。
- **产品埋点示例** (`session_create`): `elementName:"session_create", eventRegion:"app", eventType:"result", talkId, messageId, context{clientTimezone, clientLanguage, screenResolution}, eventExtraDetail{create_source, client_kind:"desktop", workspace_kind:local|remote, remote_kind:""|ssh|wsl|docker|server}`。
- **资源采样** (`toolExecResource` 事件字段): `platform, app_version, arms_env, device_mid, runtime_surface, tool_name, exit_kind, sample_count, cli_rss_kb, system_free_memory_kb` (+ 平台扩展)；进程/系统窗口: RSS/CPU 均值/峰值/p95；网络窗口 perf_network。桌面日志可见每 5 min `perf_process_window + perf_system_window flushed`、`perf_network flushed`。
- **IPC 通道**: `zcode:report-telemetry-event`, `zcode:report-arms-custom-event`, `zcode:sync-telemetry-context`, `network-telemetry-batch`, `mcp-telemetry`, `tool-exec-resource`（CLI→桌面桥，桌面统一上报）。
- **CLI 自有 OTel span 属性**（导出到 ARMS APM）: `zcode.tool_execution.{output_bytes, output_truncated, permission_decision, permission_denial_reason}`, `zcode.model_attempt.{http_status_code, finish_reason, time_to_first_*_ms, retry_after_ms, provider_error_code/message, ...}`, `zcode.context_compaction.{input_tokens, output_tokens}` — **全部是元数据/度量**。且导出前有内置 redactor：对 URL 中 `api_key|token|authorization|password|secret|cookie|session=x-arms-license-key=` 等 query 值替换为 `{redacted}`。
- **AI SDK 层 OTel（最可能带内容的地方）未被启用**: `experimental_telemetry` 全 bundle 仅 1 处出现（库自身签名解构），无调用方传入 → AI SDK 的 `ai.toolCall.result`/prompt span（默认会 stringify 工具输出）根本不会生成。
- **设备/用户标识注入**: 桌面拉起 CLI 时通过 env 传递 `ZCODE_TELEMETRY_DEVICE_MID / ZCODE_TELEMETRY_USER_ID / ZCODE_TELEMETRY_USER_ID_HASH / ZCODE_TELEMETRY_USER_SUBJECT_ID`（env 白名单同时放行 `OTEL_*`；`ZCODE_MODEL_TELEMETRY_ENABLED` 可阻断 deviceMid 注入）。
- **身份**: `credentials.json` 含 `zcodejwttoken`、`oauth:bigmodel:access_token`、api-key（键含账号 id 78601753837883***）；Local Storage 缓存 `usage-entitlement:subscription-v2:account:bigmodel-start-plan`；`zcode-v4-client-id`。

## 3. 会话/工具调用记录的存储判定与可提取性

| 位置 | 内容 | 现状 |
|---|---|---|
| `~/.zcode/cli/db/db.sqlite` | **主转录库**。表: session(share_url!), message(data), part(data), todo, session_entry(data), permission, input_history(text,attachments), session_input(payload), tool_usage(tool_name,side_effect_scope,destructive,approval_status,...), turn_usage(ttft,...), model_usage, workflow_*, dwf_* | **schema 完整，全部 0 行**（本机尚未跑过任何 agent 会话） |
| `~/.zcode/v2/tasks-index.sqlite` | tasks(title,status,provider,model), automations(**prompt**,cron), automation_runs, off_peak_tasks(**prompt**, server_ticket_id, conversation_id) | 0 行 |
| AppData\*\ZCode|zcode `session/Local Storage/leveldb` | 仅 UI 状态: pane layout、sidebar 偏好、composer draft(空)、client-id、entitlement 快照 | 无转录 |
| `session/IndexedDB/*leveldb` | 仅 FeiLin 验证码库时间戳 | 无转录 |
| `session/Session Storage` | 158 B 空壳 | 无转录 |
| `~/.zcode/v2/logs/*.log` + `cli/log/*.jsonl` | 元数据级: rpc:call 名称/耗时、memory 采样、MCP startup、traceId/spanId/sessionId | **无代码内容** |
| `session/Network/Cookies` (sqlite) | Cookie 存在（20KB）但被运行中进程独占锁（Device or resource busy），本次未能列出域 | 限制项 |

**判定：工具调用历史 100% 可恢复** —— 一旦真正跑过会话，`db.sqlite` 的 `message.data`/`part.data`（含 tool 调用输入输出）、`tool_usage`、`input_history` 都是普通 SQLite 明文行，拷贝 db+wal 后即可完整提取（等价于 `~/.claude/projects` 的地位）。今日状态为"安装完成、零会话"，故本机暂无任何历史可提。

## 4. 域名清单

### 4.1 代码内嵌（配置/硬编码，grep app.asar + zcode.cjs）
| 域名 | 用途 | 依据强度 |
|---|---|---|
| `*.cn-beijing.log.aliyuncs.com`（proj-xtrace-7e235817...） | ARMS RUM `/rum/web/v2` + OTel APM `/apm/trace/opentelemetry`（`OTEL_SERVICE_NAME=zcode-cli-agent`, header `x-arms-license-key=j2c03hoppk@***`） | 硬编码，逐字提取 |
| `zcode.z.ai` | 主后端: `/api/v1/client/configs`, `/api/v1/agent/configs`, `/api/v1/zcode-plan/billing/{balance,current}`, `/api/v1/zcode-plan/anthropic`(模型), `/api/v1/zcode-plan/off-peak/anthropic`; `endpointKey` 见 zcode-builtin-refresh.json | 硬编码 + 日志实测 |
| `api.z.ai`, `open.bigmodel.cn` | 模型 API（paas/v4、anthropic 兼容、coding-plan） | provider 注册表 |
| `opencode.ai`（/auth, /zen/v1, /zen/go/v1） | opencode 血统 provider | provider 注册表 |
| `openrouter.ai`, `api.anthropic.com`, `api.openai.com`, `api.deepseek.com`, `api.moonshot.cn`, `api.minimaxi.com`, `api.x.ai`, `platform.kimi.com`, `platform.xiaomimimo.com`, `dashscope.aliyuncs.com`(intl), `modelstudio.console.aliyun.com`, `bailian.console.aliyun.com`, `bigmodel.cn` | 可选模型 provider/控制台 | provider 注册表 |
| `zhipu-ai.feishu.cn`, `open.feishu.cn`, `discord.gg` | 反馈表单/社区（文档性） | config/default.json |
| `o.alicdn.com`, `g.alicdn.com`, `*.captcha-open.aliyuncs.com` | 登录验证码（Aliyun Captcha/FeiLin） | 缓存+Network State 实测 |
| `redirector.gvt1.com`, `r3---sn-2x3eenes.gvt1-cn.com`, `*.pki.goog` | Chrome 组件/拼写词典下载 + 证书链 | 缓存实测 |
| `secure.globalsign.com`, `ocsp/crl.globalsign.com`, `sectigo.com`, `crt.sectigo.com` | TLS 证书链 OCSP/CRL | 缓存实测 |

### 4.2 实际观测到的出网（缓存/日志，本机真实发生）
`zcode.z.ai/api/v1/zcode-plan/billing/balance`（日志中 6 次）、`zcode.z.ai/api/v1/client/configs`、alicdn 验证码资源、gvt1 词典、globalsign/sectigo/pki.goog 证书链。**未观测到任何文件/代码上传端点。**

### 4.3 打包但非编码用途的 API 面（未定位到归属模块，仅备注）
app.asar 内含一整套 `v1/...` office/bot 平台 API 路径（chats, files, user_mailboxes, tasks, meetings, employees, talent_pools, offers...246 处 apps/ 等），与 `v2/bot-config.v3.json` 的 bots 机制同源，疑似捆绑的 Z.ai bot/办公集成 SDK；本次未证实其被调用。

## 5. 遥测/隐私开关状态

| 开关 | 状态 | 证据 |
|---|---|---|
| ARMS RUM | **开，硬编码** `enable:!0`，session 采样 100%，tracing prod 10% | app.asar Ns.init |
| 用户可见 telemetry 关闭项 | **不存在**（setting.json 全键核对：locale/terminal/browser/task/reasoning/modelIo... 无任何 telemetry/privacy 键） | ~/.zcode/v2/setting.json |
| Chromium 级 metrics/安全浏览上报键 | 无（Preferences/Local State 仅 spellcheck、os_crypt、media salt） | 两 profile 四个 JSON |
| Crash 上传 | **关** `crashReporter.start({uploadToServer:!1})`，minidump 留 `~/.zcode/v2/crash` | app.asar 逐字 |
| 崩溃/诊断 | crash/live/{attachments,metadata,reports} 当前为空目录 | 目录清单 |
| `modelIoFullRetentionEnabled` | 默认 false，且会经 `workspaceUpdateModelIoPreferences{fullRetentionEnabled}` 推送到 zcode.z.ai 后端（服务端保留策略开关） | app.asar 逐字 |
| 会话分享 | opt-in（`share_code`+`share_url` 生成后可分享对话） | zcode.cjs schema |
| 自动更新 | `app-update.yml → http://localhost:8081`（generic provider，本机无服务 → 自动更新事实上不可用；配置可被服务端下发覆盖） | app-update.yml |
| 运行时配置下发 | provider 注册表从 `endpointKey=https://zcode.z.ai` 按 lease 刷新（zcode-builtin-refresh.json, nextEligibleAt 时间戳），client/configs 拉取 → **服务端可远程改配置** | 实测文件 |
| 网络代理 CA | `~/.zcode/v2/certs/zcode-network-ca.key/.pem` 由 app 运行时用 node-forge 自签（`getAppCaCertPaths`）→ 自带 TLS 拦截代理能力（app 域内），私钥在本机 | zcode.cjs 逐字 |

## 6. Canary 基线

标记: `ZCANARY-7F3A9C21-D4E8`（ASCII 与 UTF-16LE 双编码扫描）

| 树 | 命中 |
|---|---|
| `C:\Users\31838\AppData\Roaming\ZCode`（全部 99 文件） | **0** |
| `C:\Users\31838\AppData\Roaming\zcode` | **0** |
| `D:\app\ZCode`（含 312MB app.asar） | **0** |
| `C:\Users\31838\.zcode`（34MB） | **0** |

与预期一致（ZCode 尚未打开 `D:\zcode-test\canary\demo-proj`）。本基线证明扫描方法（全树二进制 + UTF-16 扫描）可用；打开 canary 工程后复扫，对比即可判定代码内容是否进入任何本地存储（进而推断上传面）。

## 7. 对核心问题的回答

**"ZCode 是否在后台收集/上传用户源码？"——按本次本地取证：没有发现后台静默上传源码的证据；源码经模型 API 通道离开本机属于产品功能（你在对话/跑 agent 时），遥测通道只传元数据。**

要点：
- 遥测三条链（ARMS RUM、ARMS APM/OTel、结构化本地日志）的载荷 schema 全部为标量元数据；最危险的 AI SDK 记录器（会把工具输出 stringify 进 span）确认未启用；崩溃转储明确不上传。
- 会话/工具调用全部本地 SQLite（明文可提取），当前 0 行。
- 需保留的保留意见：(a) 本机尚未跑过任何 agent 会话，无法用真实载荷验证"跑会话时"遥测不含内容（建议用 canary 复扫 + 代理抓包补证）；(b) 配置由 zcode.z.ai 下发刷新，理论上服务端可变更行为；(c) app 自带自签 CA 代理能力（app 域内 TLS 拦截）值得后续关注；(d) Cookies 被运行中进程锁住未能清点。

## 复现命令备注
- 扫描脚本: `D:\tmp\zcode-forensics\scan.py`（canary+域名全树扫描）、`hosts.py`（host 聚合）、`canary2.py`（扩展两树）；DB 副本: `D:\tmp\zcode-forensics\db\`。
- SQLite 只读打开方式: 拷贝 db+wal+shm 到临时目录后普通连接（原库被运行中进程锁）；Cookies 无法拷贝（独占锁）。
