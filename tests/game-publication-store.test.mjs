import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,readdir,unlink,rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { initializeDatabase } from '../server/database.mjs';
import { createStore } from '../server/store.mjs';
import { activateCommunityPublicDefaults } from '../server/community-schema.mjs';
import { ADMIN_EMAIL } from '../server/admin-policy.mjs';
import { INITIAL_CUTOFF } from '../server/config.mjs';
import { prepareGameReleaseSchema } from '../server/game-release-schema.mjs';
import { createGameReleaseStore,RELEASE_BINDING_KEYS } from '../server/game-release-store.mjs';
import { createGamePublicationStore,preparePublicationSchema,resolveDailyRunCycle } from '../server/game-publication-store.mjs';
import { dailyCycleForDate } from '../server/daily-schedule.mjs';
import { errorCode,TEST_CLOCK_SQL } from './backend-helpers.mjs';

const hash = digit => digit.repeat(64);
const operation = (action,input) => ({ action,requestId:randomUUID(),reason:'Synthetic publication test',...input });
const bindingOf = row => Object.fromEntries(['id','revision','bodyHash','policyVersion','safetyReviewId','safetyRevision','developmentBriefHash'].map(key => [key,row[key]]));

async function fixture(t,{prepare=true,runId,proposalTime=INITIAL_CUTOFF-3600000}={}) {
  const directory = await mkdtemp(path.join(tmpdir(),'yourgame-publication-store-'));
  const client = createClient({url:`file:${path.join(directory,'test.db').replaceAll('\\','/')}`});
  t.after(async () => {
    client.close();
    for (const name of await readdir(directory)) {
      const target=path.resolve(directory,name);
      assert.equal(path.dirname(target),path.resolve(directory));
      try { await unlink(target); }
      catch(error) {
        // Transferred native transaction handles survive until process exit on
        // Windows; preserve this synthetic temp fixture if it is still open.
        if(process.platform==='win32' && ['EBUSY','EPERM'].includes(error.code)) return;
        throw error;
      }
    }
    await rmdir(directory);
  });
  await client.execute('PRAGMA foreign_keys=ON');
  await initializeDatabase(client);
  const time=proposalTime;
  await client.execute('CREATE TABLE test_clock(id INTEGER PRIMARY KEY,now_ms INTEGER NOT NULL)');
  await client.execute({sql:'INSERT INTO test_clock VALUES(1,?)',args:[time]});
  await activateCommunityPublicDefaults(client,{expectedServiceRevision:1,databaseClockSql:TEST_CLOCK_SQL});
  const store=createStore(client,{now:()=>time,databaseClockSql:TEST_CLOCK_SQL});
  const admin=await store.completeLogin((await store.createAnonymousSession()).session,{
    googleSub:'publication-test-admin',name:'Administrator fixture',email:ADMIN_EMAIL,emailVerified:true,
  });
  const member=await store.completeLogin((await store.createAnonymousSession()).session,{
    googleSub:'publication-test-member',name:'Participant fixture',
  });
  const proposal=(await store.createProposal(member.session.user.id,{body:'유혈 없는 세로 판타지 탐험 게임',requestId:randomUUID()})).proposal;
  const row=(await store.admin.query(admin.session,{section:'proposals'})).items.find(item=>item.id===proposal.id);
  await store.admin.mutate(admin.session,operation('review_proposal_safety',{
    proposalId:proposal.id,proposalRevision:row.revision,bodyHash:row.safety.bodyHash,policyVersion:row.safety.policyVersion,
    revision:row.safety.revision,status:'approved',checklistConfirmed:true,developmentBrief:'세로 화면에서 터치로 판타지 탐험',
  }));
  const bindings=(await store.admin.listEligibleProposals({roundId:row.roundId,proposalIds:[proposal.id]})).map(bindingOf);
  const job=await store.admin.mutate(admin.session,operation('create_version',{label:'Fixture development',summary:'Synthetic candidates'}));
  if(runId) await client.execute({sql:`INSERT INTO development_runs(id,label,summary,status,created_at,updated_at)
    VALUES(?,'Daily fixture','Synthetic daily publication','queued',?,?)`,args:[runId,time,time]});
  const workerId='publication-fixture-worker';
  const run=await store.admin.claimRun({id:runId??job.targetId,revision:1,workerId});
  await prepareGameReleaseSchema(client,{expectedServiceRevision:1});
  if(prepare) await preparePublicationSchema(client,{expectedServiceRevision:1});
  const releases=createGameReleaseStore(client,{databaseClockSql:TEST_CLOCK_SQL});
  const publications=createGamePublicationStore(client,{databaseClockSql:TEST_CLOCK_SQL});
  async function candidate(digit,overrides={}) {
    const review={id:randomUUID(),requestId:randomUUID(),operatorId:'fixture-operator',authorizationRef:'fixture:authorization',
      runId:run.id,candidateId:`candidate-${digit}-fixture`,policyVersion:'teen-v1',snapshotDigest:hash('a'),sourceDigest:hash(digit),
      assetsDigest:hash('b'),gameVersion:`fixture-${digit}`,contentSha256:hash(digit),runtimeDigest:hash('e'),evidenceDigest:hash('f'),
      workerId,runRevision:run.revision,serviceRevision:1,roundId:row.roundId,bindings,...overrides};
    await releases.issueReview(review);
    const releaseBinding=Object.fromEntries(RELEASE_BINDING_KEYS.map(key=>[key,review[key]]));
    return {review,available:{version:review.gameVersion,sha256:review.contentSha256,reviewId:review.id},
      activation:{operationId:randomUUID(),reviewId:review.id,runId:run.id,workerId,runRevision:run.revision,
        serviceRevision:1,bindings,roundId:row.roundId,releaseBinding,commitSha:hash('1'),deploymentId:'deployment-fixture',expectedRevision:0}};
  }
  const confirm=(expectedRevision)=>publications.confirm({operationId:randomUUID(),expectedRevision,observationDigest:hash('2')});
  return {client,store,member,bindings,publications,candidate,confirm,run};
}

async function publicationEffects(client) {
  return {
    selection:(await client.execute('SELECT * FROM game_publication_selection')).rows,
    events:(await client.execute('SELECT COUNT(*) AS n FROM game_publication_events')).rows,
    audits:(await client.execute('SELECT COUNT(*) AS n FROM admin_audit')).rows,
    runs:(await client.execute('SELECT * FROM development_runs ORDER BY id')).rows,
  };
}

async function setDatabaseTime(client,time) {
  await client.execute({sql:'UPDATE test_clock SET now_ms=? WHERE id=1',args:[time]});
}

async function addAncestor(client,id,parentId=null) {
  await client.execute({sql:`INSERT INTO development_runs(id,label,summary,status,created_at,updated_at,parent_id)
    VALUES(?,'Ancestor fixture','Synthetic immutable ancestry','failed',0,0,?)`,args:[id,parentId]});
}

test('daily activation rejects before midnight without mutation and permits exact midnight using DBclock',async t=>{
  const f=await fixture(t,{runId:'daily-game-2026-09-01',proposalTime:INITIAL_CUTOFF});
  const a=await f.candidate('a');
  assert.equal(a.activation.roundId,'pending');
  assert.deepEqual(await resolveDailyRunCycle(f.client,f.run.id),dailyCycleForDate('2026-09-01'));
  const releaseAt=Date.parse(dailyCycleForDate('2026-09-01').releaseAt);
  const before=await publicationEffects(f.client);
  for(const bypass of [{releaseAt:0},{dailyReleaseAllowed:true}]) {
    await assert.rejects(f.publications.activate({...a.activation,...bypass}),errorCode('INVALID_PUBLICATION_INPUT'));
    assert.deepEqual(await publicationEffects(f.client),before);
  }
  for(const time of [releaseAt-3600000,releaseAt-1]) {
    await setDatabaseTime(f.client,time);
    await assert.rejects(f.publications.activate(a.activation),errorCode('DAILY_RELEASE_NOT_DUE'));
    assert.deepEqual(await publicationEffects(f.client),before);
  }
  await setDatabaseTime(f.client,releaseAt);
  assert.equal((await f.publications.activate(a.activation)).revision,1);
  assert.equal((await f.confirm(1)).verified,true);
});

test('daily confirmation rechecks trusted release time in its own transaction without mutation on rejection',async t=>{
  const f=await fixture(t,{runId:'daily-game-2026-09-01',proposalTime:INITIAL_CUTOFF+3600000});
  const a=await f.candidate('a');
  const releaseAt=Date.parse(dailyCycleForDate('2026-09-01').releaseAt);
  await setDatabaseTime(f.client,releaseAt);
  await f.publications.activate(a.activation);
  const before=await publicationEffects(f.client);
  await setDatabaseTime(f.client,releaseAt-1);
  await assert.rejects(f.confirm(1),errorCode('DAILY_RELEASE_NOT_DUE'));
  assert.deepEqual(await publicationEffects(f.client),before);
  await setDatabaseTime(f.client,releaseAt);
  assert.equal((await f.confirm(1)).verified,true);
});

test('retry descendants inherit the daily root deadline instead of their own ids or timestamps',async t=>{
  const f=await fixture(t,{proposalTime:INITIAL_CUTOFF+3600000});
  await addAncestor(f.client,'daily-game-2026-09-01');
  await addAncestor(f.client,'retry-parent-fixture','daily-game-2026-09-01');
  await f.client.execute({sql:'UPDATE development_runs SET parent_id=? WHERE id=?',args:['retry-parent-fixture',f.run.id]});
  assert.deepEqual(await resolveDailyRunCycle(f.client,f.run.id),dailyCycleForDate('2026-09-01'));
  const a=await f.candidate('a');
  const releaseAt=Date.parse(dailyCycleForDate('2026-09-01').releaseAt);
  const before=await publicationEffects(f.client);
  await setDatabaseTime(f.client,releaseAt-1);
  await assert.rejects(f.publications.activate(a.activation),errorCode('DAILY_RELEASE_NOT_DUE'));
  assert.deepEqual(await publicationEffects(f.client),before);
  await setDatabaseTime(f.client,releaseAt);
  assert.equal((await f.publications.activate(a.activation)).revision,1);
  assert.equal((await f.confirm(1)).verified,true);
  assert.deepEqual((await publicationEffects(f.client)).runs,before.runs);
});

test('daily root accepts only its pending proposal creation window and preclose updated times',async t=>{
  const cycle=dailyCycleForDate('2026-09-01');
  const closesAt=Date.parse(cycle.closesAt),releaseAt=Date.parse(cycle.releaseAt);
  for(const kind of ['initial-input','later-cycle','late-updated','pending-nondaily-root']) await t.test(kind,async t=>{
    const f=await fixture(t,{
      runId:kind==='pending-nondaily-root'?undefined:'daily-game-2026-09-01',
      proposalTime:kind==='initial-input'?INITIAL_CUTOFF-1:kind==='later-cycle'?closesAt:INITIAL_CUTOFF+3600000,
    });
    if(kind==='late-updated') await f.client.execute({sql:'UPDATE proposals SET updated_at=? WHERE id=?',args:[closesAt,f.bindings[0].id]});
    const a=await f.candidate('a');
    await setDatabaseTime(f.client,releaseAt);
    const before=await publicationEffects(f.client);
    await assert.rejects(f.publications.activate(a.activation),errorCode('WORKER_BLOCKED'));
    assert.deepEqual(await publicationEffects(f.client),before);
    if(kind==='pending-nondaily-root') assert.equal(await resolveDailyRunCycle(f.client,f.run.id),null);
  });
});

test('daily confirmation rechecks proposal window and frozen update time without mutation',async t=>{
  const cycle=dailyCycleForDate('2026-09-01'),closesAt=Date.parse(cycle.closesAt);
  const f=await fixture(t,{runId:'daily-game-2026-09-01',proposalTime:INITIAL_CUTOFF+3600000});
  await f.client.execute({sql:'UPDATE proposals SET updated_at=? WHERE id=?',args:[closesAt-1,f.bindings[0].id]});
  const a=await f.candidate('a');
  await setDatabaseTime(f.client,Date.parse(cycle.releaseAt));
  await f.publications.activate(a.activation);
  await f.client.execute({sql:'UPDATE proposals SET updated_at=? WHERE id=?',args:[closesAt,f.bindings[0].id]});
  const before=await publicationEffects(f.client);
  await assert.rejects(f.confirm(1),errorCode('WORKER_BLOCKED'));
  assert.deepEqual(await publicationEffects(f.client),before);
});

test('malformed daily roots and missing, cyclic or overlong ancestry fail closed without publication mutation',async t=>{
  for(const kind of ['invalid-date','malformed-daily-id','missing-parent','cycle','depth','daily-non-root']) await t.test(kind,async t=>{
    const f=await fixture(t);
    if(kind==='cycle') {
      await f.client.execute({sql:'UPDATE development_runs SET parent_id=id WHERE id=?',args:[f.run.id]});
    } else if(kind==='missing-parent') {
      // Model pre-existing corruption in this disposable local fixture only.
      await f.client.execute('PRAGMA foreign_keys=OFF');
      await f.client.execute({sql:'UPDATE development_runs SET parent_id=? WHERE id=?',args:['missing-parent-fixture',f.run.id]});
      await f.client.execute('PRAGMA foreign_keys=ON');
    } else {
      let parentId=kind==='invalid-date'?'daily-game-2026-02-30':kind==='malformed-daily-id'?'daily-game-invalid':'legacy-root-fixture';
      await addAncestor(f.client,parentId);
      if(kind==='depth') for(let i=0;i<64;i+=1) {
        const id=`ancestor-fixture-${i}`;
        await addAncestor(f.client,id,parentId); parentId=id;
      }
      if(kind==='daily-non-root') {
        await addAncestor(f.client,'daily-game-2026-09-01',parentId); parentId='daily-game-2026-09-01';
      }
      await f.client.execute({sql:'UPDATE development_runs SET parent_id=? WHERE id=?',args:[parentId,f.run.id]});
    }
    const a=await f.candidate('a');
    const before=await publicationEffects(f.client);
    await setDatabaseTime(f.client,Date.parse('2026-09-03T00:00:00+09:00'));
    await assert.rejects(f.publications.activate(a.activation),errorCode('WORKER_BLOCKED'));
    assert.deepEqual(await publicationEffects(f.client),before);
  });
});

test('empty compiled registry never reads a database; absent selection migration fails closed without writes',async t=>{
  assert.deepEqual(await createGamePublicationStore({}).getPublicGame(),{published:false});
  const f=await fixture(t,{prepare:false});
  const a=await f.candidate('a');
  assert.deepEqual(await f.publications.getPublicGame([a.available]),{published:false});
  assert.deepEqual(await f.publications.getSelection(),{revision:0,activeReviewId:null,previousVerifiedReviewId:null,verified:false});
  await assert.rejects(f.publications.activate(a.activation),errorCode('PUBLICATION_UNAVAILABLE'));
});

test('publication preparation preserves user data, refuses changed control, and does not reset the singleton',async t=>{
  const f=await fixture(t,{prepare:false});
  const before=(await f.client.execute('SELECT (SELECT COUNT(*) FROM users) AS users,(SELECT COUNT(*) FROM proposals) AS proposals')).rows;
  await assert.rejects(preparePublicationSchema(f.client,{expectedServiceRevision:2}),errorCode('WORKER_BLOCKED'));
  await preparePublicationSchema(f.client,{expectedServiceRevision:1});
  const a=await f.candidate('a');
  await f.publications.activate(a.activation);
  await preparePublicationSchema(f.client,{expectedServiceRevision:1});
  assert.equal((await f.publications.getSelection()).revision,1);
  assert.deepEqual((await f.client.execute('SELECT (SELECT COUNT(*) FROM users) AS users,(SELECT COUNT(*) FROM proposals) AS proposals')).rows,before);
});

test('activation authenticates exact review and current input, then exact operation replay is harmless',async t=>{
  const f=await fixture(t);
  const a=await f.candidate('a');
  for(const overrides of [{reviewId:randomUUID()},{workerId:'different-worker'},{runRevision:99},{serviceRevision:99},
    {releaseBinding:{...a.activation.releaseBinding,runtimeDigest:hash('9')}}]) {
    await assert.rejects(f.publications.activate({...a.activation,...overrides}));
  }
  const first=await f.publications.activate(a.activation);
  assert.equal(first.revision,1); assert.equal(first.verified,false); assert.equal(first.previousVerifiedReviewId,null);
  assert.equal((await f.publications.activate(a.activation)).replayed,true);
  await assert.rejects(f.publications.activate({...a.activation,commitSha:hash('3')}),errorCode('PUBLICATION_CONFLICT'));
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM game_publication_events')).rows[0].n,1);
});

test('first provisional failure restores no game and is never reused as the next fallback',async t=>{
  const f=await fixture(t);
  const a=await f.candidate('a'),b=await f.candidate('b');
  await f.publications.activate(a.activation);
  await assert.rejects(f.publications.activate({...b.activation,expectedRevision:1}),errorCode('PUBLICATION_PENDING_VERIFICATION'));
  const rollback={operationId:randomUUID(),expectedRevision:1,reason:'Synthetic first candidate failure'};
  const restored=await f.publications.rollback(rollback);
  assert.equal(restored.activeReviewId,null); assert.equal(restored.verified,false); assert.equal(restored.revision,2);
  assert.equal((await f.publications.rollback(rollback)).replayed,true);
  assert.deepEqual(await f.publications.getPublicGame([a.available,b.available]),{published:false});
  await f.publications.activate({...b.activation,expectedRevision:2});
  assert.deepEqual(await f.publications.getPublicGame([a.available,b.available]),{published:true,version:b.available.version,sha256:b.available.sha256});
});

test('only verified deployed predecessors are offered and rollback restores their own prior verified chain once',async t=>{
  const f=await fixture(t);
  const a=await f.candidate('a'),b=await f.candidate('b'),c=await f.candidate('c');
  await f.publications.activate(a.activation); await f.confirm(1);
  await f.publications.activate({...b.activation,expectedRevision:2});
  assert.deepEqual(await f.publications.getPublicGame([a.available]),{published:false});
  assert.deepEqual(await f.publications.getPublicGame([b.available]),{published:true,version:b.available.version,sha256:b.available.sha256});
  const pair={published:true,version:b.available.version,sha256:b.available.sha256,previous:{version:a.available.version,sha256:a.available.sha256}};
  assert.deepEqual(await f.publications.getPublicGame([a.available,b.available]),pair);
  await f.confirm(3);
  await f.publications.activate({...c.activation,expectedRevision:4});
  const rollback={operationId:randomUUID(),expectedRevision:5,reason:'Synthetic third candidate failure'};
  assert.equal((await f.publications.rollback(rollback)).activeReviewId,b.review.id);
  assert.equal((await f.publications.rollback(rollback)).replayed,true);
  assert.deepEqual(await f.publications.getPublicGame([a.available,b.available,c.available]),pair);
  assert.equal((await f.publications.getSelection()).revision,6);
  await assert.rejects(f.publications.rollback({...rollback,operationId:randomUUID()}),errorCode('REVISION_CONFLICT'));
});

test('confirmation needs live observation digest and fresh controls/approved bindings',async t=>{
  const f=await fixture(t);
  const a=await f.candidate('a');
  await f.publications.activate(a.activation);
  await assert.rejects(f.publications.confirm({operationId:randomUUID(),expectedRevision:1,observationDigest:'fake'}),errorCode('INVALID_PUBLICATION_INPUT'));
  await f.client.execute({sql:"UPDATE proposal_safety_reviews SET status='held',revision=revision+1 WHERE id=?",args:[f.bindings[0].safetyReviewId]});
  await assert.rejects(f.confirm(1),errorCode('WORKER_BLOCKED'));
  assert.equal((await f.publications.getSelection()).verified,false);
  // A failed input must not prevent preserving the existing last-good game.
  assert.equal((await f.publications.rollback({operationId:randomUUID(),expectedRevision:1,reason:'Input withdrawn'})).activeReviewId,null);
});

test('stopped service blocks both confirmation and rollback without changing selection',async t=>{
  const f=await fixture(t);
  const a=await f.candidate('a');
  await f.publications.activate(a.activation);
  await f.client.execute('UPDATE service_control SET development_enabled=0,revision=revision+1 WHERE id=1');
  await assert.rejects(f.confirm(1),errorCode('WORKER_BLOCKED'));
  await assert.rejects(f.publications.rollback({operationId:randomUUID(),expectedRevision:1,reason:'Synthetic failure'}),errorCode('WORKER_BLOCKED'));
  assert.equal((await f.publications.getSelection()).revision,1);
});

test('compiled artifact identity and immutable version identity fail closed; events cannot be edited',async t=>{
  const f=await fixture(t);
  const a=await f.candidate('a');
  await f.publications.activate(a.activation); await f.confirm(1);
  for(const changed of [{...a.available,sha256:hash('9')},{...a.available,reviewId:randomUUID()},
    {...a.available,version:'wrong-version'},{...a.available,approved:true}]) {
    assert.deepEqual(await f.publications.getPublicGame([changed]),{published:false});
  }
  const b=await f.candidate('b',{gameVersion:a.review.gameVersion});
  await assert.rejects(f.publications.activate({...b.activation,expectedRevision:2}),errorCode('GAME_VERSION_CONFLICT'));
  await assert.rejects(f.client.execute('UPDATE game_publication_events SET reason=reason'));
  await assert.rejects(f.client.execute('DELETE FROM game_publication_events'));
  const publicResult=JSON.stringify(await f.publications.getPublicGame([a.available]));
  assert.equal(publicResult.includes(a.review.id),false); assert.equal(publicResult.includes('bindings'),false);
  await assert.rejects(f.store.contribution.settle({reviewId:a.review.id}),errorCode('RELEASE_REVIEW_UNAVAILABLE'));
});

test('an unaudited manual selection cannot serve a reviewed but never-selected game',async t=>{
  const f=await fixture(t);
  const a=await f.candidate('a');
  await f.client.execute({sql:'UPDATE game_publication_selection SET active_review_id=?,revision=1 WHERE id=1',args:[a.review.id]});
  assert.deepEqual(await f.publications.getPublicGame([a.available]),{published:false});
});
