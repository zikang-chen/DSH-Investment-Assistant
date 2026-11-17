# 官方政策页面采集与历史回溯（policy_collect_official）

## 为什么需要它
内置来源（统计局 RSS、部分部委页）只给“最新几条”，所以政策库看起来只有最近一个月。
白皮书、人民银行统计表等往往以 **HTML 列表页 + PDF/XLSX 附件** 存在，没有公开 API。
本功能把「一个官方页面」变成可程序化采集的入口，并支持沿「下一页」回溯过往文件。

## 用法（对话里）
- 采集一页最新：
  `policy_collect_official(url="https://www.pbc.gov.cn/diaochatongjisi/116219/116319/index.html")`
- 回溯历史（2024 年起，最多翻 10 页）：
  `policy_collect_official(url="...", from="2024-01-01", maxPages=10, maxDocs=50)`
- 只要附件（白皮书 PDF / 统计表 XLSX）：
  `policy_collect_official(url="...", includeAttachments=true, maxAttachments=20)`
- 面板：政策页 →「采集官方页面 / 历史回溯」填 URL、起始日期、页数 →「采集 / 回溯」；
  「检查最新更新」= 对所有已启用来源跑一次 `policy_collect`。

## 行为与边界
| 项 | 说明 |
| --- | --- |
| 翻页 | 识别「下一页/下页/Next」链接，最多 30 页 |
| 正文入库 | 每篇经 `collectOne`：保存原文快照、哈希去重、结构化、镜像到资料库 |
| 附件 | PDF/XLS/XLSX/CSV/DOC/ZIP；CSV 计行数、XLSX/XLS 用本地 pandas 计行数 |
| 日期区间 | `from/to` 过滤；**无日期的条目不会被静默丢弃**（保留以免漏掉历史文件） |
| 合规 | 仅允许清单主机 + robots.txt；不绕过登录/验证码/反爬 |
| 需登录站点 | 用 `policy_import` 粘贴正文或上传文件，明确拒绝自动抓取 |

## 本机实测（2026-11-17）
- `https://www.pbc.gov.cn/diaochatongjisi/116219/116319/index.html`：跟随 302 后返回 **200 / 89KB**，
  页面含 46 个文章链接；列表页本身不直接暴露 xls，需进入文章页取附件 —— 正是本工具的两级抓取场景。
- 国务院政策文件库 JSON 接口 `sousuo.www.gov.cn/search-gov/data`：返回 **200 + JSON**，但当前参数下
  `totalCount=0`（未确认可用的检索参数），因此**不依赖它**做历史检索；改为“给列表页 URL + 翻页”的方式，
  这条路径是可验证的。

## 已知缺口
- 部分部委列表页由 JS 渲染，静态抓取只能拿到骨架；这类页面请提供具体文章 URL 或改用 `policy_import`。
- 附件中 XLSX 目前只统计行数并保存原文件，尚未把每个单元格结构化进政策正文（待补）。
