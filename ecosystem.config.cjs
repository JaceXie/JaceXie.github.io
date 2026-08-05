/**
 * PM2 配置 · 海图夜读每日更新机器人
 *
 * 启动：
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup   # 一次性配置开机自启
 *
 * 日志：
 *   pm2 logs haitu-daily-update
 *   tail -f logs/daily-update.log
 */
module.exports = {
  apps: [
    {
      name: 'haitu-daily-update',
      script: 'src/daily-update.js',
      // cron 表达式：每天 6:00 AM 本地时区
      cron_restart: '0 6 * * *',
      // 跑完即退，不自动重启
      autorestart: false,
      instances: 1,
      // 日志
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      time: true,
      merge_logs: true,
      // 内存限制
      max_memory_restart: '256M',
      // 环境
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Shanghai',
        // 关掉「发现新财报」的 macOS 桌面弹窗与提示音（用户 2026-08-05 要求）。
        // 内容仍会写进 logs/daily-update.log，不会丢信息。
        // 想开回来：改成 '1' 后 pm2 restart haitu-daily-update --update-env
        HAITU_NOTIFY: '0'
      }
    }
  ]
};
