# 海图夜读 · GitHub Pages 自动化项目

`https://haitu.jacexie.com/`

每天早上 6:00 通过 PM2 cron 运行，自动：

1. 拉取所有跟踪公司的最新财报日期 / 派息事件（yfinance）
2. 重写 `index.html` 日历面板（窗口：过去 7 天 + 全部未来）
3. 检测"已分析公司发布了新财报"→ 生成待办队列 + macOS 桌面通知
4. 如有变化，自动 `git push` 到 GitHub Pages

---

## 目录

```
JaceXie.github.io/
├── package.json                # Node.js 项目元数据
├── ecosystem.config.cjs        # PM2 配置
├── src/
│   ├── daily-update.js         # 入口（cron 跑这个）
│   ├── lib/                    # 各功能模块
│   └── scripts/
│       ├── bootstrap-tickers.js     # 一次性：初始化 tickers.json
│       └── fetch_calendar_events.py # Python yfinance 抓取
├── data/
│   ├── tickers.json            # 主数据库（git tracked）
│   └── pending.json            # 待办队列（gitignored，运行时生成）
├── logs/                       # PM2 日志（gitignored）
├── index.html                  # 主页（含 HAITU:* marker 注释，由程序更新）
└── haitu/
    ├── assets/hai.png
    └── reports/                # 所有报告 HTML + social.md
```

---

## 命令速查

```bash
# 一次性初始化
npm install                  # 零依赖（仅创建 lockfile）
npm i -g pm2                 # 全局装 PM2
pip3 install yfinance        # Python 依赖

# 首次跑（从当前 index.html 提取数据）
npm run bootstrap            # 生成 data/tickers.json

# 手动测试
npm run update:dry           # 干跑：拿数据 + 显示 diff，不写不 push
npm run update               # 真实跑：写 index.html + git push

# PM2 守护
npm run pm2:start            # 启动 cron
pm2 save                     # 保存 PM2 状态
pm2 startup                  # 开机自启（一次性）
npm run pm2:logs             # 查看日志
npm run pm2:status           # 查看状态
```

---

## 工作流：发现新财报后

1. 早上 6:00 PM2 跑 `daily-update.js`
2. 检测到 `MSFT` 在 yfinance 上的 `lastEarningsDate` 比 `tickers.json` 中记录的 `lastEarningsReleaseDate` 新
3. 写入 `data/pending.json`：
   ```json
   [{ "ticker": "MSFT", "releaseDate": "2026-07-30", "suggestedPeriod": "Q4 FY2026" }]
   ```
4. macOS 弹通知"海图：发现 1 份新财报 - MSFT"
5. **手动**：用户跑 `/haitu MSFT` 让 Claude 重新分析
6. 新报告完成后，`tickers.json` 中 `lastAnalyzedDate` + `lastReportFile` 等字段被更新（在 `/haitu` 流程末尾），从 pending 移除

---

## 数据源

- **行情 / 财报日期 / 派息事件**：`yfinance`（Python 包），通过 `child_process.spawn` 调用
- **港股**：yfinance 用 `0700.HK` / `06690.HK` 后缀
- **A 股**：yfinance 用 `600519.SS` / `000651.SZ` 后缀

---

## 安全 / 边界

- 不调用任何付费 API
- 不存储任何 API key
- `data/pending.json` 不上传到 git
- `git push` 仅在 `index.html` 或 `data/tickers.json` 有 diff 时触发
- `index.html` marker 检测失败时报错并保留原文件
