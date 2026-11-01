import { Actor } from 'apify';
import { runActor } from './runner.mjs';

await Actor.main(() => runActor(Actor));
