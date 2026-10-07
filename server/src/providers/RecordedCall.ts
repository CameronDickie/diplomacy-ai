import type { Store } from '../storage/Store.js';
import type { ProviderOutcome, ProviderUsage } from './accounting.js';

export interface ProviderResponse {
  responseId: string | null;
  usage: ProviderUsage | null;
  status: 'COMPLETED' | 'REFUSED' | 'INCOMPLETE' | 'ERROR';
  outputText: string | null;
}
export class ProviderCallError extends Error {
  constructor(readonly outcome:ProviderOutcome) {
    super(`Provider attempt did not produce a usable decision (${outcome}).`);
    this.name='ProviderCallError';
  }
}

/**
 * Runs only an already-prepared call, never re-dispatches an existing claim.
 * The caller must independently reserve funds before preparing a PAID call.
 * No production transport is wired here; current showcase remains interlocked.
 */
export async function recordedCall<T>(options:{
  store:Store;
  id:string;
  transport:(signal:AbortSignal)=>Promise<ProviderResponse>;
  validate:(value:unknown,signal:AbortSignal)=>T|Promise<T>;
  signal:AbortSignal;
  timeoutMs:number;
  now?:()=>number;
}):Promise<T> {
  const {store,id}=options,now=options.now??Date.now;
  if(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>120_000)throw new Error('Invalid provider deadline.');
  options.signal.throwIfAborted();
  await store.call('dispatchProviderCall',{id,now:now()});
  const controller=new AbortController();
  let timedOut=false;
  const abort=()=>controller.abort();
  options.signal.addEventListener('abort',abort,{once:true});
  if(options.signal.aborted)abort();
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},options.timeoutMs);
  let onAbort:()=>void=()=>{};
  const cancelled=new Promise<never>((_,reject)=>{
    onAbort=()=>reject(new ProviderCallError(timedOut?'TIMEOUT':'CANCELLED'));
    if(controller.signal.aborted)onAbort();else controller.signal.addEventListener('abort',onAbort,{once:true});
  });
  const work=Promise.resolve().then(async()=>{
    // Cancellation after claiming is conservatively uncertain; never dispatch anew.
    controller.signal.throwIfAborted();
    let response:ProviderResponse;
    try{response=await options.transport(controller.signal);}
    catch{throw new ProviderCallError('TRANSPORT_ERROR');}
    // Billing precedes output interpretation. Even a late response after timeout
    // still reconciles usage; it cannot replace a terminal game outcome.
    await store.call('receiveProviderCall',{id,responseId:response.responseId,usage:response.usage,now:now()});
    controller.signal.throwIfAborted();
    const failure=response.status==='REFUSED'?'REFUSED':response.status==='INCOMPLETE'?'INCOMPLETE':response.status!=='COMPLETED'?'PROVIDER_ERROR':null;
    if(failure)throw new ProviderCallError(failure);
    let parsed:unknown;
    try{
      if(typeof response.outputText!=='string'||Buffer.byteLength(response.outputText)>256*1024)throw Error();
      parsed=JSON.parse(response.outputText);
    }catch{throw new ProviderCallError('INVALID_JSON');}
    let value:T;
    try{value=await options.validate(parsed,controller.signal);}catch{throw new ProviderCallError('INVALID_ACTION');}
    controller.signal.throwIfAborted();
    return value;
  });
  try{
    const value=await Promise.race([work,cancelled]);
    await store.call('finishProviderCall',{id,outcome:'VALID',now:now()});
    return value;
  }catch(error){
    // Storage failure is not a provider outcome. Fail closed and leave its
    // uncertain committed state for recovery rather than making up a receipt.
    if(error instanceof ProviderCallError){await store.call('finishProviderCall',{id,outcome:error.outcome,now:now()});}
    throw error instanceof ProviderCallError?error:new Error('Provider accounting is unavailable; reconcile durable state before retrying.');
  }finally{
    clearTimeout(timer);options.signal.removeEventListener('abort',abort);
    controller.signal.removeEventListener('abort',onAbort);controller.abort();
  }
}
