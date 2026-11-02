# Transcript Dock Video Transcripts

Get timed captions from public YouTube and TikTok videos. Paste your links and pay through Apify for each completed transcript. No separate account or API key is needed.

This version supports captions only. AI transcription, translation, speaker labels and Instagram are not available.

## Input

- **Video links**: 1 to 50 public YouTube or TikTok links. Duplicate links are processed once.
- **Wait per video**: 5 to 1800 seconds, default 300.
- **Run budget**: choose your maximum total charge in Apify before starting.

## Results and charges

Each completed transcript is saved as one result with text, timestamps, source, job ID and billing information. Cached transcripts delivered to you count as completed results too.

Apify charges the published price for each result in the default dataset. Failed, cancelled and unfinished jobs are not written to that dataset and are not charged as transcript results. Their status appears in the run summary. Any separate platform usage charges are shown by Apify before you run.

When your run budget cannot cover another transcript, remaining links are not requested. Caption availability varies by video. Rerunning an unfinished link starts a new run; it may use a result that has since completed.

A paid Apify plan is required. Developer tests are the only exception. This protects the service from external provider costs on unreimbursed free runs.

## Recovery and support

A resumed run checks saved results before writing again. If a previous save or payment is ambiguous, it stops for review instead of risking a second charge. Do not delete or edit a run's dataset before resuming it.

Use this Actor's [Issues tab](https://apify.com/transcriptdock/transcriptdock-video-transcripts/issues) for help. Include the run ID and affected video link. Never include API keys, bank details or identity documents in an issue.

Published by [Transcript Dock](https://apify.com/transcriptdock).
