import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { IntradaySeries } from '../data/intraday.js'
import type { ProviderCallResult } from '../types.js'
import {
  INTRADAY_TOOL_KINDS, INTRADAY_TOOL_LIMITS, intradayToolFailure, intradayToolResult,
  parseIntradayToolRequest, type IntradayToolKind, type IntradayToolRequest,
} from './intraday-data.js'

/** Keep the tool on the unified provider service, never a parallel direct HTTP path. */
export interface IntradayToolFinance {
  getIntraday(code: string, kind?: IntradayToolKind, days?: number, signal?: AbortSignal, secid?: string): Promise<ProviderCallResult<IntradaySeries>>
}
const asJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue

export function registerIntradayTools(ctx: Context, finance: IntradayToolFinance) {
  ctx.tools.register(defineTool({
    name: 'get_intraday_data',
    description: '获取股票、指数或全球品种的分钟分时，返回来源、时区/单位、行情首末时间、价/均价/量/额及总数和分页信息。缺失为 null，失败明确报告；从已配置的公开行情源读取，不需登录。',
    parameters: {
      code: { type: 'string', description: '代码，如 600519 / 00700 / NVDA；与 secid 至少提供一个，secid 优先，省略时由其代码部分解析' },
      kind: { type: 'string', enum: [...INTRADAY_TOOL_KINDS], description: 'a / hk / us / global，默认 a；全球指数/商品用 global，有 secid 时以该品种身份为准' },
      secid: { type: 'string', description: '东财市场.代码，如 100.SPX / 101.GC00Y / 105.NVDA；优先于 code，不猜其它市场' },
      days: { type: 'number', enum: [1, 5], description: '仅 1 或 5，默认 1；是源支持的近期窗口，不保证完整交易日覆盖' },
      offset: { type: 'number', description: '全量升序序列的零基位置，非负安全整数；省略则取最近 limit 条，显式 0 从最早点开始。用 nextOffset 继续正向翻页' },
      limit: { type: 'number', description: `每页条数，整数 1–${INTRADAY_TOOL_LIMITS.maxLimit}，默认 ${INTRADAY_TOOL_LIMITS.defaultLimit}` },
    },
    output: {
      schema: { type: 'json' as const },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      let request: IntradayToolRequest
      try { request = parseIntradayToolRequest(args) }
      catch (error) { return asJson({ ok: false, errorType: 'invalid_arguments', error: error instanceof Error ? error.message : String(error) }) }
      exec.signal?.throwIfAborted()
      try {
        const result = await finance.getIntraday(request.code, request.kind, request.days, exec.signal, request.secid)
        exec.signal?.throwIfAborted()
        return asJson(intradayToolResult(result, request))
      } catch (error) {
        // Cancellation is control flow, not a fabricated provider failure.
        exec.signal?.throwIfAborted()
        return asJson(intradayToolFailure({}, request, error instanceof Error ? error.message : String(error)))
      }
    },
  }))
}
