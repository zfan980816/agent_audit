# Agent Flight Recorder

多智能体流程的「黑匣子 + 调试器」：录制 LangGraph 流程的每次运行，
对比失败 run 与成功 run 并自动定位**首个分歧**，离线确定性重放失败 run。

> 定位语：**the thing you open when the run fails.**
> 你「坏了就重跑」的习惯天然产生 失败 run + 成功 run 配对——本工具只负责把它们
> 并排放好，指出第一处不同。

## 安装

```bash
pip install -e .[demo,dev]     # demo 附带 langgraph；dev 附带 pytest
# 集中存储后端（可选）：
pip install -e .[mysql]        # MySQL（PyMySQL）
pip install -e .[dm]           # 达梦 DM8（dmPython；优先从达梦安装介质 drivers/python 安装）
```

## 三个动作

### 1. 录制（唯一的 API 改动）

```python
from afr import run
result = run(graph, inputs)    # 代替 graph.invoke(inputs)
```

捕获端无服务、无守护进程、无账号。数据落在 `~/.afr/runs.db`（SQLite 单文件，WAL）。

### 2. 查看与 diff

```bash
rec view                       # http://127.0.0.1:7231 三页：列表/瀑布详情/双run diff
# diff 页 = /diff?a=失败runID&b=成功runID（自动跳首个分歧）
```

### 3. 确定性重放

```bash
rec replay <run_id> --entry examples.flaky_demo:build
```

- LLM 调用与工具调用一律从**被重放 run 自身**的捕获记录取值（run 作用域——
  绝不会拿到另一次 run 的响应）
- 工具 stub 未命中（你改了代码，参数变了）→ **交互征询**：真实执行可能有副作用，
  默认拒绝
- 改了坏 prompt 后重放：只有变更链路产生真实调用，其余全走缓存
- 每次重放结束输出**命中率 + 未命中清单**遥测——若你什么都没改却大量未命中，
  说明代码里有隐藏非确定性（时间戳 / random）

试跑 demo（researcher → writer → critic，搜索工具随机返回垃圾）：

```bash
python examples/flaky_demo.py
```

## 存储后端（SQLite / MySQL / 达梦 DM8）

默认仍是 SQLite 单文件（`~/.afr/runs.db`），**正式/团队环境可切换集中数据库**。
你只需要提供连接信息——表和索引在首次连接时自动创建，无需手工执行任何 DDL。

连接串的写法：

```
sqlite:///C:/data/runs.db                  # SQLite 文件
mysql://user:pass@host:3306/afr            # MySQL
dm://SYSDBA:pass@host:5236?schema=AFR      # 达梦 DM8（schema 指定模式名）
```

三种配置方式（优先级从高到低）：

| 方式 | 用法 |
|---|---|
| 代码参数 | `run(graph, inputs, db_url="mysql://…")`、`replay(..., db_url=…)` |
| 环境变量 | `export AFR_DB_URL='mysql://…'` |
| 配置文件 | `~/.afr/config.json` 写 `{"db_url": "mysql://…"}` |

CLI 同样兼容：`rec --db mysql://… view`，或裸路径 `rec --db D:/x.db view`
（自动按 SQLite 处理）。什么都不配时行为与旧版完全一致。

达梦前置条件（与 Java 项目同一套路线）：

1. DM 服务端开 **MySQL 兼容模式**（`dm.ini` 设 `COMPATIBLE_MODE=4`，DBA 重启）
2. Python 侧安装 dmPython：优先从**达梦安装介质** `drivers/python` 安装
   （PyPI 上的 `dmpython` 为非官方轮子）；驱动缺失时会给出明确提示

注意事项：

- MySQL 建库请用默认的不区分大小写 collation（如 `utf8mb4_0900_ai_ci`）；
  若用 `*_bin`，查看器的搜索框会区分大小写
- 集成验证：`examples/docker-compose.yml` 一键起本地 MySQL 8 跑
  `afr/tests/test_backends_mysql.py`；达梦用 `AFR_TEST_DM_URL` 跑
  `test_backends_dm.py`（连真实实例）

### 断网缓冲（自动，无需配置）

正式部署接入后**持续监控、数据只增不删**。若配置的数据库不可达（网络抖动、
实例重启、哪怕执行到一半断开），录制自动转存本地缓冲
`~/.afr/buffer.db`（SQLite），业务流程完全不受影响；后台线程每 3 秒探测，
数据库一恢复**立即整 run 回灌并清空缓冲**——不丢一条事件、不产生重复行。
进程退出时未及回灌的数据，会在下次任何一次录制开始时自动补灌。


## 已知限制（v0）

- run-diff 仅支持**拓扑一致**的 run 对；分支/并行/循环差异显示「不可对齐」
- 确定性边界：非确定性必须全部经由 LLM/工具调用进入；节点内直接引用
  `random`/当前时间的用户代码无法被 stub，会表现为全链路未命中
- 确定性重放仅覆盖 langchain-core 的 `BaseChatModel.invoke` 与 `BaseTool.invoke`
  路径

## 设计与评审

设计文档 + 工程评审（3 轮对抗评审、9 项决策台账、任务清单 T0-T7）见
`~/.gstack/projects/mionter/31838-unknown-design-20260925-161712.md`。

## License

MIT
