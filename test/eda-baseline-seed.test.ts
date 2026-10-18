import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSeedManifest, baselineLinksMatch } from '../src/eda/entrypoints/seed-contract.js';

const id = '12bc7e3e-679a-4c3c-8669-1d8668c31538';
const patient = { authId: id, email: 'baseline@example.test', firstName: 'Demo', middleName: '', lastName: 'Patient',
  systems: { vital: 'patient' }, metadata: {}, ehrUserId: '00da91c4-a8dd-4528-900b-e464a5f5ee11', ehrPatientId: 'cae1f073-4b49-4bc2-8524-030793402279' };
test('baseline seeds require owner-issued EHR links', () => {
  assert.equal(validateSeedManifest({ version: 1, accounts: [patient] }).accounts[0]?.authId, id);
  assert.throws(() => validateSeedManifest({ version: 1, accounts: [{ ...patient, ehrPatientId: undefined }] }), /BASELINE_EHR_LINK_MISSING/);
});
test('baseline seeds reject duplicate identities and unlinked doctors', () => {
  assert.throws(() => validateSeedManifest({ version: 1, accounts: [patient, patient] }), /BASELINE_DUPLICATE_IDENTITY/);
  assert.throws(() => validateSeedManifest({ version: 1, accounts: [{ ...patient, systems: { vital: 'doctor' } }] }), /BASELINE_DEPARTMENT_MISSING/);
});

test('repeated baseline links do not trigger profile writes or outbox effects', () => {
  const expected=validateSeedManifest({version:1,accounts:[patient]}).accounts[0]!;
  const linked={role:'patient',patient:{ehrPatientId:patient.ehrPatientId,isRecordAvailable:true}};
  const before=JSON.stringify(linked);
  assert.equal(baselineLinksMatch(expected,linked),true);
  assert.equal(baselineLinksMatch(expected,linked),true);
  assert.equal(JSON.stringify(linked),before);
  assert.equal(baselineLinksMatch(expected,{...linked,patient:{...linked.patient,ehrPatientId:id}}),false);
  assert.equal(baselineLinksMatch(expected,null),false);
});
