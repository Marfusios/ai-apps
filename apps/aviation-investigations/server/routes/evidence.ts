/** Private evidence search creation and free pagination. Matched routes enforce network limits. */
import { randomUUID } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CreateEvidenceRequestSchema, CreateEvidenceResponseSchema, EvidencePageQuerySchema, EvidenceSearchIdSchema, type CreateEvidenceRequest } from '../../shared/contracts/evidence.js';
import { CaseDetailSchema } from '../../shared/contracts/cases.js';
import { NtsbNoSchema } from '../../shared/contracts/common.js';
import { ACCOUNT_GONE, lockLiveAccount, withLiveAccount } from '../auth/lifecycle.js';
import { claimBriefEvidence, deletedOrDeleting } from '../db/generations.js';
import { evidenceSearches } from '../db/schema/evidence.js';
import { caseSections } from '../db/schema/corpus.js';
import { readCaseDetail } from '../db/queries/case-views.js';
import { evidenceReservation } from '../evidence/pricing.js';
import { runEvidence } from '../evidence/run.js';
import { insertSearch, pageOf, readOwnedSearch, takeOverSearch, type EvidenceRow } from '../evidence/store.js';
import { crossSite } from '../http/origin.js';
import { issuesOf, JSON_TYPE, sendError } from '../http/reply.js';
import { admitPaidRequest, forgetIdempotency, releaseQuota, setResultRef, type Admission } from '../quota/admit.js';
import { canonicalRequestHash, principalHash, UnknownPrincipalError } from '../quota/policy.js';
import { settle } from '../quota/settle.js';
import { setLockTimeout } from '../quota/locks.js';
import { billing, checkAnonymousRetry, readersOf, sendRejection, visitor } from './briefs.js';
import type { ApiContext } from './context.js';

const NOT_FOUND = 'No AI search with that link is available. AI searches expire after 24 hours.';
const notFound = (reply: FastifyReply) => sendError(reply, 404, 'not_found', { message: NOT_FOUND });
const send = (reply: FastifyReply, row: EvidenceRow): FastifyReply => {
  const response = row.status === 'scope_reply' ? { kind: 'scope_reply', reply: row.data.reply } : { kind: 'results', search: pageOf(row, 1) };
  const valid = CreateEvidenceResponseSchema.parse(response);
  return reply.code(valid.kind === 'results' ? 201 : 200).type(JSON_TYPE).send(JSON.stringify(valid));
};

/** A replay is read by the current owner, never by the original billing principal alone. */
async function replay(ctx: ApiContext, request: FastifyRequest, reply: FastifyReply, id: string, body: CreateEvidenceRequest) {
  const ai = ctx.ai!;
  const who = await visitor(ctx, request);
  if (!who.account) {
    if (!ai.policy || !ai.llm || !ai.trials) return notFound(reply);
    const refused = await checkAnonymousRetry({ ai: { ...ai, policy: ai.policy, llm: ai.llm, trials: ai.trials } }, request, reply, body.turnstileToken);
    if (refused) return refused;
  }
  if (who.account && who.trial) {
    const account = who.account, trial = who.trial;
    await withLiveAccount(ctx.db, account, (tx) => takeOverSearch(tx, id, trial.hash, account.hash));
  }
  const row = await readOwnedSearch(ctx.db, id, readersOf(await visitor(ctx, request)), ai.now());
  if (!row) {
    if (who.trial) {
      const moved = await ctx.db.select({ id: evidenceSearches.id }).from(evidenceSearches).where(and(eq(evidenceSearches.id, id),
        eq(evidenceSearches.billingPrincipal, who.trial.hash), eq(evidenceSearches.readOwnerKind, 'account'), gt(evidenceSearches.expiresAt, ai.now())));
      if (moved.length) return sendError(reply, 403, 'moved');
    }
    return notFound(reply);
  }
  if (row.status === 'running') return sendError(reply, 429, 'in_flight');
  if (row.status === 'failed') return sendError(reply, 503, 'unavailable');
  return send(reply, row);
}

export function evidenceRoutes(app: FastifyInstance, ctx: ApiContext, appUrl: string): void {
  const origin = new URL(appUrl).origin;
  async function create(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    if (crossSite(request, origin)) return sendError(reply, 403, 'forbidden');
    const parsed = CreateEvidenceRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', { issues: issuesOf(parsed.error.issues) });
    const body = parsed.data;
    const ai = ctx.ai, svc = ctx.evidence;
    if (!ai?.startup.enabled || !ai.policy || !ai.trials || !ai.llm?.evidenceScope || !ai.startup.models || !svc || svc.shutdown.aborted) return sendError(reply, 503, 'unavailable');
    const runtime = { ai: { ...ai, policy: ai.policy, llm: ai.llm, trials: ai.trials } };
    const { turnstileToken: _token, idempotencyKey: _key, ...content } = body;
    const requestHash = canonicalRequestHash({ version: 'evidence.v1', ...content });
    let who = await visitor(ctx, request);
    // Replay before availability/budget checks, with a fresh anonymous Turnstile token.
    for (const reader of readersOf(who)) {
      const earlier = await ctx.db.execute(sql`SELECT request_hash, result_ref FROM idempotency
        WHERE principal_hash = ${reader.hash} AND idempotency_key = ${body.idempotencyKey} AND expires_at > ${ai.now()}`);
      const prior = earlier.rows[0] as { request_hash: string; result_ref: string | null } | undefined;
      if (prior) {
        if (prior.request_hash !== requestHash) return sendError(reply, 409, 'conflict');
        const id = /^evidence:([0-9a-f-]{36})$/.exec(prior.result_ref ?? '')?.[1];
        return id ? replay(ctx, request, reply, id, body) : sendError(reply, 429, 'in_flight');
      }
    }
    const parent = body.kind === 'edited' ? await readOwnedSearch(ctx.db, body.from, readersOf(who), ai.now()) : null;
    if (body.kind === 'edited' && (!parent || parent.status !== 'results')) return notFound(reply);
    const pinned = await ctx.datasets.current().catch(() => null);
    if (!pinned?.passages?.servable || !pinned.manifest.passagesIndex || !(await svc.retriever.available(pinned))) return sendError(reply, 503, 'unavailable');
    if (svc.shutdown.aborted) return sendError(reply, 503, 'unavailable');
    const billed = await billing(ctx, runtime, request, reply, who, body.turnstileToken);
    if (!billed.ok) return billed.reply;
    who = billed.who;
    if (svc.shutdown.aborted) return sendError(reply, 503, 'unavailable');
    const payer = billed.payer;
    const { reservationUsd } = evidenceReservation(ai.llm.models.scope, ai.startup.models.embed);
    let admitted;
    try {
      admitted = await admitPaidRequest(ctx.db, { policy: ai.policy, principal: payer.principal, networkId: payer.networkId,
        idempotencyKey: body.idempotencyKey, requestHash, reservationUsd, requestId: `evidence:${randomUUID()}`, now: ai.now(),
        ...(payer.account ? { precondition: (tx) => lockLiveAccount(tx, payer.account!) } : {}) });
    } catch (err) {
      if (err instanceof UnknownPrincipalError) return sendError(reply, 403, 'challenge_required');
      throw err;
    }
    if (!admitted.ok) return sendRejection(reply, admitted, ai.now());
    if (admitted.replay) {
      const id = /^evidence:([0-9a-f-]{36})$/.exec(admitted.resultRef ?? '')?.[1];
      return id ? replay(ctx, request, reply, id, body) : sendError(reply, 429, 'in_flight');
    }
    const admission: Admission = admitted;
    const abandon = async () => {
      await releaseQuota(ctx.db, admission, admission.fencingToken, { policy: ai.policy!, now: ai.now() });
      await settle(ctx.db, admission, 0, admission.fencingToken, ai.now());
      await forgetIdempotency(ctx.db, admission, ai.now());
    };
    if (svc.shutdown.aborted) { await abandon(); return sendError(reply, 503, 'unavailable'); }
    let row: EvidenceRow | null | typeof ACCOUNT_GONE;
    try {
      const write = async (tx: Parameters<typeof lockLiveAccount>[0]): Promise<EvidenceRow | null> => {
        await setLockTimeout(tx);
        if ((await claimBriefEvidence(tx, { generationId: pinned.manifest.generationId, passagesIndex: pinned.manifest.passagesIndex! })) !== 'ok' ||
            (await deletedOrDeleting(tx, [pinned.manifest.casesIndex])).length > 0) return null;
        let source = parent;
        if (body.kind === 'edited') {
          // A concurrent deletion or handover cannot give a new search a stale private question.
          if (payer.account && who.trial) await takeOverSearch(tx, body.from, who.trial.hash, payer.account.hash);
          source = await readOwnedSearch(tx, body.from, readersOf(who), ai.now(), true);
          if (!source?.data.interpretation) return null;
        }
        const inserted = await insertSearch(tx, {
          readOwner: principalHash(ai.policy!, payer.principal), readOwnerKind: payer.principal.kind,
          billingPrincipal: admission.principalHash, billingKind: payer.principal.kind, reservationId: admission.reservationId,
          generationId: pinned.manifest.generationId, casesIndex: pinned.manifest.casesIndex, passagesIndex: pinned.manifest.passagesIndex!, now: ai.now(),
          data: { question: body.kind === 'question' ? body.question : source!.data.question, edited: body.kind === 'edited',
            ...(body.kind === 'edited' ? { interpretation: { filters: body.filters, terms: body.terms, unchecked: source!.data.interpretation!.unchecked } } : {}),
            context: { dataset: pinned.dataset, citationTextVersion: pinned.manifest.citationTextVersion,
              fieldNormalizationVersion: pinned.fieldNormalizationVersion, mappingVerified: pinned.manifest.mappingVerified } },
        });
        await setResultRef(tx, admission, `evidence:${inserted.id}`);
        return inserted;
      };
      row = payer.account ? await withLiveAccount(ctx.db, payer.account, write) : await ctx.db.transaction(write);
    } catch { await abandon(); return sendError(reply, 503, 'unavailable'); }
    if (!row || row === ACCOUNT_GONE) { await abandon(); return sendError(reply, row === ACCOUNT_GONE ? 403 : 503, row === ACCOUNT_GONE ? 'signed_out' : 'unavailable'); }
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.once('aborted', abort);
    const onClose = () => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.once('close', onClose);
    svc.runs.set(row.id, { controller });
    try {
      await runEvidence(ctx, row, pinned, admission, AbortSignal.any([controller.signal, svc.shutdown, AbortSignal.timeout(30_000)]), row.data.interpretation);
      const current = await visitor(ctx, request);
      // A newly issued trial cookie is on the response, not yet on this request.
      // Sessions are re-read; only the trial just proved/issued by billing can be carried forward.
      const completed = await readOwnedSearch(ctx.db, row.id, readersOf({ ...current, trial: current.trial ?? who.trial }), ai.now());
      return completed ? send(reply, completed) : notFound(reply);
    } catch {
      // Only fixed categories leave this route, including storage failures containing private query values.
      request.log.warn({ outcome: 'failed' }, 'evidence request unavailable');
      return sendError(reply, 503, 'unavailable');
    } finally {
      request.raw.off('aborted', abort); reply.raw.off('close', onClose); svc.runs.delete(row.id);
    }
  }
  app.post('/api/evidence', async (request, reply) => ctx.evidence ? ctx.evidence.track(() => create(request, reply)) : create(request, reply));
  app.get<{ Params: { id: string } }>('/api/evidence/:id', async (request, reply) => {
    const id = EvidenceSearchIdSchema.safeParse(request.params.id), query = EvidencePageQuerySchema.safeParse(request.query ?? {});
    if (!id.success || !ctx.ai) return notFound(reply);
    if (!query.success) return sendError(reply, 400, 'bad_request');
    const row = await readOwnedSearch(ctx.db, id.data, readersOf(await visitor(ctx, request)), ctx.ai.now());
    const page = row ? pageOf(row, query.data.page) : null;
    return page ? reply.type(JSON_TYPE).send(JSON.stringify(page)) : notFound(reply);
  });
  /** Authoritative full sections at the search's generation (no current-manifest lookup). */
  app.get<{ Params: { id: string; ntsbNo: string } }>('/api/evidence/:id/cases/:ntsbNo', async (request, reply) => {
    const id = EvidenceSearchIdSchema.safeParse(request.params.id), n = NtsbNoSchema.safeParse(request.params.ntsbNo);
    if (!id.success || !n.success || !ctx.ai) return notFound(reply);
    const row = await readOwnedSearch(ctx.db, id.data, readersOf(await visitor(ctx, request)), ctx.ai.now());
    if (!row || row.status !== 'results' || !row.data.ranking?.some((c) => c.ntsbNo === n.data)) return notFound(reply);
    const detail = await readCaseDetail(ctx.db, row.generationId, n.data, row.data.context);
    if (!detail) return notFound(reply);
    // Public case pages use a text hash; evidence provenance names the canonical revision id.
    const revisions = await ctx.db.select({ key: caseSections.sectionKey, revision: caseSections.revisionId }).from(caseSections)
      .where(and(eq(caseSections.generationId, row.generationId), eq(caseSections.ntsbNo, n.data)));
    const byKey = new Map(revisions.map((s) => [s.key, s.revision]));
    const canonical = { ...detail, sections: detail.sections.map((s) => {
      const revision = byKey.get(s.key);
      if (!revision) throw new Error('missing canonical context revision');
      return { ...s, revision };
    }) };
    return reply.type(JSON_TYPE).send(JSON.stringify(CaseDetailSchema.parse(canonical)));
  });
}
