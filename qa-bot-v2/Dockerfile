# QA Ops 대시보드 전용 이미지 (읽기 전용 웹 뷰어)
# 이 대시보드는 외부 npm 패키지를 전혀 쓰지 않아서(Node 내장 http/fs/path/child_process만 사용)
# node_modules 설치 과정 없이 소스 파일만 복사하면 됩니다.

FROM node:20-alpine

WORKDIR /app

# 대시보드 구동에 필요한 파일만 복사 (봇/테스트 코드, node_modules 등은 불필요)
COPY src/config.js ./src/config.js
COPY src/dashboard ./src/dashboard

# 테스트 결과가 동기화되어 들어올 디렉토리 (docker-compose에서 볼륨으로 마운트)
RUN mkdir -p /app/reports

ENV DASHBOARD_PORT=4321
ENV QA_REPORT_BASE_DIR=/app/reports

EXPOSE 4321

CMD ["node", "src/dashboard/server.js"]
