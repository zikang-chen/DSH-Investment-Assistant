import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { evaluatePortfolioPolicy, type PortfolioPolicyInput, type PortfolioPolicyResult } from './portfolio-policy.js';

export type PortfolioVersionState = 'draft' | 'review' | 'approved' | 'rejected' | 'retired';
export type PortfolioVersionAction = 'submit' | 'approve' | 'reject' | 'retire';
export type PortfolioVersionActor = 'user' | 'agent';
export interface PortfolioReviewSnapshot {
  at: string;
  /** Evaluation uses this explicitly supplied date, NOT a hidden system-clock date. */
  asOf: string;
  policyHash: string;
  inputHash: string;
  evaluation: PortfolioPolicyResult;
}
export interface PortfolioVersionHistory {
  action: 'save' | PortfolioVersionAction;
  state: PortfolioVersionState;
  revision: number;
  reason: string;
  actor: PortfolioVersionActor;
  at: string;
  policyHash: string;
  inputHash: string;
}
export interface PortfolioVersionEntry {
  id: string;
  name: string;
  version: number;
  policy: PortfolioPolicyInput;
  policyHash: string;
  inputHash: string;
  state: PortfolioVersionState;
  revision: number;
  parentId?: string;
  reason: string;
  createdAt: string;
  evaluation: PortfolioPolicyResult;
  reviewSnapshot?: PortfolioReviewSnapshot;
  history: PortfolioVersionHistory[];
}
export interface PortfolioVersionSaveInput {
  policy: PortfolioPolicyInput;
  name: string;
  parentId?: string;
  reason: string;
  expectedParentRevision?: number;
}
export interface PortfolioVersionTransitionInput {
  id: string;
  action: PortfolioVersionAction;
  expectedRevision: number;
  reason: string;
  actor?: PortfolioVersionActor;
}
export interface PortfolioVersionsFile {
  schemaVersion: 1;
  entries: PortfolioVersionEntry[];
  updatedAt: string;
}

const transitions: Record<PortfolioVersionAction, { from: PortfolioVersionState; to: PortfolioVersionState }> = {
  submit: { from: 'draft', to: 'review' }, approve: { from: 'review', to: 'approved' },
  reject: { from: 'review', to: 'rejected' }, retire: { from: 'approved', to: 'retired' },
};
const locks = new Map<string, Promise<unknown>>();
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v === v.trim();
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const timestamp = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const jsonValue = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Portfolio versions: ${message}`);
}
function validEvaluation(policy: PortfolioPolicyInput): PortfolioPolicyResult {
  const result = evaluatePortfolioPolicy(policy);
  assert(result.ok, `invalid policy: ${result.errors.join('; ')}`);
  return result;
}
function approvable(evaluation: PortfolioPolicyResult): void {
  assert(evaluation.ok && evaluation.status !== 'BLOCKED', 'BLOCKED policy cannot be approved');
  assert(evaluation.proposed, 'missing/future/stale prices or missing paper proposal; cannot approve');
}

/** Independent paper-policy versions. Never reads/writes holdings, accounts or the ledger.
 * Atomic rename + process-wide, per-path serialization protects concurrent instances in this
 * process. This is not an inter-process lock; callers must use a single owning process.
 * Every read reloads the file; only ENOENT means empty. Malformed data is never repaired silently.
 */
export class PortfolioVersionStore {
  readonly path: string;
  private readonly lockKey: string;
  private readonly now: () => string;

  constructor(dir: string, opts?: { now?: () => string }) {
    this.path = path.resolve(dir, 'portfolio-strategies.json');
    this.lockKey = process.platform === 'win32' ? this.path.toLowerCase() : this.path;
    this.now = opts?.now ?? (() => new Date().toISOString());
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const previous = locks.get(this.lockKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    locks.set(this.lockKey, next);
    void next.finally(() => { if (locks.get(this.lockKey) === next) locks.delete(this.lockKey); }).catch(() => undefined);
    return next;
  }

  private async readState(): Promise<PortfolioVersionsFile> {
    let raw: string;
    try { raw = await readFile(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, entries: [], updatedAt: '' };
      throw error;
    }
    const data: unknown = JSON.parse(raw); // Preserve the original SyntaxError.
    assert(record(data) && data.schemaVersion === 1 && Array.isArray(data.entries) && timestamp(data.updatedAt), 'invalid file envelope');
    const ids = new Set<string>();
    for (const value of data.entries) {
      assert(record(value), 'invalid entry');
      const e = value as unknown as PortfolioVersionEntry;
      assert(text(e.id) && !ids.has(e.id) && text(e.name) && text(e.reason), 'invalid/duplicate id, name or reason');
      ids.add(e.id);
      assert(positive(e.version) && positive(e.revision) && timestamp(e.createdAt), 'invalid version/revision/date');
      assert(e.parentId === undefined || text(e.parentId), 'invalid parentId');
      const evaluation = validEvaluation(e.policy);
      assert(e.policyHash === evaluation.policyHash && e.inputHash === evaluation.inputHash, 'policy hash mismatch');
      assert(isDeepStrictEqual(e.evaluation, jsonValue(evaluation)), 'evaluation mismatch');
      assert(Array.isArray(e.history) && e.history.length === e.revision, 'history/revision mismatch');
      let state: PortfolioVersionState = 'draft';
      e.history.forEach((h, i) => {
        assert(record(h) && h.revision === i + 1 && text(h.reason) && timestamp(h.at) &&
          (h.actor === 'user' || h.actor === 'agent') && h.policyHash === e.policyHash && h.inputHash === e.inputHash, 'invalid history');
        if (i === 0) assert(h.action === 'save' && h.state === 'draft' && h.at === e.createdAt && h.reason === e.reason, 'invalid creation history');
        else {
          const t = Object.hasOwn(transitions, h.action) ? transitions[h.action as PortfolioVersionAction] : undefined;
          assert(t && t.from === state && t.to === h.state, 'invalid history transition');
          if (h.action === 'approve') { assert(h.actor === 'user', 'approval requires user'); approvable(evaluation); }
          state = t.to;
        }
      });
      assert(e.state === state, 'invalid state/history');
      if (state === 'draft') assert(e.reviewSnapshot === undefined, 'draft has review snapshot');
      else {
        const snapshot = e.reviewSnapshot;
        assert(record(snapshot) && snapshot.at === e.history[1]?.at && snapshot.asOf === e.policy.asOf &&
          snapshot.policyHash === e.policyHash && snapshot.inputHash === e.inputHash &&
          isDeepStrictEqual(snapshot.evaluation, jsonValue(evaluation)), 'invalid review hash snapshot');
      }
    }
    const entries = data.entries as PortfolioVersionEntry[];
    for (const e of entries) {
      const parent = e.parentId === undefined ? undefined : entries.find(p => p.id === e.parentId);
      assert(e.parentId === undefined ? e.version === 1 : parent && parent.version + 1 === e.version, 'missing parent or invalid version lineage');
    }
    return data as unknown as PortfolioVersionsFile;
  }

  private async persist(data: PortfolioVersionsFile): Promise<void> {
    await mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(tmp, this.path);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  async list(): Promise<PortfolioVersionEntry[]> {
    return this.serial(async () => structuredClone((await this.readState()).entries));
  }
  async get(id: string): Promise<PortfolioVersionEntry | undefined> {
    return this.serial(async () => structuredClone((await this.readState()).entries.find(e => e.id === id)));
  }

  async save(input: PortfolioVersionSaveInput): Promise<PortfolioVersionEntry> {
    // Clone before the first await so mutations by callers cannot change queued requests.
    const request = structuredClone(input);
    return this.serial(async () => {
      const data = await this.readState();
      assert(text(request.name) && text(request.reason), 'name and reason are required');
      assert(request.parentId === undefined || text(request.parentId), 'invalid parentId');
      assert(request.expectedParentRevision === undefined || positive(request.expectedParentRevision), 'invalid expectedParentRevision');
      const parent = request.parentId === undefined ? undefined : data.entries.find(e => e.id === request.parentId);
      assert(request.parentId === undefined || parent, 'parent does not exist');
      assert(request.expectedParentRevision === undefined || (parent && parent.revision === request.expectedParentRevision), 'parent revision conflict');
      const evaluation = validEvaluation(request.policy);
      // Persistence must not normalize away unsupported/undefined/non-JSON policy data.
      assert(isDeepStrictEqual(validEvaluation(jsonValue(request.policy) as PortfolioPolicyInput), evaluation), 'policy must retain its evaluation after JSON serialization');
      const at = this.now();
      assert(timestamp(at), 'invalid clock timestamp');
      const entry: PortfolioVersionEntry = {
        id: `pv_${randomUUID()}`, name: request.name, version: parent ? parent.version + 1 : 1,
        policy: request.policy, policyHash: evaluation.policyHash, inputHash: evaluation.inputHash,
        state: 'draft', revision: 1, ...(parent ? { parentId: parent.id } : {}), reason: request.reason,
        createdAt: at, evaluation,
        history: [{ action: 'save', state: 'draft', revision: 1, reason: request.reason, actor: 'agent', at,
          policyHash: evaluation.policyHash, inputHash: evaluation.inputHash }],
      };
      data.entries.push(entry);
      data.updatedAt = at;
      await this.persist(data);
      return structuredClone(entry);
    });
  }

  async transition(input: PortfolioVersionTransitionInput): Promise<PortfolioVersionEntry> {
    const request = structuredClone(input);
    return this.serial(async () => {
      const data = await this.readState();
      assert(text(request.id) && text(request.reason) && positive(request.expectedRevision), 'id, reason and expectedRevision are required');
      const actor = request.actor ?? 'agent';
      assert(actor === 'user' || actor === 'agent', 'invalid actor');
      const e = data.entries.find(entry => entry.id === request.id);
      assert(e, 'entry does not exist');
      assert(e.revision === request.expectedRevision, 'revision conflict');
      const target = Object.hasOwn(transitions, request.action) ? transitions[request.action] : undefined;
      assert(target && e.state === target.from, `illegal transition: ${e.state} -> ${request.action}`);
      const evaluation = validEvaluation(e.policy); // Deliberately retain the stored explicit asOf.
      assert(evaluation.policyHash === e.policyHash && evaluation.inputHash === e.inputHash, 'policy hash mismatch');
      if (request.action === 'approve') {
        assert(actor === 'user', 'approval requires actor=user (paper tracking only)');
        approvable(evaluation);
        assert(e.reviewSnapshot?.policyHash === evaluation.policyHash && e.reviewSnapshot?.inputHash === evaluation.inputHash,
          'review hash conflict; create a new version');
      }
      const at = this.now();
      assert(timestamp(at), 'invalid clock timestamp');
      if (request.action === 'submit') e.reviewSnapshot = {
        at, asOf: e.policy.asOf, policyHash: evaluation.policyHash, inputHash: evaluation.inputHash, evaluation: structuredClone(evaluation),
      };
      e.state = target.to;
      e.revision += 1;
      e.history.push({ action: request.action, state: e.state, revision: e.revision, reason: request.reason, actor, at,
        policyHash: e.policyHash, inputHash: e.inputHash });
      data.updatedAt = at;
      await this.persist(data);
      return structuredClone(e);
    });
  }
}
