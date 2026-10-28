import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/core/client.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { recordProfileEffects } from '../modules/profile/profile-effects.js';

const snapshotSchema = z.object({ version: z.literal(1), owner: z.literal('vital'), rows: z.array(z.object({
  authId: z.uuid(), departmentId: z.string().nullable(), departmentName: z.string().nullable(), specialty: z.string().nullable(),
}).strict()).max(10000) }).strict();

async function main() {
  if (process.env.VITAL_BASELINE_SEED !== 'true') throw new Error('CATALOG_RECOVERY_NOT_AUTHORIZED');
  const url = process.env.VITAL_CORE_MIGRATION_URL;
  if (!url || new URL(url).pathname !== '/vital_core' || new URL(url).username !== 'vital_core_migrator') {
    throw new Error('CATALOG_DATABASE_BOUNDARY_INVALID');
  }
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    if (process.env.VITAL_CATALOG_RECOVERY_MODE === 'snapshot') {
      const doctors = await db.vitalDoctor.findMany({ orderBy: { authId: 'asc' }, take: 10001 });
      if (doctors.length > 10000) throw new Error('CATALOG_SNAPSHOT_TOO_LARGE');
      console.log(JSON.stringify({ version: 1, owner: 'vital', rows: doctors.map(row => ({ authId: row.authId,
        departmentId: row.departmentExternalId, departmentName: row.departmentName, specialty: row.specialty })) }));
      return;
    }
    if (process.env.VITAL_CATALOG_RECOVERY_MODE !== 'restore') throw new Error('CATALOG_RECOVERY_MODE_INVALID');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += Buffer.byteLength(chunk);
      if (size > 4 * 1024 * 1024) throw new Error('CATALOG_SNAPSHOT_TOO_LARGE');
      chunks.push(Buffer.from(chunk));
    }
    const snapshot = snapshotSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (new Set(snapshot.rows.map(row => row.authId)).size !== snapshot.rows.length) throw new Error('CATALOG_DUPLICATE_IDENTITY');
    await db.$transaction(async tx => {
      for (const item of snapshot.rows) {
        const existing = await tx.vitalDoctor.findUniqueOrThrow({ where: { authId: item.authId } });
        const user = await tx.vitalUser.findUniqueOrThrow({ where: { authId: item.authId } });
        if (user.role !== 'doctor') throw new Error('CATALOG_IDENTITY_ROLE_CHANGED');
        if (existing.departmentExternalId === item.departmentId && existing.departmentName === item.departmentName && existing.specialty === item.specialty) continue;
        await tx.vitalDoctor.update({ where: { authId: item.authId }, data: {
          departmentExternalId: item.departmentId, departmentName: item.departmentName, specialty: item.specialty,
        } });
        const updated = await tx.vitalUser.update({ where: { authId: item.authId }, data: { version: { increment: 1 } } });
        await recordProfileEffects(tx, { authId: item.authId, role: 'doctor', serviceId: 'vital-web',
          scopes: ['profile.materialize'], resource: item.authId, correlationId: randomUUID(), isSuperAdmin: false }, updated,
          'materialize', { doctorMirror: true, departmentExternalId: item.departmentId, departmentName: item.departmentName });
      }
    }, { isolationLevel: 'Serializable', timeout: 60000 });
    console.log(JSON.stringify({ restored: true, rows: snapshot.rows.length }));
  } finally {
    await db.$disconnect();
    await pool.end();
  }
}

void main().catch(() => { console.error('CATALOG_RECOVERY_FAILED'); process.exitCode = 1; });
