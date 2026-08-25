#!/bin/bash
set -e
mkdir -p ~/qa-bot-v2 && cd ~/qa-bot-v2
if [ -d ".git" ]; then
  git pull
else
  git clone https://github.com/liveautotest/qa-bot-v2.git .
fi
cd qa-bot-v2
mkdir -p reports

export DASHBOARD_PORT=4321
export QA_REPORT_BASE_DIR=./reports

nohup node src/dashboard/server.js > /tmp/dashboard.log 2>&1 &
disown
echo "대시보드 실행됨 (PID: $!), 포트: $DASHBOARD_PORT"
echo "로그: tail -f /tmp/dashboard.log"
