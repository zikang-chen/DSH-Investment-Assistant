# DSH Investment Assistant

> An open-source investment-research plugin for **DeepSeek Harness**: China-first policy, macro, fundamentals, valuation and personal capital, turned into **evidence-backed, reviewable** investment judgements.

It installs as a DSH plugin (tools + skills + panel). No separate app, no login service, and your data stays local by default.

> An independent open-source project: the plugin architecture, investment-decision engine, policy intelligence, evidence inbox, personal capital ledger, wealth engine and financial learning are designed and implemented here.
> Some base data capabilities (quotes, funds, portfolio, research vault) reuse third-party MIT-licensed components; see [LICENSE](LICENSE) / [NOTICE](NOTICE) for their copyright and license texts.

中文说明见 [README.md](README.md)。

## What it does

| Need | Capability |
| --- | --- |
| Understand Chinese policy & industrial transmission | Official policy collection, immutable snapshots, version diff, transmission worksheet, execution tracking |
| See how global events hit China | Fed / US data / tariffs / export controls / commodities / risk-off chains, with explicit "fact vs inference vs narrative" separation |
| Never get fabricated numbers | Evidence Inbox: create a pending task → you submit → validated → research resumes |
| Ask "should I buy now?" | Investment Decision Engine: conditional recommendation, **mandatory counter-evidence and invalidation conditions**, review trail |
| Know your real return | Append-only ledger: FIFO realized/unrealized, TWR, XIRR, multi-currency net worth |
| Plan compounding | Deterministic calculator: contributions, irregular cashflows, inflation, fees, goal solving |
| Learn the jargon | Financial learning: 3 explanation levels, measurement rules, common misconceptions, favourites |

Three non-negotiables: **no invented numbers**, **all financial math is deterministic code**, **no real trading**.

## Install

```bash
git clone <this repo> dsh-investment-assistant
cd dsh-investment-assistant
npm install          # runs build (tsc + client bundle)
```

Register it into a DSH profile, then restart DSH:

- In DSH: `install_bundle` with this repo's absolute path, **or**
- CLI: `npx @deepseek-ai/dsh@<same version as your install> plugin --profile desktop add /abs/path`

Troubleshooting: [docs/plugin-install.md](docs/plugin-install.md).

## Usage in 30 seconds

1. **Ask** — in chat: "Should I allocate to CSI 300 now?" The `investment-advisor` skill gathers evidence, finds counter-evidence, and saves the advice (the tool refuses directional advice without both).
2. **Panel** — sidebar → *Investment Assistant* → five sections: Overview / Judgement / Market Research / My Capital / Settings.
3. **Missing data** — the system creates an evidence request (Overview → Todo) instead of guessing.
4. **Real return** — say "create an account, deposit 10,000, buy 10 shares at 10 with 5 fee", then ask for `capital_performance`.
5. **Explain a term** — Market Research → Learning, or the inline explainer inside the Judgement page.

## Tools (highlights)

- Policy: `policy_collect` `policy_search` `policy_compare` `policy_impact` `policy_execution` `global_to_china_impact`
- Evidence: `evidence_request_create` `evidence_submit` `evidence_validate` `evidence_research_resume`
- Judgement: `investment_advice_generate` `investment_advice_review` `investment_evidence_check`
- Capital: `capital_transaction_add` `capital_ledger_import_preview` `capital_networth_snapshot` `capital_performance`
- Wealth: `compound_calculate` `wealth_goal_solve` `wealth_plan_compare`
- Learning: `financial_concept_explain` `financial_concept_search` `financial_learning_progress`

## Tests

```bash
npm run test:policy test:evidence test:capital test:wealth test:investment test:learn test:regressions
```

All suites are offline and deterministic. Known Windows-only failures: `test:offline` (POSIX fake CLI) and `test:personal` (POSIX file mode).

## Privacy

Runtime data lives under `data/` (gitignored). The repo contains no holdings, ledgers, research notes, API keys or conversations. See [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE) for upstream attribution and third-party resources.

> Research and planning tool only. Not investment advice, no return promises, no order execution.
