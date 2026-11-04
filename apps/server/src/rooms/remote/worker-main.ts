/**
 * Entry of a room worker thread (`GAME_WORKERS` > 0): runs the rooms the main thread places here.
 * Built as `dist/room-worker.js`; run from the TypeScript source (tests, `tsx`) with tsx's loader.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { RoomHost } from './host';
import type { Cmd, WorkerInit } from './protocol';

if (!parentPort) throw new Error('room worker: no parent port');
const port = parentPort;
const host = new RoomHost(workerData as WorkerInit, (batch, transfer) => port.postMessage(batch, transfer));
port.on('message', (m: { cmds: Cmd[] }) => host.handle(m.cmds));
host.start();
