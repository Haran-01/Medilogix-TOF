const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '202610290001_initial_recordings.sql'), 'utf8');
const patientMigration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '202611020001_patient_recording_metadata.sql'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'src', 'backend', 'supabase.js'), 'utf8');
const exampleEnv = fs.readFileSync(path.join(root, '.env.example'), 'utf8');

test('recording tables enforce owner-scoped row-level security', () => {
  assert.match(migration, /alter table public\.recording_sessions enable row level security/i);
  assert.match(migration, /alter table public\.recording_events enable row level security/i);
  assert.match(migration, /using \(\(select auth\.uid\(\)\) = user_id\)/i);
  assert.match(migration, /with check \(\(select auth\.uid\(\)\) = user_id\)/i);
  assert.match(migration, /foreign key \(session_id, user_id\)/i);
  assert.match(migration, /revoke all on public\.recording_sessions from anon/i);
  assert.match(migration, /revoke all on public\.recording_events from anon/i);
});

test('patient import metadata is stored on the existing owner-scoped recording session', () => {
  for (const column of ['imported', 'recording_date', 'patient_name', 'patient_age', 'patient_gender', 'source_file_name']) {
    assert.match(patientMigration, new RegExp(`add column if not exists ${column}\\b`, 'i'));
  }
  assert.match(patientMigration, /recording_sessions_user_patient_date_idx/);
  assert.match(backend, /patient_name: metadata\.patientName/);
  assert.match(backend, /recording_date: metadata\.recordingDate/);
  assert.match(backend, /patient_age: metadata\.patientAge/);
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  assert.match(main, /session\.cloudOwnerId === signedInUser\?\.id/);
  assert.match(main, /owns this patient recording/);
  assert.match(main, /patient-import:open[\s\S]*cloudBackend\.getUser/);
});

test('desktop backend uses only public Supabase configuration and encrypted auth storage', () => {
  assert.match(backend, /SUPABASE_ANON_KEY\s*\|\|\s*process\.env\.SUPABASE_PUBLISHABLE_KEY/);
  assert.match(backend, /safeStorage\.encryptString/);
  assert.match(backend, /safeStorage\.decryptString/);
  assert.doesNotMatch(backend, /SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL/);
  const keys = exampleEnv.split(/\r?\n/).filter((line) => line.includes('=')).map((line) => line.split('=')[0]).sort();
  assert.deepEqual(keys, ['SUPABASE_ANON_KEY', 'SUPABASE_URL']);
  const configuredEnvPath = path.join(root, '.env');
  if (fs.existsSync(configuredEnvPath)) {
    const configuredKeys = fs.readFileSync(configuredEnvPath, 'utf8')
      .split(/\r?\n/).filter((line) => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line))
      .map((line) => line.trim().split('=')[0]);
    assert.ok(configuredKeys.every((key) => ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY'].includes(key)));
  }
});

test('self-registration uses Supabase Auth and exposes only a narrow desktop IPC method', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
  assert.match(backend, /supabase\.auth\.signUp\(\{[\s\S]*doctor_name: doctorName[\s\S]*phone_number: phoneNumber/);
  assert.match(backend, /supabase\.auth\.updateUser\(\{[\s\S]*doctor_name: name[\s\S]*phone_number: phone/);
  assert.match(backend, /confirmationRequired: !data\.session/);
  assert.match(main, /cloud:sign-up.*signUpWithPassword/);
  assert.match(preload, /signUp: \(credentials\) => ipcRenderer\.invoke\('cloud:sign-up', credentials\)/);
});
