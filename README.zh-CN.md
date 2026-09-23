# agentaudit

**「npm audit 之于 Node 包」——本工具之于 AI 编码 Agent。**

一条命令扫描本机 Claude Code 会话历史,报告你的 Agent 曾经做过的每一个危险操作:破坏性命令、凭证访问、数据外发、持久化植入、危险下载。

```bash
npx @fanzhen/agent-audit # 立即审计 ~/.claude/projects
agent-audit --demo      # 没装 Claude Code?跑内置演示
```

## 检测什么(28 条规则)

| 类别 | 示例 |
|---|---|
| 🟥 破坏性操作 | `rm -rf`、`git reset --hard`、强推、擦盘 |
| 🔑 凭证访问 | 读取 `.env`、`id_rsa`、`~/.aws`、钥匙串 |
| 📤 数据外发 | `cat .env \| curl`、上传 paste 站/webhook |
| 🚪 越权/持久化 | 放宽 `settings.json`、写 `.bashrc`、cron、`authorized_keys` |
| ⚠️ 危险执行 | `curl \| sh`、base64 载荷、云元数据端点、反弹 shell |

`agentaudit --list-rules` 查看全部规则与严重度。

删除本会话内 Agent 自己创建的内容、或常见构建产物目录(`node_modules`、`dist`、`target` 等)时,该发现自动降级为提示(info)并标注「已豁免」;隐私类规则(数据外发 E、凭证访问 C)永不降级。

## 安装与使用

需要 Node 18+。

```bash
npx @fanzhen/agent-audit   # 免安装直接运行,或:npm i -g @fanzhen/agent-audit
agent-audit               # 审计默认目录
agent-audit ~/somewhere   # 审计自定义 projects 目录 / .jsonl 文件
agent-audit --json        # 机器可读输出
agent-audit --severity high --rules E,C
agent-audit --session <id> # 仅审计单个会话
agent-audit --share       # 输出可分享的摘要卡
agent-audit --watch       # 实时出网监视(Windows;见下文)
agent-audit --footprint   # Qoder 本地收集了什么(见下文)
agent-audit --canary      # 有没有工具偷偷扫你的盘?(见下文)
```

Python 版说明:v0.1.1 原始实现保留在 `src/` 作为移植参照,**未发布到 PyPI**。
(注意:PyPI 上名为 `agent-audit` 的包属于无关第三方,安装它并不会得到本工具。)

- 100% 本地解析,永不联网,无遥测
- Windows / macOS / Linux 全支持(Windows 优先测试)

退出码:成功为 `0`(发现项不影响退出码——`--fail-on` 计划中),参数错误或数据目录缺失为 `2`。

## Watch 模式(v0.2.x,仅 Windows)

除了审计历史记录,agent-audit 还能监视 AI 编码工具**此刻**连到哪里:轮
询 TCP 表(每次轮询拉起一个 PowerShell 查询,实际节奏为几秒),抓取被
监视进程的已建立连接,按内置的已知 agent 域名注册表(`model-api` /
`telemetry` / `update` / `captcha` / `community`)标注每个目标,白名单
之外的新目标即时告警 `[!]`。

```bash
agent-audit --watch                          # 监视所有已知 AI 工具,60 秒
agent-audit --watch --proc ZCode,QoderCN     # 指定进程名(不带 .exe)
agent-audit --watch --seconds 300 --csv out.csv   # 记录到 CSV
```

```
[10:13:37] claude(11852) → 160.79.104.10:443 api.anthropic.com (model-api)
[!] [10:13:37] claude(11852) → 47.96.134.91:443 (unknown — no DNS mapping observed)
──── agent-audit watch ────
watched 14s · procs 3 · polls 5 · new connections 3 · dns entries 11
by category: model-api 1 · unknown 2
[!] unknown targets: 47.96.134.91:443 (claude)
```

主机名来自监视窗口内采样的 Windows DNS 缓存——期间从未解析过的 IP 如实
上报为 unknown,绝不按 IP 段猜测。Ctrl+C 提前停止时同样输出摘要。非
Windows 平台上 `--watch` 以退出码 2 结束(`watch: Windows-only in v0.2.x`)。

## Footprint 模式(v0.2.x):Qoder 收集了你什么?

`--footprint` 回答的是与审计不同的问题:不是"agent 做了什么",而是"工具从
你这里拿走了什么"。对 Qoder CN,它盘点 `~/.qoder-cn/shared_client/` 下的本
地索引库:逐仓库读取向量索引的 chunk 表(绝对文件路径——仅元数
据)、统计补全索引 `.zap` 段(内含可还原的源码文本——只报文件数与字节数,
绝不打开)、git/graph 索引规模、项目记忆文件名清单与工作区记忆条数。

```bash
agent-audit --footprint                  # 盘点 ~/.qoder-cn
agent-audit --footprint --json           # 机器可读(含文件清单)
agent-audit --footprint --agent qoder    # 显式指定(v0.2.x 仅支持 qoder)
```

隐私:报告只**列出**收集了什么(仓库、文件路径、chunk 数、索引时间)——
绝不读取或输出文件**内容**。其他 `--agent` 一律退出码 2。

## Canary 模式(v0.4.1):有没有工具偷偷扫你的盘?

金丝雀法是 `--watch` 的内容级补位(`--watch` 只能看到「连到谁」——线上
载荷是 TLS 加密的)。做法:建一个一次性「金丝雀」假项目,里面埋一个唯
一标记串,并且**永远不在任何 AI 工具里打开它**。标记出现在某个工具的
本地数据目录里,就是这个工具自己从盘上读了该项目的铁证:偷偷扫盘,人赃并获。

`--canary` 只读扫描所有已知工具的数据目录(Qoder、ZCode、Trae、Kimi
Code、Codex、Gemini、Cursor,含各自 CLI 目录)找标记。扫描是二进制安全
的(latin1 按字节匹配——`.zap` 段、sqlite、ldb 页里的标记也看得见,不止
纯文本),有界(目录深度 8、单文件 256MB),并且**每次运行自带阳性自
检**:在临时目录埋一个标记,要求检测器必须找到——找不到就报
`RESULT:SELFTEST_FAILED` 并以退出码 3 结束,绝不输出没有意义的「干净」。

```bash
agent-audit --canary                                   # 默认目录 ~/canary-project
agent-audit --canary --canary-dir D:\Projects\demo-inventory-sync
agent-audit --canary --json                            # 机器可读报告
```

```
──── agent-audit canary ────
canary project: D:\Projects\demo-inventory-sync (you never opened it in any AI tool)
marker: ZCANARY-7F3A9C21-D4E8
  ✓ Qoder(active root): clean
  🚨 Trae: marker found x2 — it scanned your canary project!
      C:\Users\you\AppData\Roaming\Trae CN\... @byte4815
  · Kimi-Code: not installed, skipped
  ...
RESULT:CLEAN
```

退出码:`0` 干净 · `1` 发现标记 · `2` 金丝雀项目缺失 · `3` 自检失败。

自建金丝雀(每台机器做一次——默认标记串是部署期常量,请生成自己的):

```powershell
# 1. 生成一台机器一个的标记
powershell -Command "ZCANARY-" + [guid]::NewGuid().ToString("N").Substring(0,12).ToUpper()
# 2. 建一次性假项目,把标记埋进去
mkdir D:\Projects\demo-inventory-sync
echo "canary-marker: ZCANARY-<你的标记>" > D:\Projects\demo-inventory-sync\CANARY.txt
# 3. 把同一标记告诉检查器——并且绝不在任何工具里打开这个项目
agent-audit --canary --canary-dir D:\Projects\demo-inventory-sync --marker ZCANARY-<你的标记>
```

诚实脚注:Trae 本地库加密,Trae 的「干净」只覆盖可读存储(输出里有标
注);压缩存储(Codex `.zst`)与 UTF-16 文本是字节扫描的盲区。

## 非目标(v0.2.x,明说)

- **工具自身后台网络流量的内容级取证**:线上是 TLS 加密的;`--watch`
  报告"连到谁",不报告"发了什么"。要内容级证据请用金丝雀法——已内置为
  `--canary`(见上文):在一次性仓库里埋唯一标记串,再在工具的本地存储
  与抓包流量里搜该标记。
- **Trae 聊天记录**:本地库加密,格式开放前无法审计。
- **Qoder 聊天记录**:在服务端;本地可见的只有数据足迹(见 `--footprint`)。

## 实现说明

v0.2 用 TypeScript 重写了本工具(`npm/`)作为规范实现——在 v0.1 输出面上与 Python 原版等价,由自动化等价性校验在 demo、边界语料与真实会话数据上验证(v0.2.x 增加了 by_agent 等 TS 专属字段,校验时已归一化)。Python 实现(`src/agentaudit`)定格于 v0.1.1,作为移植参照与规格。

## 路线图

- v0.2:已完成——TypeScript/npm 规范移植(v0.1 输出面等价)
- v0.2.x:Codex CLI 适配已完成(0.3.0)· Gemini CLI 待一次真会话验证 · SARIF 导出
- v0.3:guard 模式——在危险操作执行前拦截(PreToolUse hook)

## 许可

MIT
