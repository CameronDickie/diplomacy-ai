import { useEffect,useRef,useState } from 'react';
import type { ChallengeAction,ChallengeAttemptView,ChallengeCard,ChallengeLegalCatalog,ChallengeReplay,PublicPhaseReport,SubmissionState } from '@diplomacy/shared';
import { useAuth } from './useAuth.js';
const base=import.meta.env.VITE_SERVER_URL||'';
export async function challengeRequest<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(`${base}/api${path}`,{method:body===undefined?'GET':'POST',credentials:'include',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),
    headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();
  if(!response.ok)throw new Error(result.message|| (response.status===401?'Sign in to continue.':'This request could not be completed.'));
  return result as T;
}
export function useChallenge(){
  const auth=useAuth(),identity=auth.user?.id??null;
  const identityRef=useRef(identity);identityRef.current=identity;
  const [cards,setCards]=useState<ChallengeCard[]>([]),[demo,setDemo]=useState<ChallengeReplay|null>(null);
  const [attempt,setAttempt]=useState<ChallengeAttemptView|null>(null),[history,setHistory]=useState<ChallengeAttemptView[]>([]);
  const [legal,setLegal]=useState<ChallengeLegalCatalog|null>(null),[reports,setReports]=useState<PublicPhaseReport[]>([]);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false);
  const current=useRef(attempt);current.current=attempt;
  const startId=useRef<string|null>(null),pending=useRef<{phaseId:string;requestId:string;action:ChallengeAction}|null>(null);
  const lastActivity=useRef(0),mutation=useRef(false);
  useEffect(()=>{
    const controller=new AbortController();
    Promise.all([challengeRequest<{challenges:ChallengeCard[]}>('/challenges',undefined,controller.signal),challengeRequest<ChallengeReplay>('/challenges/demo',undefined,controller.signal)])
      .then(([catalog,replay])=>{setCards(catalog.challenges);setDemo(replay);setLoaded(true);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return()=>controller.abort();
  },[]);
  useEffect(()=>{
    const controller=new AbortController();
    setAttempt(null);setHistory([]);setLegal(null);setReports([]);pending.current=null;startId.current=null;setError('');
    if(identity)challengeRequest<{attempts:ChallengeAttemptView[]}>('/attempts',undefined,controller.signal).then(({attempts})=>{
      if(identityRef.current!==identity)return;setHistory(attempts);setAttempt(attempts.find(a=>a.lifecycle==='ACTIVE')??null);
    }).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return()=>controller.abort();
  },[identity]);
  useEffect(()=>{
    if(!attempt||attempt.lifecycle!=='ACTIVE'||!identity)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try{const next=await challengeRequest<ChallengeAttemptView>(`/attempts/${attempt.id}`,undefined,controller.signal);
        if(identityRef.current===identity){setAttempt(next);setHistory(items=>items.map(item=>item.id===next.id?next:item));}
      }catch(e){if(!controller.signal.aborted)setError((e as Error).message);}
      if(!controller.signal.aborted)timer=setTimeout(()=>void poll(),2000);
    };
    timer=setTimeout(()=>void poll(),2000);
    return()=>{controller.abort();clearTimeout(timer);};
  },[attempt?.id,attempt?.lifecycle,identity]);
  useEffect(()=>{
    setLegal(null);
    if(!attempt||!identity)return;
    const controller=new AbortController(),version=attempt.revision,id=attempt.id;
    challengeRequest<{reports:PublicPhaseReport[]}>(`/attempts/${id}/reports`,undefined,controller.signal).then(r=>{if(identityRef.current===identity)setReports(r.reports);})
      .catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    if(attempt.lifecycle==='ACTIVE'&&attempt.execution==='ACCEPTING'&&attempt.board.phase==='ORDERS')
      challengeRequest<ChallengeLegalCatalog>(`/attempts/${id}/legal`,undefined,controller.signal).then(r=>{
        if(identityRef.current===identity&&current.current?.id===id&&current.current.revision===version)setLegal(r);
      }).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return()=>controller.abort();
  },[attempt?.id,attempt?.revision,identity]);
  async function mutate(work:(owner:string)=>Promise<void>){
    if(!identity||mutation.current)return;
    mutation.current=true;setBusy(true);setError('');
    try{await work(identity);}catch(e){if(identityRef.current===identity)setError((e as Error).message);}
    finally{mutation.current=false;setBusy(false);}
  }
  async function refresh(id:string,owner:string){
    const next=await challengeRequest<ChallengeAttemptView>(`/attempts/${id}`);
    if(identityRef.current!==owner)return;
    setAttempt(next);
    const list=await challengeRequest<{attempts:ChallengeAttemptView[]}>('/attempts');
    if(identityRef.current===owner)setHistory(list.attempts);
  }
  return {auth,cards,demo,attempt,history,legal,reports,error,busy,loaded,clearError:()=>setError(''),
    start:(card:ChallengeCard)=>mutate(async owner=>{
      startId.current??=crypto.randomUUID();
      const result=await challengeRequest<ChallengeAttemptView>('/attempts',{requestId:startId.current,challengeId:card.id,challengeVersion:card.version});
      if(identityRef.current===owner){startId.current=null;setAttempt(result);await refresh(result.id,owner);}
    }),
    resume:(id:string)=>mutate(async owner=>{await refresh(id,owner);}),
    submit:(action:ChallengeAction)=>mutate(async owner=>{
      const saved=current.current;if(!saved)return;
      const old=pending.current;
      // An uncertain delivery retries its original command; a changed draft needs a fresh ID.
      if(!old||old.phaseId!==saved.phaseId||JSON.stringify(old.action)!==JSON.stringify(action))pending.current={phaseId:saved.phaseId,requestId:crypto.randomUUID(),action};
      await challengeRequest<SubmissionState>(`/attempts/${saved.id}/orders`,{revision:saved.revision,...pending.current});
      if(identityRef.current===owner){pending.current=null;await refresh(saved.id,owner);}
    }),
    recover:()=>mutate(async owner=>{const id=current.current?.id;if(id){await challengeRequest(`/attempts/${id}/recover`,{});await refresh(id,owner);}}),
    abandon:()=>mutate(async owner=>{const id=current.current?.id;if(id){await challengeRequest(`/attempts/${id}/abandon`,{});await refresh(id,owner);}}),
    activity:async(force=false)=>{
      const saved=current.current,owner=identity;if(!saved||!owner||saved.lifecycle!=='ACTIVE'||(!force&&Date.now()-lastActivity.current<30_000))return;
      lastActivity.current=Date.now();
      try{const next=await challengeRequest<ChallengeAttemptView>(`/attempts/${saved.id}/activity`,{revision:saved.revision});
        if(identityRef.current===owner&&current.current?.id===next.id&&current.current.revision===next.revision)setAttempt(next);
      }catch(e){if(force&&identityRef.current===owner)setError((e as Error).message);}
    },
  };
}
