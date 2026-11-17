/**
 * Impact worksheet builder.
 *
 * This module does NOT predict anything. It assembles, from what the document
 * actually says, the pieces a human or the agent must reason about — channel,
 * indicators to watch, support conditions, falsifiers, and an explicit list of
 * what is still unknown. Numbers always come from the source text or from the
 * caller's macro snapshot; nothing is invented here.
 */
import { EVIDENCE_LABEL, policyEvidenceLevel, type EvidenceLevel } from './evidence.js'
import { excerpt, type PolicyDocument } from './types.js'

export const CHANNEL_LABEL: Record<string, string> = {
  fiscal: '财政',
  monetary: '货币',
  investment: '投资',
  consumption: '消费',
  regulation: '监管',
  trade: '外贸',
  industry: '产业',
  other: '其他',
}

interface ChannelMeta {
  mechanism: string
  indicators: string[]
  lagHint: string
  macro: string[]
}

const CHANNEL_META: Record<string, ChannelMeta> = {
  fiscal: {
    mechanism: '财政支出/专项债 → 基建与设备投资 → 上游订单与地方配套',
    indicators: ['财政支出进度', '政府债券发行规模', '固定资产投资', '基建投资增速'],
    lagHint: '1–2 个季度',
    macro: ['gdp', 'money_supply'],
  },
  monetary: {
    mechanism: '利率与流动性 → 融资成本与估值 → 信贷、地产与投资',
    indicators: ['社融存量同比', 'M1/M2 同比', 'LPR 与资金利率', '企业中长期贷款'],
    lagHint: '1–2 个季度',
    macro: ['money_supply', 'cpi', 'ppi'],
  },
  investment: {
    mechanism: '项目审批/开工 → 设备与材料采购 → 中游制造订单',
    indicators: ['新开工项目数', '固定资产投资', '挖掘机/水泥等中观数据'],
    lagHint: '2–4 个季度',
    macro: ['gdp'],
  },
  consumption: {
    mechanism: '补贴/以旧换新 → 终端需求 → 渠道库存与价格',
    indicators: ['社会消费品零售总额', 'CPI', '重点品类销量'],
    lagHint: '1 个季度内',
    macro: ['cpi', 'gdp'],
  },
  regulation: {
    mechanism: '准入/成本/合规要求 → 行业格局与利润率 → 龙头份额',
    indicators: ['配套细则出台', '处罚与整改案例', '行业集中度变化'],
    lagHint: '3–12 个月',
    macro: ['ppi'],
  },
  trade: {
    mechanism: '关税/出口管制 → 订单与成本 → 出口链利润',
    indicators: ['出口增速', '关税清单变化', '海外订单与产能布局'],
    lagHint: '1–2 个季度',
    macro: ['gdp', 'ppi'],
  },
  industry: {
    mechanism: '产能与需求目标 → 供需缺口 → 价格与企业毛利',
    indicators: ['产能利用率', '行业价格', '装机/产量数据', '招标中标金额'],
    lagHint: '2–4 个季度',
    macro: ['pmi', 'ppi'],
  },
  other: {
    mechanism: '（文件未给出明确传导路径，需人工判断）',
    indicators: ['（待定）'],
    lagHint: '未知',
    macro: [],
  },
}

export interface ImpactChannel {
  channel: string
  label: string
  mechanism: string
  indicators: string[]
  lagHint: string
  /** `extracted` = the document names this channel; `implied` = inferred from its type. */
  source: 'extracted' | 'implied'
  paragraph?: number
}

export interface PolicyImpactPlan {
  policy: {
    id: string
    title: string
    issuer: string
    publishedAt: string
    status: string
    legalEffect: string
    docType: string
    canonicalUrl: string
  }
  evidence: { level: EvidenceLevel; label: string; reasons: string[] }
  channels: ImpactChannel[]
  funding: string
  responsible: string
  /** Conditions that, if observed, support the document's stated intent. */
  support: string[]
  /** Conditions that would falsify the transmission story. */
  falsifiers: string[]
  /** Macro series worth pulling for this policy. */
  macroSeries: string[]
  industries: string[]
  /** What is missing — never fill these with guesses. */
  unknown: string[]
  disclaimer: string
}

/** Map a document type to a default channel when the extraction names none. */
function impliedChannel(doc: PolicyDocument): string {
  if (doc.docType === 'fiscal-report') return 'fiscal'
  if (doc.docType === 'monetary-report') return 'monetary'
  if (doc.docType === 'industry-plan' || doc.docType === 'five-year-plan') return 'industry'
  if (doc.docType === 'regulation' || doc.docType === 'regulation-draft') return 'regulation'
  if (doc.docType === 'statistics') return 'other'
  if (doc.docType === 'white-paper') return 'industry'
  return 'other'
}

function cite(paragraph: number | undefined): string {
  return typeof paragraph === 'number' ? `（原文第 ${paragraph + 1} 段）` : ''
}

/** Build the deterministic skeleton of a policy impact analysis. */
export function buildImpactPlan(doc: PolicyDocument, opts: { industry?: string } = {}): PolicyImpactPlan {
  const grade = policyEvidenceLevel(doc)
  const extractedChannels = new Map<string, { paragraph?: number }>()
  for (const measure of doc.policyMeasures) {
    const channel = CHANNEL_META[measure.channel] ? measure.channel : 'other'
    if (!extractedChannels.has(channel)) extractedChannels.set(channel, { paragraph: measure.paragraph })
  }
  if (extractedChannels.size === 0) extractedChannels.set(impliedChannel(doc), {})

  const channels: ImpactChannel[] = [...extractedChannels.entries()].map(([channel, meta]) => ({
    channel,
    label: CHANNEL_LABEL[channel] ?? channel,
    mechanism: CHANNEL_META[channel]?.mechanism ?? CHANNEL_META.other!.mechanism,
    indicators: CHANNEL_META[channel]?.indicators ?? CHANNEL_META.other!.indicators,
    lagHint: CHANNEL_META[channel]?.lagHint ?? '未知',
    source: meta.paragraph === undefined ? 'implied' : 'extracted',
    ...(meta.paragraph === undefined ? {} : { paragraph: meta.paragraph }),
  }))

  const macroSeries = [...new Set(channels.flatMap((c) => CHANNEL_META[c.channel]?.macro ?? []))].slice(0, 3)

  const support: string[] = []
  for (const target of [...doc.measurableTargets, ...doc.policyGoals]) {
    if (target.value) support.push(`原文给出量化目标：${target.metric}=${target.value}${target.unit ?? ''}${target.deadline ? `（期限 ${target.deadline}）` : ''}${cite(target.paragraph)}`)
  }
  if (doc.fundingMechanism) support.push(`原文写明资金机制：${excerpt(doc.fundingMechanism, 120)}`)
  if (doc.executionResponsibility) support.push(`原文写明执行责任：${excerpt(doc.executionResponsibility, 120)}`)
  if (support.length === 0) support.push(`仅确认方向：${excerpt(doc.paragraphs[0] ?? doc.text, 120)}${cite(0)}`)

  const falsifiers: string[] = []
  for (const target of doc.measurableTargets) {
    if (target.value && target.deadline) {
      falsifiers.push(`若 ${target.deadline} 前「${target.metric}」未达到 ${target.value}${target.unit ?? ''}，说明执行弱于文件表述${cite(target.paragraph)}`)
    } else if (target.metric) {
      falsifiers.push(`若后续公开数据中「${target.metric}」没有同向变化，说明传导未发生${cite(target.paragraph)}`)
    }
  }
  if (doc.fundingMechanism) falsifiers.push(`若后续披露的实际到位资金显著低于「${excerpt(doc.fundingMechanism, 80)}」，对产业链的拉动需下调`)
  const responsibleOrgs = [...new Set(doc.policyMeasures.map((m) => m.responsible).filter((v): v is string => Boolean(v)))]
  if (responsibleOrgs.length > 0) {
    falsifiers.push(`若 ${responsibleOrgs.slice(0, 2).join('、')} 在 6 个月内未发布配套细则或实施文件，视为推进放缓`)
  } else if (doc.executionResponsibility) {
    falsifiers.push('若半年内没有可查的配套文件或项目清单，视为停留在表态层面')
  }
  const primaryChannel = channels[0]!
  falsifiers.push(`若「${primaryChannel.indicators.slice(0, 2).join('」「')}」在 ${primaryChannel.lagHint} 内没有同向变化，应判定传导未发生`)
  if (grade.level === 'E3' || grade.level === 'unverified') {
    falsifiers.push('当前只有战略表述：在拿到资金规模或量化目标前，不得据此判断任何公司受益')
  }

  const unknown: string[] = []
  if (doc.parseStatus === 'pdf-pending') unknown.push('PDF 正文尚未抽取，引用前必须核对页码')
  if (doc.parseStatus === 'failed') unknown.push(`正文解析失败：${doc.parseError || '原因未知'}`)
  if (!doc.publishedAt) unknown.push('发布日期缺失，无法判断时效与是否已被后续文件取代')
  if (!doc.documentNumber) unknown.push('文号缺失，多站转载的同一性仅靠标题与发布日判断')
  if (doc.measurableTargets.length === 0) unknown.push('没有可量化目标：无法验证执行进度')
  if (!doc.fundingMechanism) unknown.push('未写明资金规模或来源：无法判断资金约束')
  if (doc.status === 'draft') unknown.push('这是征求意见稿，条款可能调整，不能当作已生效规则')
  if (doc.legalEffect === 'statement') unknown.push('这是讲话/通稿，不产生可执行义务，只能作为方向信号')
  if (opts.industry) unknown.push(`行业「${opts.industry}」的暴露度需要公司层面的业务证据（年报/订单/招投标），本工具不提供公司结论`)

  return {
    policy: {
      id: doc.id,
      title: doc.title,
      issuer: doc.issuer,
      publishedAt: doc.publishedAt,
      status: doc.status,
      legalEffect: doc.legalEffect,
      docType: doc.docType,
      canonicalUrl: doc.canonicalUrl,
    },
    evidence: { level: grade.level, label: EVIDENCE_LABEL[grade.level], reasons: grade.reasons },
    channels,
    funding: doc.fundingMechanism,
    responsible: doc.executionResponsibility,
    support,
    falsifiers,
    macroSeries,
    industries: [...new Set([...doc.relatedIndustries, ...(opts.industry ? [opts.industry] : [])])],
    unknown,
    disclaimer:
      '本清单是分析脚手架，不是结论：传导机制与受益判断需结合宏观数据、公司业务证据与市场定价再论证；不构成投资建议，不预测涨跌幅。',
  }
}
