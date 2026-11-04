// Starts a room worker from the TypeScript sources (tests, `tsx`): a worker thread does not inherit
// the parent's tsx loader, so it registers its own before loading the entry. The build ships
// dist/room-worker.js instead and never loads this file.
import { workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
await import(workerData.entry);
