import { PersonalStore } from './personal.js'
import { registerPersonalTools } from './personal-tools.js'
import { GrowthStore } from './growth-store.js'
import { registerGrowthTools } from './tools/growth-tools.js'
import { FollowStore } from './follow-store.js'
import { registerFollowTools } from './tools/follow-tools.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { AnalysisStore } from './analysis-store.js'
import { StrategyLibrary } from './strategy/library.js'
import '@deepseek-ai/dsh-settings'
import '@deepseek-ai/dsh-system-prompt'
import '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-web'
import '@deepseek-ai/dsh-host-webserver'
import { Config, name as pluginName } from './config.js'
import { ProviderRegistry } from './data/registry.js'
import { FinanceDataService } from './data/service.js'
import { configureWestock } from './data/westock.js'
import { createLogger, type Logger } from './log.js'
import { PanelBus } from './panel-bus.js'
import { PortfolioStore } from './store.js'
import { registerTools } from './tools/register.js'
import { registerWestockTools } from './tools/westock.js'
import { registerSkills } from './skills.js'
import { registerRoutes } from './server-routes.js'
import { registerMcpSources } from './mcp/manager.js'
import { HistoryStore } from './history/store.js'
import { registerHistoryTools } from './history/tools.js'
import { WESTOCK_SPECS } from './data/westock-capabilities.js'
import { KIND_LABEL, ORIGIN_LABEL, ResearchVault, type ResearchKind } from './research/store.js'
import { registerResearchTools } from './research/tools.js'
import { createWebSearchProvider } from './web-search.js'
import { ReminderStore, scanReminders, type ReminderOptions } from './reminders.js'
import { registerReminderTools } from './reminders-tools.js'
import { PolicyStore } from './policy/store.js'
import { PolicyThesisStore } from './policy/thesis.js'
import { ExecutionStore } from './policy/execution.js'
import { registerPolicyTools } from './policy/tools.js'
import { DEFAULT_POLICY_SOURCES, decisionHosts, mergeSources } from './policy/sources.js'
import { runPolicyTick } from './policy/scheduler.js'
import { EvidenceRepository } from './evidence/repository.js'
import { EvidenceWorkflow } from './evidence/workflow.js'
import { registerEvidenceTools } from './evidence/tools.js'
import { CapitalStore } from './capital/ledger.js'
import { registerCapitalTools } from './capital/tools.js'
import { WealthPlanStore } from './wealth/plans.js'
import { registerWealthTools } from './wealth/tools.js'
import { AdviceStore } from './invest/store.js'
import { registerInvestmentTools } from './invest/tools.js'
import { LearningStore } from './learn/explain.js'
import { registerLearnTools } from './learn/tools.js'

export const name = pluginName
export const inject = ['tools', 'systemPrompt', 'web', 'webServer', 'agents', 'skills']

export { Config }

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** State file inside `dataDir`: empty value → `<dataDir>/<fallback>`, absolute as is, relative against the package root. */
function stateFile(dataDir: string, value: string, fallback: string): string {
  if (value === '') return path.join(dataDir, fallback)
  return path.isAbsolute(value) ? value : path.join(packageRoot, value)
}

/**
 * The profile entry owns this plugin's config: the Settings surface renders the
 * `Config` schema and a write re-applies the entry with the new values, so every
 * apply call reads its own `config` directly (no plugin-local settings section).
 */
export function apply(ctx: Context, config: Config) {
  const dataDir = path.isAbsolute(config.dataDir) ? config.dataDir : path.join(packageRoot, config.dataDir)

  // 1) Logging first: every later failure (state load, provider call, route
  //    error, tool rejection) must leave a record instead of vanishing.
  const logger = createLogger({
    dataDir,
    level: (config.logLevel ?? 'info') as Logger['currentLevel'],
    mirror: (entry) => {
      const host = (ctx as { logger?: { warn?: (s: string) => void; error?: (s: string) => void } }).logger
      if (entry.level === 'error') host?.error?.(`${entry.scope}: ${entry.msg}`)
      else if (entry.level === 'warn') host?.warn?.(`${entry.scope}: ${entry.msg}`)
    },
  })
  logger.info('plugin apply', { dataDir, logLevel: config.logLevel, node: process.version })

  // WeStock CLI settings (profile layer): disabled sources fail fast and the
  // registry falls through to the HTTP providers.
  configureWestock({
    enabled: config.westock?.enabled !== false,
    binPath: config.westock?.binPath ?? '',
    timeoutMs: config.westock?.timeoutMs ?? 20_000,
    autoUpgrade: config.westock?.autoUpgrade === true,
  }, logger)

  const registry = new ProviderRegistry({
    cacheTtlSec: config.cacheTtlSec,
    requestGapMs: config.requestGapMs,
    httpTimeoutMs: config.httpTimeoutMs,
    probeReportPath: stateFile(dataDir, config.probeReportPath, 'probe-report.json'),
    packageRoot,
    dataDir,
    logger,
    // WeStock 是本地 CLI：并行调用（而非串行间隔），并把 ws_* 提到每个能力的最前。
    westockConcurrency: config.westock?.concurrency ?? 6,
    preferWestock: config.preferWestock !== false,
    staleTtlSec: config.staleTtlSec ?? Math.max(config.cacheTtlSec * 10, 120),
  })
  void registry.loadProbeReport()
  void registry.loadPolicy()

  const store = new PortfolioStore(stateFile(dataDir, config.portfolioPath, 'portfolio.json'), logger)
  void store.load().catch((err) => logger.fail('portfolio load failed', err))
  const analyses = new AnalysisStore(path.join(dataDir, 'analysis-cache.json'), logger)
  void analyses.load().catch((err) => logger.fail('analysis cache load failed', err))
  const strategyLibrary = new StrategyLibrary(path.join(dataDir, 'strategy-library.json'))
  void strategyLibrary.load().catch((err) => logger.fail('strategy library load failed', err))

  // Bidirectional channel: store mutations (from tools, routes, or the agent) are
  // pushed to connected panel clients over SSE instead of waiting for the 60s poll.
  const bus = new PanelBus()
  // Agent 活动指示（Agent → 面板）：每个工具调用的开始/结束推给面板，
  // 顶部胶囊显示「Agent 正在做什么」；活动提示永不影响工具本身的结果。
  ctx.on('tools/execute', async (exec, next) => {
    try { bus.publish({ kind: 'agent', phase: 'start', tool: String(exec.name ?? ''), at: new Date().toISOString() }) } catch { /* 提示不阻塞 */ }
    try {
      return await next()
    } finally {
      try { bus.publish({ kind: 'agent', phase: 'done', tool: String(exec.name ?? ''), at: new Date().toISOString() }) } catch { /* 提示不阻塞 */ }
    }
  })
  store.onChange((file) => bus.publish({
    kind: 'portfolio',
    holdings: file.holdings,
    watchlist: file.watchlist,
    portfolioPath: store.path,
  }))
  analyses.onChange((analysis) => bus.publish({
    kind: 'analysis',
    code: analysis.code,
    type: analysis.type,
    generatedAt: analysis.generatedAt,
  }))

  const finance = new FinanceDataService(
    registry,
    () => store.get().holdings,
    async (holdings) => { await store.setHoldings(holdings) },
  )

  // 观点触发式提醒：行情异动 + 资料库观点复核，落盘去重，推送到面板铃铛。
  const reminders = new ReminderStore(path.join(dataDir, 'reminders.json'), logger)
  void reminders.load().catch((err) => logger.fail('reminder store load failed', err))
  const scanRemindersNow = async (options?: ReminderOptions) => {
    const result = await scanReminders(finance, store, vault, reminders, options)
    if (result.added.length) {
      logger.info('reminders triggered', { added: result.added.length })
      bus.publish({ kind: 'reminder', count: result.added.length, at: result.at })
    }
    return result
  }

  const history = new HistoryStore(path.join(dataDir, 'history'), logger)

  // 投研资料库：正文落工作区（Markdown），索引在 <dataDir>/research/index.json。
  const vaultRoot = config.research?.dir
    ? (path.isAbsolute(config.research.dir) ? config.research.dir : path.join(packageRoot, config.research.dir))
    : path.join(dataDir, 'research')
  const vault = new ResearchVault(vaultRoot, logger)
  vault.onChange((items) => logger.debug('vault changed', { items: items.length }))
  // 本地文件 ↔ 面板双向联动：文件落盘后监听目录，外部（编辑器/Agent 文件工具）
  // 增删改 Markdown 都会回灌索引并推送给面板。
  const onVaultFileChange = (r: { added: number; updated: number; missing: number; changed: string[] }) => {
    logger.info('vault file change', { added: r.added, updated: r.updated, missing: r.missing })
    bus.publish({ kind: 'research', action: 'sync', id: r.changed[0] ?? '', origin: 'file' })
  }
  ctx.effect(() => {
    void vault.load()
      .then(async () => { await vault.syncFromDisk(); vault.watch(onVaultFileChange) })
      .catch((err) => logger.fail('research vault load failed', err))
    return () => vault.stopWatching()
  })

  // 面板与路由共享的存储引用（实际实例在下面的启用块里创建）。
  const capitalRef: { current?: CapitalStore } = {}
  const learnRef: { current?: LearningStore } = {}
  const wealthRef: { current?: WealthPlanStore } = {}

  // 个人资本账本：交易/资金流水（append-only）、多币种、确定性收益计算。
  if (config.capital?.enabled !== false) {
    const capitalRoot = config.capital?.dir
      ? (path.isAbsolute(config.capital.dir) ? config.capital.dir : path.join(packageRoot, config.capital.dir))
      : path.join(dataDir, 'capital')
    const capital = new CapitalStore(capitalRoot, logger)
    capitalRef.current = capital
    ctx.effect(() => {
      void capital.load()
        .then(() => logger.info('capital ledger ready', { dir: capitalRoot, accounts: capital.listAccounts().length, events: capital.listEvents({ limit: 5000 }).length }))
        .catch((err) => logger.fail('capital ledger load failed', err))
      return () => {}
    })
    registerCapitalTools(ctx, { store: capital, logger, baseCurrency: config.capital?.baseCurrency ?? 'CNY' })
  }

  // 复利与财富模拟：确定性计算 + 方案保存（数据在 <dataDir>/wealth）。
  if (config.wealth?.enabled !== false) {
    const wealthRoot = config.wealth?.dir
      ? (path.isAbsolute(config.wealth.dir) ? config.wealth.dir : path.join(packageRoot, config.wealth.dir))
      : path.join(dataDir, 'wealth')
    const plans = new WealthPlanStore(wealthRoot, logger)
    wealthRef.current = plans
    ctx.effect(() => {
      void plans.load()
        .then(() => logger.info('wealth plans ready', { dir: wealthRoot, plans: plans.all().length }))
        .catch((err) => logger.fail('wealth plan load failed', err))
      return () => {}
    })
    registerWealthTools(ctx, { plans, logger })
  }



  // 金融学习：本地概念库 + 学习进度（数据在 <dataDir>/learn）。
  if (config.learn?.enabled !== false) {
    const learnRoot = config.learn?.dir
      ? (path.isAbsolute(config.learn.dir) ? config.learn.dir : path.join(packageRoot, config.learn.dir))
      : path.join(dataDir, 'learn')
    const learning = new LearningStore(learnRoot, logger)
    learnRef.current = learning
    ctx.effect(() => {
      void learning.load()
        .then(() => logger.info('learning store ready', { dir: learnRoot, tracked: learning.stats().tracked }))
        .catch((err) => logger.fail('learning store load failed', err))
      return () => {}
    })
    registerLearnTools(ctx, { store: learning, logger })
  }

  ctx.provide('financeData', finance)

  // 证据协作：数据缺失 → 持久化待补请求 → 用户提交 → 校验 → 恢复研究。
  let evidenceBundle: { workflow: EvidenceWorkflow; repo: EvidenceRepository } | undefined
  if (config.evidence?.enabled !== false) {
    const evidenceRoot = config.evidence?.dir
      ? (path.isAbsolute(config.evidence.dir) ? config.evidence.dir : path.join(packageRoot, config.evidence.dir))
      : path.join(dataDir, 'evidence')
    const evidenceRepo = new EvidenceRepository(evidenceRoot, logger)
    const evidence = new EvidenceWorkflow({
      repo: evidenceRepo,
      logger,
      timeoutMs: config.evidence?.timeoutMs ?? 20_000,
      maxBytes: config.evidence?.maxBytes ?? 16_000_000,
      publish: (event) => bus.publish(event),
    })
    evidenceBundle = { workflow: evidence, repo: evidenceRepo }
    ctx.effect(() => {
      void evidenceRepo.load()
        .then(() => {
          logger.info('evidence store ready', { dir: evidenceRoot, ...evidenceRepo.stats() })
        })
        .catch((err) => logger.fail('evidence store load failed', err))
      return () => {}
    })
    registerEvidenceTools(ctx, { repo: evidenceRepo, workflow: evidence, logger })
  }

  // 政策研究：官方政策原文 → 不可变快照 → 哈希去重 → 结构化 → 检索 → 资料库归档。
  // 目录与 allowlist 都来自配置；未启用时不注册任何政策工具。
  let policyStore: PolicyStore | undefined
  if (config.policy?.enabled !== false) {
    const policyRoot = config.policy?.dir
      ? (path.isAbsolute(config.policy.dir) ? config.policy.dir : path.join(packageRoot, config.policy.dir))
      : path.join(dataDir, 'policy')
    const policySources = mergeSources(DEFAULT_POLICY_SOURCES, config.policy?.sources ?? [])
    const policy = new PolicyStore(policyRoot, logger)
    const policyTheses = new PolicyThesisStore(policyRoot, logger)
    const policyExecution = new ExecutionStore(policyRoot, logger)
    policyStore = policy
    ctx.effect(() => {
      void Promise.all([policy.load(), policyTheses.load(), policyExecution.load()])
        .then(() => logger.info('policy store ready', {
          dir: policyRoot,
          docs: policy.stats().total,
          theses: policyTheses.stats().total,
          tracked: policyExecution.all().length,
        }))
        .catch((err) => logger.fail('policy store load failed', err))
      return () => {}
    })
    registerPolicyTools(ctx, {
      store: policy,
      hosts: decisionHosts(policySources),
      timeoutMs: config.policy?.timeoutMs ?? 30_000,
      maxBytes: config.policy?.maxBytes ?? 8_000_000,
      logger,
      bus,
      vault,
      mirrorToVault: config.policy?.autoCollect?.mirrorToVault !== false,
      finance,
      portfolio: store,
      theses: policyTheses,
      execution: policyExecution,
    })
    // 后台自动采集：只在启用时挂定时器；失败只记录，不影响插件其余能力。
    if (config.policy?.autoCollect?.enabled !== false) {
      const hours = Math.max(1, config.policy?.autoCollect?.intervalHours ?? 24)
      const limitPerSource = Math.max(1, Math.min(20, config.policy?.autoCollect?.limitPerSource ?? 5))
      const firstDelayMs = Math.max(0, config.policy?.autoCollect?.firstRunDelaySec ?? 120) * 1000
      const enabledSources = policySources.filter((s) => s.enabled)
      const tick = async (): Promise<void> => {
        await policy.load()
        const res = await runPolicyTick(
          { store: policy, hosts: decisionHosts(policySources), timeoutMs: config.policy?.timeoutMs ?? 30_000, maxBytes: config.policy?.maxBytes ?? 8_000_000, logger },
          { sources: enabledSources, limitPerSource, vault, mirror: config.policy?.autoCollect?.mirrorToVault !== false, logger },
        )
        if (res.added + res.updated > 0) bus.publish({ kind: 'policy', action: 'collect', at: res.runAt })
      }
      ctx.effect(() => {
        const first = setTimeout(() => { void tick().catch((err) => logger.warn('policy auto tick failed', { error: String(err) })) }, firstDelayMs)
        const timer = setInterval(() => { void tick().catch((err) => logger.warn('policy auto tick failed', { error: String(err) })) }, hours * 3_600_000)
        return () => { clearTimeout(first); clearInterval(timer) }
      })
      logger.info('policy auto-collect scheduled', { hours, limitPerSource, sources: enabledSources.map((s) => s.id) })
    }
  }
  const personal = new PersonalStore(path.join(dataDir, 'personal.json'))
  registerPersonalTools(ctx, personal, finance, vault)
  // 成长档案：Agent 记忆（规划/学习/复盘状态），数据全本地；变更经总线回执面板。
  const growth = new GrowthStore(path.join(dataDir, 'growth.json'), (change) => {
    bus.publish({ kind: 'growth', action: change.action, at: new Date().toISOString() })
  })
  registerGrowthTools(ctx, growth, store, personal, vault)
  // 追踪档案：机构13F/政客申报/名私募（Agent 驱动，全本地）；新披露经总线回执面板。
  const follow = new FollowStore(path.join(dataDir, 'follow.json'), (change) => {
    bus.publish({ kind: 'follow', action: change.action, targetId: change.targetId, at: new Date().toISOString() })
  })
  // 首次启动预置默认追踪对象（seededAt 一次性标记；删除后不复活）。
  void follow.seedDefaults().catch((err) => logger.warn('follow: default targets seed failed', { error: String(err) }))
  registerFollowTools(ctx, { finance, portfolio: store, follow, bus, vault, growth }, { tick: true })
  registerTools(ctx, finance, store, analyses, bus, personal, strategyLibrary)
  registerWestockTools(ctx, finance)
  registerHistoryTools(ctx, finance, history, bus)
  if (config.research?.enabled !== false) registerResearchTools(ctx, finance, vault, bus)
  const yingmiCommand = (config.mcpSources ?? []).find((s) => s.kind === 'cli' && s.enabled)?.command || undefined
  const skills = registerSkills(ctx, packageRoot, dataDir, yingmiCommand, logger)
  const mcp = registerMcpSources(ctx, config.mcpSources ?? [], dataDir)
  // 面板「投资判断」页通过它读取建议库；实际实例在下方投资建议块里创建。
  const adviceRef: { current?: AdviceStore } = {}
  // 路由注册必须挂到 ctx.effect：registerRoutes 返回的 disposer 就是卸载句柄。
  // 早期这里丢掉了返回值，导致插件重载（改配置、装别的 bundle）时旧路由不会被释放，
  // 下一次 apply 就撞 "duplicate prefix route /plugins/dsh-finance/api"，整个 fiber 激活失败，
  // 连带它注册的 web 搜索提供方一起消失。包一层 try 保证卸载异常不阻断其他清理。
  ctx.effect(() => {
    const disposeRoutes = registerRoutes(ctx.webServer, finance, store, mcp, history, skills, analyses, bus, vault, logger, reminders, scanRemindersNow, personal, growth, follow, policyStore, evidenceBundle, adviceRef, capitalRef, wealthRef, learnRef)
    return () => {
      try {
        disposeRoutes()
      } catch (err) {
        logger.warn('route dispose failed', { error: String((err as Error)?.message ?? err) })
      }
    }
  })
  // 投资建议引擎：结构化建议 + 证据/反证强制校验（数据在 <dataDir>/investment）。
  // 放在 policy/evidence 之后注册，证据校验才能引用政策库与证据库。
if (config.investment?.enabled !== false) {
    const investmentRoot = config.investment?.dir
      ? (path.isAbsolute(config.investment.dir) ? config.investment.dir : path.join(packageRoot, config.investment.dir))
      : path.join(dataDir, 'investment')
    const advices = new AdviceStore(investmentRoot, logger)
    adviceRef.current = advices
    ctx.effect(() => {
      void advices.load()
        .then(() => logger.info('investment advice ready', { dir: investmentRoot, advices: advices.all().length }))
        .catch((err) => logger.fail('investment advice load failed', err))
      return () => {}
    })
    registerInvestmentTools(ctx, {
      store: advices,
      logger,
      ...(policyStore ? { policy: policyStore } : {}),
      vault,
      ...(evidenceBundle ? { evidence: evidenceBundle.repo } : {}),
      finance: {
        getKline: (code, period, start, end) => finance.getKline(code, period, start, end),
        getUsKline: (code, period, start, end) => finance.getUsKline(code, period, start, end),
      },
      bus,
    })
  }

  registerReminderTools(ctx, reminders, scanRemindersNow, bus)
  // 定时扫描：10 分钟一次（插件卸载时随 effect 清理）。
  ctx.effect(() => {
    const t = setInterval(() => { void scanRemindersNow().catch(() => {}) }, 10 * 60_000)
    // 启动 20 秒后先扫一次，让提醒尽快可见。
    const boot = setTimeout(() => { void scanRemindersNow().catch(() => {}) }, 20_000)
    return () => { clearInterval(t); clearTimeout(boot) }
  })

  // Replace the default (key-gated) web search with free meta search (Python ddgs → Brave/Bing/Google).
  ctx.web.registerSearchProvider(createWebSearchProvider((q, signal) => finance.webSearch(q, signal)))

  // Diagnostics: report whether this package's client entry reached the web client graph.
  // Written to <dataDir>/logs/dsh-finance.jsonl so a missing panel can be traced without
  // opening the browser console.
  try {
    ctx.inject(['clientModules'], (c) => {
      try {
        const registry = (c as unknown as { get(name: string): unknown }).get('clientModules') as
          | { graph(): { entries?: { id?: string }[] } }
          | undefined
        const ids = (registry?.graph?.().entries ?? []).map((e) => e.id).filter((v): v is string => typeof v === 'string')
        logger.info('client graph', { count: ids.length, hasSelf: ids.includes(pluginName), ids })
      } catch (err) {
        logger.warn('client graph probe failed', { error: err instanceof Error ? err.message : String(err) })
      }
    })
  } catch (err) {
    logger.warn('client graph inject failed', { error: err instanceof Error ? err.message : String(err) })
  }

  ctx.systemPrompt.section({
    name: 'dsh-finance:portfolio',
    order: 121,
    text: [
      '## Finance portfolio file',
      `- Holdings/watchlist live in a local JSON file: ${store.path}`,
      '- After reading a user-uploaded holdings screenshot, call import_holdings to propose a preview; the user must confirm in the personal home before writing it; the "金融面板" sidebar refreshes live.',
      '- Market data uses direct HTTP endpoints (Eastmoney / Tencent), not akshare. If a market tool fails, call probe_finance_sources first.',
      '- Holdings CRUD works without quotes; P&L enrichment needs a healthy quote provider.',
      '- 历史K线/财报/分红可用 sync_history 落地到本地库，再用 get_history 读取（含事件标记）。',
      '- 对话中想引导用户看面板时调用 panel_navigate（tab 必填，可带 code 聚焦；tab=quotes 聚焦K线工作区（tab=kline 为兼容别名），kind 指定市场，open_analysis 可同时打开 AI 解读）。note 会作为一句话解释显示在面板顶部，anchor 页内滚动（home 可用 overview/growth/journal/reviews/approvals，holdings 用 lookthrough，follow 用 state-capital/targets/jobs/briefs/shadow）——导航时带上它们，用户才知道你让他看什么。',
      '- 调仓推演用 simulate_rebalance：trades（买卖列表）或 targets（目标权重%）二选一，返回前后权重/HHI/分币种敞口对比；纯模拟，不改持仓。',
      '- 面板焦点用 panel_state 读取（用户当前所在标签页与聚焦代码，best-effort）：回答「我该看哪 / 你刚才说的那个」或引用面板内容前先读它，对齐用户实际所看。',
      '- Use type:"fund" for funds (基金, 6-digit code) and type:"stock" for stocks (A股/港股/美股).',
      '- 基金分析工具链：fund_dossier 一次取基金经理/规模/重仓/风险/基准档案 → calculate_fund_metrics 算收益/回撤/夏普与基准对比 → compare_funds 比相关性、analyze_fund_overlap 看基金与持仓的重叠；排行 get_fund_rank 支持 sortBy（m1/m3/m6/y1/y3/ytd）与 page。',
      '- 基金净值是 T+1（quote 里 asOf/raw.navDate 为净值日期，勿当实时价）；场内 ETF（51/56/15/16 开头）另有 get_etf_overview 看折溢价与规模、get_etf_holdings 看重仓（WeStock 能力，可能失败需标注缺失）。',
      '- 伪分散检测与买入纪律：portfolio_lookthrough 一次穿透全组合（HHI/有效个股/重复暴露排行）；买入或加仓前先 check_new_position 看边际影响（这是「分散」还是「加大同一个赌注」），结论要引用它的 before/after 数字。',
      '- panel_navigate 支持 type=fund：tab=dossier 打开基金档案、tab=quotes 打开基金K线聚焦。',
      '- When the panel sends an active position-analysis request, gather the requested data with finance tools and finish by calling save_position_analysis with the complete Markdown report.',
    ].join('\n'),
  })

  ctx.systemPrompt.section({
    name: 'dsh-finance:research',
    order: 122,
    text: [
      '## 投研资料库 (Research Vault)',
      `- 资料正文以 Markdown 落在工作区：${vaultRoot}（<年>/<id>-<slug>.md），索引 ${vault.indexPath}，可直接用文件工具读写。`,
      '- 文件与面板双向联动：目录已开启监听，用文件工具新建/编辑/删除 Markdown 会自动回灌索引（也可调 sync_research 手动扫描）；面板里改正文同样写回该文件。',
      '- 文件结构＝YAML frontmatter（id/title/source/date/codes/tags/status/summary/opinion）+ 正文 + `## 观点与批注`；改 frontmatter 即改元数据，写正文不要动这两段。',
      '- 每条资料必须带 source（来源）与 date（资料时间），可关联 codes（标的）并沉淀 opinion（个人观点）——不做无来源、无时间戳的孤岛笔记。',
      '- 收集：collect_research（code + kind=report/news，自动带来源与时间、按标题+时间去重）；研报正文用 get_research_report_detail 或 collect_research 的 withBody。',
      '- 整理：list_research（按 kind/status/code/tag/query 过滤）→ get_research 读全文 → update_research 补 codes/tags/opinion → archive_research 归档。',
      '- 观点持续积累：add_research_note（带时间戳追加，不覆盖历史）；research_overview 看哪些标的资料已积累充分。',
      `- 数据补充：研报用 research_report 能力（WeStock），行情/财报/资讯走 finance 工具；资料库与行情工具通过 codes 关联，形成「标的 → 资料 → 观点」链路。`,
      '- **对话 → 面板（必须做）**：对话里收集/产出的可复用内容一律落库（collect_research 批量收集、save_research 单条记录、add_research_note 追加观点），落库后资料立刻出现在「金融面板 → 资料」并写入上面的 Markdown 文件；禁止只在回复里输出而不入库。',
      '- 落库后要回一句「已存入资料库（资料 tab / 文件 <路径>）」，让用户知道去哪看、后续可继续维护。',
      '- **面板 → 对话**：用户在资料详情点「问 Agent」时，会把该资料的标题/来源/时间/标的/观点/正文摘录拼成一条提问发到当前对话，按这条上下文继续研究、补观点（add_research_note）或改状态（update_research）。',
      '- 维护节奏：同一标的先查（list_research / 上面的现状清单），有就补 note、改 status（inbox → active → archived），缺才 collect；不要让资料库出现标题+时间重复的条目。',
    ].join('\n'),
  })

  // 每轮动态注入「资料库现状」：让对话侧始终知道已沉淀了什么，避免重复收集、能按 id 继续维护。
  ctx.systemPrompt.section({
    name: 'dsh-finance:research-state',
    order: 122.5,
    text: () => {
      if (!vault.isLoaded()) return ''
      const d = vault.digest(10)
      if (!d.total) {
        return [
          '## 资料库现状（每轮动态生成）',
          '- 资料库为空。对话里收集到的研报/资讯/结论请用 collect_research / save_research 落库，之后就能在「金融面板 → 资料」里持续维护。',
        ].join('\n')
      }
      const kindOf = (k: string) => KIND_LABEL[k as ResearchKind] ?? k
      const lines = d.recent.map((i) => {
        const bits = [
          i.id,
          kindOf(i.kind),
          i.date,
          i.source,
          i.codes.length ? i.codes.join('/') : '无标的',
          `渠道:${ORIGIN_LABEL[i.origin] ?? i.origin}`,
          i.notes ? `${i.notes} 观点` : '',
        ].filter(Boolean).join(' · ')
        return `  - ${bits} — ${i.title}${i.opinion ? `（观点：${i.opinion}）` : ''}`
      })
      return [
        '## 资料库现状（每轮动态生成）',
        `- 共 ${d.total} 条：待整理 ${d.byStatus.inbox ?? 0} · 在用 ${d.byStatus.active ?? 0} · 已归档 ${d.byStatus.archived ?? 0}；来源渠道：对话 ${d.byOrigin.chat ?? 0} · 面板 ${d.byOrigin.panel ?? 0} · 文件 ${d.byOrigin.file ?? 0}`,
        `- 关联最多的标的：${d.topCodes.slice(0, 5).map((c) => `${c.code}(${c.count})`).join('、') || '（无）'}`,
        '- 最近资料（id 可直接用于 get_research / add_research_note / update_research / archive_research）：',
        ...lines,
      ].join('\n')
    },
  })

  ctx.systemPrompt.section({
    name: 'dsh-finance:growth',
    order: 124,
    text: [
      '## 成长（规划·学习·复盘，Agent 驱动，全本地记忆）',
      '- 触发：用户是新手、问「我该学什么 / 怎么开始」、聊家庭财务（攒钱/负债/保障/目标）、或要求复盘时——先 growth_state 装载记忆，再 growth_diagnose 拿带证据的缺口清单；结论由你结合上下文决策，一次只做 1 件事。',
      '- 规划先于投资：health.fixes 非空时先完成规划修复项（一次一个具体动作，如「先把 3 个月开支的应急金单独存」），未完成规划前不讲选股/择时课程。',
      '- 微课纪律：一次只讲 1 节（lesson_get 取材：3 个要点 + 1 道检验题 → lesson_complete 判分，≥80 记 mastered）；优先选与当前对话最相关的课程，讲完回到投资主线，绝不打断主线。',
      '- 访谈写入 family_plan_update：section=profile|cashflow|balance|goals|protection；一次只问 1 个问题、先说明用途并注明「这些数据只保存在本机」；数字看不准就让用户口述，不猜、不代填。',
      '- 决策纪律：用户形成/修订观点后，引导落一条决策日记（save_research kind=decision：判断+依据+证伪条件）；周复盘照旧走 weekly 流程。',
      '- 月度成长复盘（每月一次或用户主动要求）：四柱（学习/计划/纪律/资产）对照上期、引用数字、给出下月唯一改进动作 → save_research kind=review → growth_review_mark 记 streak。资料库缺数据就明说缺什么，缺的部分留空，不编。',
      '- 激励只谈过程（遵循计划、完成复盘、补齐证伪条件），绝不评价收益、绝不鼓励频繁交易，不承诺任何回报。',
      '- 成长状态是记忆不是看板：面板只读展示你诊断出的 nextSteps；不要派发打卡任务，不要自动生成投资计划。',
    ].join('\\n'),
  })

  ctx.systemPrompt.section({
    name: 'dsh-finance:follow',
    order: 125,
    text: [
      '## 追踪（机构13F / 政客申报 / A股名私募 / 国家资本公开披露，Agent 驱动，全本地档案）',
      '- 默认档案已预置三个样本对象：Berkshire Hathaway（CIK 0001067983，13F）、Nancy Pelosi（国会申报）、冯柳（A股十大流通股东）。首次 follow_list 即可见；用户不要哪个就 follow_remove（删了不复活）。',
      '- 触发：用户说「跟踪/盯」某人或机构、问「他最近买了什么 / 巴菲特/段永平/木头姐持仓」、问「跟着国会议员买哪些股」时：先 follow_list 装载记忆（新鲜度徽标+待解读任务），再 follow_fetch 拉最新披露。',
      '- follow_add：名字先自己解析（EDGAR/成员接口有响应式候选），失败带候选让用户选，再带 cik/slug 重试；不记固定名人表。加之前向用户说明该源的延迟与覆盖边界（工具返回自带 caveat，直接转述）。',
      '- 解读节奏（一次只做 1 件事）：follow_fetch（新披露会自动入队 follow_fetch 式任务卡）→ follow_diff 引用具体数字与披露日期 → 有重叠或用户想复刻时 follow_vs_holdings → 最后 follow_note 落简报（3-6 条要点，引用数字/日期/边界，同步资料库）。',
      '- follow_replicate 是纯纸面复刻（不触达真实账户、不建仓、不构成建议）；收益只按已定价部分算并标注缺失。禁：给出任何标的的买卖建议、声称「跟单」、暗示申报交易=内幕。',
      '- 面板追踪页（tab=follow）只读展示对象/任务卡/简报/复刻状态；任务卡 click 回投对话（kind=follow 回执），解读仍在会话里做。anchor：follow 页用 state-capital/targets/jobs/briefs/shadow。',
      '- 国家队/国家资本监测先 follow_list 查看stateCapitalCatalog，再 follow_add(kind="cn-state",stateEntityId,name,stateCodes,autoCheck=false)。huijin空池仅查看官网机构股权（非全部证券）；huijin-asset/csf需明确最多5只A股股票。不能读个人持仓自动扩围，也不能把ETF份额/成交/机构占比认成汇金买卖。',
      '- 国家资本使用 follow_fetch → follow_diff → follow_note；每条保留报告期、披露日、抓取日及官方/聚合等级。披露日未知不填今天；newObservation不等于新披露；缺榜/首次观察不等于清仓/建仓；同一期改版不等于交易；母子公司不可直接加总。聚合股东表不是已核正式公告，ETF具名持有人不在本版自动源覆盖内。',
      '- 国家资本对象默认仅手动，不新增后台任务。用户明确要求后才能 follow_state_configure(autoCheck=true) 复用既有6小时检查；stateCodes修改保留旧证据且不作跨范围差分。国家资本不支持follow_replicate或伪完整组合重叠。其它既有对象仍按6小时检查新披露，解读由会话触发，不自动刷屏。',
    ].join('\n'),
  })

  ctx.systemPrompt.section({
    name: 'dsh-finance:westock',
    order: 123,
    text: [
      `## WeStock 数据源（腾讯自选股 CLI，免鉴权）— ${WESTOCK_SPECS.length} 个能力`,
      '- 不确定有什么数据时先调 `westock_capabilities`（分组列出全部能力、用法与示例参数）；想用目录外的子命令用 `westock_call` 传 argv（只读白名单）。',
      `- 也可以直接用命令行：\`${packageRoot}/scripts/westock.sh <子命令...>\`（或 \`npm run westock -- <子命令>\`）。透传原生 CLI 原文；\`--cap <能力> --args '<JSON>'\` 走插件能力目录并输出 JSON（带缓存与多源回落）；\`--list\` 看能力目录，\`--status\` 看二进制版本。`,
      '- 常用专用工具：get_money_flow（资金流）· get_consensus（一致预期/目标价）· get_shareholder · get_dividend · get_stock_events / get_risk_events · get_disclosure_calendar · get_notice_list · get_dragon_tiger · get_margin_trade · get_chip_distribution · get_stock_score · get_institution_rating · get_north_holding。',
      '- 市场层面：get_market_breadth（涨跌分布/情绪温度）· get_hot_rank（热搜股票/板块/ETF/热文）· screen_stocks（排行/条件/策略/标签/事件选股）· get_market_calendar（新股/财报披露/投资/停复牌/交易日历）。',
      '- 投研建议链路：screen_stocks 初筛 → get_realtime_quote/get_stock_kline 看价格 → get_consensus/get_financial_indicators 看基本面 → get_money_flow/get_north_holding 看资金 → collect_research 沉淀研报 → add_research_note 记录观点。',
    ].join('\n'),
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    financeData: FinanceDataService
  }
}
