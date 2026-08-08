import { execSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger.js';

/** 日更机器人允许触碰的两个文件。 */
const CORE_PATHS = ['index.html', 'data/tickers.json'];

/** 报告目录。这里的新文件必须与 index.html 同一次提交，理由见 pendingReports()。 */
const REPORTS_DIR = 'haitu/reports';

/**
 * 列出 haitu/reports/ 下「新增或已改动」的报告文件。
 *
 * ⚠️ 这个函数存在的原因，是一次真实事故：
 * 原来 commitAndPush 只 add index.html 与 data/tickers.json。于是写完一份新报告后，
 * 门户已经把链接注入进 index.html 并推上线，而报告文件本身还躺在工作区未跟踪 ——
 * 读者点进去拿到 404，而本地 `git status` 里那两个 `??` 没人会去看。
 * 站点上曾因此同时存在 9 份「链接得到、打不开」的报告。
 *
 * 只认 .html 与 .md，且只认磁盘上真实存在的文件：
 * `git ls-files --modified` 会把已删除的文件也列出来，而「删掉一份报告」永远应当是
 * 人的决定，不该由每天 6 点的定时任务代劳。删除留给人处理。
 */
function pendingReports(repoRoot) {
  const out = execSync(
    `git ls-files --others --modified --exclude-standard -- ${REPORTS_DIR}`,
    { cwd: repoRoot, encoding: 'utf8' }
  );
  return [...new Set(out.split('\n').map(s => s.trim()).filter(Boolean))]
    .filter(f => f.endsWith('.html') || f.endsWith('.md'))
    .filter(f => existsSync(join(repoRoot, f)))
    .sort();
}

/**
 * 检测是否有待发布的改动：index.html / data/tickers.json 有 diff，或有新增/改动的报告文件。
 */
export function hasChanges(repoRoot) {
  if (pendingReports(repoRoot).length > 0) return true;
  try {
    // git diff --quiet 在无改动时返回 0，有改动时返回 1
    execSync(`git diff --quiet -- ${CORE_PATHS.join(' ')}`, {
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
 * Stage + commit + push。
 * 白名单：index.html、data/tickers.json，以及 haitu/reports/ 下新增或改动的 .html / .md。
 */
export function commitAndPush(repoRoot, message) {
  try {
    const reports = pendingReports(repoRoot);

    // 路径走参数数组，不拼进 shell 字符串（文件名里的空格与引号会破坏命令）
    execFileSync('git', ['add', '--', ...CORE_PATHS, ...reports], { cwd: repoRoot, stdio: 'pipe' });

    // 逐条记入日志。绝不静默地把文件扫进提交 —— 谁被带上必须看得见。
    let finalMessage = message;
    if (reports.length > 0) {
      logger.info(`✓ 一并提交 ${reports.length} 份报告文件：`);
      reports.forEach(f => logger.info(`    + ${f}`));
      finalMessage = `${message}\n\n随附报告文件：\n${reports.map(f => `  ${f}`).join('\n')}`;
    }

    // commit message 走参数数组，不拼进 shell 字符串
    // （原来是 `git commit -m "${message}"`，message 里一个双引号或反引号就会破坏命令）
    execFileSync('git', ['commit', '-m', finalMessage], { cwd: repoRoot, stdio: 'pipe' });
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
