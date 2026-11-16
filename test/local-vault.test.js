const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ENCRYPTED_PREFIX, migrateLocalRecordings, readSecureText, writeSecureText } = require('../src/local-vault');

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
    decryptString: (value) => {
      const text = value.toString('utf8');
      assert.ok(text.startsWith('protected:'));
      return text.slice('protected:'.length);
    }
  };
}

test('local vault encrypts new content and remains readable after replacement', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'medilogix-vault-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'records.jsonl');
  const safeStorage = fakeSafeStorage();

  writeSecureText(file, 'patient measurement', safeStorage);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(ENCRYPTED_PREFIX));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('patient measurement'));
  assert.equal(readSecureText(file, safeStorage), 'patient measurement');

  writeSecureText(file, 'updated patient measurement', safeStorage);
  assert.equal(readSecureText(file, safeStorage), 'updated patient measurement');
});

test('local vault migrates legacy session, event, and patient files without changing content', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'medilogix-vault-migrate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = path.join(root, 'session-one');
  const dateFolder = path.join(root, '2026-11-02');
  fs.mkdirSync(session);
  fs.mkdirSync(dateFolder);
  fs.writeFileSync(path.join(session, 'session.json'), '{"patientName":"Jane"}');
  fs.writeFileSync(path.join(session, 'records.jsonl'), '{"raw":"23:00,100"}\n');
  fs.writeFileSync(path.join(dateFolder, 'Jane.csv'), '2026-11-02\nJane\n');
  fs.writeFileSync(path.join(dateFolder, 'unrelated.txt'), 'leave as-is');
  const safeStorage = fakeSafeStorage();

  assert.deepEqual(migrateLocalRecordings(root, safeStorage), { migrated: 3 });
  assert.equal(readSecureText(path.join(session, 'session.json'), safeStorage), '{"patientName":"Jane"}');
  assert.equal(readSecureText(path.join(session, 'records.jsonl'), safeStorage), '{"raw":"23:00,100"}\n');
  assert.equal(readSecureText(path.join(dateFolder, 'Jane.csv'), safeStorage), '2026-11-02\nJane\n');
  assert.equal(fs.readFileSync(path.join(dateFolder, 'unrelated.txt'), 'utf8'), 'leave as-is');
  assert.deepEqual(migrateLocalRecordings(root, safeStorage), { migrated: 0 });
});

test('local vault refuses to write patient data when secure storage is unavailable', () => {
  assert.throws(() => writeSecureText('unused', 'patient data', { isEncryptionAvailable: () => false }), /Secure local storage is unavailable/);
});
