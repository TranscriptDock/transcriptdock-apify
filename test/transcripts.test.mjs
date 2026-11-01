import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createClient, transcribeVideo, validateInput } from '../src/transcripts.mjs';
import { runActor } from '../src/runner.mjs';

// Local fixtures only. These are not real jobs, credentials or provider results.
const apiKey = 'td_live_local_fixture_only';
const url = 'https://www.youtube.com/watch?v=local-fixture';
const jobId = '00000000-0000-4000-8000-000000000001';
const resultId = '00000000-0000-4000-8000-000000000002';
const job = {
    id: jobId, status: 'succeeded', stage: null, result_id: resultId, error: null,
    billing: { credits_reserved: 0, credits_charged: 1, kind: 'captions' },
    created_at: '2026-01-01T00:00:00Z',
};
const transcript = {
    id: resultId, source: { platform: 'youtube', media_id: 'local-fixture' },
    source_origin: 'platform_captions', language: 'en', text: 'Local fixture text.',
    segments: [{ start: 0, end: 1, text: 'Local fixture text.' }], words: null,
    timing_granularity: 'segment', duration_seconds: 1, recognition: null,
    extraction_version: 'local-fixture', created_at: '2026-01-01T00:00:00Z',
};
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test('validate the complete input before spending and require explicit AI selection', () => {
    assert.equal(validateInput({ apiKey, urls: [url, url] }).urls.length, 1);
    assert.equal(validateInput({ apiKey, urls: [url] }).mode, 'captions_only');
    for (const bad of ['https://youtube.com.evil.test/x', 'http://youtube.com/x',
        'https://user:password@youtube.com/x', 'https://127.0.0.1/x']) {
        assert.throws(() => validateInput({ apiKey, urls: [url, bad] }));
    }
    assert.throws(() => validateInput({ apiKey, urls: ['https://instagram.com/reel/fixture'] }), /Instagram/);
    assert.throws(() => validateInput({ apiKey, urls: [url], mode: 'translate' }));
    assert.throws(() => validateInput({ apiKey, urls: [url], language: 'fr' }), /unsupported/);
    assert.throws(() => validateInput({ apiKey, urls: [url], maxCredits: 0 }));
    assert.throws(() => validateInput({ apiKey: 'td_live_bad\nkey', urls: [url] }));
});

test('retry a throttled submission with the same receipt and credit cap', async () => {
    const requests = [];
    const sleeps = [];
    let submissions = 0;
    const client = createClient(apiKey, {
        sleep: async (ms) => sleeps.push(ms),
        fetchImpl: async (target, init) => {
            requests.push({ target, init });
            if (init.method === 'POST' && ++submissions === 1) return response({}, 429, { 'Retry-After': '2' });
            if (target.includes('/transcripts/')) return response(transcript);
            return response(job);
        },
    });
    const input = validateInput({ apiKey, urls: [url], mode: 'auto', maxCredits: 7 });
    const row = await transcribeVideo(client, input, 'fixture-run', 0);
    const posts = requests.filter((r) => r.init.method === 'POST');
    assert.equal(posts.length, 2);
    assert.equal(new Headers(posts[0].init.headers).get('idempotency-key'), new Headers(posts[1].init.headers).get('idempotency-key'));
    assert.equal(JSON.parse(posts[1].init.body).max_credits, 7);
    assert.equal(row.transcript.text, transcript.text);
    assert.deepEqual(sleeps, [2000]);
    assert.ok(requests.every((r) => new URL(r.target).origin === 'https://www.transcriptdock.com'));
});

test('pending and failed jobs never produce a success transcript', async () => {
    let now = 0;
    const pending = { ...job, status: 'queued', result_id: null };
    const input = validateInput({ apiKey, urls: [url], timeoutSeconds: 5 });
    const client = createClient(apiKey, { fetchImpl: async () => response(pending) });
    const row = await transcribeVideo(client, input, 'fixture-pending', 0, {
        now: () => now, sleep: async (ms) => { now += ms; },
    });
    assert.equal(row.timedOut, true);
    assert.equal(row.status, 'queued');
    assert.equal(row.transcript, undefined);
    const failedClient = createClient(apiKey, { fetchImpl: async () => response({
        ...pending, status: 'failed', error: { code: 'NO_CAPTIONS', message: 'No captions.', retryable: false },
    }) });
    const failed = await transcribeVideo(failedClient, input, 'fixture-failed', 0);
    assert.equal(failed.error.code, 'NO_CAPTIONS');
    assert.equal(failed.transcript, undefined);
});

test('a long Retry-After does not trigger an early retry', async () => {
    let calls = 0;
    const client = createClient(apiKey, {
        fetchImpl: async () => { calls++; return response({}, 429, { 'Retry-After': '3600' }); },
        sleep: async () => assert.fail('Do not shorten the server retry delay'),
    });
    await assert.rejects(() => client.createJob({ url, mode: 'captions_only', language: null, max_credits: 1 }, 'fixture-throttle'));
    assert.equal(calls, 1);
});

test('a redirect cannot send the API key to another host', async (t) => {
    let attackerHits = 0;
    const attacker = createServer((_req, res) => { attackerHits++; res.end('{}'); });
    const origin = createServer((_req, res) => {
        res.writeHead(302, { Location: `http://127.0.0.1:${attacker.address().port}/steal` });
        res.end();
    });
    for (const server of [attacker, origin]) {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        t.after(() => new Promise((resolve) => server.close(resolve)));
    }
    const client = createClient(apiKey, {
        sleep: async () => {},
        fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${origin.address().port}/`, init),
    });
    await assert.rejects(() => client.createJob({ url, mode: 'captions_only', language: null, max_credits: 1 }, 'fixture-redirect'));
    assert.equal(attackerHits, 0);
});

test('recovery replays the receipt, skips checkpointed work and isolates changed credentials', async (t) => {
    const receipts = new Set();
    let charged = 0;
    t.mock.method(globalThis, 'fetch', async (target, init) => {
        if (init.method === 'POST') {
            const key = new Headers(init.headers).get('idempotency-key');
            if (!receipts.has(key)) { receipts.add(key); charged++; }
        }
        return response(target.includes('/transcripts/') ? transcript : job);
    });
    let progress = null;
    let failCheckpoint = true;
    let runId = 'fixture-recovery';
    let key = apiKey;
    const rows = [];
    const actor = {
        getInput: async () => ({ apiKey: key, urls: [url] }),
        getEnv: () => ({ actorRunId: runId }),
        getValue: async () => progress,
        setValue: async (_name, value) => {
            if (failCheckpoint) { failCheckpoint = false; throw new Error('Local fixture checkpoint failure'); }
            progress = value;
        },
        pushData: async (row) => rows.push(row), log: { info() {} },
    };
    await assert.rejects(() => runActor(actor), /checkpoint failure/);
    await runActor(actor);
    assert.equal(charged, 1);
    assert.equal(rows.length, 2); // Dataset delivery is at least once; deduplicate by jobId.
    await runActor(actor);
    assert.equal(charged, 1);
    const validProgress = progress;
    progress = { ...progress, nextIndex: 500 };
    await assert.rejects(() => runActor(actor), /progress is invalid/);
    progress = validProgress;
    key = 'td_live_other_local_tenant';
    await assert.rejects(() => runActor(actor), /different input/);
    assert.equal(charged, 1);
    runId = 'fixture-new-run';
    await runActor(actor);
    assert.equal(charged, 2);
});

test('authorization failure stops the run and redacts echoed credentials', async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return response({ error: { code: 'UNAUTHORIZED', message: `Rejected ${apiKey}`, retryable: false } }, 401);
    });
    const actor = {
        getInput: async () => ({ apiKey, urls: [url, 'https://youtu.be/another-fixture'] }),
        getEnv: () => ({ actorRunId: 'fixture-auth' }), getValue: async () => null,
        pushData: async () => assert.fail('No success output allowed'), log: { info() {} },
    };
    await assert.rejects(() => runActor(actor), (error) => !error.message.includes(apiKey) && error.message.includes('[REDACTED]'));
    assert.equal(calls, 1);
});
