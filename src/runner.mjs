import { createHash, randomUUID } from 'node:crypto';
import { createClient, transcribeVideo, validateInput } from './transcripts.mjs';

export async function runActor(actor) {
    const input = validateInput(await actor.getInput());
    const runId = actor.getEnv().actorRunId || randomUUID();
    const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const client = createClient(input.apiKey);
    const saved = await actor.getValue('PROGRESS');
    const progress = saved?.runId === runId ? saved : { nextIndex: 0 };
    if (saved?.runId === runId && saved.inputHash !== inputHash) {
        throw new Error('This run has different input. Start a new run to continue.');
    }
    if (!Number.isInteger(progress.nextIndex) || progress.nextIndex < 0 || progress.nextIndex > input.urls.length) {
        throw new Error('Stored progress is invalid. Start a new run to continue.');
    }
    try {
        for (let index = progress.nextIndex; index < input.urls.length; index++) {
            const row = await transcribeVideo(client, input, runId, index);
            await actor.pushData(row);
            await actor.setValue('PROGRESS', { runId, inputHash, nextIndex: index + 1 });
            actor.log.info(`Video ${index + 1} of ${input.urls.length}: ${row.status}`);
        }
    } catch (error) {
        throw new Error(client.redactText(error instanceof Error ? error.message : String(error)));
    }
}
