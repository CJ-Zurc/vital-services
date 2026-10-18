import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { createArtifactRepository } from '../src/eda/modules/records/artifact-repository.js';
import type { ArtifactClaim,ArtifactJob,ArtifactPrepared,ArtifactPublication } from '../src/eda/modules/records/artifacts.js';

type Capacity={operationId:string|null;operationFence:number|null;leaseOwner:string|null;leaseUntil:Date|null};
type Operation={id:string;resourceId:string;state:string;version:number;attempts:number;leaseOwner:string|null;leaseUntil:Date|null;nextAttemptAt:Date;preparedArtifact:ArtifactPrepared|null;errorCode:string|null};
type Asset={id:string;patientId:string;kind:string;state:string;version:number;objectKey:string;contentHash:string;byteLength:number;mimeType:string;publishedKey?:string;scanEvidence?:unknown};

// Transactional SQL fixture: shared row locks, rollback and a controllable database clock.
function fixture(count=2){
  let now=Date.now(),capacity:Capacity|null={operationId:null,operationFence:null,leaseOwner:null,leaseUntil:null};
  let operations=new Map<string,Operation>(),assets=new Map<string,Asset>(),events=0,holder:number|null=null,serial=0;
  let failure:string|undefined,expireOn:string|undefined;
  const waiters:Array<()=>void>=[],queries:Array<{tx:number;sql:string;args:unknown[]}>=[];
  for(let i=0;i<count;i++){
    const id=randomUUID(),resourceId=randomUUID();
    operations.set(id,{id,resourceId,state:'pending',version:0,attempts:0,leaseOwner:null,leaseUntil:null,nextAttemptAt:new Date(now),preparedArtifact:null,errorCode:null});
    assets.set(resourceId,{id:resourceId,patientId:randomUUID(),kind:'upload',state:'quarantine',version:0,objectKey:'quarantine/'+resourceId,contentHash:'a'.repeat(64),byteLength:3,mimeType:'application/pdf'});
  }
  const matchesCapacity=(args:unknown[])=>!!capacity&&capacity.operationId===args[0]&&capacity.leaseOwner===args[1]&&capacity.operationFence===args[2]&&!!capacity.leaseUntil&&capacity.leaseUntil.getTime()>now;
  const matchesOperation=(args:unknown[])=>{const op=operations.get(String(args[0]));return !!op&&op.leaseOwner===args[1]&&op.version===args[2]&&op.state==='processing'&&!!op.leaseUntil&&op.leaseUntil.getTime()>now;};
  const pool={
    query:async()=>{throw new Error('Repository must use a transaction, not pool.query');},
    connect:async()=>{
      const tx=++serial;let prior:{capacity:Capacity|null;operations:Map<string,Operation>;assets:Map<string,Asset>;events:number}|undefined;
      const unlock=()=>{if(holder===tx){holder=null;for(const wake of waiters.splice(0))wake();}};
      return{release(){assert.notEqual(holder,tx,'Connection released with capacity still locked');},async query(source:string,args:unknown[]=[]){
        const sql=source.replace(/\s+/g,' ').trim();queries.push({tx,sql,args});
        assert.doesNotMatch(sql,/\b(?:CREATE|ALTER|DROP|TRUNCATE)\b/i);
        const done=(rows:unknown[]=[],rowCount=rows.length)=>({rows:structuredClone(rows),rowCount});
        if(sql==='BEGIN')return done();
        if(sql==='COMMIT'){unlock();return done();}
        if(sql==='ROLLBACK'){if(prior){({capacity,operations,assets,events}=prior);}unlock();return done();}
        if(expireOn&&sql.startsWith(expireOn)){expireOn=undefined;now+=60001;}
        if(failure&&sql.startsWith(failure)){failure=undefined;throw new Error('SYNTHETIC_SQL_FAILURE');}
        if(sql.startsWith('SELECT id FROM records_artifact_capacity')){
          assert.match(sql,/clock_timestamp\(\)/);
          const available=()=>sql.includes('"leaseUntil" IS NULL')?!!capacity&&(!capacity.leaseUntil||capacity.leaseUntil.getTime()<=now):matchesCapacity(args);
          if(!available())return done();
          if(sql.includes('FOR UPDATE')){
            if(holder!==null&&holder!==tx&&sql.includes('SKIP LOCKED'))return done();
            while(holder!==null&&holder!==tx)await new Promise<void>(resolve=>waiters.push(resolve));
            if(!available())return done();
            holder=tx;prior=structuredClone({capacity,operations,assets,events});
          }
          if(sql.includes('EXISTS')&&!matchesOperation(args))return done();
          return done([{id:1}]);
        }
        assert.equal(holder,tx,'Operation accessed before capacity lock');
        if(sql.startsWith('WITH due AS')){
          assert.match(sql,/FOR UPDATE SKIP LOCKED/);assert.match(sql,/clock_timestamp\(\)\+\$2\*INTERVAL '1 millisecond'/);
          const op=[...operations.values()].find(o=>o.state==='pending'&&o.nextAttemptAt.getTime()<=now||o.state==='processing'&&!!o.leaseUntil&&o.leaseUntil.getTime()<=now);
          if(!op)return done();
          op.state='processing';op.leaseOwner=String(args[0]);op.leaseUntil=new Date(now+Number(args[1]));op.version++;op.attempts++;return done([op]);
        }
        if(sql.startsWith('SELECT * FROM record_operations'))return done(matchesOperation(args)?[operations.get(String(args[0]))]:[]);
        if(sql.startsWith('SELECT a.*,d.id'))return done(assets.has(String(args[0]))?[assets.get(String(args[0]))]:[]);
        if(sql.startsWith('UPDATE records_artifact_capacity')){
          if(sql.includes('"operationId"=NULL')){if(!matchesCapacity(args))return done();capacity={operationId:null,operationFence:null,leaseOwner:null,leaseUntil:null};}
          else if(sql.includes('SET "operationId"=')){assert.ok(capacity);capacity={operationId:String(args[0]),leaseOwner:String(args[1]),operationFence:Number(args[2]),leaseUntil:operations.get(String(args[0]))!.leaseUntil};}
          else{if(!matchesCapacity(args))return done();capacity!.leaseUntil=operations.get(String(args[0]))!.leaseUntil;}
          return done([],1);
        }
        if(sql.startsWith('UPDATE record_operations')){
          if(!matchesOperation(args))return done();const op=operations.get(String(args[0]))!;
          if(sql.includes('SET "leaseUntil"=')){assert.match(sql,/clock_timestamp\(\)\+\$4/);op.leaseUntil=new Date(now+Number(args[3]));}
          else if(sql.includes('SET "preparedArtifact"='))op.preparedArtifact=JSON.parse(String(args[3])) as ArtifactPrepared;
          else{op.state=sql.includes("state='completed'")?'completed':sql.includes("state='rejected'")?'rejected':String(args[3]);op.leaseOwner=null;op.leaseUntil=null;
            if(sql.includes('"nextAttemptAt"=$5')){op.nextAttemptAt=args[4] as Date;op.errorCode=String(args[5]);}
            else op.errorCode=sql.includes("state='rejected'")?String(args[3]):null;
          }return done([],1);
        }
        if(sql.startsWith('UPDATE records_file_assets')){
          const asset=assets.get(String(args[0]));assert.ok(asset);
          if(sql.includes("state='ready'")){asset.state='ready';asset.publishedKey=String(args[1]);asset.version++;return done([{version:asset.version}]);}
          if(sql.includes("state='rejected'")){asset.state='rejected';asset.version++;}
          else asset.scanEvidence=JSON.parse(String(args[1])) as unknown;
          return done([],1);
        }
        if(sql.startsWith('INSERT INTO outbox_events')){events++;return done([],1);}
        throw new Error('Unexpected fixture SQL: '+sql);
      }};
    },
  } as unknown as Pool;
  const repository=createArtifactRepository(pool);
  const claim=(owner='worker-a')=>repository.claimDue({leaseOwner:owner,leaseMs:60000,now:new Date(0)});
  const handle=(job:ArtifactJob,owner='worker-a'):ArtifactClaim=>({operationId:job.operationId,leaseOwner:owner,fence:job.fence});
  const prepared:ArtifactPrepared={objectKey:'final/synthetic.pdf',contentHash:'a'.repeat(64),byteLength:3,mimeType:'application/pdf'};
  const publication=():ArtifactPublication=>({...prepared,scanEvidence:{final:{engine:'clamav',engineVersion:'synthetic',databaseVersion:1,databaseDate:new Date(now).toISOString(),scannedAt:new Date(Date.now()).toISOString(),contentHash:prepared.contentHash,byteLength:3,verdict:'clean'}}});
  return{repository,claim,handle,prepared,publication,queries,capacity:()=>capacity,operations:()=>operations,assets:()=>assets,events:()=>events,
    advance:(ms:number)=>{now+=ms;},missing:()=>{capacity=null;},fail:(prefix:string)=>{failure=prefix;},expire:(prefix:string)=>{expireOn=prefix;}};
}

test('Records artifact repository capacity one serializes competing workers and uses the database clock',async()=>{
  const f=fixture();const results=await Promise.all([f.claim('a'),f.claim('b')]);
  assert.equal(results.filter(Boolean).length,1);assert.equal(await f.claim('c'),null);
  const job=results.find((value):value is ArtifactJob=>value!==null)!;
  assert.equal(job.fence,1);assert.equal(f.capacity()!.operationId,job.operationId);
  assert.ok(f.capacity()!.leaseUntil!.getTime()>Date.now()-1000);
  assert.equal([...f.operations().values()].reduce((n,o)=>n+o.attempts,0),1);
});

test('Records artifact repository missing seed and empty queue fail closed without DDL or runtime insertion',async()=>{
  const f=fixture();f.missing();assert.equal(await f.claim(),null);
  assert.ok(f.queries.every(q=>!q.sql.startsWith('WITH due')&&!q.sql.startsWith('INSERT')));
  const empty=fixture(0);assert.equal(await empty.claim(),null);assert.equal(empty.capacity()!.operationId,null);
});

test('Records artifact repository expired capacity recovers with a new fence and blocks all stale mutations',async()=>{
  const f=fixture(1),first=(await f.claim())!,old=f.handle(first);await f.repository.savePrepared(old,f.prepared);
  f.advance(60000);assert.equal(await f.repository.renew(old,{leaseMs:60000,now:new Date()}),false);
  const second=(await f.claim())!,current=f.handle(second);assert.equal(second.fence,first.fence+1);assert.deepEqual(second.prepared,f.prepared);
  assert.equal(await f.repository.savePrepared(old,f.prepared),false);assert.equal(await f.repository.recordScan(old,f.publication().scanEvidence),false);
  assert.equal(await f.repository.publish(old,f.publication()),false);
  await f.repository.retry(old,{errorCode:'STALE',nextAttemptAt:new Date(),blocked:false});await f.repository.reject(old,'STALE');
  assert.equal(f.capacity()!.operationFence,current.fence);assert.equal(f.operations().get(current.operationId)!.state,'processing');assert.equal(f.events(),0);
});

test('Records artifact repository renewal updates both leases atomically and preserves capacity',async()=>{
  const f=fixture(),job=(await f.claim())!,claim=f.handle(job),before=f.capacity()!.leaseUntil!.getTime();f.advance(15000);
  assert.equal(await f.repository.renew(claim,{leaseMs:60000,now:new Date(0)}),true);
  assert.equal(f.capacity()!.leaseUntil!.getTime(),before+15000);assert.deepEqual(f.capacity()!.leaseUntil,f.operations().get(job.operationId)!.leaseUntil);
  const renewed=f.capacity()!.leaseUntil!.getTime();f.advance(15000);f.fail('UPDATE records_artifact_capacity');
  await assert.rejects(f.repository.renew(claim,{leaseMs:60000,now:new Date()}),/SYNTHETIC_SQL_FAILURE/);
  assert.equal(f.capacity()!.leaseUntil!.getTime(),renewed);assert.equal(f.operations().get(job.operationId)!.leaseUntil!.getTime(),renewed);
  assert.equal(await f.claim('b'),null);
});

test('Records artifact repository fresh expiry after waiting or during renewal rolls back both leases',async()=>{
  for(const prefix of ['SELECT * FROM record_operations','UPDATE records_artifact_capacity']){
    const f=fixture(1),job=(await f.claim())!,claim=f.handle(job),before=f.capacity()!.leaseUntil!.getTime();f.expire(prefix);
    assert.equal(await f.repository.renew(claim,{leaseMs:60000,now:new Date()}),false);
    assert.equal(f.capacity()!.leaseUntil!.getTime(),before);assert.equal(f.operations().get(job.operationId)!.leaseUntil!.getTime(),before);
    assert.ok(await f.claim('b'));
  }
});

test('Records artifact repository wrong owners and mismatched operation leases cannot renew or release capacity',async()=>{
  const f=fixture(1),job=(await f.claim())!,claim=f.handle(job),wrong=f.handle(job,'worker-b');
  assert.equal(await f.repository.renew(wrong,{leaseMs:60000,now:new Date()}),false);
  await f.repository.retry(wrong,{errorCode:'STALE',nextAttemptAt:new Date(0),blocked:false});await f.repository.reject(wrong,'STALE');
  assert.equal(f.capacity()!.leaseOwner,claim.leaseOwner);
  f.operations().get(job.operationId)!.leaseUntil=new Date(0);
  assert.equal(await f.repository.renew(claim,{leaseMs:60000,now:new Date()}),false);
  assert.equal(await f.claim('worker-b'),null);assert.equal(f.capacity()!.operationId,job.operationId);
});

test('Records artifact repository publish releases capacity atomically and stale publication cannot release a different job',async()=>{
  const f=fixture(),job=(await f.claim())!,claim=f.handle(job);await f.repository.savePrepared(claim,f.prepared);
  assert.equal(await f.repository.publish(claim,f.publication()),true);assert.equal(f.capacity()!.operationId,null);assert.equal(f.events(),1);
  assert.equal(f.operations().get(job.operationId)!.state,'completed');assert.equal(f.assets().get(job.assetId)!.state,'ready');
  const next=(await f.claim())!;assert.notEqual(next.operationId,job.operationId);
  assert.equal(await f.repository.publish(claim,f.publication()),false);assert.equal(f.capacity()!.operationId,next.operationId);assert.equal(f.events(),1);
});

test('Records artifact repository retry blocked retry and rejection release only their own capacity',async()=>{
  for(const outcome of ['retry','blocked','reject']){
    const f=fixture(),job=(await f.claim())!,claim=f.handle(job),nextAttemptAt=new Date(Date.now()+3600000);
    if(outcome==='reject')await f.repository.reject(claim,'MALWARE');
    else await f.repository.retry(claim,{errorCode:'SCANNER_UNAVAILABLE',nextAttemptAt,blocked:outcome==='blocked'});
    assert.equal(f.capacity()!.operationId,null);assert.equal(f.operations().get(job.operationId)!.state,outcome==='reject'?'rejected':outcome==='blocked'?'blocked':'pending');
    const next=(await f.claim())!;assert.notEqual(next.operationId,job.operationId);
    await f.repository.retry(claim,{errorCode:'STALE',nextAttemptAt:new Date(0),blocked:false});await f.repository.reject(claim,'STALE');
    assert.equal(f.capacity()!.operationId,next.operationId);assert.equal(f.operations().get(next.operationId)!.state,'processing');
  }
});

test('Records artifact repository failed release or outbox rolls back terminal operation asset and capacity',async()=>{
  for(const prefix of ['UPDATE records_artifact_capacity','INSERT INTO outbox_events']){
    const f=fixture(1),job=(await f.claim())!,claim=f.handle(job);await f.repository.savePrepared(claim,f.prepared);f.fail(prefix);
    await assert.rejects(f.repository.publish(claim,f.publication()),/SYNTHETIC_SQL_FAILURE/);
    assert.equal(f.operations().get(job.operationId)!.state,'processing');assert.equal(f.assets().get(job.assetId)!.state,'quarantine');
    assert.equal(f.capacity()!.operationId,job.operationId);assert.equal(f.events(),0);assert.equal(await f.repository.publish(claim,f.publication()),true);
  }
});

test('Records artifact repository expiry during terminal release rolls back publication and outbox',async()=>{
  const f=fixture(1),job=(await f.claim())!,claim=f.handle(job);await f.repository.savePrepared(claim,f.prepared);
  f.expire('UPDATE records_artifact_capacity');assert.equal(await f.repository.publish(claim,f.publication()),false);
  assert.equal(f.operations().get(job.operationId)!.state,'processing');assert.equal(f.assets().get(job.assetId)!.state,'quarantine');assert.equal(f.events(),0);
  const recovered=(await f.claim('worker-b'))!;assert.equal(recovered.fence,job.fence+1);assert.equal(f.capacity()!.leaseOwner,'worker-b');
});

test('Records artifact repository claim failure rolls back operation attempts and singleton acquisition',async()=>{
  const f=fixture(1);f.fail('SELECT a.*,d.id');await assert.rejects(f.claim(),/SYNTHETIC_SQL_FAILURE/);
  assert.equal(f.capacity()!.operationId,null);assert.equal([...f.operations().values()][0]!.attempts,0);assert.ok(await f.claim());
});

test('Records artifact repository claim expiry before commit does not leave a partially acquired operation',async()=>{
  const f=fixture(1);f.expire('SELECT a.*,d.id');assert.equal(await f.claim(),null);
  assert.equal(f.capacity()!.operationId,null);assert.equal([...f.operations().values()][0]!.attempts,0);assert.ok(await f.claim());
});

test('Records artifact repository rejects invalid lease durations before acquiring capacity',async()=>{
  const f=fixture();for(const duration of [0,-1,60001,1.5,Number.NaN]){
    await assert.rejects(f.repository.claimDue({leaseOwner:'worker-a',leaseMs:duration,now:new Date()}));
  }assert.equal(f.queries.length,0);
});

test('Records artifact capacity maintained schema and additive migration stay aligned',()=>{
  const migration=readFileSync(resolve('prisma/core/migrations/202610130003_records_ownership/migration.sql'),'utf8');
  assert.match(migration,/id SMALLINT PRIMARY KEY CHECK \(id=1\)/);assert.match(migration,/INSERT INTO records_artifact_capacity \(id\) VALUES \(1\)/);
  assert.match(migration,/"operationFence" IS NOT NULL AND "operationFence">0/);
  const model=(path:string)=>readFileSync(resolve(path),'utf8').match(/model RecordsArtifactCapacity \{[^}]+\}/)?.[0];
  const capacity=model('prisma/core/schema.prisma');assert.ok(capacity);
  assert.match(capacity,/id Int @id @db.SmallInt/);assert.match(capacity,/operationId String\? @unique @db.Uuid/);
  assert.match(capacity,/operationFence Int\?/);assert.match(capacity,/onDelete: Restrict/);
  assert.match(capacity,/@@map\("records_artifact_capacity"\)/);
});
