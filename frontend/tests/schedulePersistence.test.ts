import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceStore, type Requester } from '../src/services/workspaceStore.ts';
import type { Availability, SchedulePreview, WorkSession } from '../src/types/models.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const availability: Availability = { days: Array.from({length:7}, (_,day) => ({day,enabled:true,periods:[{start:540,end:1020}]})), weekOverrides:[], timeZone:'UTC', reminders:false };
const preview: SchedulePreview = {previewId:'preview',status:'pending',schedule:{version:1,generatedAt:'2026-10-24T09:00:00Z',startDate:'2026-10-24',endDate:'2026-10-24',timeZone:'UTC',sessions:[],tasks:[],explanations:[],inputFingerprint:'fingerprint'}};
const session = (id:string,source:'manual'|'auto',locked=false): WorkSession => ({id,source,locked,taskId:'task',date:'2026-10-24',start:540,end:600});
function harness(apply:()=>Promise<WorkSession[]>) {
  let saved=[session('manual','manual'),session('locked','auto',true),session('old','auto')];
  const request: Requester = async <T>(path:string) => {
    if(path==='/schedule/preview') return structuredClone(preview) as T;
    if(path==='/schedule/apply') {
      const sessions=await apply();
      saved=[...saved.filter(s=>s.source!=='auto'||s.locked),...sessions];
      return {previewId:'preview',status:'applied',sessions} as T;
    }
    return structuredClone(path==='/sessions'?saved:path==='/availability'?availability:path==='/plan'?null:[]) as T;
  };
  return {request};
}
test('Apply preserves manual and locked blocks and restores committed sessions in a fresh store',async()=>{
  const {request}=harness(async()=>[session('new','auto')]);
  const store=createWorkspaceStore(request); store.setUser('owner'); await tick();
  await store.previewSchedule(); await store.applySchedulePreview();
  assert.deepEqual(store.getSnapshot().sessions.map(s=>s.id),['manual','locked','new']);
  assert.equal(store.getSnapshot().schedulePreview,null);
  const refreshed=createWorkspaceStore(request); refreshed.setUser('owner'); await tick();
  assert.deepEqual(refreshed.getSnapshot().sessions,store.getSnapshot().sessions);
});
test('Apply failure keeps prior sessions and the preview and surfaces the backend error',async()=>{
  const {request}=harness(async()=>{throw new Error('MongoDB rejected the saved document');});
  const store=createWorkspaceStore(request); store.setUser('owner'); await tick();
  await store.previewSchedule();
  await assert.rejects(store.applySchedulePreview(),/MongoDB rejected/);
  assert.deepEqual(store.getSnapshot().sessions.map(s=>s.id),['manual','locked','old']);
  assert.equal(store.getSnapshot().schedulePreview?.previewId,'preview');
  assert.equal(store.getSnapshot().saving,false);
});
test('A late Apply response cannot publish sessions into a different account',async()=>{
  let finish!:(sessions:WorkSession[])=>void;
  const pending=new Promise<WorkSession[]>(resolve=>{finish=resolve;});
  const {request}=harness(()=>pending);
  const store=createWorkspaceStore(request); store.setUser('owner'); await tick();
  await store.previewSchedule(); const applying=store.applySchedulePreview();
  store.setUser(null); finish([session('new','auto')]);
  await assert.rejects(applying,/account changed/);
  assert.deepEqual(store.getSnapshot().sessions,[]);
});
