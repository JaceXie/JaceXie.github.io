import { exec } from 'node:child_process';
import { logger } from './logger.js';

/**
 * macOS 桌面通知（osascript）。其它平台静默跳过。
 */
export function notify(title, body) {
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
