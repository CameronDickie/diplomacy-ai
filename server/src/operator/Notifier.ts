import type { Store } from '../storage/Store.js';
import type { OutboxMessage } from '../storage/contracts.js';

export interface Delivery {
  readonly channel: 'outbox' | 'resend';
  /** Must throw on any outcome that is not a confirmed acceptance. */
  send(message: OutboxMessage, signal: AbortSignal): Promise<void>;
}
/** Development delivery: nothing leaves the process; messages are read from the operator dashboard. */
export const localDelivery: Delivery = { channel:'outbox', send:async () => {} };

class DeliveryError extends Error { constructor(readonly code: string) { super(code); } }
export function render(message: OutboxMessage): { subject: string; text: string } {
  const p = message.payload, at = typeof p.at === 'number' ? new Date(p.at).toISOString() : 'unknown time';
  return message.kind === 'ATTEMPT_STARTED'
    ? { subject:'Diplomacy: a challenge attempt started', text:`Attempt ${p.attemptId} of ${p.challengeId} v${p.challengeVersion} (${p.mode}) started at ${at}.` }
    : { subject:'Diplomacy: a player requested more sponsored play', text:`Account ${p.playerId} asked for sponsored play to resume (pause #${p.episode}) at ${at}. One notice is sent per account per pause.` };
}
/** The dedupe key doubles as Resend's idempotency key, so a retry after an unknown outcome cannot send twice. */
export function resendDelivery(settings: { apiKey: string; from: string; to: string }, request: typeof fetch = fetch): Delivery {
  return { channel:'resend', async send(message, signal) {
    let response: Response;
    try {
      response = await request('https://api.resend.com/emails', { method:'POST', signal, redirect:'error',
        headers:{ Authorization:`Bearer ${settings.apiKey}`, 'Content-Type':'application/json', 'Idempotency-Key':message.dedupeKey },
        body:JSON.stringify({ from:settings.from, to:[settings.to], ...render(message) }) });
    } catch { throw new DeliveryError(signal.aborted ? 'TIMEOUT' : 'NETWORK'); }
    // Never read or log the provider body: it can echo addresses and keys.
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new DeliveryError(`HTTP_${response.status}`);
  } };
}

/** Sends due outbox rows outside any game transaction; a slow or failing provider never delays a phase. */
export class Notifier {
  private draining?: Promise<number>;
  private timer?: NodeJS.Timeout;
  private closed = false;
  constructor(private store: Store, private delivery: Delivery, private now: () => number = Date.now, private timeoutMs = 10_000) {}
  drain(): Promise<number> {
    if (this.closed) return Promise.resolve(0);
    this.draining ??= this.run().finally(() => { this.draining = undefined; });
    return this.draining;
  }
  private async run(): Promise<number> {
    let delivered = 0;
    const batch = await this.store.call('claimOutbox',{now:this.now(),limit:10,leaseMs:Math.max(60_000,this.timeoutMs*6)});
    for (const message of batch) {
      if (this.closed) break;
      try {
        await this.delivery.send(message,AbortSignal.timeout(this.timeoutMs));
        await this.store.call('settleOutbox',{id:message.id,ok:true,channel:this.delivery.channel,now:this.now()});
        delivered++;
      } catch (error) {
        // If this settle is lost too, the lease expires and the idempotent send is repeated.
        await this.store.call('settleOutbox',{id:message.id,ok:false,error:error instanceof DeliveryError ? error.code : 'DELIVERY_FAILED',now:this.now()}).catch(() => {});
      }
    }
    return delivered;
  }
  start(intervalMs = 15_000): void {
    this.timer = setInterval(() => { void this.drain().catch(() => {}); },intervalMs);
    this.timer.unref();
  }
  async close(): Promise<void> { this.closed = true; clearInterval(this.timer); await this.draining?.catch(() => {}); }
}
