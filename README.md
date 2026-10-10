# Agent Flight Recorder

给 LangGraph 多智能体流程用的黑匣子:录下每次运行,把失败的和成功的并排对比、标出第一处分歧,还能离线重放失败的 run。

> the thing you open when the run fails.

坏了就重跑,重跑就有成功和失败两份记录。这个工具做的事,就是把它们并排放好,告诉你第一处不同在哪。

## 安装

```bash
pip install -e .[demo,dev]     # demo 附带 langgraph;dev 附带 pytest
# 集中存储(可选):
pip install -e .[mysql]        # MySQL(PyMySQL)
pip install -e .[dm]           # 达梦 DM8(dmPython;建议从达梦安装介质 drivers/python 装)
```

## 用法

### 1. 录制

唯一的 API 改动:

```python
from afr import run
result = run(graph, inputs)    # 代替 graph.invoke(inputs)
```

没有服务,没有守护进程。数据默认落在 `~/.afr/runs.db`(SQLite 单文件,WAL)。

要接团队共享的数据库、并且让应用自带监控页,启动时配置一次:

```python
import afr

afr.setup(db_url="mysql://user:pass@host:3306/afr",  # 库不存在会自动创建
          view=True)
result = afr.run(graph, inputs)
# 浏览器打开 http://127.0.0.1:7231,不需要别的命令
```

### 2. 看录制

```bash
rec view                       # http://127.0.0.1:7231,列表 / 瀑布详情 / diff 三页
# diff 页 = /diff?a=失败runID&b=成功runID,自动跳到首个分歧
```

### 3. 重放

```bash
rec replay <run_id> --entry examples.flaky_demo:build
```

- LLM 和工具调用一律从这个 run 自己的录制记录取值,不会拿到别的 run 的响应
- 工具 stub 没命中(说明你改了代码)会先问你:真实执行可能有副作用,默认拒绝
- 改完 prompt 重放,只有改动过的链路产生真实调用,其余全走缓存
- 每次重放会打印命中率。什么都没改却大量未命中,说明代码里有隐藏的非确定性(时间戳、random 之类)

试跑 demo(researcher → writer → critic,搜索工具随机返回垃圾):

```bash
python examples/flaky_demo.py
```

## 存储后端

默认 SQLite 单文件(`~/.afr/runs.db`)。团队/正式环境换 MySQL 或达梦,给一条连接串就行,表和索引首次连接时自动建:

```
sqlite:///C:/data/runs.db                  # SQLite 文件
mysql://user:pass@host:3306/afr            # MySQL
dm://SYSDBA:pass@host:5236?schema=AFR      # 达梦 DM8(schema 指定模式名)
```

配置按优先级取:`run(graph, inputs, db_url=...)` > `afr.setup(db_url=...)` > 环境变量 `AFR_DB_URL` > `~/.afr/config.json` 里的 `{"db_url": ...}`。什么都不配就是默认 sqlite。

CLI 也认这些:`rec --db mysql://… view`,或者裸路径 `rec --db D:/x.db view`(按 SQLite 处理)。

MySQL 的库也是自动建的:连接时报 1049(库不存在)会自动 `CREATE DATABASE ... DEFAULT CHARACTER SET utf8mb4`,需要账号有 CREATE 权限,多进程同时首次连接也安全。

监控页两种开法:`afr.setup(view=True)` 内嵌在应用里(`view_port=` 换端口,端口被占就跳过,不影响录制),或者 `rec view` 单独起一个。

达梦的两个前置条件(和 Java 项目同一套路线):

1. 服务端开 MySQL 兼容模式(`dm.ini` 设 `COMPATIBLE_MODE=4`,DBA 改完重启)
2. dmPython 建议从达梦安装介质 `drivers/python` 装,PyPI 上的 `dmpython` 是非官方轮子

MySQL 建库请用默认的不区分大小写 collation(比如 `utf8mb4_0900_ai_ci`);用 `*_bin` 的话查看器搜索会区分大小写。

集成测试:`examples/docker-compose.yml` 起本地 MySQL 8 跑 `afr/tests/test_backends_mysql.py`(CI 里已经在跑);达梦设 `AFR_TEST_DM_URL` 跑 `test_backends_dm.py`,连真实实例。

## 断网缓冲

配置的数据库连不上时(网络抖动、实例重启,哪怕执行到一半断开),录制自动转存本地 `~/.afr/buffer.db`,业务流程不受影响。后台线程每 3 秒探测,库一恢复就把缓冲里的 run 整体写回再清空。

写回是幂等的:崩溃重试、多个进程同时回灌、主库其实已收到但确认丢了,这些情况靠数据表的 (run_id, seq) 唯一索引兜底,不会出现重复行。进程退出时没来得及写回的,下次录制开始时自动补灌。

## 隐私

录制是明文全量的:每条 prompt、模型回复、工具出入参、节点状态都原样入库,diff 和重放依赖这一点。别把含敏感用户数据的流程录进你不完全控制的库。

## 设计边界

简洁是第一约束,下面的能力有意不做:

- 鉴权、多租户。安全模型就是查看器只绑 127.0.0.1,数据属于本机和可信团队
- 告警推送。这是排障工具,不是值守监控
- 查询 API。sqlite 单文件直接查就是 API
- 采样、TTL、保留策略。本机场景,删库文件重建就是保留策略
- metadata、tags。label 一个字段够用
- 脱敏钩子(将来真要做,也只会是一个可选的 redact= 参数)

另外:重放靠进程级补丁拦截 LLM/工具调用,`rec replay` 是独立进程,没问题;但不要在正在服务流量的进程里并发调 `replay()`。

## 已知限制(v0)

- run-diff 只支持拓扑一致的 run 对;分支、并行、循环差异会显示「不可对齐」
- 非确定性必须全部经由 LLM/工具调用进入;节点内直接用 random 或当前时间的代码 stub 不掉,表现为全链路未命中
- 确定性重放只覆盖 langchain-core 的 BaseChatModel.invoke 和 BaseTool.invoke

## 设计与评审

设计文档和工程评审记录在 `~/.gstack/projects/mionter/31838-unknown-design-20260925-161712.md`。

## License

MIT
