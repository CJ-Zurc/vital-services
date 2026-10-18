import assert from 'node:assert/strict';
import test from 'node:test';
import { registrationAuthority } from '../src/eda/modules/profile/registration-authority.js';
const authId = '11111111-1111-4111-8111-111111111111';
const registrationId = '22222222-2222-4222-8222-222222222222';
const environment = { VITAL_AUTH_INTERNAL_URL: 'https://auth.test/', VITAL_SERVICES_AUTH_REGISTRATION_KEY: 's'.repeat(40) };
const receipt = { success: true, data: { version: 1, purpose: 'vital.patient.self-registration',
  auth_id: authId, registration_id: registrationId, email: 'patient@example.test', is_verified: false } };

test('registration authority: bounded online lookup binds target purpose and provenance', async () => {
  const authority = registrationAuthority(environment, async (url, init) => {
    assert.equal(String(url), 'https://auth.test/internal/vital/registrations/resolve');
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(JSON.parse(String(init?.body)), { auth_id: authId, registration_id: registrationId });
    assert.equal(new Headers(init?.headers).get('X-Internal-Service'), 'vital-services');
    return Response.json(receipt);
  });
  await authority(authId, registrationId, authId);
});

test('registration authority: substitutions denial outage and missing configuration fail closed', async () => {
  for (const response of [Response.json({ ...receipt, data: { ...receipt.data, auth_id: registrationId } }),
    Response.json({ ...receipt, data: { ...receipt.data, purpose: 'doctor.provision' } }),
    new Response('', { status: 409 }), new Response('', { status: 503 }), Response.json({ raw: 'x'.repeat(70_000) })]) {
    await assert.rejects(registrationAuthority(environment, async () => response)(authId, registrationId, authId));
  }
  await assert.rejects(registrationAuthority({}, async () => { throw new Error('must not call'); })(authId, registrationId, authId));
});
