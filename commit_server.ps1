Set-Location -Path "f:\SHANTO windows\kriya ghor\server"

git add index.js
git commit -m "fix(core): prevent global server crashes on unhandled rejections and handle client disconnects"

git add api.js cron.js
git commit -m "perf(db): optimize Mongoose queries with lean() and Promise.all for massive speedups"

git add .
git commit -m "fix(api): fix SSRF, memory leaks, and invalidate redis cache dynamically"

git push origin main
