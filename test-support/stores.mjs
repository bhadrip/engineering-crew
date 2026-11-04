import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { openDatabase } from '../lib/database.mjs';

export const postgres = Boolean(process.env.CREW_TEST_DATABASE_URL);

export async function testDatabase(t) {
  const url = new URL(process.env.CREW_TEST_DATABASE_URL);
  const admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  const name = `crew_test_${randomUUID().replaceAll('-', '')}`;
  let db;
  t.after(async () => {
    try {
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  db = await openDatabase(url.href);
  return { db, url: url.href };
}

export function memoryRunStore() {
  let record;
  let pending = Promise.resolve();
  const clone = value => JSON.parse(JSON.stringify(value));
  return {
    read: async () => clone(record),
    create: async value => { record = clone(value); },
    update: callback => {
      const update = pending.then(() => {
        const next = clone(record);
        const result = callback(next);
        record = clone(next);
        return result;
      });
      pending = update.catch(() => {});
      return update;
    },
  };
}
