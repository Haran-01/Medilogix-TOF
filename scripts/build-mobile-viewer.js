'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const sourceDir = path.join(projectRoot, 'mobile-viewer');
const outputDir = path.join(projectRoot, 'release', 'mobile-viewer');

function loadRootEnv() {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadRootEnv();
const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
const anonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();
if (!supabaseUrl || !anonKey) {
  throw new Error('Set SUPABASE_URL and SUPABASE_ANON_KEY in the environment or root .env before building.');
}
if (!/^https:\/\//i.test(supabaseUrl)) {
  throw new Error('SUPABASE_URL must use HTTPS for the published mobile viewer.');
}

fs.mkdirSync(outputDir, { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'email-confirmed.html']) {
  fs.copyFileSync(path.join(sourceDir, file), path.join(outputDir, file));
}
for (const file of ['medilogix-symbol.png', 'medilogix-logo.png']) {
  fs.copyFileSync(path.join(projectRoot, 'src', 'assets', file), path.join(outputDir, file));
}

const publicConfig = JSON.stringify({ url: supabaseUrl.replace(/\/$/, ''), anonKey });
fs.writeFileSync(path.join(outputDir, 'config.js'), `window.MEDILOGIX_CONFIG = Object.freeze(${publicConfig});\n`, 'utf8');
process.stdout.write(`Mobile Recordings site built at: ${outputDir}\n`);
