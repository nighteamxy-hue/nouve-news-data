# 定制新闻台

网址：https://news.nouve.cn

- `index.html`：手机网页（适配 iPhone，可添加到主屏幕）
- `data/news.json`：新闻数据，由 Claude 的定时任务每 6 小时自动更新
- `data/sources.json`：默认新闻源列表（在网页设置里修改后会保存在 Cloudflare KV）
- `data/meta.json`：最近一次更新的时间和状态
- `worker/worker.js`：Cloudflare Worker，负责把这个仓库的文件提供给 news.nouve.cn

修改页面只需改 `index.html` 并推送，网站几分钟内自动生效。
