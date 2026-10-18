import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { trustedInternalOrigin } from '../src/eda/infrastructure/private-transport.js';
import { validateBrokerUrl } from '../src/eda/infrastructure/broker.js';

test('staging private HTTP accepts only reviewed Docker service origins', () => {
  const staging = { NODE_ENV: 'production', VITAL_EDA_PRIVATE_HTTP: 'true' };
  assert.equal(trustedInternalOrigin(new URL('http://auth-api:8000'), staging), true);
  assert.equal(trustedInternalOrigin(new URL('http://uhse-ehr-api:8008'), staging), true);
  for (const origin of ['http://example.com', 'http://auth-api:8001', 'http://127.0.0.1:8000',
    'http://user@auth-api:8000', 'ftp://auth-api:8000'])
    assert.equal(trustedInternalOrigin(new URL(origin), staging), false, origin);
  assert.equal(trustedInternalOrigin(new URL('http://auth-api:8000'), { NODE_ENV: 'production' }), false);
});

test('staging broker accepts only the dedicated plaintext Docker alias and vhost', () => {
  const staging = { VITAL_EDA_PRIVATE_HTTP: 'true' };
  assert.doesNotThrow(() => validateBrokerUrl('amqp://vital_runtime:secret@rabbitmq:5672/vital', staging));
  for (const url of ['amqp://vital_runtime:secret@example.com:5672/vital',
    'amqp://vital_runtime:secret@rabbitmq:5672/%2F',
    'amqp://guest:secret@rabbitmq:5672/vital']) assert.throws(() => validateBrokerUrl(url, staging));
  assert.throws(() => validateBrokerUrl('amqp://vital_runtime:secret@rabbitmq:5672/vital', {}));
});
