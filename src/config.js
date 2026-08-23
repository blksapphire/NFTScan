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

/** Keys beginning with `_` are documentation, not settings. Exported for tests. */
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

/**
 * Minimal `.env` reader. Node 18 has no --env-file, and pulling in dotenv for
 * twelve lines of parsing is not worth a dependency.
 */
export function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip matching surrounding quotes, if present.
    if (value.length >= 2 && /^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    // Real environment variables always win over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function bool(value) {
  if (value === undefined || value === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * A configuration problem, as opposed to a runtime one.
 *
 * `title` is what shows on a GitHub Actions run summary, so it has to make sense
 * with no surrounding context.
 */
export class ConfigError extends Error {
  constructor(message, title) {
    super(message);
    this.name = 'ConfigError';
    this.title = title;
  }
}

/**
 * Distinguish "nobody mentioned this variable" from "something set it to empty".
 *
 * The difference is diagnostic gold on GitHub Actions. `env: FOO: ${{ secrets.FOO }}`
 * always defines FOO — it just defines it as an empty string when no secret by
 * that exact name exists. So `empty` inside Actions means the workflow asked for
 * a secret and GitHub had none to give: the secret is missing, misspelled, or was
 * added under the *Variables* tab instead of *Secrets*. `absent` would instead
 * mean the workflow never passed it at all.
 */
function envState(name) {
  const raw = process.env[name];
  if (raw === undefined) return 'absent';
  if (raw.trim() === '') return 'empty';
  return 'set';
}

/**
 * @param {object} [options]
 * @param {object} [options.overrides] Runtime overrides from state (Telegram commands).
 * @param {string[]} [options.argv] Command-line flags.
 * @param {boolean} [options.envFile] Read `.env`. Pass false for a hermetic load —
 *   the self-test needs it, because `.env` only fills variables that are undefined,
 *   so a developer's real credentials would quietly satisfy the very "is this
 *   secret missing" checks being tested and the suite would pass on their machine
 *   while failing in CI.
 */
export function loadConfig({ overrides = {}, argv = [], envFile = true } = {}) {
  if (envFile) loadDotEnv(resolve(ROOT, '.env'));

  const configPath = resolve(ROOT, 'config.json');
  if (!existsSync(configPath)) {
    throw new Error(`config.json not found at ${configPath}`);
  }

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

    // Screener knobs, with Telegram overrides applied on top.
    minScore: clampNumber(overrides.minScore ?? file.minScore, 0, 100, 70),
    paused: overrides.paused ?? false,

    // Secrets and run mode. Trimmed because pasting into GitHub's secret box (or
    // a .env line) very easily carries a trailing newline or space, and Telegram
    // rejects a token with whitespace in it with an unhelpful 404.
    telegramToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    telegramChatId: (process.env.TELEGRAM_CHAT_ID || '').trim(),
    openseaApiKey: (process.env.OPENSEA_API_KEY || '').trim(),

    mode: (flagValue('mode') || process.env.MODE || 'poll').toLowerCase(),
    stateFile: resolve(ROOT, process.env.STATE_FILE || './state.json'),

    dryRun: flag('dry-run') || bool(process.env.DRY_RUN),
    debug: flag('debug') || bool(process.env.DEBUG),

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

  // Weights must sum to 100 or the 0-100 score is meaningless.
  const weights = cfg.weights || {};
  const sum = Object.values(weights).reduce((a, b) => a + Number(b || 0), 0);
  if (Math.abs(sum - 100) > 0.01) {
    problems.push(
      `config.json weights must sum to 100, got ${sum}. ` +
        `Current: ${JSON.stringify(weights)}`
    );
  }

  if (!Array.isArray(cfg.leadTimeMinutes) || cfg.leadTimeMinutes.length === 0) {
    problems.push('config.json leadTimeMinutes must be a non-empty array of minutes.');
  }

  if (!['poll', 'stream'].includes(cfg.mode)) {
    problems.push(`MODE must be "poll" or "stream", got "${cfg.mode}".`);
  }

  // Credentials are only required when we actually intend to send something.
  // Note this is why a --dry-run workflow_dispatch can go green on a repo with no
  // secrets at all, and then the first scheduled run fails: a schedule has no
  // `inputs.dry_run`, so DRY_RUN arrives empty and these checks switch on.
  const missingSecrets = [];
  if (!cfg.dryRun) {
    if (!cfg.telegramToken) {
      missingSecrets.push('TELEGRAM_BOT_TOKEN');
      problems.push(
        `TELEGRAM_BOT_TOKEN is ${describeMissing('TELEGRAM_BOT_TOKEN')}. ` +
          `Get one from @BotFather, or use --dry-run.`
      );
    }
    if (!cfg.telegramChatId) {
      missingSecrets.push('TELEGRAM_CHAT_ID');
      problems.push(
        `TELEGRAM_CHAT_ID is ${describeMissing('TELEGRAM_CHAT_ID')}. ` +
          `Message @userinfobot to find yours, or use --dry-run.`
      );
    }
  }

  if (problems.length) {
    const message = `Configuration problems:\n  - ${problems.join('\n  - ')}`;

    // Only the credentials case gets the friendlier title, because it is the one
    // that is a setup step rather than a bug.
    const title =
      missingSecrets.length === problems.length
        ? `missing repository secret${missingSecrets.length > 1 ? 's' : ''}: ${missingSecrets.join(', ')}`
        : 'bad configuration';

    let extra = '';
    if (process.env.GITHUB_ACTIONS && missingSecrets.length) {
      extra =
        `\n\nAdd them under Settings -> Secrets and variables -> Actions -> ` +
        `New repository secret.`;
      // Only worth raising the Variables tab if the symptom actually matches it:
      // an empty value. An absent variable means the workflow file changed instead.
      if (missingSecrets.some((name) => envState(name) === 'empty')) {
        extra +=
          ` Use the "Secrets" tab, not "Variables" — a value stored as a variable ` +
          `is not readable as \${{ secrets.NAME }} and arrives empty, which looks ` +
          `identical to not having added it.`;
      }
    }

    throw new ConfigError(message + extra, title);
  }
}

/**
 * Why a required variable counts as missing, in the terms the user can act on.
 * @param {string} name
 */
function describeMissing(name) {
  const state = envState(name);
  if (!process.env.GITHUB_ACTIONS) {
    return state === 'empty' ? 'set but empty' : 'not set';
  }
  // Inside Actions the workflow always defines it, so `empty` is the normal
  // symptom of a secret that does not exist under that name.
  return state === 'absent'
    ? 'not passed by the workflow at all (the env: block may have been edited)'
    : 'empty — GitHub has no repository secret by that name';
}
