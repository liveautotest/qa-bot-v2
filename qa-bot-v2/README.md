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

## 스테이징 앱 최신 빌드 확인

Firebase App Distribution 연동 값을 `.env`에 설정하면 AOS 테스트 시작 전에 단말의 스테이징 앱 빌드가 최신인지 확인합니다.

```env
APP_BUILD_CHECK_ENABLED=true
AUTO_INSTALL_LATEST_STAGING=true
FIREBASE_PROJECT_NUMBER=123456789
FIREBASE_STAGING_APP_ID=1:123456789:android:abcdef
FIREBASE_DEV_APP_ID=1:123456789:android:fedcba
FIREBASE_SERVICE_ACCOUNT_PATH=/Users/liveanywhere_test/Documents/자동화 프로젝트/firebase-service-account.json
```

최신 빌드가 아니면 Firebase 최신 릴리즈 APK를 다운로드한 뒤 `adb install -r`로 설치하고 테스트를 진행합니다. Firebase에 올라간 파일이 AAB이면 단말에 바로 설치할 수 없으므로 자동 설치용 스테이징 릴리즈는 APK를 권장합니다.

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
    contract-approve.test.js
    contract-request.test.js
    login.test.js
    logout.test.js
    search.test.js
reports/
```
