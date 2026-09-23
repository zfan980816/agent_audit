# 本机常驻监控部署(agent-audit 配套工具)

这套脚本回答一个问题:**有没有 AI 编码工具在偷偷扫你的项目**。
核心机制是金丝雀:一个你从未在任何工具里打开过的假项目(带唯一标记),
哪个工具的数据库里出现标记 = 它背着你自己扫了盘。

## 文件

| 文件 | 作用 |
|---|---|
| `canary-check.mjs` | 金丝雀检查器:扫描各工具数据目录找标记(只读) |
| `console.mjs` | 网页监控台:localhost:8420,实时出网记录 + 分类 + 告警 |
| `一直监控.cmd` | 常驻循环:每小时出网监视 + 金丝雀检查 |
| `检查金丝雀.cmd` | 手动金丝雀检查入口(双击) |
| `install-task.ps1` | 注册开机自启(需用户本人执行) |

## 部署(本机约定路径 D:\agent-watch)

1. 把本目录 5 个文件复制到 `D:\agent-watch\`
2. 假项目放到 `D:\Projects\demo-inventory-sync`(内容在 `canary-check.mjs`
   头部注释有配方;标记串 `ZCANARY-7F3A9C21-D4E8`,换机器请换新标记)
3. 启动:双击 `一直监控.cmd`;网页台:`node console.mjs` 后开
   http://localhost:8420
4. 开机自启(可选,需本人执行):
   `powershell -NoProfile -ExecutionPolicy Bypass -File D:/agent-watch/install-task.ps1`

## 运行数据(不入库)

egress.csv / baseline.json / run.log / canary-result.txt 由脚本在部署目录
生成,属机器本地数据,不进版本控制。

## 已知边界

- TLS 加密:只知「连了谁」,不知「传了什么」;内容级实锤用金丝雀
- Trae 本地主库加密,「Trae 干净」结构性不可信(标注在检查输出里)
- latin1 字节扫描对压缩存储(Codex .zst)与 UTF-16 存在盲区
