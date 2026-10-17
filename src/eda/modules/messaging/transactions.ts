import type { Pool, PoolClient } from 'pg';

export async function messagingTransaction<T>(pool: Pool, run: (tx: PoolClient) => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    const tx = await pool.connect();
    // Owner locks serialize mutations; each statement must see commits made while waiting for those locks.
    try { await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED'); const result = await run(tx); await tx.query('COMMIT'); return result; }
    catch (error) {
      await tx.query('ROLLBACK');
      if (attempt >= 2 || !['40001', '40P01'].includes(String((error as { code?: string })?.code))) throw error;
    } finally { tx.release(); }
  }
}
