# README 演示图怎么来的

这些图不是设计稿，也不是实机持仓截图：用无头 Chrome 渲染**插件真实组件**，数据是下面的示例。

## 生成方式

```bash
npm install --prefix tools/demo/.deps react-dom@19.3.1   # 只给渲染用，不进主依赖
npm run docs:images
```

- `tools/demo/entry.tsx`：挂载 `OverviewWorkbench` / `PortfolioStrategy` 等真实组件，`get/post` 换成固定 fixture，不发请求、不读持仓。
- `tools/demo/render.mjs`：esbuild 打包 → 启动无头 Chrome → 通过 CDP 按真实面板宽度（520 / 960 / 390）截图。
- `tools/demo/record.mjs` + `tools/demo/gif.mjs`：脚本化滚动与切换 Tab，逐帧截图后用一个自写的 GIF 编码器（PNG 解码 + 固定调色板 + LZW）拼成 `docs/images/demo.gif`。

## 产物

| 文件 | 用途 |
| --- | --- |
| `docs/images/demo.gif` | README 首屏演示：总览 → 投资判断 → 组合策略 |
| `docs/images/overview-light.png` | 总览，面板默认 520px 宽 |
| `docs/images/advice-light.png` | 投资判断详情（证据／反证／失效条件） |
| `docs/images/overview-dark.png` | 深色主题 |
| `docs/images/overview-wide.png` | 展开态 960px |
| `docs/images/overview-mobile.png` | 390px 窄屏 |
| `docs/images/portfolio-light.png` | 组合策略，含示例权重 |

## 为什么标「示例数据」

截图里出现的账户、权重、政策标题都是 fixture。真机截图会带出本机持仓、账户和对话记录，不能进公开仓库。任何引用这些图的文案都必须写明是示例数据。

重新生成前请确认 fixture 里没有真实标的数量、成本或私人观点。
