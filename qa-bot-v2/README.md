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
```

## Slack 명령어

명령어 뒤에 `dev` 또는 `stg`를 붙일 수 있습니다. 생략하면 `stg`로 실행합니다.
계약 요청/승인/결제/취소 계열은 실행 전에 필요한 게스트/호스트 로그인 상태를 먼저 확인하고,
세션이 풀려 있으면 자동 로그인 후 원래 동작을 이어서 진행합니다.

```text
!기본검증 일반결제 stg
!기본검증 무통장 결제 stg
!기본검증 자동결제 stg
!기본검증 연장결제 카드 stg
!기본검증 연장결제 무통장 stg
!게스트 로그인 stg
!게스트 로그아웃 stg
!게스트 검색 정확한일정 stg
!게스트 검색 유연한일정 stg
!게스트 계약 요청 stg
!게스트 계약 요청 취소 stg
!게스트 계약 확정 취소 stg
!게스트 연장요청 stg
!게스트 연장결제 카드 stg
!게스트 연장결제 무통장 stg
!게스트 계약 결제 일반카드 stg
!게스트 계약 결제 자동카드 stg
!게스트 계약 결제 무통장 stg
!게스트 리브후기 프로필 stg
!게스트 리브후기 일정 선택 stg
!게스트 리브후기 상세 stg
!게스트 쿠폰함 stg
!게스트 리뷰작성 stg
!게스트 리뷰수정 stg
!게스트 리뷰삭제 stg
!무통장 입금 승인
!호스트 로그인 stg
!호스트 로그아웃 stg
!호스트 계약 승인 stg
!호스트 계약 요청 거절 stg
!호스트 연장수락 stg
!호스트 연장승인 stg
```

`dev` 환경 예시:

```text
!기본검증 일반결제 dev
!기본검증 무통장 결제 dev
!기본검증 자동결제 dev
!기본검증 연장결제 카드 dev
!기본검증 연장결제 무통장 dev
!게스트 계약 요청 dev
!게스트 연장요청 dev
!게스트 연장결제 카드 dev
!게스트 연장결제 무통장 dev
!게스트 계약 결제 무통장 dev
!게스트 리브후기 프로필 dev
!게스트 리브후기 일정 선택 dev
!게스트 리브후기 상세 dev
!게스트 쿠폰함 dev
!게스트 리뷰작성 dev
!게스트 리뷰수정 dev
!게스트 리뷰삭제 dev
!호스트 연장수락 dev
!호스트 연장승인 dev
!무통장 입금 승인
!호스트 계약 승인 dev
!호스트 계약 요청 거절 dev
```

상세 명령어도 지원합니다.

```text
!qa basic-validation env=staging method=extension-card
!qa basic-validation env=staging method=extension-bank-transfer
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
!qa toss-deposit-approve
!qa review-profile env=staging role=guest
!qa review-schedule-select env=staging role=guest
!qa review-detail env=staging role=guest
!qa coupon-box env=staging role=guest
!qa review-write env=staging role=guest
!qa review-edit env=staging role=guest
!qa review-delete env=staging role=guest
```

## 구현된 시나리오

| 테스트 ID | 명령어 | 기준 |
| --- | --- | --- |
| `FLOW-BASIC-CARD-001` | `!기본검증 일반결제` | 게스트 계약 요청, 호스트 승인, 게스트 일반카드 결제 1사이클 |
| `FLOW-BASIC-BANK-001` | `!기본검증 무통장 결제` | 게스트 계약 요청, 호스트 승인, 게스트 무통장 결제, 토스 입금 승인 1사이클 |
| `FLOW-BASIC-AUTO-001` | `!기본검증 자동결제` | 게스트 자동카드 계약 요청, 호스트 승인 1사이클 |
| `FLOW-EXTENSION-CARD-001` | `!기본검증 연장결제 카드` | 게스트 연장요청, 호스트 연장수락, 게스트 카드 연장결제 1사이클 |
| `FLOW-EXTENSION-BANK-001` | `!기본검증 연장결제 무통장` | 게스트 연장요청, 호스트 연장수락, 게스트 무통장 연장결제 1사이클 |
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
| `TC-CONTRACT-CANCEL-REQUEST-001` | `!게스트 계약 요청 취소` | 요청 상태 카드에서 계약 요청 취소 |
| `TC-CONTRACT-CANCEL-CONFIRMED-001` | `!게스트 계약 확정 취소` | 확정 계약 취소, 취소 내역 확인, 완료 팝업, 홈 복귀 |
| `TC-INTERNAL-REFACTOR-001` | `!게스트 리브후기 프로필` | 리브후기 프로필 진입, 게시물 많은 계정 스크롤, 레이아웃/구분선 신호 확인 |
| `TC-INTERNAL-REFACTOR-002` | `!게스트 리브후기 일정 선택` | 리브후기 작성 일정 선택 모달, 예약/일정 목록 스크롤과 선택 확인 |
| `TC-INTERNAL-REFACTOR-003` | `!게스트 리브후기 상세` | 추천 태그 선택, 후기 상세 진입, 헤더 이미지와 상세 내용 스크롤 확인 |
| `TC-INTERNAL-REFACTOR-004` | `!게스트 쿠폰함` | 내 정보 쿠폰함, 쿠폰 그리드, 상세 다이얼로그, 목록 스크롤 확인 |
| `TC-INTERNAL-REFACTOR-005` | `!게스트 리뷰작성` | 별점 3개, 랜덤 태그 3개, 사진 3장, AI 리뷰 생성, 제출 완료 확인 |
| `TC-INTERNAL-REFACTOR-006` | `!게스트 리뷰수정` | 별점 변경, 키워드 추가/제거, 사진 추가/삭제, 리뷰 본문 변경, 저장 확인 |
| `TC-INTERNAL-REFACTOR-007` | `!게스트 리뷰삭제` | 내 리뷰 상세에서 삭제 확인 팝업 처리와 오류 미노출 확인 |

## 환경 설정

`.env`에 Slack, ADB, 계정, 앱 패키지 정보를 설정합니다.

```env
QA_DRY_RUN=false
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_RESULT_CHANNEL=C01KLGVHMD3
SLACK_RESULT_CHANNEL_ALLOWLIST=!기본검증 연장결제 stg,!기본검증 연장결제 dev,!기본검증 일반결제 stg,!기본검증 일반결제 dev,!기본검증 무통장 결제 stg,!기본검증 무통장 결제 dev,!기본검증 자동결제 stg,!기본검증 자동결제 dev,!기본검증 연장결제 카드 stg,!기본검증 연장결제 카드 dev,!기본검증 연장결제 무통장 stg,!기본검증 연장결제 무통장 dev,!게스트 연장요청 stg,!게스트 연장요청 dev,!호스트 연장수락 stg,!호스트 연장수락 dev,!게스트 연장결제 카드 stg,!게스트 연장결제 카드 dev,!게스트 연장결제 무통장 stg,!게스트 연장결제 무통장 dev,!게스트 리뷰작성 stg,!게스트 리뷰작성 dev,!게스트 리뷰수정 stg,!게스트 리뷰수정 dev,!게스트 리뷰삭제 stg,!게스트 리뷰삭제 dev
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
```

기본 환경은 `staging`입니다.

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
- 기본검증은 일반결제, 무통장 결제, 자동결제, 연장결제 카드/무통장 1사이클을 지원합니다.
- 리뷰/쿠폰 계열은 TargetSdk/UI 리팩토링 영향권을 빠르게 확인하는 내부 리팩토링 검증 케이스입니다.
- 리뷰 삭제는 삭제 확인 팝업 닫힘과 앱 오류 미노출까지 자동 확인하고, 계약 목록 버튼 상태 변화는 수동 확인 항목으로 남깁니다.

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
    coupon-box.test.js
    login.test.js
    logout.test.js
    review-delete.test.js
    review-detail.test.js
    review-edit.test.js
    review-profile.test.js
    review-schedule-select.test.js
    review-write.test.js
    search.test.js
    helpers/
docs/
scripts/aos/
reports/
```
