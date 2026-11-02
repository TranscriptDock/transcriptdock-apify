import { createHash } from 'node:crypto';
import { log } from 'apify';
import { createClient, transcribeVideo, validateInput } from './transcripts.mjs';

export const RESULT_EVENT = 'apify-default-dataset-item';
const ACTOR_ID = 'XPyfHR4ntccEGagtw';
const OWNER_ID = 'mYgyUUBLZsjhXtb8h';
const PROGRESS = 'NATIVE_PROGRESS';

export function nativeInput(raw, key) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || Object.keys(raw).some((name) => !['urls', 'timeoutSeconds'].includes(name))) {
        throw new Error('Use video links and a wait time only.');
    }
    // Reuse the same URL restrictions and API validation as the published Actor.
    return validateInput({ ...raw, apiKey: key, mode: 'captions_only', maxCredits: 1 });
}

export async function runNativeActor(actor, settings = process.env) {
    const env = actor.getEnv();
    if (settings.TRANSCRIPTDOCK_NATIVE_BILLING_ENABLED !== '1'
        || !actor.isAtHome() || env.actorId !== ACTOR_ID || !env.actorRunId) {
        throw new Error('Apify payments are not enabled for this version.');
    }
    if (env.userIsPaying !== '1' && env.userId !== OWNER_ID) {
        throw new Error('A paid Apify plan is required. No transcript was requested.');
    }
    const key = settings.TRANSCRIPTDOCK_APIFY_SERVICE_KEY;
    if (!key) throw new Error('The service is not ready. Contact us through Issues.');
    const input = nativeInput(await actor.getInput(), key);
    const client = createClient(key);
    try {
        const manager = actor.getChargingManager();
        const pricing = manager.getPricingInfo();
        const price = pricing.perEventPrices[RESULT_EVENT];
        if (!pricing.isPayPerEvent || !Number.isFinite(price) || price <= 0
            || Object.entries(pricing.perEventPrices).some(([name, amount]) => name !== RESULT_EVENT && amount !== 0)) {
            throw new Error('Transcript pricing is not ready. No transcript was requested.');
        }
        const maxCharge = manager.getMaxTotalChargeUsd();
        if (!Number.isFinite(maxCharge) || maxCharge < price) {
            throw new Error('Set a run budget covering at least one transcript.');
        }
        const fingerprint = createHash('sha256').update(JSON.stringify({
            urls: input.urls, timeoutSeconds: input.timeoutSeconds,
        })).digest('hex');
        const saved = await actor.getValue(PROGRESS);
        if (saved && (saved.runId !== env.actorRunId || saved.fingerprint !== fingerprint)) {
            throw new Error('The input changed. Start a new run.');
        }
        const progress = saved ?? { runId: env.actorRunId, fingerprint, nextIndex: 0, pendingIndex: null, outcomes: [] };
        if (!Number.isInteger(progress.nextIndex) || progress.nextIndex < 0 || progress.nextIndex > input.urls.length
            || !Array.isArray(progress.outcomes) || (progress.pendingIndex !== null && progress.pendingIndex !== progress.nextIndex)) {
            throw new Error('Saved progress needs review. Contact us through Issues.');
        }
        const dataset = await actor.openDataset();
        const { items } = await dataset.getData({ limit: 51 });
        const delivered = new Set();
        for (const row of items) {
            if (!Number.isInteger(row.inputIndex) || row.inputIndex < 0 || row.inputIndex >= input.urls.length
                || row.url !== input.urls[row.inputIndex] || row.status !== 'succeeded'
                || !row.transcript || delivered.has(row.inputIndex)) {
                throw new Error('The results changed. Contact us through Issues before resuming.');
            }
            delivered.add(row.inputIndex);
        }
        // Dataset writes are billed by Apify itself. Reconcile a lost push response
        // before resuming, rather than issuing another write and another charge.
        if (manager.getChargedEventCount(RESULT_EVENT) !== items.length) {
            throw new Error('The payment history needs review. Contact us through Issues.');
        }
        if (progress.pendingIndex !== null && !delivered.has(progress.pendingIndex)) {
            throw new Error('A previous result save was interrupted. Contact us through Issues before retrying.');
        }
        for (let index = progress.nextIndex; index < input.urls.length; index++) {
            if (!delivered.has(index)) {
                if (manager.calculateMaxEventChargeCountWithinLimit(RESULT_EVENT) < 1) {
                    log.info('Run budget reached. Remaining links were not requested.');
                    break;
                }
                const row = await transcribeVideo(client, input, env.actorRunId, index);
                if (row.status === 'succeeded' && row.transcript) {
                    progress.pendingIndex = index;
                    await actor.setValue(PROGRESS, progress);
                    // Only successful transcripts enter this dataset. Apify charges
                    // its native dataset event when the result is written.
                    await actor.pushData({ ...row, inputIndex: index });
                } else {
                    progress.outcomes.push({ url: row.url, jobId: row.jobId, status: row.status, error: row.error ?? null });
                }
            }
            progress.pendingIndex = null;
            progress.nextIndex = index + 1;
            await actor.setValue(PROGRESS, progress);
        }
        await actor.setValue('SUMMARY', {
            processedLinks: progress.nextIndex,
            totalLinks: input.urls.length,
            unchargedResults: progress.outcomes,
            help: 'Only completed transcripts in the results dataset are charged. Use Issues for support.',
        });
    } catch (error) {
        throw new Error(client.redactText(error instanceof Error ? error.message : String(error)));
    }
}
