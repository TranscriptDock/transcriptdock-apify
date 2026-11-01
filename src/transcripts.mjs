import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { TranscriptDockClient, waitForJob } from '@transcriptdock/mcp/client';

const ORIGIN = 'https://www.transcriptdock.com';
const HOSTS = new Set([
    'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be',
    'tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com',
    'instagram.com', 'www.instagram.com',
]);

export function validateInput(input) {
    if (!input || typeof input.apiKey !== 'string' || !/^td_live_[A-Za-z0-9_-]+$/.test(input.apiKey)) {
        throw new Error('Enter your Transcript Dock API key.');
    }
    const fields = new Set(['apiKey', 'urls', 'mode', 'maxCredits', 'timeoutSeconds']);
    if (Object.keys(input).some((key) => !fields.has(key))) throw new Error('Remove unsupported input options.');
    const { mode = 'captions_only', maxCredits = 10, timeoutSeconds = 300 } = input;
    if (!['captions_only', 'auto', 'transcribe'].includes(mode)) throw new Error('Choose a supported transcription mode.');
    if (!Number.isSafeInteger(maxCredits) || maxCredits < 1 || maxCredits > 100000) {
        throw new Error('Set a credit cap per video from 1 to 100000.');
    }
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 1800) {
        throw new Error('Set the wait per video from 5 to 1800 seconds.');
    }
    if (!Array.isArray(input.urls) || input.urls.length < 1 || input.urls.length > 50) {
        throw new Error('Enter between 1 and 50 video links.');
    }
    const urls = [...new Set(input.urls.map((value) => {
        let url;
        try { url = new URL(value); } catch { throw new Error('Enter valid video links.'); }
        if (typeof value !== 'string' || value.length > 2048 || url.protocol !== 'https:'
            || url.username || url.password || url.port || !HOSTS.has(url.hostname)) {
            throw new Error('Use HTTPS links from YouTube, TikTok or Instagram.');
        }
        if (url.hostname.endsWith('instagram.com') && mode === 'captions_only') {
            throw new Error('Instagram Reels need auto or transcribe mode on a paid plan.');
        }
        return value;
    }))];
    return { apiKey: input.apiKey, urls, mode, maxCredits, timeoutSeconds };
}

export function createClient(apiKey, { fetchImpl = fetch, sleep = setTimeout, now = Date.now } = {}) {
    const boundedFetch = async (url, init) => {
        for (let attempt = 0; attempt < 3; attempt++) {
            let response;
            try {
                response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30000) });
            } catch {
                if (attempt === 2) throw new Error('Could not reach Transcript Dock.');
                await sleep(1000 * 2 ** attempt);
                continue;
            }
            if (![429, 502, 503, 504].includes(response.status) || attempt === 2) return response;
            const header = response.headers.get('retry-after');
            const retryAfter = header && (/^\d+$/.test(header)
                ? Number(header) * 1000 : Date.parse(header) - now());
            const delay = Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : 1000 * 2 ** attempt;
            if (delay > 60000) return response;
            await response.body?.cancel();
            await sleep(delay);
        }
    };
    return new TranscriptDockClient({ apiKey, baseUrl: ORIGIN }, boundedFetch);
}

export async function transcribeVideo(client, input, runId, index, waitOptions = {}) {
    const url = input.urls[index];
    const key = `apify-${createHash('sha256').update(`${runId}:${index}`).digest('hex')}`;
    const created = await client.createJob({ url, mode: input.mode, language: null, max_credits: input.maxCredits }, key);
    const { job, timed_out: timedOut } = await waitForJob(client, created.id, input.timeoutSeconds, {
        serverWaitSeconds: 25, pollIntervalMs: 1000, ...waitOptions,
    });
    const row = { url, jobId: job.id, status: job.status, timedOut, billing: job.billing };
    if (job.status === 'succeeded') {
        if (!job.result_id) throw new Error('Transcript Dock returned a completed job without a transcript.');
        row.transcript = await client.getTranscript(job.result_id);
    } else if (job.status === 'failed' || job.status === 'cancelled') {
        row.error = job.error ? { code: job.error.code, message: client.redactText(job.error.message) } : null;
    }
    return row;
}
