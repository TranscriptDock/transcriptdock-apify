import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { Actor, ChargingManager, Configuration } from 'apify';
import { NATIVE_ACTOR_OPTIONS, nativeInput, RESULT_EVENT, runNativeActor } from '../src/native-runner.mjs';

// Local payment fixtures only. The real pinned Apify charging manager enforces
// prices and run limits; neither customer funds nor a live provider is used.
const key = 'td_live_native_local_fixture';
const url = 'https://www.youtube.com/watch?v=native-fixture';
const settings = { TRANSCRIPTDOCK_NATIVE_BILLING_ENABLED: '1', TRANSCRIPTDOCK_APIFY_SERVICE_KEY: key };
const copy = (value) => structuredClone(value);
async function fixture({ budget = 0.02, counts = 0, items = [], input = { urls: [url] }, event = RESULT_EVENT } = {}) {
    const pricing = { pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: {
        [event]: { eventPriceUsd: 0.01, eventTitle: 'Completed transcript' },
    } } };
    const manager = new ChargingManager(new Configuration({
        isAtHome: true, actorRunId: 'fixture-run', actorPricingInfo: JSON.stringify(pricing),
        chargedEventCounts: JSON.stringify({ [event]: counts }), maxTotalChargeUsd: budget,
    }), {});
    await manager.init();
    const values = new Map();
    const actor = {
        getEnv: () => ({ actorId: 'XPyfHR4ntccEGagtw', actorRunId: 'fixture-run', userId: 'fixture-user', userIsPaying: '1' }),
        isAtHome: () => true,
        getChargingManager: () => manager,
        getInput: async () => input,
        getValue: async (name) => copy(values.get(name) ?? null),
        setValue: async (name, value) => { values.set(name, copy(value)); },
        openDataset: async () => ({ getData: async () => ({ items: copy(items) }) }),
        pushData: async (row) => { items.push(copy(row)); await manager.charge({ eventName: RESULT_EVENT }); },
    };
    return { actor, manager, values, items };
}

async function withApi(work, { status = 'succeeded' } = {}) {
    const original = globalThis.fetch;
    let submissions = 0;
    const receipts = [];
    globalThis.fetch = async (target, init) => {
        assert.equal(new URL(target).origin, 'https://www.transcriptdock.com');
        assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${key}`);
        if (init.method === 'POST') {
            submissions++;
            const body = JSON.parse(init.body);
            assert.equal(body.mode, 'captions_only');
            assert.equal(body.max_credits, 1);
            receipts.push(new Headers(init.headers).get('idempotency-key'));
        }
        const body = String(target).includes('/transcripts/')
            ? { id: '00000000-0000-4000-8000-000000000002', source: { platform: 'youtube', media_id: 'native-fixture' }, source_origin: 'platform_captions', language: 'en', text: 'Local payment fixture.', segments: [], words: null, timing_granularity: 'segment', duration_seconds: 1, recognition: null, extraction_version: 'local-fixture', created_at: '2026-01-01T00:00:00Z' }
            : { id: '00000000-0000-4000-8000-000000000001', status, stage: null, created_at: '2026-01-01T00:00:00Z', result_id: status === 'succeeded' ? '00000000-0000-4000-8000-000000000002' : null,
                billing: { credits_reserved: 0, credits_charged: status === 'succeeded' ? 1 : 0, kind: 'captions' },
                error: status === 'failed' ? { code: 'NO_CAPTIONS', message: 'No captions available.', retryable: false } : null };
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    };
    try { return await work(() => submissions, receipts); } finally { globalThis.fetch = original; }
}

test('native input cannot choose a key, AI, a credit cap or an outside URL', () => {
    assert.equal(nativeInput({ urls: [url, url] }, key).urls.length, 1);
    for (const extra of [{ apiKey: key }, { mode: 'auto' }, { maxCredits: 99999999 }, { baseUrl: 'https://outside.test' }]) {
        assert.throws(() => nativeInput({ urls: [url], ...extra }, key));
    }
    for (const bad of ['https://instagram.com/reel/fixture', 'http://youtube.com/x', 'https://127.0.0.1/x', 'https://youtube.com.evil.test/x']) {
        assert.throws(() => nativeInput({ urls: [bad] }, key));
    }
});

test('real SDK budget stops before requesting the next video, and resumed runs do not charge twice', async () => {
    const f = await fixture({ budget: 0.01, input: { urls: [url, url + '2'] } });
    await withApi(async (submissions) => {
        await runNativeActor(f.actor, settings);
        assert.equal(submissions(), 1);
        assert.equal(f.items.length, 1);
        assert.equal(f.manager.getChargedEventCount(RESULT_EVENT), 1);
        await runNativeActor(f.actor, settings);
        assert.equal(submissions(), 1);
        assert.equal(f.manager.getChargedEventCount(RESULT_EVENT), 1);
    });
});

test('failed jobs are summarized without any dataset write or charge', async () => {
    const f = await fixture();
    await withApi(async () => { await runNativeActor(f.actor, settings); }, { status: 'failed' });
    assert.equal(f.items.length, 0);
    assert.equal(f.manager.getChargedEventCount(RESULT_EVENT), 0);
    assert.equal(f.values.get('SUMMARY').unchargedResults[0].status, 'failed');
});

test('missing pricing, free users, wrong Actor, disabled version and exhausted budgets spend nothing', async () => {
    await withApi(async (submissions) => {
        const wrongEvent = await fixture({ event: 'unconfigured-event' });
        await assert.rejects(runNativeActor(wrongEvent.actor, settings), /pricing/);
        const poor = await fixture({ budget: 0.001 });
        await assert.rejects(runNativeActor(poor.actor, settings), /budget/);
        const free = await fixture();
        free.actor.getEnv = () => ({ actorId: 'XPyfHR4ntccEGagtw', actorRunId: 'fixture-run', userId: 'free-user', userIsPaying: '0' });
        await assert.rejects(runNativeActor(free.actor, settings), /paid Apify plan/);
        const wrong = await fixture();
        wrong.actor.getEnv = () => ({ actorId: 'other-actor', actorRunId: 'fixture-run' });
        await assert.rejects(runNativeActor(wrong.actor, settings), /not enabled/);
        const off = await fixture();
        await assert.rejects(runNativeActor(off.actor, { ...settings, TRANSCRIPTDOCK_NATIVE_BILLING_ENABLED: '0' }));
        assert.equal(submissions(), 0);
    });
});

test('lost dataset response is reconciled on resume without a second provider request or charge', async () => {
    const f = await fixture();
    const push = f.actor.pushData;
    f.actor.pushData = async (row) => { await push(row); throw new Error('Lost fixture response'); };
    await withApi(async (submissions) => {
        await assert.rejects(runNativeActor(f.actor, settings), /Lost fixture response/);
        assert.equal(f.items.length, 1);
        f.actor.pushData = push;
        await runNativeActor(f.actor, settings);
        assert.equal(submissions(), 1);
        assert.equal(f.items.length, 1);
        assert.equal(f.manager.getChargedEventCount(RESULT_EVENT), 1);
    });
});

test('ambiguous save, modified input and payment mismatches stop without another charge', async () => {
    const f = await fixture();
    f.actor.pushData = async () => { throw new Error(`Fixture failure ${key}`); };
    await withApi(async (submissions) => {
        await assert.rejects(runNativeActor(f.actor, settings), (error) => !error.message.includes(key));
        await assert.rejects(runNativeActor(f.actor, settings), /interrupted/);
        assert.equal(submissions(), 1);
        f.actor.getInput = async () => ({ urls: [url + 'changed'] });
        await assert.rejects(runNativeActor(f.actor, settings), /input changed/);
        const mismatch = await fixture({ counts: 1 });
        await assert.rejects(runNativeActor(mismatch.actor, settings), /payment history/);
        assert.equal(submissions(), 1);
    });
});


test('native storage client does not retry an ambiguous dataset write', async (t) => {
    let writes = 0;
    const server = createServer((req, res) => {
        if (req.method === 'POST') writes++;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'fixture-interruption', message: 'Local interruption' } }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const actor = new Actor({ ...NATIVE_ACTOR_OPTIONS, apiBaseUrl: `http://127.0.0.1:${server.address().port}`, token: 'local-apify-fixture' });
    await actor.getChargingManager().init();
    await assert.rejects(actor.apifyClient.dataset('local-dataset-fixture').pushItems({ text: 'Local fixture only' }));
    assert.equal(writes, 1);
});
