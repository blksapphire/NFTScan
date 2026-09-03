#!/usr/bin/env node
import { loadConfig } from './config.js';
import { loadState, saveState } from './state.js';
import { buildBacktestReport, calibrateThresholds } from './research.js';

const cfg = loadConfig({ argv: ['--dry-run'], envFile: true });
const state = loadState(cfg.stateFile);
const command = process.argv[2] || 'report';
const horizon = Number(process.argv.find((a) => a.startsWith('--horizon='))?.split('=')[1] || 360);

if (command === 'report') {
  const report = buildBacktestReport(state, { horizonMinutes: horizon, minScore: cfg.minScore });
  console.log(JSON.stringify(report, null, 2));
} else if (command === 'calibrate') {
  console.log(JSON.stringify(calibrateThresholds(state, { horizonMinutes: horizon }), null, 2));
} else if (command === 'prune') {
  state.research.alerts = state.research.alerts.slice(0, Number(cfg.research?.maxAlerts ?? 5000));
  state.research.snapshots = state.research.snapshots.slice(-10000);
  saveState(cfg.stateFile, state);
  console.log('Research ledger pruned.');
} else {
  console.error('Usage: npm run research [report|calibrate|prune] [--horizon=360]');
  process.exit(2);
}
