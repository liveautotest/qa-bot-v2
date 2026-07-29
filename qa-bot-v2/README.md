# qa-bot-v2

LiveAnywhere Android 앱 QA를 Slack 명령어로 실행하는 ChatOps 자동화 봇입니다. 기존 `issue-bot.js`와 분리된 새 프로젝트입니다.

## 현재 목표

- QA 담당자가 Slack에서 짧은 한국어 명령어로 AOS 시나리오를 실행합니다.
- 실행마다 `run_id`를 발급하고 `reports/{run_id}`에 결과를 저장합니다.
- 실패 시 원인을 바로 볼 수 있도록 실행 단계, UI XML, 스크린샷, runner log를 남깁니다.
- `dev`, `stg` 앱을 같은 명령어 체계에서 선택해 실행합니다.

## 로컬 실행

의존성 설치:

```bash
npm install
```

Slack Socket Mode 실행:

```bash
cd "/Users/liveanywhere_test/Documents/자동화 프로젝트/qa-bot-v2"
caffeinate -i /opt/homebrew/bin/node src/app.js
```

CLI 실행 예시:

```bash
/opt/homebrew/bin/node src/cli.js login --env=staging --role=guest
/opt/homebrew/bin/node src/cli.js contract-payment --env=dev --role=guest --payment_method=bank-transfer
/opt/homebrew/bin/node src/cli.js schedule-change --reservation_id=146183 --offset=일주일후
```

## Slack 명령어

명령어 뒤에 `dev` 또는 `stg`를 붙일 수 있습니다. 생략하면 `stg`로 실행합니다.
계약 요청/승인/결제/취소 계열은 실행 전에 필요한 게스트/호스트 로그인 상태를 먼저 확인하고,
세션이 풀려 있으면 자동 로그인 후 원래 동작을 이어서 진행합니다.

```text
!기본검증 일반결제 stg
!기본검증 무통장 결제 stg
!기본검증 자동결제 stg
!게스트 로그인 stg
!게스트 로그아웃 stg
!게스트 검색 정확한일정 stg
!게스트 검색 유연한일정 stg
!게스트 계약 요청 stg
!게스트 계약 요청 취소 stg
!게스트 계약 확정 취소 stg
!게스트 연장요청 stg
!게스트 계약 결제 일반카드 stg
!게스트 계약 결제 자동카드 stg
!게스트 계약 결제 무통장 stg
!무통장 입금 승인
!146183 계약 변경 일주일 전
!146183 계약 변경 2주일전
!146183 계약 변경 한달전
!146183 계약 변경 일주일 후
!146183 계약 변경 2주 후
!146183 계약 변경 한달 후
!호스트 로그인 stg
!호스트 로그아웃 stg
!호스트 계약 승인 stg
!호스트 계약 요청 거절 stg
!호스트 연장수락 stg
```

`dev` 환경 예시:

```text
!기본검증 일반결제 dev
!기본검증 무통장 결제 dev
!기본검증 자동결제 dev
!게스트 계약 요청 dev
!게스트 연장요청 dev
!게스트 계약 결제 무통장 dev
!호스트 연장수락 dev
!무통장 입금 승인
!호스트 계약 승인 dev
!호스트 계약 요청 거절 dev
```

상세 명령어도 지원합니다.

```text
!qa basic-validation env=staging method=card
!qa basic-validation env=staging method=bank-transfer
!qa basic-validation env=staging method=auto-card
!qa login env=staging role=guest
!qa logout env=staging role=guest
!qa search env=staging role=guest
!qa search-flexible env=staging role=guest
!qa contract-request env=staging role=guest
!qa contract-request env=staging role=guest method=auto-card
!qa contract-cancel-request env=staging role=guest
!qa contract-cancel-confirmed env=staging role=guest
!qa contract-payment env=staging role=guest method=card
!qa contract-payment env=staging role=guest method=bank-transfer
!qa contract-approve env=staging role=host
!qa contract-reject env=staging role=host
!qa schedule-change reservation_id=146183 offset=일주일후
!qa toss-deposit-approve
```

## 구현된 시나리오

| 테스트 ID | 명령어 | 기준 |
| --- | --- | --- |
| `FLOW-BASIC-CARD-001` | `!기본검증 일반결제` | 게스트 로그인, 계약 요청, 호스트 승인, 게스트 일반결제 1사이클 |
| `FLOW-BASIC-BANK-001` | `!기본검증 무통장 결제` | 게스트 로그인, 계약 요청, 호스트 승인, 게스트 무통장 결제, Toss 입금 승인 1사이클 |
| `FLOW-BASIC-AUTO-CARD-001` | `!기본검증 자동결제` | 게스트 로그인, 자동카드 계약 요청, 호스트 승인 1사이클 |
| `TC-LOGIN-001` | `!게스트 로그인`, `!호스트 로그인` | 게스트는 홈 화면 진입, 호스트는 호스트모드 계약 탭 진입 |
| `TC-LOGOUT-001` | `!게스트 로그아웃`, `!호스트 로그아웃` | 내 정보 화면의 로그아웃 버튼과 확인 팝업 처리 |
| `TC-SEARCH-001` | `!게스트 검색 정확한일정` | 국내, 8월 1일-8월 7일, 어린이/유아/반려동물 조건 검색 |
| `TC-SEARCH-002` | `!게스트 검색 유연한일정` | 국내, 일주일, 7월/8월 조건 검색 |
| `TC-CONTRACT-001` | `!게스트 계약 요청` | 정확한 일정 검색 후 첫 번째 숙소 계약 요청. PASS 시 `!호스트 계약 승인`을 자동 연결 실행 |
| `TC-CONTRACT-001` | `!게스트 계약 결제 자동카드` | 계약 요청 화면에서 호스트 수락 즉시 자동 결제 선택. PASS 시 `!호스트 계약 승인`을 자동 연결 실행 |
| `TC-CONTRACT-APPROVE-001` | `!호스트 계약 승인` | 호스트 계약 탭에서 요청 건 수락 |
| `TC-CONTRACT-REJECT-001` | `!호스트 계약 요청 거절` | 게스트 홈 카드의 숙소명/일정과 매칭되는 요청 건 거절 |
| `TC-CONTRACT-PAYMENT-001` | `!게스트 계약 결제 일반카드` | JCB 카드 테스트 결제 후 홈 복귀 |
| `TC-CONTRACT-PAYMENT-001` | `!게스트 계약 결제 무통장` | 현금영수증, 환불 계좌, 무통장 결제 완료 후 홈 복귀. PASS 시 `!무통장 입금 승인`을 자동 연결 실행 |
| `TC-TOSS-DEPOSIT-APPROVE-001` | `!무통장 입금 승인` | 토스 테스트 결제내역에서 최근 무통장 입금대기 건 입금처리 |
| `TC-SCHEDULE-CHANGE-001` | `!146183 계약 변경 일주일 후` | 현재 날짜 기준으로 변경 기간을 계산하고 날짜만 변경하는 계약 일정 변경 API 호출 |
| `TC-CONTRACT-CANCEL-REQUEST-001` | `!게스트 계약 요청 취소` | 요청 상태 카드에서 계약 요청 취소 |
| `TC-CONTRACT-CANCEL-CONFIRMED-001` | `!게스트 계약 확정 취소` | 확정 계약 취소, 취소 내역 확인, 완료 팝업, 홈 복귀 |

## 환경 설정

`.env`에 Slack, ADB, 계정, 앱 패키지 정보를 설정합니다.

```env
QA_DRY_RUN=false
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ADB_PATH=/Users/liveanywhere_test/Library/Android/sdk/platform-tools/adb
ADB_GUEST_DEVICE=R3CT80QJ3NL
ADB_HOST_DEVICE=R3CR30K439K
ANDROID_STAGING_PACKAGE=com.live1month.live1month.staging
ANDROID_DEV_PACKAGE=com.live1month.live1month.dev
GUEST_EMAIL=...
GUEST_PASSWORD=...
HOST_EMAIL=...
HOST_PASSWORD=...

TOSS_ADMIN_URL=https://developers.tosspayments.com/3118/accounts/127851/phases/test/payment-logs
TOSS_ADMIN_MID=liveanjb2c
TOSS_ADMIN_EMAIL=...
TOSS_ADMIN_PASSWORD=...
TOSS_ADMIN_HEADLESS=true
TOSS_ADMIN_KEEP_OPEN_ON_FAIL=false

QA_API_BASE_URL=https://staging-api-gateway.liveanywhere.me
QA_API_AUTH_HEADER=Bearer ...
QA_API_TOKEN=...
# 또는 QA_API_COOKIE=...
```

기본 환경은 `staging`입니다.
계약 일정 변경 명령은 앱 실행 환경과 무관한 API 명령이므로 `dev`/`stg`를 붙이지 않습니다.
`POST /v1/reservations/{reservationId}/unusually-reschedule`을 호출하며, 계약 기간 날짜만 변경합니다.
세부가격/총결제금액 재계산까지 포함하는 콘솔형 일정 변경은 별도 검증 대상으로 분리합니다.

## Firebase App Distribution 연동

앱 최신 빌드 확인은 아직 선택 기능입니다. 값을 설정하면 테스트 시작 전 단말 설치 버전과 Firebase 최신 릴리즈를 비교할 수 있습니다.

```env
APP_BUILD_CHECK_ENABLED=true
AUTO_INSTALL_LATEST_STAGING=true
FIREBASE_PROJECT_NUMBER=326461175001
FIREBASE_STAGING_APP_ID=1:326461175001:android:c402489a89eb156bdc7ac8
FIREBASE_DEV_APP_ID=1:326461175001:android:2baa0e3b69b9d2e5dc7ac8
FIREBASE_SERVICE_ACCOUNT_PATH=/Users/liveanywhere_test/Documents/자동화 프로젝트/firebase-service-account.json
```

Firebase 릴리즈 파일이 AAB이면 `adb install -r`로 바로 설치할 수 없으므로 자동 설치용 릴리즈는 APK가 필요합니다.

## 리포트 구조

```text
reports/{run_id}/
  request.json
  result.json
  logs/
  screenshots/
```

운영 원칙:

- PASS에는 핵심 검증 요약을 Slack에 표시합니다.
- FAIL에는 실패 단계, 확인할 내용, 리포트 경로를 표시합니다.
- 스크린샷은 실패 화면 중심으로 저장합니다.
- ADB/UI dump 기반 탐색을 우선하고, XML에서 버튼이 분리되지 않는 팝업은 제한된 화면 조건에서만 좌표 fallback을 사용합니다.
- 계약 계열은 실행 전 필요한 게스트/호스트 로그인 상태를 확인하고, 세션이 풀려 있으면 자동 로그인 후 이어서 진행합니다.
- 기본검증은 내부에서 계약 요청과 호스트 승인을 명시적으로 한 번씩 실행해 중복 승인 처리를 방지합니다.

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
    contract-cancel-request.test.js
    contract-payment.test.js
    contract-request.test.js
    login.test.js
    logout.test.js
    search.test.js
docs/
scripts/aos/
reports/
```
