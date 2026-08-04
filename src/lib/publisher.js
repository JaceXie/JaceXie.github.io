import { execSync, execFileSync } from 'node:child_process';
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

    // commit message 走参数数组，不拼进 shell 字符串
    // （原来是 `git commit -m "${message}"`，message 里一个双引号或反引号就会破坏命令）
    execFileSync('git', ['commit', '-m', message], { cwd: repoRoot, stdio: 'pipe' });
    logger.info(`✓ git commit: ${message}`);

    // push 前先同步远端。
    // 原来直接 push，远端一旦领先（另一台机器 / 网页编辑 / 手工提交）就永久失败，
    // 本地 commit 无声堆积、站点冻结，而读者完全看不出异常 —— 这正是站点停摆 24 天没人发现的原因之一。
    try {
      execSync('git fetch origin main', { cwd: repoRoot, stdio: 'pipe' });
      execSync('git rebase --autostash origin/main', { cwd: repoRoot, stdio: 'pipe' });
    } catch (rebaseErr) {
      // rebase 冲突时中止，保持工作区干净，把问题留给人处理，绝不强推
      try { execSync('git rebase --abort', { cwd: repoRoot, stdio: 'ignore' }); } catch {}
      logger.error(`git rebase failed, aborted: ${rebaseErr.stderr?.toString() || rebaseErr.message}`);
      logger.warn('远端有冲突提交，需人工处理后再跑。本次不 push。');
      return false;
    }

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
