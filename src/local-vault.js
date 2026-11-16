const fs = require('node:fs');

const ENCRYPTED_PREFIX = 'MEDILOGIX-LOCAL-VAULT:v1\n';
const PROTECTED_FILES = new Set(['session.json', 'records.jsonl']);

function encryptionReady(safeStorage) {
  if (!safeStorage?.isEncryptionAvailable?.()) {
    throw new Error('Secure local storage is unavailable on this computer. Patient records were not saved.');
  }
}

function writeSecureText(filePath, value, safeStorage, options = {}) {
  encryptionReady(safeStorage);
  const encrypted = safeStorage.encryptString(String(value)).toString('base64');
  // Replacing an existing file with rename is not reliable on Windows. Encrypt
  // before opening the target, then write in place; new patient files use wx.
  fs.writeFileSync(filePath, `${ENCRYPTED_PREFIX}${encrypted}`, { encoding: 'utf8', flag: options.flag || 'w' });
}

function readSecureText(filePath, safeStorage) {
  const stored = fs.readFileSync(filePath, 'utf8');
  if (!stored.startsWith(ENCRYPTED_PREFIX)) return stored;
  encryptionReady(safeStorage);
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENCRYPTED_PREFIX.length).trim(), 'base64'));
  } catch {
    throw new Error('This patient record could not be unlocked on this Windows account.');
  }
}

function migrateLocalRecordings(root, safeStorage) {
  if (!fs.existsSync(root)) return { migrated: 0 };
  encryptionReady(safeStorage);
  let migrated = 0;
  const visit = (directory, depth) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const itemPath = require('node:path').join(directory, entry.name);
      if (entry.isDirectory() && depth < 2) visit(itemPath, depth + 1);
      else if (entry.isFile() && (PROTECTED_FILES.has(entry.name) || entry.name.toLowerCase().endsWith('.csv'))) {
        const content = fs.readFileSync(itemPath, 'utf8');
        if (content.startsWith(ENCRYPTED_PREFIX)) continue;
        writeSecureText(itemPath, content, safeStorage);
        migrated += 1;
      }
    }
  };
  visit(root, 0);
  return { migrated };
}

module.exports = { ENCRYPTED_PREFIX, migrateLocalRecordings, readSecureText, writeSecureText };
