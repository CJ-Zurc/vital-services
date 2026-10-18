import { renameSync, rmSync, writeFileSync } from 'node:fs';

export function validHealth(value: unknown, now = Date.now()) {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(',') === 'at,pid,ready' && row.ready === true
    && Number.isSafeInteger(row.pid) && Number(row.pid) > 0 && Number.isSafeInteger(row.at)
    && now - Number(row.at) >= -5000 && now - Number(row.at) <= 120_000;
}
export function runtimeHealth(mode: 'api' | 'worker', environment = process.env) {
  const path = environment[mode === 'api' ? 'VITAL_EDA_API_HEALTH_FILE' : 'VITAL_EDA_WORKER_HEALTH_FILE'];
  if (path !== undefined && path !== `/tmp/vital-${mode}-health.json`) throw new Error('RUNTIME_HEALTH_PATH_INVALID');
  return {
    ready() {
      if (!path) return;
      writeFileSync(path + '.next', JSON.stringify({ ready: true, pid: process.pid, at: Date.now() }), { mode: 0o600 });
      renameSync(path + '.next', path);
    },
    unavailable() { if (path) { rmSync(path, { force: true }); rmSync(path + '.next', { force: true }); } },
  };
}
