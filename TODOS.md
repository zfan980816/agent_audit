# TODOS

## 状态快照大小上限（可选）
- **What**: 为每节点状态快照加可选大小上限（如 256KB/节点，超限截断 + STALE 标记）
- **Why**: 长流程/大状态下 SQLite 库体积增长快
- **Pros**: 库体积可控、viewer 渲染稳定
- **Cons**: 截断的快照在 diff 时信息不全（靠 STALE 标记暴露）
- **Context**: 2026-09-25 工程评审 D8 裁决为延迟决策；v0 保持全量快照语义（设计 Constraints 已批准）。触发条件：单库 > 100MB 或 viewer 明显卡顿。届时在 capture.py 序列化处加 cap 参数即可
- **Depends on / blocked by**: 无
