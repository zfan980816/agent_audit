# Agent Flight Recorder

多智能体流程的「黑匣子 + 调试器」：录制 LangGraph 流程的每次运行，
对比失败 run 与成功 run 并自动定位**首个分歧**，离线确定性重放失败 run。

> 定位语：**the thing you open when the run fails.**
> 你「坏了就重跑」的习惯天然产生 失败 run + 成功 run 配对——本工具只负责把它们
> 并排放好，指出第一处不同。

## 安装

```bash
pip install -e .[demo,dev]     # demo 附带 langgraph；dev 附带 pytest
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
