# agentaudit

**「npm audit 之于 Node 包」——本工具之于 AI 编码 Agent。**

一条命令扫描本机 Claude Code 会话历史,报告你的 Agent 曾经做过的每一个危险操作:破坏性命令、凭证访问、数据外发、持久化植入、危险下载。

```bash
npx agent-audit         # 立即审计 ~/.claude/projects
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

## 安装与使用

需要 Node 18+。

```bash
npx agent-audit           # 免安装直接运行,或:npm i -g agent-audit
agent-audit               # 审计默认目录
agent-audit ~/somewhere   # 审计自定义 projects 目录 / .jsonl 文件
agent-audit --json        # 机器可读输出
agent-audit --severity high --rules E,C
agent-audit --session <id> # 仅审计单个会话
agent-audit --share       # 输出可分享的摘要卡
```

Python 3.10+ 备选:`uvx agent-audit`(免安装)或 `pipx install agent-audit`
(命令名:`agentaudit`)。

- 100% 本地解析,永不联网,无遥测
- Windows / macOS / Linux 全支持(Windows 优先测试)

退出码:成功为 `0`(发现项不影响退出码——`--fail-on` 计划中),参数错误或数据目录缺失为 `2`。

## 实现说明

v0.2 用 TypeScript 重写了本工具(`npm/`)作为规范实现——在 v0.1 输出面上与 Python 原版等价,由自动化等价性校验在 demo、边界语料与真实会话数据上验证(v0.2.x 增加了 by_agent 等 TS 专属字段,校验时已归一化)。Python 实现(`src/agentaudit`)定格于 v0.1.1,作为移植参照与规格。

## 路线图

- v0.2:已完成——TypeScript/npm 规范移植(v0.1 输出面等价)
- v0.2.x:支持 Codex CLI / Gemini CLI,SARIF 导出
- v0.3:guard 模式——在危险操作执行前拦截(PreToolUse hook)

## 许可

MIT
