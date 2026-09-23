# 本机常驻监控部署(agent-audit 配套工具)

这套脚本回答一个问题:**有没有 AI 编码工具在偷偷扫你的项目**。
核心机制是金丝雀:一个你从未在任何工具里打开过的假项目(带唯一标记),
哪个工具的数据库里出现标记 = 它背着你自己扫了盘。

金丝雀检查自 agent-audit 0.4.1 起是一等公民(`agent-audit --canary`),
逻辑与退出码与 `canary-check.mjs` 完全一致;`canary-check.mjs` 保留为
无 0.4.1 环境的兜底。

## 文件

| 文件 | 作用 |
|---|---|
| `agent-audit --canary` | 金丝雀检查的**首选入口**(0.4.1+ 内置,只读扫描) |
| `canary-check.mjs` | 旧版独立检查器,兜底用(逻辑同 CLI,已移植进 npm/) |
| `console.mjs` | 网页监控台:localhost:8420,实时出网记录 + 分类 + 告警 |
| `一直监控.cmd` | 常驻循环:每小时出网监视 + 金丝雀检查 |
| `检查金丝雀.cmd` | 手动金丝雀检查入口(双击) |
| `install-task.ps1` | 注册开机自启(需用户本人执行) |

## 部署(本机约定路径 D:\agent-watch)

1. 把本目录脚本复制到 `D:\agent-watch\`
2. 按下方「金丝雀配方」创建假项目 `D:\Projects\demo-inventory-sync`
3. 启动:双击 `一直监控.cmd`;网页台:`node console.mjs` 后开
   http://localhost:8420
4. 开机自启(可选,需本人执行):
   `powershell -NoProfile -ExecutionPolicy Bypass -File D:/agent-watch/install-task.ps1`

## 金丝雀配方(每台机器做一次)

金丝雀 = 一个**永远不会在任何 AI 工具里打开**的假项目,里面埋一个唯一标记串。

```bat
:: 1. 生成一台机器一个的标记(不要沿用示例值)
powershell -Command "ZCANARY-" + [guid]::NewGuid().ToString("N").Substring(0,12).ToUpper()

:: 2. 建假项目,放两三个无害文件,把标记埋进去
mkdir D:\Projects\demo-inventory-sync
echo # demo-inventory-sync > D:\Projects\demo-inventory-sync\README.md
echo canary-marker: ZCANARY-<你的标记> > D:\Projects\demo-inventory-sync\CANARY.txt
```

3. 把同一标记通过 `--marker` 告诉检查器:

```bat
agent-audit --canary --canary-dir "D:\Projects\demo-inventory-sync" --marker ZCANARY-<你的标记>
```

规则:**绝不**在任何工具里打开这个项目;标记出现在任何工具数据目录 =
偷偷扫盘实锤。每次检查自带阳性自检(检测器连自己埋的标记都找不到会报
`RESULT:SELFTEST_FAILED`,退出码 3)。退出码:0=干净 1=发现 2=无金丝雀项目 3=自检失败。

## 运行数据(不入库)

egress.csv / baseline.json / run.log / canary-result.txt 由脚本在部署目录
生成,属机器本地数据,不进版本控制。

## 已知边界

- TLS 加密:只知「连了谁」,不知「传了什么」;内容级实锤用金丝雀
- Trae 本地主库加密,「Trae 干净」结构性不可信(标注在检查输出里)
- latin1 字节扫描对压缩存储(Codex .zst)与 UTF-16 存在盲区
