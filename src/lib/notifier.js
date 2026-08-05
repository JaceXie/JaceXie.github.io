import { exec } from 'node:child_process';
import { logger } from './logger.js';

/**
 * macOS 桌面通知（osascript）。其它平台静默跳过。
 *
 * 开关：环境变量 HAITU_NOTIFY
 *   '0' / 'false' / 'off' → 不弹窗，但内容照样写进日志（用户 2026-08-05 要求关掉弹窗）
 *   未设置或其它值        → 弹窗（保留原行为，便于随时开回来）
 * ecosystem.config.cjs 已把每日任务设为 HAITU_NOTIFY: '0'。
 * 想临时开回来：HAITU_NOTIFY=1 npm run update
 */
const NOTIFY_OFF = ['0', 'false', 'off'].includes(
  String(process.env.HAITU_NOTIFY ?? '').toLowerCase()
);

export function notify(title, body) {
  if (NOTIFY_OFF) {
    // 不弹窗也要留痕 —— 否则「发现新财报」这件事会无声消失
    logger.info(`[通知已关闭 HAITU_NOTIFY=0] ${title} — ${body}`);
    return;
  }

  if (process.platform !== 'darwin') {
    logger.info(`[notify skipped on ${process.platform}] ${title}: ${body}`);
    return;
  }

  const safe = (s) => String(s).replace(/"/g, '\\"').replace(/'/g, "\\'");
  const cmd = `osascript -e 'display notification "${safe(body)}" with title "${safe(title)}" sound name "Pop"'`;

  exec(cmd, (err) => {
    if (err) {
      logger.warn(`notify failed: ${err.message}`);
    } else {
      logger.info(`📣 Notified: ${title} — ${body}`);
    }
  });
}
