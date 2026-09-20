# agent-audit 多 Agent 适配计划(v0.2.x,M 系列)

日期:2026-09-20 · 前置:v0.2.0(TS 主线,169 tests,等价门 7/7)
定位:把「只审 Claude Code」扩展为「审本机所有主流 AI 编码工具」。全部开发在 npm/(TS);Python 定格 v0.1.1 不再演进。
调研依据:docs/superpowers/research/ 下三份尖刺文档(格式、存储位置、坑)。

## 架构决策

1. **Agent 注册表**:`npm/src/agents.ts` — 每个 agent 一个描述符 `{ id, displayName, roots(): string[], find(root?): string[] }`。现有 discovery.ts 的 Claude Code 逻辑收编为 `claude-code` 描述符(公共 API `findSessionFiles` 保留向后兼容)。
2. **解析器约定**:每个 agent 一个 `npm/src/parsers/<agent>.ts`,导出 `iterEvents(path, stats): AsyncGenerator<Event>`(与 claude-code.ts 同签名)。ParseStats 复用。**事件模型不动**——Kimi/Codex 全部映射到现有 ShellCommand/FileWrite/NetworkRequest/McpToolCall。
3. **引擎不动**:runAudit 已按 Event 抽象工作。file→agent 的路由由发现层负责(路径决定用哪个 parser:`agentForPath(path)`)。
4. **CLI**:`--agent <id[,id...]|all>`,默认 `all`(缺失的 root 静默跳过并计入 stderr 提示)。`--list-agents` 子命令。报告层加 `summary.by_agent` 计数(ts+py 兼容性:TS 规范实现自定 schema,无需对齐 Python)。
5. **TDD 纪律不降**:每任务先测后码;调研文档里的真实记录样例直接做测试夹具(脱敏)。

## 任务

### M1:Kimi-Code 垂直切片(第一个非 Claude 适配)
- `npm/src/parsers/kimi.ts`:`iterEvents` 解析 `~/.kimi-code/sessions/wd_*/session_*/agents/main/wire.jsonl`
- 映射(依据调研):`tool.call`(name=Bash/Read/Grep/FetchURL/Glob/Skill...)→ ShellCommand/FileWrite/NetworkRequest;`turn.prompt` 记 user 意图(跳过);metadata 的 sessionId/workDir
- `npm/src/agents.ts` 注册表 + kimi 发现逻辑(walk sessions/wd_*/session_* 找 wire.jsonl)
- CLI `--agent` / `--list-agents`;`summary.by_agent`
- 测试:真实 wire.jsonl 样例(调研文档中的脱敏记录)构造夹具;hit/miss 用现有 28 条规则验证(如 Bash 工具调用里的 rm -rf 要触发 D001)
- 交付判据:`node dist/cli.js --agent kimi --json` 在本机真实 Kimi 数据上跑通

### M2:Codex 适配
- `npm/src/parsers/codex.ts`:信封 `{timestamp,ordinal,type,payload}`;只取 `response_item`
- 映射:`function_call`(exec_command/shell/local_shell_call)→ShellCommand;`custom_tool_call`(apply_patch,原生 V4A 文本)→FileWrite(Add=全量 content,Update=diff 仅路径+补丁文本);`web_search_call`→NetworkRequest;MCP function_call→McpToolCall
- 坑(调研已确认):event_msg 无工具记录;args 是 JSON 编码字符串(双重解码);版本漂移(shell→exec_command、task_started→turn_started)未知 type 跳过;`.jsonl.zst` 暂不支持(报计数);PascalCase item_completed
- 本机语料无工具调用记录 → 合成夹具(源码核实的形态)
- CLI 集成 + 本机真实 5 个会话跑通(允许 0 findings)

### M3:Gemini 适配
- 先由用户/代理跑一次真实会话(或用 zhipu key?不——Gemini CLI 需 Google 账号,标注为「需用户配合一次」)验证 functionCall 落盘形态;结构清晰,半天量级

### M4:ZCode 适配
- `npm/src/parsers/zcode.ts`:读 `~/.zcode/cli/db/db.sqlite`(schema 已摸清:message/part/tool_usage/session);sqlite 只读打开(mode=ro),WAL 场景 copy db+wal 再读
- 非流式(库文件):iterEvents 内部分页读取,对外仍 AsyncGenerator
- 隐私:JWT/credentials 字段绝不读取;只取 tool_usage/message 文本列

### M5:watch 动态监视命令(今日手工流程产品化)
- `agent-audit watch [--proc ZCode,Qoder,...] [--seconds N]`:进程级 TCP 出网记录(本日 watch_egress.ps1 的 TS 移植,Get-NetTCPConnection 轮询/Node 原生替代)+ 已知 agent 域名清单标注(调研产出的 domain inventory 内置为 `npm/src/domains.ts`)+ 白名单外新域名告警
- 输出:CSV + 终端摘要(连接数/目标分类:模型API/遥测/更新/未知)

### M6:Qoder 本地足迹审计(「它索引了你什么」报告)
- 读 `index/vector/v5/*/chat.db` chunk_table(路径+行区间,无内容)+ completion 索引的文件名清单 → 报告:仓库×文件数×chunk 数×时间
- 定位为独立子命令 `agent-audit footprint --agent qoder`

## 非目标(明确写进 README)
- 工具自身后台网络行为的**内容级**取证(TLS 加密;canary 方法论文档化供用户手动执行)
- Trae 聊天审计(本地加密,等待破解或官方接口)
- Qoder 云端聊天(无本地数据)

## 环境注意
沿用:C 盘满三前缀/npm 缓存 D:/npm-cache/GitHub 走 SOCKS 10808;调研目录只读;金丝雀工具集在 D:/zcode-test/
