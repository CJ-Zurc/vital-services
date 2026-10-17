import { readFileSync } from 'node:fs';
const mode = process.argv[2];
try {
  if (!['api', 'worker'].includes(mode)) throw new Error();
  const path = process.env[mode === 'api' ? 'VITAL_EDA_API_HEALTH_FILE' : 'VITAL_EDA_WORKER_HEALTH_FILE'];
  if (path !== `/tmp/vital-${mode}-health.json`) throw new Error();
  const { validHealth } = await import('../../dist/infrastructure/runtime-health.js');
  const row = JSON.parse(readFileSync(path, 'utf8'));
  if (!validHealth(row)) throw new Error();
  process.kill(row.pid, 0);
} catch { process.exitCode = 1; }
