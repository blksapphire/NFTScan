/**
 * Configuration loading.
 *
 * Three layers, later ones winning:
 *   1. config.json          - your screener rules, committed, editable on github.com
 *   2. environment / .env   - secrets and run mode
 *   3. runtime overrides    - things you changed from Telegram (/threshold, /pause)
 *
 * Hand-rolled validation keeps this project at zero dependencies, which means
 * nothing to install, nothing to audit, and no build step.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');

export function stripComments(obj) {
  if (Array.isArray(obj)) return obj.map(stripComments);
  if (obj === null || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    out[k] = stripComments(v);
  }
  return out;
}

export function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && /^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function bool(value) {
  if (value === undefined || value === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export class ConfigError extends Error {
  constructor(message, title) {
    super(message);
    this.name = 'ConfigError';
    this.title = title;
  }
}

function envState(name) {
  const raw = process.env[name];
  if (raw === undefined) return 'absent';
  if (raw.trim() === '') return 'empty';
  return 'set';
}

export function loadConfig({ overrides = {}, argv = [], envFile = true } = {}) {
  if (envFile) loadDotEnv(resolve(ROOT, '.env'));

  const configPath = resolve(ROOT, 'config.json');
  if (!existsSync(configPath)) throw new Error(`config.json not found at ${configPath}`);

  let file;
  try {
    file = stripComments(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${err.message}`);
  }

  const flag = (name) => argv.includes(`--${name}`);
  const flagValue = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };

  const cfg = {
    ...file,
    minScore: clampNumber(overrides.minScore ?? file.minScore, 0, 100, 70),
    paused: overrides.paused ?? false,
    telegramToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    telegramChatId: (process.env.TELEGRAM_CHAT_ID || '').trim(),
    openseaApiKey: (process.env.OPENSEA_API_KEY || '').trim(),
    mode: (flagValue('mode') || process.env.MODE || 'poll').toLowerCase(),
    stateFile: resolve(ROOT, process.env.STATE_FILE || './state.json'),
    dryRun: flag('dry-run') || bool(process.env.DRY_RUN),
    debug: flag('debug') || bool(process.env.DEBUG),
    explain: flag('explain') || bool(process.env.EXPLAIN),
    once: flag('once'),
    testTelegram: flag('test-telegram'),
    newKey: flag('new-key'),
  };

  validate(cfg);
  return cfg;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function validate(cfg) {
  const problems = [];
  const weights = cfg.weights || {};
  const sum = Object.values(weights).reduce((a, b) => a + Number(b || 0), 0);
  if (Math.abs(sum - 100) > 0.01) {
    problems.push(`config.json weights must sum to 100, got ${sum}. Current: ${JSON.stringify(weights)}`);
  }
  if (!Array.isArray(cfg.leadTimeMinutes) || cfg.leadTimeMinutes.length === 0) {
    problems.push('config.json leadTimeMinutes must be a non-empty array of minutes.');
  }
  if (!['poll', 'stream'].includes(cfg.mode)) problems.push(`MODE must be "poll" or "stream", got "${cfg.mode}".`);

  const missingSecrets = [];
  if (!cfg.dryRun) {
    if (!cfg.telegramToken) {
      missingSecrets.push('TELEGRAM_BOT_TOKEN');
      problems.push(`TELEGRAM_BOT_TOKEN is ${describeMissing('TELEGRAM_BOT_TOKEN')}. Get one from @BotFather, or use --dry-run.`);
    }
    if (!cfg.telegramChatId) {
      missingSecrets.push('TELEGRAM_CHAT_ID');
      problems.push(`TELEGRAM_CHAT_ID is ${describeMissing('TELEGRAM_CHAT_ID')}. Message @userinfobot to find yours, or use --dry-run.`);
    }
  }

  if (problems.length) {
    const message = `Configuration problems:\n  - ${problems.join('\n  - ')}`;
    const title = missingSecrets.length === problems.length
      ? `missing repository secret${missingSecrets.length > 1 ? 's' : ''}: ${missingSecrets.join(', ')}`
      : 'bad configuration';
    let extra = '';
    if (process.env.GITHUB_ACTIONS && missingSecrets.length) {
      extra = `\n\nAdd them under Settings -> Secrets and variables -> Actions -> New repository secret.`;
      if (missingSecrets.some((name) => envState(name) === 'empty')) {
        extra += ` Use the "Secrets" tab, not "Variables" — a value stored as a variable is not readable as \${{ secrets.NAME }} and arrives empty.`;
      }
    }
    throw new ConfigError(message + extra, title);
  }
}

function describeMissing(name) {
  const state = envState(name);
  if (!process.env.GITHUB_ACTIONS) return state === 'empty' ? 'set but empty' : 'not set';
  return state === 'absent'
    ? 'not passed by the workflow at all (the env: block may have been edited)'
    : 'empty — GitHub has no repository secret by that name';
}
