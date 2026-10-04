import { Worker } from 'node:worker_threads';
import { createHash, randomBytes } from 'node:crypto';
import type { StoreOperation, StoreOperations, StoreErrorCode } from './contracts.js';
import { StoreError } from './contracts.js';

/** No SQL or raw credentials cross this boundary. A bounded queue runs off the event loop. */
export class Store {
  private readonly worker: Worker;
  private sequence = 0;
  private failed = false;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private constructor(path: string, restoreFrom?: string, readOnly = false) {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { path, restoreFrom, readOnly }, env: {}, execArgv: [] });
    this.worker.on('message', (message: { id: number; result?: unknown; error?: { code: StoreErrorCode; message: string } }) => {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new StoreError(message.error.code, message.error.message));
      else request.resolve(message.result);
    });
    this.worker.on('error', () => this.fail());
    this.worker.on('exit', () => { if (!this.closing || this.pending.size) this.fail(); });
  }
  static async open(path: string, restoreFrom?: string): Promise<Store> {
    const store = new Store(path, restoreFrom);
    try { await store.call('health', {}); return store; }
    catch (error) { await store.worker.terminate(); throw error; }
  }
  /** Maintenance reads/backups must not migrate the source before taking a backup. */
  static async inspect(path: string): Promise<Store> {
    const store = new Store(path, undefined, true);
    try { await store.call('health', {}); return store; }
    catch (error) { await store.worker.terminate(); throw error; }
  }
  call<K extends StoreOperation>(operation: K, input: StoreOperations[K]['input']): Promise<StoreOperations[K]['output']> {
    if (this.failed || this.closing) return Promise.reject(new StoreError('STORE_UNAVAILABLE', 'Persistent storage is unavailable. Retry after recovery.'));
    if (this.pending.size >= 64) return Promise.reject(new StoreError('STORE_BUSY', 'Persistent storage capacity is full. Retry shortly.'));
    try {
      if (Buffer.byteLength(JSON.stringify(input)) > 2 * 1024 * 1024) return Promise.reject(new StoreError('STORE_INVALID', 'Persistent storage request exceeds its size limit.'));
    } catch { return Promise.reject(new StoreError('STORE_INVALID', 'Persistent storage request cannot be serialized.')); }
    return new Promise((resolve,reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        // A timed-out write may have committed: fail closed, never auto-replay it.
        this.fail();
        void this.worker.terminate();
      }, operation === 'backup' ? 60_000 : 10_000);
      this.pending.set(id, { resolve: value => resolve(value as StoreOperations[K]['output']), reject, timer });
      try { this.worker.postMessage({ id, operation, input }); }
      catch { this.fail(); }
    });
  }
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const closing = this.failed ? Promise.resolve(null) : this.call('close', {});
    this.closing = true;
    this.closePromise = (async () => {
      try { await closing; }
      finally { await this.worker.terminate(); }
    })();
    return this.closePromise;
  }
  private fail(): void {
    this.failed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new StoreError('STORE_UNAVAILABLE', 'Persistent storage is unavailable; an interrupted write may have committed. Re-read durable state after recovery.'));
    }
    this.pending.clear();
  }
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
export const newToken = (): string => randomBytes(32).toString('base64url');
