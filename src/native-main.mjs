import { Actor } from 'apify';
import { runNativeActor } from './native-runner.mjs';

await Actor.main(() => runNativeActor(Actor));
