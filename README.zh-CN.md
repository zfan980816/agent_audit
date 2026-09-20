# agentaudit

**「npm audit 之于 Node 包」——本工具之于 AI 编码 Agent。**

一条命令扫描本机 Claude Code 会话历史,报告你的 Agent 曾经做过的每一个危险操作:破坏性命令、凭证访问、数据外发、持久化植入、危险下载。

```bash
uvx agent-audit          # 立即审计 ~/.claude/projects
agentaudit --demo       # 没装 Claude Code?跑内置演示
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

需要 Python 3.10+。

```bash
pipx install agent-audit
agentaudit              # 审计默认目录
agentaudit --json       # 机器可读输出
agentaudit --share      # 输出可分享的摘要卡
```

- 100% 本地解析,永不联网,无遥测
- Windows / macOS / Linux 全支持(Windows 优先测试)

退出码:成功为 `0`(发现项不影响退出码——`--fail-on` 计划于 v0.2),参数错误或数据目录缺失为 `2`。

## 路线图

- v0.2:支持 Codex CLI / Gemini CLI,SARIF 导出
- v0.3:guard 模式——在危险操作执行前拦截(PreToolUse hook)

## 许可

MIT
