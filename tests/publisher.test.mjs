#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════
   publisher.js 端到端测试
     node tests/publisher.test.mjs

   在一个临时的隔离 git 仓库里跑真实代码路径（add → commit → fetch →
   rebase → push），**不碰生产仓库、不产生任何网络请求** —— origin 是本地
   的裸仓库。跑完自动清理。

   为什么需要这个测试：
   publisher.js 修过两个真实事故，而这两条路径都不会在日常运行中自然暴露。

   1. 「只 add index.html 与 data/tickers.json」——写完新报告后，门户已把
      链接注入并推上线，而报告文件本身还躺在工作区未跟踪，读者点进去拿 404。
      站点上曾同时存在 9 份「链接得到、打不开」的报告。（场景 1、3）

   2. 「push 前不 fetch/rebase」——远端一旦领先就永久静默失败，本地 commit
      无声堆积、站点冻结，而读者完全看不出异常。这是站点停摆 24 天没人发现
      的原因之一。（场景 2）

   场景 4 是这个测试自己发现的缺陷：报告文件被删除时（删除按设计不由定时
   任务代劳提交），add 完暂存区是空的，`git commit` 因「没有可提交内容」
   退出非零，被记成一条长得像真故障的 `git commit failed` ERROR。
   已加暂存区空检查修掉。
   ══════════════════════════════════════════════════════════════════ */
import { execSync } from 'node:child_process';
import { writeFileSync, appendFileSync, unlinkSync, mkdtempSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib');
const ROOT = mkdtempSync(join(tmpdir(), 'haitu-pubtest-'));
const WORK = join(ROOT, 'work');
const ORIGIN = join(ROOT, 'origin.git');

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++; };
const g = (c) => execSync(`git ${c}`, { cwd: WORK, encoding: 'utf8' }).trim();
const onOrigin = (c) => execSync(`git ${c}`, { cwd: ORIGIN, encoding: 'utf8' }).trim();

try {
  execSync(`git init -q --bare "${ORIGIN}"`);
  execSync(`git clone -q "${ORIGIN}" "${WORK}"`, { stdio: 'pipe' });
  execSync('git config user.email t@test && git config user.name test', { cwd: WORK, shell: '/bin/bash' });
  mkdirSync(join(WORK, 'src', 'lib'), { recursive: true });
  mkdirSync(join(WORK, 'data'), { recursive: true });
  mkdirSync(join(WORK, 'haitu', 'reports'), { recursive: true });
  cpSync(join(SRC, 'publisher.js'), join(WORK, 'src', 'lib', 'publisher.js'));
  cpSync(join(SRC, 'logger.js'), join(WORK, 'src', 'lib', 'logger.js'));
  writeFileSync(join(WORK, 'index.html'), '<html>seed</html>');
  writeFileSync(join(WORK, 'data', 'tickers.json'), '{"tickers":[]}');
  writeFileSync(join(WORK, 'haitu', 'reports', 'old-report.html'), '<html>old</html>');
  execSync('git add -A && git commit -qm seed && git branch -M main && git push -q origin main', { cwd: WORK, shell: '/bin/bash' });

  process.chdir(WORK);
  const { hasChanges, commitAndPush } = await import(join(WORK, 'src', 'lib', 'publisher.js'));

  console.log('\n═══ 场景 1：新报告 + 门户注入（正常发布路径）═══');
  appendFileSync('index.html', '\n<!-- injected -->');
  writeFileSync('haitu/reports/newco-q1-2026.html', '<html>r1</html>');
  writeFileSync('haitu/reports/newco-q1-2026-social.md', '# social');
  writeFileSync('haitu/reports/scratch.txt', 'not a report');
  check('hasChanges = true', hasChanges(WORK) === true);
  check('commitAndPush = true', commitAndPush(WORK, 'chore(daily): 场景1') === true);
  const f = g('show --stat --name-only --pretty=format: HEAD').split('\n').filter(Boolean);
  check('报告 .html 已提交', f.includes('haitu/reports/newco-q1-2026.html'));
  check('报告 -social.md 已提交', f.includes('haitu/reports/newco-q1-2026-social.md'));
  check('index.html 已提交', f.includes('index.html'));
  check('scratch.txt 未误纳入（只收 .html/.md）', !f.includes('haitu/reports/scratch.txt'), `共 ${f.length} 文件`);
  check('commit message 列出随附文件', g('log -1 --pretty=%B').includes('newco-q1-2026.html'));
  check('已推送 origin', onOrigin('log -1 --pretty=%s') === 'chore(daily): 场景1');

  console.log('\n═══ 场景 2：远端领先（旧版会永久静默失败）═══');
  execSync(`git clone -q "${ORIGIN}" "${ROOT}/other"`, { stdio: 'pipe' });
  execSync(`cd "${ROOT}/other" && git config user.email o@o && git config user.name o && echo x >> README.md && git add -A && git commit -qm "remote commit" && git push -q origin main`, { shell: '/bin/bash' });
  writeFileSync('haitu/reports/newco2-q1-2026.html', '<html>r2</html>');
  check('远端领先时仍成功', commitAndPush(WORK, 'chore(daily): 场景2') === true);
  check('已 rebase 到远端之上', g('log --oneline -3').includes('remote commit'));
  check('报告2 已上 origin', onOrigin('ls-tree -r --name-only HEAD').includes('newco2-q1-2026.html'));

  console.log('\n═══ 场景 3：只有报告文件、门户无改动 ═══');
  writeFileSync('haitu/reports/newco3-q1-2026.html', '<html>r3</html>');
  check('hasChanges = true（旧版会漏判为无改动）', hasChanges(WORK) === true);
  check('提交并推送成功', commitAndPush(WORK, 'chore(daily): 场景3') === true &&
    onOrigin('ls-tree -r --name-only HEAD').includes('newco3-q1-2026.html'));

  console.log('\n═══ 场景 4：删除的报告不由定时任务代劳 ═══');
  unlinkSync('haitu/reports/old-report.html');
  const headBefore = g('rev-parse HEAD');
  check('返回 true 而非报 ERROR', commitAndPush(WORK, 'chore(daily): 场景4') === true);
  check('未产生空提交', g('rev-parse HEAD') === headBefore);
  check('origin 仍保有该文件（删除留给人处理）',
    onOrigin('ls-tree -r --name-only HEAD').includes('old-report.html'));
  check('hasChanges 对纯删除返回 false', hasChanges(WORK) === false);

  console.log(`\n────────────  ${pass} 通过 · ${fail} 失败  ────────────`);
} finally {
  process.chdir(tmpdir());
  rmSync(ROOT, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
