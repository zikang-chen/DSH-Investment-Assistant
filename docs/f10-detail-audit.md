# 证券详情 F10 实测与修复（2026-11-17）

## 根因

PageAjax接口需要code=SH601988，旧请求使用SECUCODE=601988.SH，未取得预期公司字段。与datacenter接口不同，不能共用参数约定。UI展开嵌套对象不能修好上游空数据。

## 实测结果

2026-11-17T15:00Z，对601988执行公开HTTP小查询并经当前normalize函数处理，未保存原始响应到仓库：

| 模块 | 实际结构/归一化结果 | 仍缺 |
|---|---|---|
| CompanySurvey | jbzl+fxxg；名称中国银行；8个业务字段 | mainBusiness未返回，不用经营范围冒充 |
| BusinessAnalysis | zygcfx 200行，收入/成本/利润/比例/报告期 | 不声明覆盖全部历史 |
| CoreConception | ssbk+hxtc，44行 | 板块标签非收入贡献 |
| ShareholderResearch | gdrs 10行，最新统计期2026-09-30 | 公告日缺失，不能用报告期做已知信息回测 |
| IndustryAnalysis | gzbj 8行；身份取CORRE_SECURITY_CODE | 可比口径仍按源解释 |
| 主要财务 | datacenter success=true，2行探测 | 字段逐项映射，不用现金流替代净资产 |

这仅是601988单标的当次验证，不代表所有证券、所有时期、持续可用性。通用meta.contractVerified仍保持false，不批量改为已核验。

## 修复

- PageAjax改传code=市场前缀+数字代码；datacenter仍保留SECUCODE过滤。
- 解析只选择业务对应表，不递归把十大股东、基金、同行等不相关表混入。
- 公司资料空壳、空财务/同行表明确失败；只有meta不算有效业务数据。
- 财务真实字段TOTALOPERATEREVE/PARENTNETPROFIT加入映射；BPS不再回退经营现金流MGJYXJJE。
- 同行身份优先CORRE字段，避免多行都显示被研究公司。
- 页面空/失败维度显示缺失说明，不展开大量meta冒充公司详情。

## 排障

更新后执行build并重载插件服务端，档案点击刷新。旧Provider缓存可能保留到TTL到期；页面刷新不等于服务端重载。上游缺失mainBusiness或公告日仍应如实显示，不填示例或猜测值。

## 可复现验证

- `npm run test:security`：含8组F10真实结构的合成离线fixture、概况展示与图表路由测试。
- `npx tsx scripts/probe_f10_normalized.ts`：手动在线小查询，只输出字段/数量/缺失，不存原始金融数据。
- `node scripts/probe_f10_details.mjs`：手动结构探针，不自动批量运行。

构建、档案/导航相关测试和8类金融回归通过。真实浏览器视觉点击验收未执行。
