const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const root = path.join(__dirname, '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('Set DATABASE_URL in the process environment before running this migration.');
  }

  const migrationsDir = path.join(root, 'supabase', 'migrations');
  const migrations = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();
  if (!migrations.length) throw new Error('No Supabase SQL migrations were found.');
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 15000,
    application_name: 'medilogix-tof-schema-migration'
  });

  try {
    await client.connect();
    for (const migration of migrations) {
      await client.query('begin');
      await client.query(fs.readFileSync(path.join(migrationsDir, migration), 'utf8'));
      await client.query('commit');
      process.stdout.write(`Applied ${migration}.\n`);
    }
  } catch (error) {
    try { await client.query('rollback'); } catch { /* The connection may already be closed. */ }
    process.stderr.write(`Migration failed (${error.code || error.name}). Credentials were not logged.\n`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
