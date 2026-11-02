# Transcript Dock Video Transcripts

Get timed transcripts from public YouTube and TikTok videos through the Transcript Dock API. Instagram Reels use AI transcription on paid Transcript Dock plans in beta.

Use your own Transcript Dock API key. Our website is available on the [Transcript Dock developer profile](https://apify.com/transcriptdock). Your key is a secret input encrypted by Apify. It is sent only to the fixed Transcript Dock API origin and is never written to the dataset or logs. Each user's key selects their own workspace; there is no shared billing account.

## Input and cost

Enter up to 50 HTTPS video links. Duplicate links are removed before submission. Captions only is the default and costs 1 Transcript Dock credit per video. Selecting auto explicitly permits AI fallback; transcribe always requests AI. AI costs 2 credits per started minute and requires a paid Transcript Dock plan. Instagram requires auto or transcribe mode.

`maxCredits` caps each video, default 10 credits. The maximum run spend is the cap multiplied by the number of unique links. Apify compute usage is separate. Check your available Transcript Dock credits and Apify allowance before running. This Actor has no additional rental or result fee configured.

`timeoutSeconds` limits waiting per video, default 300 seconds. Jobs can continue on Transcript Dock after waiting ends. The output preserves their actual status and job ID so you can retrieve them later. The Actor does not cancel or silently resubmit them.

Example input with placeholders. Replace both the key and video URL before running:

```json
{
  "apiKey": "REPLACE_WITH_YOUR_TRANSCRIPT_DOCK_KEY",
  "urls": ["PASTE_YOUR_PUBLIC_VIDEO_URL_HERE"],
  "mode": "captions_only",
  "maxCredits": 10,
  "timeoutSeconds": 300
}
```

Uploads, direct media URLs, translation and speaker labels are not Actor input options. Unsupported fields are rejected before any submission.

## Output and recovery

The Apify dataset contains one row per unique URL, with `jobId`, actual `status`, `timedOut`, billing information and the full JSON transcript when it succeeds. Transcript text, segments, language and timing come from the real API response. Failed jobs carry a typed error; pending jobs carry no invented transcript. Apify can export dataset rows as JSON or CSV.

The Actor stores completed progress in its run's private key value store. It reuses the same submission receipt when the same Apify run resumes, and retries transient errors at most three times. The server's receipt retention window is at least 24 hours; recovery after that window is not guaranteed to avoid another charge. A new Apify run uses new receipts, with normal Transcript Dock content cache rules.

Dataset writes and progress checkpoints are separate operations. An interruption between them can repeat a row on recovery. Deduplicate output by `jobId`. Changing input or credentials during the same run is rejected. API authentication or transport failures stop the run rather than producing success rows.

## Local setup and checks

Requires Node 22.15 or later. Run from the standalone Actor repository root, or from `integrations/apify` in the application monorepo:

```sh
npm ci --ignore-scripts
npm test
docker build -t transcriptdock-apify:local .
```

Local tests use clearly separated fixtures and make no paid API calls. The container runs as a nonroot user with writable local storage. Dependencies are pinned and recorded in `package-lock.json`. Security overrides pin patched MCP SDK, Zod, FTP parser and glob matcher versions inherited from the upstream packages; local tests exercise the resulting client and lifecycle.

The SDK loads platform input and decrypts secret fields automatically. For local development, follow the Apify SDK's secret input instructions; never commit a real key in a local `storage/` directory or input file. Credentials must have `jobs:write`, `jobs:read` and `transcripts:read` scopes.

## Release evidence

Local tests cover retry receipt reuse and caps, pending and failed jobs, redirect credential protection, checkpoint recovery, account isolation and error redaction. The Apify CLI input schema validator passes. On 2026-11-02, the Transcript Dock organization completed a real cloud build and a captions_only run with a 1 credit cap. The run succeeded with one dataset row containing a full transcript; the API reported a cached result and zero Transcript Dock credits charged. The run used limited permissions. Live AI transcription and paid source paths were not tested in this check. Apify compute usage is separate from Transcript Dock credits.

For support, open the Actor's [Issues tab](https://apify.com/transcriptdock/transcriptdock-video-transcripts/issues).
