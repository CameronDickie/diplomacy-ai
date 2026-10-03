import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type EngineErrorCode = 'ENGINE_BUSY' | 'ENGINE_TIMEOUT' | 'ENGINE_CANCELLED' |
  'ENGINE_FAILED' | 'ENGINE_OUTPUT_LIMIT' | 'ENGINE_INPUT_LIMIT' | 'ENGINE_INVALID_RESPONSE';

export class EngineError extends Error {
  constructor(readonly code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

export interface EngineLimits {
  concurrency: number;
  maxQueue: number;
  timeoutMs: number;
  maxOutputBytes: number;
}

interface Job {
  start(): void;
  cancel(error: EngineError): void;
}

/** One process-wide pool: limits include every room and legal-catalog request. */
export class EngineExecutor {
  private queue: Job[] = [];
  private jobs = new Set<Job>();
  private running = 0;
  private closed = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly limits: EngineLimits) {
    for (const name of ['concurrency', 'maxQueue', 'timeoutMs', 'maxOutputBytes'] as const) {
      const value = limits[name];
      if (!Number.isSafeInteger(value) || value < (name === 'maxQueue' ? 0 : 1)) {
        throw new Error(`Invalid engine limit: ${name}`);
      }
    }
  }

  get stats() { return { running: this.running, queued: this.queue.length, closed: this.closed }; }

  execute(payload: unknown, enginePath: string, signal?: AbortSignal): Promise<unknown> {
    const cancelled = () => new EngineError('ENGINE_CANCELLED', 'Rules operation was cancelled.');
    if (this.closed || signal?.aborted) return Promise.reject(cancelled());
    if (this.running >= this.limits.concurrency && this.queue.length >= this.limits.maxQueue) {
      return Promise.reject(new EngineError('ENGINE_BUSY', 'Rules engine capacity is full. Retry shortly.'));
    }
    let input: string;
    try { input = JSON.stringify(payload); } catch {
      return Promise.reject(new EngineError('ENGINE_INPUT_LIMIT', 'Rules request could not be serialized.'));
    }
    if (typeof input !== 'string' || Buffer.byteLength(input) > 4 * 1024 * 1024) {
      return Promise.reject(new EngineError('ENGINE_INPUT_LIMIT', 'Rules request exceeds the input limit.'));
    }

    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams | undefined;
      let active = false;
      let settled = false;
      let failure: EngineError | undefined;
      const chunks: Buffer[] = [];
      let bytes = 0;
      const finish = (error?: EngineError, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.queue = this.queue.filter(candidate => candidate !== job);
        this.jobs.delete(job);
        if (active) this.running--;
        if (error) reject(error); else resolve(result);
        this.drain();
        if (this.jobs.size === 0) this.idleWaiters.splice(0).forEach(notify => notify());
      };
      const job: Job = {
        cancel: error => {
          if (settled) return;
          failure ??= error;
          if (!active) { finish(failure); return; }
          // Keep the slot until 'close': an expired process is still live until
          // reaped. Kill the process group on POSIX, including any descendants.
          if (child?.pid) {
            try {
              if (process.platform === 'win32') child.kill('SIGKILL');
              else process.kill(-child.pid, 'SIGKILL');
            } catch { child.kill('SIGKILL'); }
          }
        },
        start: () => {
          active = true;
          this.running++;
          try {
            child = spawn(enginePath, [], {
              shell: false, detached: process.platform !== 'win32', stdio: 'pipe',
              // Godip needs no provider/session credentials from the server.
              env: { PATH: process.env.PATH, LANG: 'C' },
            });
          } catch {
            finish(new EngineError('ENGINE_FAILED', 'Could not start the rules engine. Check the configured executable.'));
            return;
          }
          child.on('error', () => { failure ??= new EngineError('ENGINE_FAILED', 'Could not start the rules engine. Check the configured executable.'); });
          const consume = (chunk: Buffer, stdout: boolean) => {
            bytes += chunk.length;
            if (bytes > this.limits.maxOutputBytes) {
              job.cancel(new EngineError('ENGINE_OUTPUT_LIMIT', 'Rules engine exceeded its output limit.'));
            } else if (stdout) chunks.push(chunk);
          };
          child.stdout.on('data', (chunk: Buffer) => consume(chunk, true));
          child.stderr.on('data', (chunk: Buffer) => consume(chunk, false));
          child.stdin.on('error', () => {
            job.cancel(new EngineError('ENGINE_FAILED', 'Rules engine stopped accepting input.'));
          });
          child.on('close', code => {
            if (failure) { finish(failure); return; }
            if (code !== 0) { finish(new EngineError('ENGINE_FAILED', 'Rules engine failed to resolve this position.')); return; }
            try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { finish(new EngineError('ENGINE_INVALID_RESPONSE', 'Rules engine returned an invalid response.')); }
          });
          child.stdin.end(input);
        },
      };
      const onAbort = () => job.cancel(cancelled());
      // This deadline includes queue time; accepted work cannot wait forever.
      const timer = setTimeout(() => job.cancel(new EngineError('ENGINE_TIMEOUT', 'Rules engine deadline exceeded. Retry the phase.')), this.limits.timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.jobs.add(job);
      this.queue.push(job);
      this.drain();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const idle = this.jobs.size ? new Promise<void>(resolve => this.idleWaiters.push(resolve)) : Promise.resolve();
    for (const job of this.jobs) job.cancel(new EngineError('ENGINE_CANCELLED', 'Rules engine is shutting down.'));
    await idle;
  }

  private drain(): void {
    while (!this.closed && this.running < this.limits.concurrency && this.queue.length) {
      this.queue.shift()!.start();
    }
  }
}
