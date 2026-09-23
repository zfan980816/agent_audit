# 发布帖草稿(中英双版)

> 用途:HN / Reddit r/ClaudeAI(英文版),V2EX / 即刻(中文版)。
> 数据全部来自本机真实运行,可复现命令附后。

---

## English (HN / Reddit)

**Show HN: agent-audit – npm audit for your AI coding agents (4 agents, 28 rules, canary trap)**

I let AI coding agents run shell commands on my machine all day. Last month I
finally asked the uncomfortable question: what did they actually DO? So I
built agent-audit — a local, read-only CLI that parses the session history of
Claude Code, Codex, Kimi Code and ZCode and scores every action against 28
security rules (destructive ops, credential access, exfiltration, persistence,
unsafe execution).

```
$ npx @fanzhen/agent-audit
files 532 · sessions 154 · events 12k · findings 421
  195 CRITICAL · 73 HIGH · 143 MEDIUM
```

421 findings on my own machine. Then came the interesting part: most of it was
noise. When an agent `rm -rf`s the node_modules it just created, that's
cleanup, not an incident. So I built creator-immunity: the engine tracks what
each session created (Write tool AND bash mkdir/redirects/git-clone outputs)
and auto-downgrades deletion of its own content or build artifacts to info —
while privacy rules (credential reads, exfiltration) are NEVER downgraded.
Same machine, after: 421 → 115 signals worth reading.

Two things I couldn't find anywhere else:

1. **--canary** — the content-level answer to "is my IDE secretly scanning my
   disk?" You plant a throwaway project with a unique marker and never open it
   in any tool. agent-audit binary-scans every tool's local stores (vector
   indexes, sqlite, bleve segments) for the marker. Found = caught
   red-handed. Every run ships a positive self-test — it plants a marker and
   proves the detector can ring, because a silent alarm is worse than none.

2. **--footprint** — inventories what a tool already collected from you. First
   finding on my own machine: an AI IDE had full-text-indexed 5 of my repos
   (1,467 files in one) into local bleve stores.

Honest limits, stated in the README: TLS means --watch sees WHO a tool talks
to, not WHAT it sends (canary covers content); one vendor's local DB is
encrypted (its "clean" is marked as weak evidence). Python implementation is
frozen as the porting reference; TypeScript is canonical, byte-equivalence
proven by an automated gate on real session data.

100% local, zero telemetry, MIT. Would love feedback — especially rule ideas
for the evasion patterns I'm sure I've missed.

https://github.com/zfan980816/agent_audit

---

## 中文(V2EX / 即刻)

**做了個「npm audit 之于 AI 编码 Agent」:审计你的 Claude Code/Codex 们到底干过什么,附抓偷扫盘的金丝雀**

让 AI 编程工具整天在自己机器上跑命令,某天突然想问:它们到底干过什么?
于是写了 agent-audit——本地只读,一条命令扫描 Claude Code / Codex /
Kimi Code / ZCode 的会话历史,28 条安全规则审每个动作(破坏性命令、
读凭证、外发数据、持久化植入、危险执行)。

我自己的机器:532 个会话文件,**421 条发现**。

然后是真正花功夫的部分:大部分是噪音。agent 删掉自己刚建的
node_modules 是清理,不是事故。所以做了「创建者豁免」引擎——追踪每个
会话创建过什么(Write 工具 + bash 的 mkdir/重定向/git clone 产出),
删自己建的内容/构建产物自动降级标注;**隐私类规则永不降级**。同一台
机器:421 → 115 条值得看的信号。

两个别处找不到的东西:

1. **--canary 抓偷扫盘**:建一个带唯一标记、永远不在任何工具里打开的
   假项目;工具二进制扫描所有工具的本地库(向量索引/sqlite/bleve 段)
   找标记——出现 = 人赃并获。每次运行自带阳性自检:先埋一个标记证明
   检测器会响,不会响的铃铛比没有铃铛更危险。

2. **--footprint 盘点已被收集的**:我机器上的第一个发现——某 AI IDE
   已经把我的 5 个仓库全文索引进了它的本地库(其中一个 1,467 个文件)。

诚实边界都写在 README:TLS 加密意味着监视只知「连到谁」不知「传了
什么」(内容级用金丝雀);某厂商本地库加密,其「干净」标注为弱证据。
100% 本地、零遥测、MIT。

https://github.com/zfan980816/agent_audit

---

## 复现指引(发帖前自查)

- `npx @fanzhen/agent-audit` — 审计
- `npx @fanzhen/agent-audit --demo` — 无 AI 工具也能看效果
- `npx @fanzhen/agent-audit --canary --canary-dir <假项目>` — 金丝雀
- 数据口径:421/115 为 2026-09-21~23 本机实测;发帖时如数字变化,以
  当日 `--json` 输出为准
