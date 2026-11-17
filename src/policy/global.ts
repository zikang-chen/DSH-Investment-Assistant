/**
 * Overseas events → China transmission.
 *
 * The value of this module is the boundary it draws, not the stories it can
 * tell:
 * - `fact`        — only what the caller supplied with a source and a number;
 * - `conditional` — mechanism-based chains this module can justify structurally;
 * - `narrative`   — claims that circulate but are not verifiable here, listed
 *                   explicitly so they cannot be quietly promoted to fact.
 *
 * Nothing here predicts prices or recommends trades.
 */

export const GLOBAL_EVENT_KINDS = [
  'fed-policy', // 美联储加息/降息/缩表/点阵图
  'us-data', // 非农、CPI 等美国数据
  'trade-policy', // 关税、贸易调查、反倾销
  'export-control', // 出口管制、实体清单、技术限制
  'commodity', // 能源与大宗商品价格
  'risk-off', // 全球风险偏好变化
  'external-demand', // 主要市场需求变化
] as const
export type GlobalEventKind = (typeof GLOBAL_EVENT_KINDS)[number]

export const GLOBAL_EVENT_LABEL: Record<GlobalEventKind, string> = {
  'fed-policy': '美联储政策',
  'us-data': '美国经济数据',
  'trade-policy': '贸易政策',
  'export-control': '出口管制',
  commodity: '能源与大宗',
  'risk-off': '全球风险偏好',
  'external-demand': '外部需求',
}

export interface GlobalEventInput {
  kind: GlobalEventKind
  /** One-line description of what happened (no interpretation). */
  summary: string
  /** Verified facts with numbers and source, e.g. "美国9月CPI同比3.7%（BLS，2026-10-15）". */
  facts?: string[]
  /** Where the facts come from. */
  source?: string
  /** Specific China industry to keep in view (optional). */
  industry?: string
}

export type Certainty = 'fact' | 'conditional' | 'narrative'

export interface GlobalChain {
  id: string
  certainty: Certainty
  /** Ordered transmission path, first step is the overseas event. */
  path: string[]
  mechanism: string
  /** China instruments/fields affected, phrased as "受影响对象", not as direction bets. */
  affected: string[]
  /** Data or disclosures that would confirm/deny the chain. */
  watch: string[]
  lagHint: string
  caveat: string
}

export interface GlobalImpactPlan {
  event: { kind: GlobalEventKind; label: string; summary: string; source: string }
  facts: string[]
  chains: GlobalChain[]
  /** Macro series worth pulling on the China side. */
  macroSeries: string[]
  /** Popular claims this analysis refuses to adopt. */
  unverifiedNarratives: string[]
  unknown: string[]
  disclaimer: string
}

interface ChainSpec {
  id: string
  path: string[]
  mechanism: string
  affected: string[]
  watch: string[]
  lagHint: string
  macro: string[]
}

const CHAINS: Record<GlobalEventKind, ChainSpec[]> = {
  'fed-policy': [
    {
      id: 'fed-rate-usdcny',
      path: ['美联储政策利率变化', '美债收益率与美元指数', '中美利差与人民币汇率', '外资流向与 A/港股估值'],
      mechanism: '美债收益率与美元是人民币资产的贴现率与汇率外生变量：利率下行通常缓解人民币贬值压力，但传导取决于国内货币政策是否跟随。',
      affected: ['人民币汇率', '港股（外资占比高）', 'A股外资重仓板块'],
      watch: ['美元兑人民币中间价与即期', '中美 10 年期国债利差', '北向资金（如有披露）', '港股成交额'],
      lagHint: '1–5 个交易日（情绪）／1–2 个季度（基本面）',
      macro: ['money_supply'],
    },
    {
      id: 'fed-rate-policy-space',
      path: ['美联储政策利率变化', '汇率约束变化', '国内货币政策空间', 'LPR/降准与信贷投放'],
      mechanism: '外部利率通过汇率约束影响国内宽松空间，这是「条件性」传导：国内政策取向不因外因而自动改变。',
      affected: ['LPR 与贷款利率', '社融与信贷结构', '地产与高杠杆行业融资成本'],
      watch: ['LPR 报价', '社融存量同比', '央行公开市场操作'],
      lagHint: '1–2 个季度',
      macro: ['money_supply', 'gdp'],
    },
  ],
  'us-data': [
    {
      id: 'us-data-yields',
      path: ['美国通胀/就业数据', '美债收益率与美元', '黄金与人民币资产相对吸引力', '港股与 A 股风险偏好'],
      mechanism: '数据超预期通过贴现率渠道影响全球风险资产估值；对中国的实际影响取决于汇率与国内政策是否对冲。',
      affected: ['黄金', '港股', '高估值成长板块'],
      watch: ['美元指数', '美债 10 年期收益率', '人民币汇率', '黄金价格'],
      lagHint: '当日到 1 周',
      macro: ['cpi'],
    },
    {
      id: 'us-data-demand',
      path: ['美国消费/就业数据', '美国进口需求', '中国出口订单', '出口链企业营收与利润'],
      mechanism: '外需通过订单传导到出口链，但需以中国海关出口数据和中观订单验证，不能只看美国数据。',
      affected: ['出口链', '家电/消费电子/机械'],
      watch: ['中国出口同比', '对美出口占比', 'PMI 新出口订单分项'],
      lagHint: '1–2 个季度',
      macro: ['gdp', 'pmi'],
    },
  ],
  'trade-policy': [
    {
      id: 'tariff-cost',
      path: ['关税/贸易措施', '出口成本与终端价格', '订单转移或份额变化', '出口企业毛利率'],
      mechanism: '关税改变相对价格：短期由出口商与海外买方分担，长期取决于替代供给与议价能力。',
      affected: ['对美出口占比高的行业', '跨境电商与物流'],
      watch: ['关税清单与生效日', '中国对美出口额', '企业公告中的关税影响表述'],
      lagHint: '1–2 个季度',
      macro: ['gdp'],
    },
    {
      id: 'trade-retaliation',
      path: ['贸易措施', '反制与谈判进展', '相关商品价格与供应链重构', '国内替代与内需政策'],
      mechanism: '贸易摩擦常伴生国内对冲政策（扩内需、国产替代），这属于条件性推断，需要看后续文件。',
      affected: ['农业与能源进口链', '国产替代方向'],
      watch: ['反制清单', '国务院/部委配套政策', '进口量与价格'],
      lagHint: '2–4 个季度',
      macro: ['cpi', 'ppi'],
    },
  ],
  'export-control': [
    {
      id: 'export-control-supply',
      path: ['出口管制/实体清单', '关键设备与零部件供给', '国内厂商产能与良率', '国产替代份额与毛利'],
      mechanism: '供给约束抬升替代厂商的订单确定性，但同时增加资本开支与良率风险；受益与该风险必须同时评估。',
      affected: ['半导体设备与材料', '工业软件', '高端制造'],
      watch: ['企业公告/招投标', '设备进口额', '产能与良率披露'],
      lagHint: '2–6 个季度',
      macro: ['ppi', 'pmi'],
    },
    {
      id: 'export-control-capex',
      path: ['出口管制', '国内资本开支与专项支持', '设备与材料订单', '产业链公司收入确认'],
      mechanism: '管制往往触发产业政策加码，但资金与项目落地需要看预算与招标，不能由管制本身推出受益。',
      affected: ['设备', '材料', '检测'],
      watch: ['专项资金与项目清单', '招标中标金额', '在建工程与资本开支'],
      lagHint: '3–8 个季度',
      macro: ['pmi'],
    },
  ],
  commodity: [
    {
      id: 'commodity-cost',
      path: ['国际能源/大宗价格', '中国进口成本', 'PPI 与工业利润', '中下游毛利与终端价格'],
      mechanism: '输入型成本通过 PPI 传导，能否转嫁取决于下游需求强弱与行业集中度。',
      affected: ['上游资源', '中游制造', '下游消费'],
      watch: ['原油/铜/铁矿石价格', 'PPI 同比', '工业企业利润'],
      lagHint: '1–2 个月',
      macro: ['ppi', 'cpi'],
    },
  ],
  'risk-off': [
    {
      id: 'risk-off-liquidity',
      path: ['全球风险偏好下降', '美元流动性与新兴市场资金', '港股流动性与估值', 'A股情绪与成交'],
      mechanism: '风险偏好属于短期情绪变量，通常放大波动而非改变中期基本面；对基本面的影响需另行验证。',
      affected: ['港股', '高 Beta 板块', '外资重仓股'],
      watch: ['VIX', '美元指数', '港股成交与南向资金', 'A股成交额'],
      lagHint: '当日到数周',
      macro: [],
    },
  ],
  'external-demand': [
    {
      id: 'external-demand-orders',
      path: ['主要市场需求变化', '中国出口订单与产能利用率', '出口链营收', '相关行业利润'],
      mechanism: '外需变化先在订单与产能利用率上体现，再到营收与利润；需要用中观数据验证，而非直接映射到股价。',
      affected: ['出口制造', '航运港口', '上游材料'],
      watch: ['PMI 新出口订单', '出口金额同比', '集装箱运价'],
      lagHint: '1–2 个季度',
      macro: ['pmi', 'gdp'],
    },
  ],
}

const NARRATIVES: Record<GlobalEventKind, string[]> = {
  'fed-policy': ['「美联储降息 → A 股必涨」：降息只是贴现率条件，A 股方向还取决于国内盈利与风险偏好。', '「降息 → 人民币必然升值」：汇率还取决于国内利率与跨境收支。'],
  'us-data': ['「美国数据差 → 中国出口马上转弱」：需以中国出口与订单数据验证。', '「美债收益率下行 → 成长股一定跑赢」：风格切换还受国内流动性与监管影响。'],
  'trade-policy': ['「加征关税 → 相关公司利润必然下滑」：取决于关税分担、替代市场与汇率。', '「贸易摩擦 → 国产替代必然受益」：需看具体清单与企业业务重合度。'],
  'export-control': ['「被管制 → 国产替代立刻放量」：产能、良率与客户认证都有时滞。', '「实体清单 → 相关公司股价必跌」：影响取决于收入敞口，需查年报披露。'],
  commodity: ['「油价上涨 → 石化全行业受益」：上游受益、中下游成本承压，方向相反。', '「大宗涨价 → 通胀马上起来」：需看 PPI 向 CPI 的传导与需求强弱。'],
  'risk-off': ['「全球下跌 → A 股跟随下跌」：A 股与全球的相关性随阶段变化，需看资金与政策。', '「避险 → 黄金必涨」：实际利率与美元同样重要。'],
  'external-demand': ['「海外需求好 → 出口链公司业绩必好」：要看份额、价格与汇率，不能只看需求总量。'],
}

/** Build a transmission plan. Every chain from the library is `conditional` by construction. */
export function buildGlobalImpact(input: GlobalEventInput): GlobalImpactPlan {
  const kind = (GLOBAL_EVENT_KINDS as readonly string[]).includes(input.kind) ? input.kind : 'risk-off'
  const specs = CHAINS[kind] ?? []
  const chains: GlobalChain[] = specs.map((spec) => ({
    id: spec.id,
    certainty: 'conditional',
    path: spec.path,
    mechanism: spec.mechanism,
    affected: input.industry ? [...spec.affected, `${input.industry}（指定行业，需公司层面证据）`] : spec.affected,
    watch: spec.watch,
    lagHint: spec.lagHint,
    caveat: '这是机制推断，不是已发生的事实；需用「验证指标」逐项确认后再升级判断。',
  }))

  const facts = (input.facts ?? []).map((f) => String(f).trim()).filter(Boolean)
  const unknown: string[] = []
  if (facts.length === 0) unknown.push('未提供可核验的事实（含数字与来源）：本分析只能给机制，不能给方向')
  if (!input.source) unknown.push('未给出来源：事实无法追溯，不得引用为「已确认」')
  unknown.push('中国侧的最终影响未知：需以中国宏观数据、行业订单与公司披露验证')
  if (input.industry) unknown.push(`「${input.industry}」的暴露度需年报收入占比/订单证据，本工具不给公司结论`)

  return {
    event: {
      kind,
      label: GLOBAL_EVENT_LABEL[kind],
      summary: String(input.summary ?? '').trim(),
      source: String(input.source ?? '').trim(),
    },
    facts,
    chains,
    macroSeries: [...new Set(specs.flatMap((s) => s.macro))].slice(0, 3),
    unverifiedNarratives: NARRATIVES[kind] ?? [],
    unknown,
    disclaimer:
      '本分析只给出传导机制与验证清单，不预测价格、不给买卖建议；事实由调用方提供并对其来源负责。',
  }
}
