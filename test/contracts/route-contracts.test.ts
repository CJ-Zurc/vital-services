import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { reviewRouteContract } from '../../scripts/eda/route-contracts.mjs';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '../../../vital-web');
const sha = (text: string) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
type Route = { path: string; source: string; sourceSha256: string; methods: string[] };
const read = (file: string) => readFileSync(resolve(web, file), 'utf8');
const review = reviewRouteContract as (route: Route, options?: { readSource?: (file: string) => string; webRoot?: string }) => any;

function routes() {
  const result: Route[] = [];
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name === 'route.ts') {
        const text = readFileSync(file, 'utf8'), tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const verbs = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']), found = new Set<string>();
        for (const node of tree.statements) {
          if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause))
            for (const item of node.exportClause.elements) if (verbs.has(item.name.text)) found.add(item.name.text);
          if (!node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
          if (ts.isFunctionDeclaration(node) && node.name && verbs.has(node.name.text)) found.add(node.name.text);
          if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations)
            if (ts.isIdentifier(declaration.name) && verbs.has(declaration.name.text)) found.add(declaration.name.text);
        }
        result.push({ path: '/' + relative(resolve(web, 'app'), dirname(file)).split(/[\\/]/).filter(part => !part.startsWith('(')).join('/'),
          methods: [...found].sort(), source: relative(web, file).replaceAll('\\', '/'), sourceSha256: sha(text) });
      }
    }
  }
  walk(resolve(web, 'app'));
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
const current = routes();
const reviewed = new Map<string, any>();
function get(path: string) {
  if (!reviewed.has(path)) reviewed.set(path, review(current.find(route => route.path === path)!));
  return reviewed.get(path);
}
function method(path: string, verb = 'GET') { return get(path).methods.find((row: any) => row.method === verb); }

test('route contract review maps every current Web route and exported method without claiming runtime parity', () => {
  assert.equal(current.length, 160, 'A changed route inventory requires explicit source review.');
  for (const route of current) {
    const result = get(route.path);
    assert.equal(result.reviewed, true, route.path + ': ' + JSON.stringify(result.gates));
    assert.equal(result.reviewType, 'static_source_review'); assert.equal(result.parityStatus, 'not_verified');
    assert.deepEqual(result.runtimeEvidence, []);
    assert.deepEqual(result.methods.map((row: any) => row.method).sort(), route.methods);
    for (const row of result.methods) {
      for (const field of ['targetOwner', 'caller', 'authentication', 'requiredRole', 'requestDto', 'responseDto', 'status', 'cookies', 'errors', 'dependencies', 'gates', 'bodyLimit', 'timeout'])
        assert.ok(row[field], `${row.method} ${route.path}: missing ${field}`);
      assert.equal(row.parityStatus, 'not_verified'); assert.deepEqual(row.runtimeEvidence, []);
      assert.equal(row.status.exhaustive, false);
      assert.match(row.gates.runtimeParity, /unverified/);
    }
    assert.ok(result.remainingGates.includes('runtime_route_parity_not_executed'));
    assert.match(result.evidenceSemantics, /not a passing test result/);
  }
});

test('route contract review verifies real BFF dispatch policies and method-specific ownership', () => {
  const patient = method('/api/patient/dashboard'), doctor = method('/api/doctor/dashboard');
  assert.equal(patient.family, 'completion'); assert.equal(doctor.family, 'appointment');
  assert.equal(patient.dispatch.symbol, 'targetCompletion'); assert.equal(doctor.dispatch.symbol, 'targetAppointment');
  assert.equal(patient.dispatch.policy.symbol, 'completionRouteAllowed');
  assert.equal(method('/api/doctor/patients/[patientId]/opqrst').family, 'extras');
  assert.equal(method('/api/doctor/patients/[patientId]/record').family, 'records');
  assert.equal(method('/api/patient/appointments/[appointmentId]/payment', 'POST').dispatch.symbol, 'targetPayment');
  assert.equal(method('/api/patient/appointments/[appointmentId]/payment', 'PATCH').dispatch.symbol, 'targetPayment');
  assert.equal(method('/api/auth/consent', 'GET').requiredRole, 'admin');
  assert.equal(method('/api/auth/consent', 'POST').requiredRole, 'patient');
  assert.match(method('/api/auth/me', 'GET').targetOwner, /Profile/);
  assert.equal(method('/api/auth/me', 'PATCH').targetOwner, 'UHSE_AUTH via Gateway');
  assert.match(method('/api/admin/users', 'PATCH').targetOwner, /Auth|AUTH/);
  const alias = method('/api/doctor/profile/onboarding', 'POST');
  assert.equal(alias.dispatch.handlerSource, 'app/api/doctor/onboarding/route.ts');
  assert.equal(alias.dispatch.implementation, 'lib/eda/profile-mutations.ts');
  const catalogs = method('/api/patient/health-records/catalogs/[catalog]');
  assert.equal(catalogs.dispatch.policy.probes.length, 4);
  assert.ok(catalogs.dispatch.policy.probes.every((probe: any) => probe.accepted));
  assert.match(catalogs.requiredRole, /patient or doctor/);
  assert.equal(method('/api/patient/documents/[documentType]/[documentId]/file').dispatch.policy.probes.length, 2);
  const records = get('/api/doctor/patients');
  assert.ok(records.evidence.some((item: any) => item.file === 'lib/eda/records-pages.ts'));
  assert.match(records.methods[0].dependencies.note, /not a browser contract change/);
  const readiness = method('/api/internal/vital/readiness');
  assert.equal(readiness.family, 'readiness');
  assert.equal(readiness.caller, 'Gateway server readiness probe; not browser');
  assert.match(readiness.authentication, /X-Gateway-Secret.*verified mTLS.*no user or actor assertion/);
  assert.match(readiness.requiredRole, /no patient\/doctor role or user session/);
  assert.equal(readiness.dispatch.frontDoor.targetModeAccepted, null);
  assert.deepEqual(readiness.dispatch.frontDoor.probes, []);
  assert.match(readiness.gates.frontDoor, /not_applicable/);
});

test('route contract review distinguishes public Auth callback internal and retired exceptions', () => {
  const address = method('/api/ph-address'); assert.equal(address.family, 'address'); assert.match(address.requiredRole, /public/);
  const sso = method('/api/auth/sso/callback', 'POST');
  assert.equal(sso.family, 'auth'); assert.match(sso.requestDto.summary, /exchange_token/);
  const meet = method('/api/doctor/google-meet/callback');
  assert.equal(meet.family, 'video'); assert.match(meet.caller, /callback navigation/);
  assert.match(meet.cookies.policy, /HttpOnly.*vital_google_meet_oauth/); assert.ok(meet.status.documentedFamilyBranches.includes(303));
  assert.match(method('/api/auth/google/url').targetOwner, /UHSE_AUTH/);
  assert.match(method('/api/auth/session').requestDto.summary, /refresh-token cookie.*not bearer-only/);
  assert.match(method('/api/auth/logout', 'POST').cookies.policy, /Clear.*even if upstream logout fails/);
  assert.match(method('/api/auth/me/password', 'POST').authentication, /no cookie-bootstrap fallback/);
  assert.match(method('/api/doctor').requiredRole, /not a role check/);
  assert.match(method('/internal/users/[user_id]/roles').requiredRole, /Auth internal service/);
  assert.match(method('/api/internal/analytics/v1/pre-consultations').authentication, /internal service\/key/);
  for (const [path, verb] of [['/api/admin/concerns', 'GET'], ['/api/admin/concerns/[concernId]', 'PATCH'], ['/api/appointments/[appointmentId]/concerns', 'POST']]) {
    const row = method(path!, verb); assert.equal(row.family, 'retired'); assert.deepEqual(row.status.documentedFamilyBranches, [410]);
    assert.deepEqual(row.dependencies.owners, []);
    assert.equal(row.dispatch.frontDoor.targetModeAccepted, false);
  }
  const worker = method('/api/internal/appointments/auto-complete', 'POST');
  assert.equal(worker.family, 'worker'); assert.deepEqual(worker.status.documentedFamilyBranches, [503]);
  assert.match(method('/api/test-support/e2e/credentials/consume', 'POST').authentication, /test-only/);
  for (const path of ['/integrations/v1/doctors', '/integrations/v1/patient/bootstrap', '/integrations/v1/prescriptions', '/integrations/v1/medical-certificates']) {
    const post = method(path, 'POST');
    assert.equal(post.dispatch.frontDoor.contractRoute, true);
    assert.equal(post.dispatch.frontDoor.targetModeAccepted, true);
    assert.equal('outsideApiMutation' in post.dispatch.frontDoor, false);
    assert.ok(post.dispatch.frontDoor.probes.every((probe: any) => probe.accepted && !probe.ingressGuardBlocked));
    assert.ok(!get(path).remainingGates.includes('front_door_blocks_target_mode_route'));
    assert.deepEqual(post.dispatch.frontDoor.ownerFlagChecks.map((check: any) => check.disabledFlag),
      [path.includes('prescriptions') || path.includes('medical-certificates') ? 'VITAL_EDA_RECORDS_ENABLED' : 'VITAL_EDA_COMPLETION_ENABLED']);
    assert.ok(post.dispatch.frontDoor.ownerFlagChecks.every((check: any) => check.probes.every((probe: any) => !probe.accepted && probe.ingressGuardBlocked)));
    assert.ok(get(path).evidence.some((item: any) => item.file === 'tests/eda-ingress-policy.test.ts' && item.execution === 'not_run'));
  }
});

test('route contract review hashes source validators and test evidence without inventing execution', () => {
  const result = get('/api/appointments/[appointmentId]/messages');
  const messageRoute = current.find(item => item.path === '/api/appointments/[appointmentId]/messages')!;
  const windows = review(messageRoute, { readSource: file => read(file).replace(/\r?\n/g, '\r\n') });
  assert.deepEqual(windows.evidence.map((item: any) => [item.file, item.sha256]),
    result.evidence.map((item: any) => [item.file, item.sha256]));
  assert.ok(result.evidence.some((item: any) => item.file === 'lib/eda/messaging-dto.ts'));
  assert.ok(result.evidence.some((item: any) => item.file === 'tests/messaging-ui-state.test.ts'));
  for (const evidence of result.evidence) {
    assert.equal(evidence.sha256, sha(read(evidence.file)), evidence.file);
    assert.equal(evidence.reviewedSha256, evidence.sha256);
    assert.equal(evidence.execution, 'not_run');
  }
  for (const reference of result.callerAndTestReferences) {
    assert.equal(reference.sha256, sha(read(reference.file)));
    assert.equal(reference.execution, 'not_run');
    for (const match of reference.references) assert.equal(typeof read(reference.file).split(/\r?\n/)[match.line - 1], 'string');
  }
  assert.ok(result.callerAndTestReferences.some((item: any) => item.kind === 'caller_source_reference'));
  const sending = method('/api/appointments/[appointmentId]/messages', 'POST');
  assert.ok(sending.requestDto.staticValidatorReferences.some((item: any) => /messagingSendInput/.test(item.source)));
  assert.match(sending.callerAndTestEvidence.scope, /HTTP method.*not inferred/);
  const route = current.find(row => row.path === '/api/doctor/google-meet/callback')!;
  assert.deepEqual(review(route), review(route), 'Static output must be deterministic, without timestamps or live calls.');
});

test('VITAL audit routes have explicit admin ownership and do not claim runtime parity',()=>{
  for(const [path,verb] of [['/api/admin/audit-logs','GET'],['/api/admin/audit-logs/export','POST']]){
    const row=method(path!,verb!);assert.equal(row.family,'audit');assert.equal(row.requiredRole,'admin');assert.equal(row.dispatch.symbol,'targetAudit');
    assert.equal(row.dispatch.frontDoor.targetModeAccepted,true);assert.equal(row.parityStatus,'not_verified');
  }
});

test('AI and appointment-code routes retain explicit owners, roles and dispatch',()=>{
  const intake=method('/api/patient/intakes','PATCH');
  assert.equal(intake.family,'intelligence');assert.equal(intake.requiredRole,'patient');
  assert.equal(intake.dispatch.symbol,'targetIntelligence');
  assert.equal(method('/api/doctor/ai/sandbox/analyze','POST').requiredRole,'doctor');
  assert.equal(method('/api/admin/analytics/clusters/label','POST').requiredRole,'admin');
  assert.equal(method('/api/doctor/appointments/[appointmentId]/intake-brief','POST').dispatch.symbol,'forward');
  for(const [path,verb,role] of [
    ['/api/doctor/appointments/[appointmentId]/access/redeem','POST','doctor'],
    ['/api/patient/appointments/[appointmentId]/access/code','GET','patient'],
    ['/api/patient/appointments/[appointmentId]/access/reissue','POST','patient'],
    ['/api/patient/appointments/[appointmentId]/access/withdraw','POST','patient']]){
    const row=method(path!,verb!);assert.equal(row.family,'appointment');assert.equal(row.requiredRole,role);
    assert.equal(row.dispatch.symbol,'targetAppointment');assert.equal(row.dispatch.frontDoor.targetModeAccepted,true);
  }
  const route=current.find(r=>r.path==='/api/patient/intakes/analyze')!;
  const unexpected=review({...route,methods:['DELETE']});assert.equal(unexpected.reviewed,false);
  assert.ok(unexpected.gates.some((g:any)=>g.code==='ROUTE_UNREVIEWED'));
});

test('route contract review gates unknown missing changed and mismatched route evidence', () => {
  const original = current.find(route => route.path === '/api/doctor/schedule')!;
  const codes = (value: any) => value.gates.map((gate: any) => gate.code);
  const unknown = review({ ...original, path: '/api/doctor/new-unreviewed', source: 'app/api/doctor/new-unreviewed/route.ts' });
  assert.equal(unknown.reviewed, false); assert.ok(codes(unknown).includes('ROUTE_UNREVIEWED'));
  const extra = review({ ...original, methods: [...original.methods, 'DELETE'] });
  assert.equal(extra.reviewed, false); assert.ok(codes(extra).includes('ROUTE_UNREVIEWED'));
  const changedHash = review({ ...original, sourceSha256: '0'.repeat(64) });
  assert.equal(changedHash.reviewed, false); assert.ok(codes(changedHash).includes('ROUTE_SOURCE_HASH_MISMATCH'));
  const missing = review(original, { readSource: file => {
    if (file === 'lib/eda/appointment-bff.ts') throw new Error('fixture missing implementation');
    return read(file);
  } });
  assert.equal(missing.reviewed, false); assert.ok(codes(missing).includes('EVIDENCE_MISSING'));
  const changed = review(original, { readSource: file => read(file) + (file === 'lib/eda/appointment-compatibility.ts' ? '\n// fixture edit\n' : '') });
  assert.equal(changed.reviewed, false); assert.ok(codes(changed).includes('REVIEW_SOURCE_CHANGED'));
  const mismatch = review(original, { readSource: file => read(file).replace(file === original.source ? /return targetAppointment\(req\)/g : /NEVER_MATCH_SENTINEL/g, 'return unrelatedOwner(req)') });
  assert.equal(mismatch.reviewed, false); assert.ok(codes(mismatch).includes('WRAPPER_DISPATCH_MISMATCH'));
  const deniedPolicy = review(original, { readSource: file => file === 'lib/eda/appointment-paths.ts'
    ? read(file).replace('export function appointmentRoute(path:string,method:string):AppointmentRoute|null{', 'export function appointmentRoute(path:string,method:string):AppointmentRoute|null{ return null;') : read(file) });
  assert.equal(deniedPolicy.reviewed, false); assert.ok(codes(deniedPolicy).includes('DISPATCH_POLICY_MISMATCH'));
  const integration = current.find(route => route.path === '/integrations/v1/doctors')!;
  const oldBlanket = review(integration, { readSource: file => file === 'proxy.ts'
    ? read(file).replace('!contractRoute && req.method', '!pathname.startsWith("/api/") && req.method') : read(file) });
  assert.equal(oldBlanket.reviewed, false); assert.ok(codes(oldBlanket).includes('REVIEW_SOURCE_CHANGED'));
  assert.equal(oldBlanket.methods.find((row: any) => row.method === 'POST').dispatch.frontDoor.targetModeAccepted, false);
  assert.ok(oldBlanket.remainingGates.includes('front_door_blocks_target_mode_route'));
  const unsafe = review({ ...original, path: '/../../outside', source: '../../outside.ts' });
  assert.equal(unsafe.reviewed, false); assert.ok(codes(unsafe).includes('ROUTE_INPUT_INVALID'));
});
