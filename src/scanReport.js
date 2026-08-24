/** Format persisted scan results for Telegram inspection commands. */

import { escapeHtml, shortAddress } from './util.js';

export function normaliseScanRows(rows = []) {
  return rows.map((row) => ({
    name: row.name || 'Unnamed collection',
    kind: row.kind || 'unknown',
    source: row.source || 'unknown',
    score: Number.isFinite(Number(row.score)) ? Number(row.score) : 0,
    coverage: Number.isFinite(Number(row.coverage)) ? Number(row.coverage) : 0,
    riskScore: Number.isFinite(Number(row.riskScore)) ? Number(row.riskScore) : 0,
    confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0,
    rejected: row.rejected || null,
    contractAddress: row.contractAddress || null,
  }));
}

export function formatScanRow(row, index) {
  const status = row.rejected
    ? `REJECTED: ${row.rejected}`
    : `${row.score}/100`;
  const coverage = `${row.coverage}/8`;
  const confidence = `${Math.round(row.confidence * 100)}%`;
  const risk = `${row.riskScore}`;
  const contract = row.contractAddress ? `\n<code>${escapeHtml(shortAddress(row.contractAddress))}</code>` : '';
  return `<b>${index + 1}. ${escapeHtml(row.name)}</b>\n${status} · ${coverage} signals · ${confidence} confidence · risk ${risk}\n<i>${escapeHtml(row.kind)} · ${escapeHtml(row.source)}</i>${contract}`;
}

export function paginateScanRows(rows, page = 1, perPage = 10) {
  const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (safePage - 1) * perPage;
  return { page: safePage, totalPages, items: rows.slice(start, start + perPage) };
}
