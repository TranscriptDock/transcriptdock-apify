import { Actor } from 'apify';
import { NATIVE_ACTOR_OPTIONS, runNativeActor } from './native-runner.mjs';

// A lost dataset response must be reconciled on resume, not automatically
// retried inside the client, because every accepted write carries a charge.
const actor = new Actor(NATIVE_ACTOR_OPTIONS);
await actor.main(() => runNativeActor(actor));
