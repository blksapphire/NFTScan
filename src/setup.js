#!/usr/bin/env node
/**
 * Local first-run setup.
 *
 * Creates .env from .env.example only when .env does not already exist.
 * The generated .env is ignored by git and is where the user's real
 * credentials belong.
 */

import { copyFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './config.js';

const envPath = resolve(ROOT, '.env');
const examplePath = resolve(ROOT, '.env.example');

if (existsSync(envPath)) {
  console.log('.env already exists; leaving it untouched.');
  process.exit(0);
}

if (!existsSync(examplePath)) {
  console.error(`Missing ${examplePath}`);
  process.exit(1);
}

copyFileSync(examplePath, envPath);
try {
  chmodSync(envPath, 0o600);
} catch (err) {
  console.warn(`[setup] Could not restrict .env permissions: ${err.message}`);
}

console.log('Created .env from .env.example.');
console.log('Open .env and fill in TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, and OPENSEA_API_KEY.');
console.log('The .env file is gitignored and must never be committed.');
