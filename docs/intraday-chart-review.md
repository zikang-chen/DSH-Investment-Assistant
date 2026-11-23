# 分时图修订记录

2026-11-23。此次只调整当前插件，不引入新的图表运行时依赖。

## 参考的实现

- [TradingView Lightweight Charts：WhitespaceData](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/WhitespaceData)：时间点可以没有价格；未交易区间应保留空间，不靠重复前值来填满。
- [TradingView：价格与量图的十字光标联动](https://tradingview.github.io/lightweight-charts/examples/crosshair/sync-crosshairs)：同一个时间坐标对应价格、量与读数，面板宽度跟随容器。
- [Apache ECharts：K线与成交量示例](https://echarts.apache.org/examples/en/editor.html?c=candlestick-brush)：K线和成交量分面共享时间轴；分时折线不是分钟蜡烛图。

参考的是数据与交互方式，没有把示例行情导入本项目，也没有声称完成了这些产品的全功能复刻。

## 本次修复

| 原问题 | 处理 |
| --- | --- |
| 半天数据按点数铺满全天 | 用交易时段映射位置，剩余时段留白 |
| 过滤 null 后跨缺失点连线 | 价格和均价分别断线，跨日分隔 |
| 恒定序列贴在纵轴顶端 | 昨收基准上下对称、最小范围与留白 |
| 手机窄面板文字被一起缩小 | 以容器实际宽度布局 |
| 画法与日线不一致（自绘 SVG、色板不同） | 改为与日线同一套 canvas 画法：同色板、同右侧价格轴、同十字光标与价签、同量仓透明度 |
| 只有线，没有分钟读数 | 十字光标 + 白底浮层（时间/价格/均价/分钟量）+ 键盘 ←→/Home/End/Esc |
| 切标的时旧请求可能覆盖新图 | 独立分时视图，身份key、取消和卸载守卫 |
| 日K没缓存就看不了分时 | 模式选择移到公共工具栏，分时独立加载 |
| 请求拿到响应头后超时失效 | 计时器覆盖JSON/text完整读取 |
| 新浪把伦铜当COMEX铜 | 移除错误映射 |
| 无日期分时被标成今天 | 日期缺失直接拒绝 |

## 验证范围

纯计算、字段解析、取消、超时、备用源及接线由离线测试验证。组件另用无头 Chrome 渲染固定示例数据（`tools/demo/render-intraday.mjs`，产物只写 `tools/demo/.out/`，不入库、不读持仓）核对：半天留白、缺口断线、午休折叠、美股跨午夜、多日分隔、窄面板换行与十字光标浮层。

当前连接的宿主页面尚无可用浏览器控制，因此不把这些渲染当作"面板里已经跑过"；宿主需要重载插件后才会用到新代码。上游可用性为采样结果，不是持续服务保证。
