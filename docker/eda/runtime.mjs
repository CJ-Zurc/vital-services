import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const mode = process.argv[2];
const suffix = process.env.EDA_DATABASE_SUFFIX ?? '';
if (!['', '_test'].includes(suffix)) throw new Error('Only isolated dev or _test database names are permitted.');
const environment = { ...process.env };
function secret(name) {
  const value = readFileSync(`/run/secrets/${name}`, 'utf8').trim();
  if (!value || /REPLACE|PLACEHOLDER/.test(value)) throw new Error(`Missing secret: ${name}`);
  return value;
}
function database(domain, identity) {
  return `postgresql://vital_${domain}_${identity}:${encodeURIComponent(secret(`${domain}_${identity}_password`))}@postgres:5432/vital_${domain}${suffix}`;
}
function broker(identity, vhost) {
  const privateBroker = environment.VITAL_EDA_PRIVATE_HTTP === 'true';
  return `${privateBroker ? 'amqp' : 'amqps'}://vital_${identity}:${encodeURIComponent(secret(`rabbit_${identity}_password`))}@rabbitmq:${privateBroker ? 5672 : 5671}/${vhost}`;
}
let commands;
if (mode === 'api' || mode === 'worker') {
  if (environment.VITAL_EDA_ENABLED !== 'true') throw new Error('EDA is OFF by default. Explicit isolated runtime opt-in is required.');
  if (suffix) throw new Error('Runtime entrypoints must not target test databases.');
  for (const domain of ['core', 'integrations']) {
    environment[`VITAL_${domain.toUpperCase()}_DATABASE_URL`] = database(domain, mode);
  }
  if (mode === 'worker') environment.VITAL_RABBITMQ_URL = broker('runtime', 'vital');
  commands = [[`dist/entrypoints/${mode}.js`]];
} else if (['migrate', 'seed', 'seed-verify', 'catalog-snapshot', 'catalog-restore'].includes(mode)) {
  for (const domain of ['core', 'integrations']) {
    const url = new URL(database(domain, 'migrator'));
    if (environment.VITAL_EDA_PRIVATE_HTTP !== 'true') {
      url.searchParams.set('sslmode', 'verify-full');
      url.searchParams.set('sslrootcert', environment.VITAL_DATABASE_CA_FILE);
    }
    environment[`VITAL_${domain.toUpperCase()}_MIGRATION_URL`] = url.href;
  }
  if (mode === 'migrate') commands = ['core', 'integrations'].map(domain => ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', `prisma/${domain}.config.ts`]);
  else if (mode.startsWith('catalog-')) {
    environment.VITAL_BASELINE_SEED = 'true';
    environment.VITAL_CATALOG_RECOVERY_MODE = mode === 'catalog-snapshot' ? 'snapshot' : 'restore';
    commands = [['dist/entrypoints/catalog-recovery.js']];
  }
  else { environment.VITAL_BASELINE_SEED = 'true'; environment.VITAL_BASELINE_VERIFY = String(mode === 'seed-verify'); commands = [['dist/entrypoints/seed.js']]; }
} else if (mode === 'provision') {
  if (suffix) throw new Error('Test broker topology belongs to the test harness, not the runtime provisioner.');
  if (environment.VITAL_EDA_PROVISION_BROKER !== 'true') throw new Error('Explicit broker provision opt-in is required.');
  environment.VITAL_RABBITMQ_PROVISION_URL = broker('provision', 'vital');
  commands = [['dist/entrypoints/provision-broker.js']];
} else if (mode === 'test') {
  if (environment.EDA_TEST_ENABLED !== 'true' || environment.EDA_TEST_ISOLATED !== 'yes' || suffix !== '_test') {
    throw new Error('Tests require EDA_TEST_ENABLED=true, EDA_TEST_ISOLATED=yes and the _test suffix.');
  }
  for (const domain of ['core', 'integrations']) {
    environment[`EDA_TEST_${domain.toUpperCase()}_DATABASE_URL`] = database(domain, 'worker');
  }
  environment.EDA_TEST_DATABASE_CA_FILE = environment.VITAL_EDA_PRIVATE_HTTP === 'true' ? '' : '/run/secrets/db-ca.pem';
  environment.EDA_TEST_RABBITMQ_URL = broker('runtime', 'vital_test');
  environment.EDA_TEST_RABBITMQ_PROVISION_URL = broker('provision', 'vital_test');
  environment.EDA_TEST_RABBITMQ_CA_FILE = environment.VITAL_EDA_PRIVATE_HTTP === 'true' ? '' : '/run/secrets/broker-ca.pem';
  environment.EDA_TEST_SERVICE_CA_FILE = '/run/secrets/test-service-ca.pem';
  environment.EDA_TEST_API_CERT_FILE = '/run/secrets/test-api-cert.pem';
  environment.EDA_TEST_API_KEY_FILE = '/run/secrets/test-api-key.pem';
  environment.EDA_TEST_WEB_CERT_FILE = '/run/secrets/test-web-cert.pem';
  environment.EDA_TEST_WEB_KEY_FILE = '/run/secrets/test-web-key.pem';
  // Privileged fixture teardown is available only after separate isolated Records opt-in.
  if (environment.EDA_TEST_RECORDS_ENABLED === 'true') {
    environment.EDA_TEST_CORE_MIGRATOR_URL = database('core', 'migrator');
  }
  commands = [['--import', 'tsx', '--test', 'test/eda-integration.test.ts']];
} else throw new Error('Expected api, worker, migrate, seed, seed-verify, catalog-snapshot, catalog-restore, provision or test mode.');

// Keep PID 1 signal propagation and never print credential-bearing environment.
for (const args of commands) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: environment });
  const terminate = () => child.kill('SIGTERM');
  const interrupt = () => child.kill('SIGINT');
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  process.off('SIGTERM', terminate);
  process.off('SIGINT', interrupt);
  if (result !== 0) process.exit(result);
}
