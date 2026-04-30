import { execSync } from 'node:child_process';
import { logger } from './logger.js';

/**
 * 检测是否有 unstaged 改动（仅检查 index.html 与 data/tickers.json）。
 */
export function hasChanges(repoRoot) {
  try {
    // git diff --quiet 在无改动时返回 0，有改动时返回 1
    execSync('git diff --quiet -- index.html data/tickers.json', {
      cwd: repoRoot,
      stdio: 'ignore'
    });
    return false; // exit 0 = no diff
  } catch (e) {
    if (e.status === 1) return true; // exit 1 = diff present
    logger.warn(`git diff exit ${e.status}: ${e.message}`);
    return false;
  }
}

/**
 * Stage + commit + push.
 * 仅 add 白名单文件（index.html, data/tickers.json）。
 */
export function commitAndPush(repoRoot, message) {
  try {
    execSync('git add index.html data/tickers.json', { cwd: repoRoot, stdio: 'pipe' });
    execSync(`git commit -m "${message}"`, { cwd: repoRoot, stdio: 'pipe' });
    logger.info(`✓ git commit: ${message}`);

    try {
      execSync('git push origin main', { cwd: repoRoot, stdio: 'pipe' });
      logger.info(`✓ git push origin main`);
      return true;
    } catch (pushErr) {
      logger.error(`git push failed: ${pushErr.stderr?.toString() || pushErr.message}`);
      logger.warn(`Commit was made locally; will retry on next cron`);
      return false;
    }
  } catch (commitErr) {
    logger.error(`git commit failed: ${commitErr.stderr?.toString() || commitErr.message}`);
    return false;
  }
}
