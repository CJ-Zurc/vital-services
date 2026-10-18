import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/core/client.js';
import { validateSeedManifest, baselineLinksMatch } from './seed-contract.js';
import { recordProfileEffects } from '../modules/profile/profile-effects.js';
import { randomUUID } from 'node:crypto';

async function main() {
if (process.env.VITAL_BASELINE_SEED !== 'true') throw new Error('BASELINE_SEED_NOT_AUTHORIZED');
const chunks: Buffer[] = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += Buffer.byteLength(chunk);
  if (size > 1024 * 1024) throw new Error('BASELINE_MANIFEST_TOO_LARGE');
  chunks.push(Buffer.from(chunk));
}
const manifest = validateSeedManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
const verify = process.env.VITAL_BASELINE_VERIFY === 'true';
const url = process.env.VITAL_CORE_MIGRATION_URL;
if (!url || new URL(url).pathname !== '/vital_core' || new URL(url).username !== 'vital_core_migrator') {
  throw new Error('BASELINE_DATABASE_BOUNDARY_INVALID');
}
const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });
try {
  for (const account of manifest.accounts) {
    const role = account.systems.vital;
    if (!role) continue;
    await db.$transaction(async tx => {
      let user = await tx.vitalUser.findUnique({ where: { authId: account.authId }, include: { patient: true, doctor: true, admin: true } });
      if (user && user.role !== role) throw new Error('BASELINE_ROLE_CONFLICT');
      if (!verify) {
        let changed = false;
        if (!user) {
          await tx.vitalUser.create({ data: { authId: account.authId, role, version: 1,
            ...(role === 'patient' ? { patient: { create: { authId: account.authId, ehrPatientId: account.ehrPatientId!,
              isRecordAvailable: true, ehrRecordOrigin: 'preexisting' } } } : {}),
            ...(role === 'doctor' ? { doctor: { create: { authId: account.authId,
              departmentExternalId: account.departmentId!, departmentName: account.departmentName! } } } : {}),
            ...(role === 'admin' ? { admin: { create: { authId: account.authId } } } : {}),
          } });
          changed = true;
        } else if (role === 'patient' && !baselineLinksMatch(account, user)) {
          await tx.vitalPatient.update({ where: { authId: account.authId }, data: { ehrPatientId: account.ehrPatientId!, isRecordAvailable: true, ehrRecordOrigin: 'preexisting' } });
          changed = true;
        } else if (role === 'doctor' && !baselineLinksMatch(account, user)) {
          await tx.vitalDoctor.update({ where: { authId: account.authId }, data: { departmentExternalId: account.departmentId!, departmentName: account.departmentName! } });
          changed = true;
        }
        if (changed) {
          if (user) await tx.vitalUser.update({ where: { authId: account.authId }, data: { version: { increment: 1 } } });
          const source = await tx.vitalUser.findUniqueOrThrow({ where: { authId: account.authId } });
          await recordProfileEffects(tx, { authId: account.authId, role: role as 'patient' | 'doctor' | 'admin', serviceId: 'vital-web',
            scopes: ['profile.materialize'], resource: account.authId, correlationId: randomUUID(), isSuperAdmin: false }, source,
            'materialize', { doctorMirror: role === 'doctor', departmentExternalId: account.departmentId, departmentName: account.departmentName });
        }
        user = await tx.vitalUser.findUniqueOrThrow({ where: { authId: account.authId }, include: { patient: true, doctor: true, admin: true } });
      }
      if (!baselineLinksMatch(account, user)) {
        throw new Error('BASELINE_LINK_VERIFICATION_FAILED');
      }
    }, { isolationLevel: 'Serializable' });
  }
  console.log(JSON.stringify({ success: true, mode: verify ? 'verify' : 'seed', identities: manifest.accounts.filter(a => a.systems.vital).length }));
} finally {
  await db.$disconnect();
  await pool.end();
}

}
function safeFailureCode(error: unknown): string {
  if (error instanceof Error && /^BASELINE_[A-Z0-9_]+$/.test(error.message)) {
    return error.message;
  }

  if (error && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string' && /^[A-Z0-9_]{2,16}$/.test(error.code)) {
    return error.code;
  }

  if (error instanceof Error) return error.constructor.name;
  return 'UnknownError';
}

void main().catch((error: unknown) => {
  console.error(`BASELINE_SEED_FAILED ${safeFailureCode(error)}`);
  process.exitCode = 1;
});
