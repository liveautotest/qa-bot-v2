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
/opt/homebrew/bin/node src/cli.js console-schedule-change --env=dev --role=admin --reservation_id=146628 --shift="일주일 전"
```

## Slack 명령어

명령어 뒤에 `dev` 또는 `stg`를 붙일 수 있습니다. 생략하면 `stg`로 실행합니다.
계약 요청/승인/결제/취소 계열은 실행 전에 필요한 게스트/호스트 로그인 상태를 먼저 확인하고,
세션이 풀려 있으면 자동 로그인 후 원래 동작을 이어서 진행합니다.

```text
!기본검증 일반결제 stg
!기본검증 무통장 결제 stg
!기본검증 등록카드결제 stg
!기본검증 분할결제 stg
!기본검증 연장결제 카드 stg
!기본검증 연장결제 무통장 stg
!검증
!빌드설치
!일정변경
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
!일정변경 146628 일주일 전 stg
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
!기본검증 등록카드결제 dev
!기본검증 분할결제 dev
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
!일정변경 146628 일주일 전 dev
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
!qa basic-validation env=staging method=split-payment
!qa login env=staging role=guest
!qa logout env=staging role=guest
!qa search env=staging role=guest
!qa search-flexible env=staging role=guest
!qa contract-request env=staging role=guest
!qa contract-request env=staging role=guest method=auto-card
!qa contract-request env=staging role=guest method=split-payment
!qa contract-cancel-request env=staging role=guest
!qa contract-cancel-confirmed env=staging role=guest
!qa contract-payment env=staging role=guest method=card
!qa contract-payment env=staging role=guest method=bank-transfer
!qa contract-approve env=staging role=host
!qa contract-reject env=staging role=host
!qa toss-deposit-approve
!qa console-schedule-change env=staging role=admin reservation_id=146628 shift=일주일전
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
| `FLOW-BASIC-AUTO-001` | `!기본검증 등록카드결제` | 게스트 자동카드 계약 요청, 호스트 승인 1사이클 |
| `FLOW-BASIC-SPLIT-001` | `!기본검증 분할결제` | 게스트 계약 요청 화면에서 기본 180박 장기 일정과 분할 결제 선택, 호스트 승인 1사이클 |
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
| `TC-CONTRACT-PAYMENT-001` | `!게스트 계약 결제 일반카드` | JCB 카드, 만료일, PG 이메일 입력 후 테스트 결제와 홈 복귀 |
| `TC-CONTRACT-PAYMENT-001` | `!게스트 계약 결제 무통장` | 현금영수증, 환불 계좌, 무통장 결제 완료 후 홈 복귀. PASS 시 `!무통장 입금 승인`을 자동 연결 실행 |
| `TC-TOSS-DEPOSIT-APPROVE-001` | `!무통장 입금 승인` | 토스 테스트 결제내역에서 최근 무통장 입금대기 건 입금처리 |
| `TC-CONSOLE-SCHEDULE-CHANGE-001` | `!일정변경 146628 일주일 전 dev` | 콘솔 예약 상세에서 체크인/체크아웃 변경, 세부 가격 모달, 변경 완료 팝업 처리 |
| `TC-CONSOLE-DEPOSIT-RETURN-001` | `!보증금 반환 146647 stg`, `!보증금 보류 146647 stg` | 호스트 콘솔 예약 상세에서 보증금 반환 확정 또는 보류 처리. 보류는 기타 제외 사유를 랜덤 선택 |
| `TC-BUILD-INSTALL-001` | `!빌드설치` | Slack UI에서 사용자(게스트/호스트/게스트+호스트), Android/iOS 클라이언트, 환경, Firebase 빌드를 선택해 해당 플랫폼 단말에 설치. 낮은 버전 설치 시 해당 앱만 삭제 후 설치 |
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
SLACK_RESULT_CHANNEL_ALLOWLIST=!기본검증 연장결제 stg,!기본검증 연장결제 dev,!기본검증 일반결제 stg,!기본검증 일반결제 dev,!기본검증 무통장 결제 stg,!기본검증 무통장 결제 dev,!기본검증 등록카드결제 stg,!기본검증 등록카드결제 dev,!기본검증 분할결제 stg,!기본검증 분할결제 dev,!기본검증 연장결제 카드 stg,!기본검증 연장결제 카드 dev,!기본검증 연장결제 무통장 stg,!기본검증 연장결제 무통장 dev,!게스트 연장요청 stg,!게스트 연장요청 dev,!호스트 연장수락 stg,!호스트 연장수락 dev,!게스트 연장결제 카드 stg,!게스트 연장결제 카드 dev,!게스트 연장결제 무통장 stg,!게스트 연장결제 무통장 dev,!게스트 리뷰작성 stg,!게스트 리뷰작성 dev,!게스트 리뷰수정 stg,!게스트 리뷰수정 dev,!게스트 리뷰삭제 stg,!게스트 리뷰삭제 dev
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

CONSOLE_DEV_URL_BASE=https://dev-console.liveanywhere.me/reservations
CONSOLE_STAGING_URL_BASE=https://staging-console.liveanywhere.me/reservations
CONSOLE_ADMIN_EMAIL=...
CONSOLE_ADMIN_PASSWORD=...
CONSOLE_ADMIN_HEADLESS=true
CONSOLE_ADMIN_KEEP_OPEN_ON_FAIL=false
CONSOLE_HOST_EMAIL=...
CONSOLE_HOST_PASSWORD=...
CONSOLE_HOST_HEADLESS=true
CONSOLE_HOST_KEEP_OPEN_ON_FAIL=false
```

기본 환경은 `staging`입니다.

## Firebase App Distribution 연동

앱 최신 빌드 확인은 선택 기능입니다. 값을 설정하면 테스트 시작 전 단말 설치 버전과 Firebase 최신 릴리즈를 비교할 수 있고, `!빌드설치` UI에서 선택한 Android APK 또는 iOS IPA를 해당 플랫폼 단말에 설치할 수 있습니다.

```env
APP_BUILD_CHECK_ENABLED=true
AUTO_INSTALL_LATEST_STAGING=true
FIREBASE_PROJECT_NUMBER=326461175001
FIREBASE_STAGING_APP_ID=1:326461175001:android:c402489a89eb156bdc7ac8
FIREBASE_DEV_APP_ID=1:326461175001:android:2baa0e3b69b9d2e5dc7ac8
# 비워두면 이 Mac의 `firebase login` 세션을 사용합니다.
FIREBASE_SERVICE_ACCOUNT_PATH=
```

Firebase 릴리즈 파일이 AAB이면 `adb install -r`로 바로 설치할 수 없으므로 자동 설치용 릴리즈는 APK가 필요합니다.

`!빌드설치` 설치 규칙:

- Slack UI의 클라이언트 선택에 따라 Android 단말은 APK/ADB, iOS 단말은 IPA/`xcrun devicectl` 설치 경로를 사용합니다.
- 선택한 빌드가 단말 설치 버전보다 높으면 플랫폼 설치기로 업데이트합니다.
- 선택한 빌드가 단말 설치 버전보다 낮으면 해당 환경 앱만 삭제한 뒤 선택한 APK 또는 IPA를 설치합니다.
- 같은 버전이면 설치를 생략하고 PASS로 처리합니다.
- Android 신규 설치와 낮은 버전 재설치는 선택한 역할·환경의 로그인을 이어서 실행합니다. 호스트는 업데이트 설치 후에도 호스트 로그인을 실행하며, 동일 버전 설치 생략 시에는 로그인도 생략합니다. iOS 설치는 현재 설치 및 버전 검증까지만 수행합니다.
- PASS 결과의 버전은 설치 직후 해당 환경 앱을 다시 조회한 값이며, 이후 다른 설치 작업으로 단말 버전이 바뀔 수 있습니다.
- 결과는 테스트 채널에 Slack 요약만 남기며 PDF 리포트는 업로드하지 않습니다.

## Slack 선택 UI

- `!검증` 또는 `/검증`: 테스터, 클라이언트, 환경, 검증 항목을 선택한 뒤 기존 자동화 명령을 같은 봇 프로세스에서 실행합니다. 로그인, 검색, 계약 요청/취소/승인/거절, 연장 요청/수락, 결제 기본검증과 계약 확정 취소를 선택할 수 있습니다. 현재 Android APP의 stg/dev만 실행할 수 있고 PC, iOS APP, Prod는 준비 중으로 표시됩니다.
- `!빌드설치`: 사용자, 클라이언트(Android/iOS), 환경, Firebase 빌드를 선택해 해당 플랫폼 단말에 설치합니다. `게스트 + 호스트`는 게스트를 먼저 설치한 뒤 호스트를 순차 설치합니다.
- `!일정변경`: 계약 ID, 변경 날짜 기준, 환경을 선택한 뒤 기존 콘솔 일정 변경 자동화를 실행합니다. 인자를 직접 입력하는 기존 명령어도 계속 지원합니다.
- 선택 UI는 별도 Socket Mode 프로세스로 실행하지 않고 `src/app.js`에 핸들러로 등록합니다.

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
- 기본검증은 일반결제, 무통장 결제, 등록카드결제, 분할결제, 연장결제 카드/무통장 1사이클을 지원합니다.
- 리뷰/쿠폰 계열은 TargetSdk/UI 리팩토링 영향권을 빠르게 확인하는 내부 리팩토링 검증 케이스입니다.
- 리뷰 삭제는 삭제 확인 팝업 닫힘과 앱 오류 미노출까지 자동 확인하고, 계약 목록 버튼 상태 변화는 수동 확인 항목으로 남깁니다.
- 콘솔 일정 변경은 앱/ADB를 사용하지 않는 Playwright 브라우저 자동화이며, 로그인 직후 예약 상세 본문이 비어 보이면 같은 예약 URL을 재진입/재대기한 뒤 판정합니다.
- 콘솔 보증금 반환/보류와 빌드 설치는 결과를 Slack 요약으로만 표시하고 PDF 업로드는 생략합니다.

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
    console-schedule-change.test.js
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
