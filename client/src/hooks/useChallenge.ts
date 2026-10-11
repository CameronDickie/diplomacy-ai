import { useEffect,useRef,useState } from 'react';
import type { ExhibitionReplay,ExhibitionSummary,ChallengeAction,ChallengeAttemptView,ChallengeCard,ChallengeMode,ChallengeCatalog,ChallengeHistoryPage,ChallengeLegalCatalog,ChallengeReplay,ChatView,GameRecord,PlaytestLog,Power,PublicPhaseReport,SubmissionState } from '@diplomacy/shared';
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
  const [catalog,setCatalog]=useState<ChallengeCatalog|null>(null),[demo,setDemo]=useState<ChallengeReplay|null>(null);
  const [attempt,setAttempt]=useState<ChallengeAttemptView|null>(null),[history,setHistory]=useState<ChallengeAttemptView[]>([]);
  const [legal,setLegal]=useState<ChallengeLegalCatalog|null>(null),[reports,setReports]=useState<PublicPhaseReport[]>([]);
  const [playtest,setPlaytest]=useState<PlaytestLog|null>(null);
  const [chat,setChat]=useState<ChatView|null>(null);
  const [exhibitions,setExhibitions]=useState<ExhibitionSummary[]>([]);
  const [older,setOlder]=useState<string|null>(null),[creditRequested,setCreditRequested]=useState(false);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false);
  const current=useRef(attempt);current.current=attempt;
  const startMode=useRef<ChallengeMode|null>(null),startId=useRef<string|null>(null),pending=useRef<{phaseId:string;requestId:string;action:ChallengeAction}|null>(null);
  const lastActivity=useRef(0),mutation=useRef(false);
  useEffect(()=>{
    const controller=new AbortController();
    Promise.all([challengeRequest<ChallengeCatalog>('/challenges',undefined,controller.signal),challengeRequest<ChallengeReplay>('/challenges/demo',undefined,controller.signal)])
      .then(([published,replay])=>{setCatalog(published);setDemo(replay);setLoaded(true);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return()=>controller.abort();
  },[]);
  // Bot exhibition games are public and optional: failing to list them never blocks the page.
  useEffect(()=>{
    const load=()=>{void challengeRequest<{exhibitions:ExhibitionSummary[]}>('/exhibitions').then(r=>setExhibitions(r.exhibitions)).catch(()=>{});};
    load();const timer=setInterval(load,15_000);return()=>clearInterval(timer);
  },[]);
  // When the featured challenge rotates at midnight UTC, load the new card and its replay without a page reload.
  useEffect(()=>{
    const at=catalog?.rotation.nextChangeAt;if(!at)return;
    const timer=setTimeout(()=>{
      Promise.all([challengeRequest<ChallengeCatalog>('/challenges'),challengeRequest<ChallengeReplay>('/challenges/demo')]).then(([published,replay])=>{setCatalog(published);setDemo(replay);}).catch(()=>{});
    },Math.min(Math.max(at-Date.now(),0)+1500,2_000_000_000));
    return()=>clearTimeout(timer);
  },[catalog?.rotation.nextChangeAt]);
  useEffect(()=>{
    const controller=new AbortController();
    setAttempt(null);setHistory([]);setOlder(null);setCreditRequested(false);setLegal(null);setReports([]);pending.current=null;startId.current=null;setError('');
    if(identity)challengeRequest<ChallengeHistoryPage>('/attempts',undefined,controller.signal).then(({attempts,next})=>{
      if(identityRef.current!==identity)return;setHistory(attempts);setOlder(next);setAttempt(attempts.find(a=>a.lifecycle==='ACTIVE')??null);
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
    // Offered by development servers only; the route does not exist anywhere else.
    if(attempt.mode==='SPONSORED'&&(catalog?.sponsoredMock||catalog?.sponsoredLive))
      challengeRequest<PlaytestLog>(`/attempts/${id}/playtest`,undefined,controller.signal).then(r=>{if(identityRef.current===identity)setPlaytest(r);}).catch(()=>{});
    else setPlaytest(null);
    if(attempt.mode==='SPONSORED'&&catalog?.sponsoredChat)
      challengeRequest<ChatView>(`/attempts/${id}/chat`,undefined,controller.signal).then(r=>{if(identityRef.current===identity)setChat(r);}).catch(()=>{});
    else setChat(null);
    challengeRequest<{reports:PublicPhaseReport[]}>(`/attempts/${id}/reports`,undefined,controller.signal).then(r=>{if(identityRef.current===identity)setReports(r.reports);})
      .catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    if(attempt.lifecycle==='ACTIVE'&&attempt.execution==='ACCEPTING'&&attempt.board.phase==='ORDERS')
      challengeRequest<ChallengeLegalCatalog>(`/attempts/${id}/legal`,undefined,controller.signal).then(r=>{
        if(identityRef.current===identity&&current.current?.id===id&&current.current.revision===version)setLegal(r);
      }).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return()=>controller.abort();
  },[attempt?.id,attempt?.revision,attempt?.execution,identity]);
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
    const list=await challengeRequest<ChallengeHistoryPage>('/attempts');
    if(identityRef.current===owner){setHistory(list.attempts);setOlder(list.next);}
  }
  return {auth,older,exhibitions,loadExhibition:(id:string)=>challengeRequest<ExhibitionReplay>(`/exhibitions/${id}`),cards:catalog?.challenges??[],limits:catalog?.limits??null,rotation:catalog?.rotation??null,sponsoredPlay:catalog?.sponsoredPlay??null,sponsoredMock:catalog?.sponsoredMock??false,sponsoredLive:catalog?.sponsoredLive??false,playtest,chat,
    // Development only: every phase, call, conversation and failure for this attempt, saved as one JSON file.
    exportRecord:async()=>{if(!attempt)return;try{const record=await challengeRequest<GameRecord>(`/attempts/${attempt.id}/export`);
      const url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)],{type:'application/json'})),link=document.createElement('a');
      link.href=url;link.download=`diplomacy-${record.attempt.challengeId}-${attempt.id.slice(0,8)}.json`;link.click();URL.revokeObjectURL(url);}catch(e){setError((e as Error).message);}},
    // One request id per message, so a retried send can never store it or pay for a reply twice.
    sendChat:(power:Power,body:string)=>mutate(async owner=>{if(!attempt)return;const next=await challengeRequest<ChatView>(`/attempts/${attempt.id}/chat`,{power,requestId:crypto.randomUUID(),body});if(identityRef.current===owner)setChat(next);}),capacity:catalog?.capacity??null,creditRequested,demo,attempt,history,legal,reports,error,busy,loaded,clearError:()=>setError(''),
    start:(card:ChallengeCard,mode:ChallengeMode='PRACTICE')=>mutate(async owner=>{
      startId.current??=crypto.randomUUID();
      // The start ID is tied to the chosen mode, so switching mode after an uncertain response is a new request.
      if(startMode.current!==mode){startId.current=crypto.randomUUID();startMode.current=mode;}
      const result=await challengeRequest<ChallengeAttemptView>('/attempts',{requestId:startId.current,challengeId:card.id,challengeVersion:card.version,...(mode==='PRACTICE'?{}:{mode})});
      if(identityRef.current===owner){startId.current=null;setAttempt(result);await refresh(result.id,owner);}
      // A refused start usually means capacity or availability changed since the page loaded.
    }).finally(()=>{void challengeRequest<ChallengeCatalog>('/challenges').then(setCatalog).catch(()=>{});}),
    // The server keeps one request per account per pause, so repeating this is harmless.
    requestCredit:()=>mutate(async owner=>{await challengeRequest('/credit-request',{});if(identityRef.current===owner)setCreditRequested(true);}),
    resume:(id:string)=>mutate(async owner=>{
      const next=await challengeRequest<ChallengeAttemptView>(`/attempts/${id}`);
      if(identityRef.current===owner)setAttempt(next);
    }),
    loadOlder:()=>mutate(async owner=>{
      if(!older)return;
      const page=await challengeRequest<ChallengeHistoryPage>(`/attempts?before=${encodeURIComponent(older)}`);
      if(identityRef.current===owner){setHistory(items=>[...items,...page.attempts.filter(a=>!items.some(item=>item.id===a.id))]);setOlder(page.next);}
    }),
    // The server has already removed the session; refreshing auth clears every piece of owned state above.
    deleteAccount:()=>mutate(async()=>{await challengeRequest('/account/delete',{confirm:'DELETE'});await auth.refresh();}),
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
