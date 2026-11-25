# 国家资本公开披露监测

现有「机构追踪」新增国家资本区，不是实时买卖雷达，也不是全量账户或交易建议。

## 主体与来源

分别登记 `huijin`（中央汇金投资有限责任公司）、`huijin-asset`（中央汇金资产管理有限责任公司）、`csf`（中国证券金融股份有限公司）。名称精确匹配，不把包含“汇金”的基金产品或其他国资主体合并进来。

- **汇金官网模式**：`huijin` 不设股票池，读取官方[总体情况](https://www.huijin-inv.cn/huijin-inv/Investments/Overview.shtml)和[持股详情](https://www.huijin-inv.cn/huijin-inv/Investments/Shareholding.shtml)。直接、间接机构和全资子公司注分开；这是机构股权，不是全部二级市场证券持仓。总体页期别不借给未标期别的详情页，注册资本不当成实缴出资或市值。
- **股票观察池模式**：任一主体明确设置1—5只A股股票，读取东方财富 `RPT_F10_EH_HOLDERS` 最新返回十大股东，匹配法定户名。标为 `aggregated`，不是已核官方公告；源无公告日就留未知。有限池不读取用户持仓、不自动扩围或翻历史分页。
- **未覆盖**：ETF具名持有人报告、场外账户、所有国家资本平台与实时交易。ETF份额、成交和机构比例不能用于识别国家队身份。未见名单不等于零持仓。

每条记录保留原文单位和换算数量、比例分母、持有方式、各自报告期、披露日期、抓取时间、URL、内容SHA-256与行定位。来源版本、旧范围快照保留。缺值不补0，来源失败不替换旧基线。

## Agent与面板使用同一条链路

先 `follow_list` 查重和主体目录。示例：

```json
{"kind":"cn-state","stateEntityId":"huijin","name":"中央汇金投资有限责任公司","autoCheck":false}
```

对具名股票披露：

```json
{"kind":"cn-state","stateEntityId":"csf","name":"中国证券金融股份有限公司","stateCodes":["601288","601398"],"autoCheck":false}
```

以上作为 `follow_add` 参数；再依次 `follow_fetch(id)` → `follow_diff(id)` → `follow_note(id,title,points)`。面板的「添加并检查」「检查披露」向当前会话投递相同流程，不在浏览器另写一套金融操作。

改变范围用 `follow_state_configure`；旧快照不删，范围变化不直接比较。首次观察、前后期未具名披露、同一期修订、单位/直接间接口径不同、未知期间均单独标记。可比时只说“期末数量增加/减少”，不推断交易时间、现金买入额、成本或政策保底。

`newObservation` 表示本系统首次观察此版本；披露日期未知时不能称为新发布的文件。没有完整国家资本组合，不能用 `follow_replicate` 或把有限名单的缺项当零做持仓重叠。

## 运行预算与后台权限

新增对象默认手动；没有新建计划任务。仅在用户明确要求后，用 `follow_state_configure(autoCheck:true)` 复用既有6小时检查。

每次最多2个官网页面，或最多5只明确股票、每票1请求；单请求12秒、整轮45秒、每响应不超过1MB，不重试、不跟重定向、不扫描全市场。

## 验证

```bash
npm run test:state-capital
node node_modules/tsx/dist/cli.mjs scripts/test_state_capital_sources.ts --live
```

第一项为离线内核、来源契约、持久化/Agent工具与组件测试；第二项显式联网核查少量真实来源，不是所有国家资本账户或浏览器端到端验收。实时价格、原始政策表态与具名持仓分层呈现，不能互相替代。
