# qa-bot-v2

새로 만드는 QA ChatOps Bot입니다. 기존 `issue-bot.js`는 사용하지 않습니다.

## 1단계 목표

- `!qa` 명령어 체계 준비
- 실행마다 `run_id` 발급
- `reports/{run_id}/request.json` 저장
- `reports/{run_id}/result.json` 저장
- `screenshots/`, `logs/` 폴더 생성
- dry-run 로그인 테스트 실행

## 로컬 실행

```bash
npm run run:login -- --env=staging --role=guest
```

실제 Slack Bot 실행은 의존성 설치 후 가능합니다.

```bash
npm install
npm start
```

기존 env 파일 경로를 쓰고 싶으면 복사하지 않고 경로만 지정합니다.

```bash
export QA_ENV_PATH=/Users/liveanywhere_test/C:issue-bot/env.txt
npm start
```

## 파일 구조

```text
src/
  app.js
  cli.js
  config.js
  infra/
    adb.js
    device-lock.js
  orchestrator/
    run-store.js
    run-test.js
    test-registry.js
  slack/
    command-router.js
    slack-reporter.js
  tests/
    login.test.js
reports/
```
