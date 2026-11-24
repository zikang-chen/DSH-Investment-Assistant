# Agent 分时工具目录与调用契约

## 工具目录

| 工具 | 用途与边界 |
| --- | --- |
| `get_intraday_data` | 统一股票/指数/全球品种分钟分时；沿用 `finance.getIntraday` 的已配置公开源、缓存、回落与取消机制；提供明确的总数、截断和分页。 |
| `get_minute_data` | 原 WeStock `minute` 兼容入口，不具备本页统一分页契约；新增分时研究优先用 `get_intraday_data`。 |
| `search_symbol` | 需要确认全球品种真实市场/代码时先解析，再把返回的 `secid` 传给统一分时工具。 |
| `probe_finance_sources` | 公开行情源失败时的健康检查；有响应不代表全部市场/全部分钟一定可取。 |

不读取真实持仓、私人文件或登录凭证；不使用登录/验证码爬取，不自动交易，不写账本或历史库。源不支持、覆盖不足或失败时明确返回，不能用单个日终报价伪装成分时。

## 参数

- `code?: string`：如 `600519`、`00700`、`NVDA`。与 `secid` 至少传一个。
- `kind?: 'a' | 'hk' | 'us' | 'global'`：默认 `a`。指数/商品等全球品种用 `global`。
- `secid?: string`：如 `100.SPX`、`101.GC00Y`、`105.NVDA`、`106.BRK.B`。优先于 `code`，服务负责实际身份解析；可省略 `code`，此时传给服务的代码是空串，由 `secid` 解析。不得从代码猜另一市场来替代显式 `secid`。
- `days?: number`：严格只接受数字 **1 或 5**，默认 1；不是任意 1–5，不接受字符串、不四舍五入。5 日源失败不能悄悄当作 1 日完整结果。
- `limit?: number`：严格为 **1–1000** 整数，默认 **240**；超界/小数/非数字会失败，不隐式夹取。
- `offset?: number`：非负安全整数，是**全量按时间升序**后的零基位置。省略时取**最近 `limit` 条**；显式 `0` 从最早点开始。不是倒序偏移，也不是上次页面内偏移。

```json
{ "code": "600519", "kind": "a" }
```

```json
{ "code": "00700", "kind": "hk", "days": 5, "offset": 0, "limit": 240 }
```

```json
{ "kind": "global", "secid": "100.SPX", "days": 1 }
```

```json
{ "kind": "global", "secid": "101.GC00Y", "days": 5, "offset": 0, "limit": 1000 }
```

```json
{ "kind": "us", "secid": "105.NVDA", "offset": 0, "limit": 240 }
```

例子只说明参数，不声称这些品种当前源一定可用或有完整 5 日数据。

## 成功结果：事实、时间与单位

工具准确解包 `ProviderCallResult<IntradaySeries>.data`，不把 provider 包装层误当序列，不重复输出完整原始数据。

- `provider` 是实际 provider 标识，`source` 是序列的源标识；`code/kind/secid/days` 优先采用服务返回的实际身份与覆盖天数。`requestedDays` 独立保留原请求，不能将不等的天数称为请求已满足。
- 顶层 `at` 是**抓取时刻**，不可代替行情日期。`firstDataTime/lastDataTime` 与 `firstDataAt/lastDataAt` 是本次源返回的**全序列**首末行情时刻；`returnedFirstTime/returnedLastTime` 是**当前页**首末时刻。
- `timezone.time` 只采用源确认的 `Asia/Shanghai` 或 `unknown`。没有元数据的旧序列仍为 `unknown`，不根据品种或抓取时间猜时区。`time` 保留源原文；有核验的 `point.at` 才是对应 ISO 时刻。全球源时区未知时 `point.at=null`，只按已观测的日期/时间标签排序，不换算时区、不推断完整交易时段。
- `points` 每行只包含 `time/at/price/avgPrice/volume/amount`；升序返回。缺失/非有限数值保持 `null`，真实 `0` 保留。工具不插值、不聚合、不补交易分钟，也不自行计算均价。
- `preClose` 为源昨收，未知为 `null`。`units.volume` 为源声明的 `shares/lots/source`，`units.amount` 为 `CNY/HKD/source`，缺元数据默认 `source`（未核实）。不默认把量当股数、额当人民币；价格/均价的币种或指数点值以品种为准，未声明的不猜。
- `warnings` 保留源告警（最多 20 条、每条最多 1000 字符，条数或文本截断由 `warningsTruncated` 显式标记）。`missingFields` 报告当前页 `at/price/avgPrice/volume/amount` 的缺失数以及昨收是否缺失，不将省略的历史算为缺失值。

## 有界分页

- `count`：本次**源返回的完整点数**；不是当前页条数，也不是请求交易日理论应有的分钟数。
- `returnedCount`：当前 `points.length`。`offset/limit` 为实际选择范围/本页上限；`order='ascending'`，`selection='latest' | 'offset'`。
- `truncated`：当前页没有包含该源序列全部点时为 `true`。仅是工具分页截断，**不代表源上游是否完整**；上游原本少数据时 `truncated=false` 也不等于完整交易日。
- `omittedBefore/omittedAfter`：本页前/后省略的点数。始终有 `omittedBefore + returnedCount + omittedAfter = count`。
- `nextOffset`：本页以后还有点时，下一次正向请求的 `offset`；否则为 `null`。
- `previousOffset`：有更早数据时的前一页起点，否则为 `null`。
- `followUp`：截断时给出可执行工具名与完整参数。默认尾页即使 `nextOffset=null` 仍可能 `truncated=true`，此时 `followUp.args.offset=0` 提示从头补查，不能把尾页误称全量。

例如源本次返回 532 点，默认最近 240 条：实际 `offset=292`，`count=532`，`returnedCount=240`，`truncated=true`，`omittedBefore=292`，`nextOffset=null`。若需全量，改为 `offset=0, limit=240`，然后按返回的 `nextOffset=240`、`480` 继续，最后为 `null`。原始数据始终升序；不会因为翻页反转。

`offset` 等于或超过 `count` 时返回成功的空页（`returnedCount=0`、首末当前页时刻为 `null`），但保留非零的源 `count`、全序列首末时刻和向前补查参数；不是伪造源空序列。每次调用可能重新取源数据/使用服务缓存，**不是固定快照游标**；盘中有新点或窗口滚动时先核对首末时间与总数，需要严格重现时由调用方保留同次结果。

## 失败与取消

- 参数非法：DSH schema 的类型/枚举错误可在执行前抛 `ToolArgsError (INVALID_ARGS)`；工具的跨字段/范围校验返回 `ok=false, errorType='invalid_arguments'`。两者都不调用数据服务。
- Provider 失败：`ok=false`，保留 `provider/error/attempts`，未知 `count=null`，不返回伪造的 `points=[]` 或行情首末时间。尝试记录最多 8 条，额外记录由 `attemptsTruncated` 标记。
- 成功包装层缺 `data.points`、身份/来源缺失、无法排序的时间：明确失败，不静默丢点或将包装层当作空成功。
- 源明确返回空序列：明确失败，已知 `count=0`；不能确认行情覆盖。
- `AbortSignal` 原样传递；请求前/请求中取消保持取消异常，不转为普通行情不可用。

## 集成与离线验证

注册链：`registerTools` → `registerIntradayTools` → `finance.getIntraday(code, kind, days, signal, secid)`。纯展示模块只负责校验、排序、空值和分页，不引入第二条 HTTP 路径，不修改数据服务/路由/UI。

在项目根目录运行（Node.js + 现有本地依赖，不联网安装）：

```powershell
node node_modules/tsx/dist/cli.mjs scripts/test_intraday_tool.ts
node node_modules/tsx/dist/cli.mjs scripts/test_dossier_tool_data.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

新增测试使用合成分钟夹具和内存服务，禁用网络；覆盖主注册入口、五参透传、全球 secid 解析契约、已知/未知时区、单位/空值/真实零、默认尾页/正向翻页/越界、1000 点上限、严格参数、失败与取消。离线通过不能宣称已验证实时端点/真实市场覆盖。
