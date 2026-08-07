import pg from 'pg';
import { config } from '../config.js';

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: config.pgUrl, max: 5 });
  return pool;
}

export async function pgReachable(): Promise<boolean> {
  try {
    await getPool().query('select 1');
    return true;
  } catch {
    return false;
  }
}
