# AOS QA Scripts

이 디렉토리는 AOS 자동화 테스트의 기준 스크립트를 관리한다.

현재 Slack 명령어와 스크립트 매핑은 다음과 같다.

| Slack 명령어 | 스크립트 | 실행 코드 |
| --- | --- | --- |
| `!기본검증 일반결제` | 개별 스크립트 조합 | `src/slack/command-router.js` |
| `!기본검증 무통장 결제` | 개별 스크립트 조합 | `src/slack/command-router.js` |
| `!기본검증 등록카드결제` | 개별 스크립트 조합 | `src/slack/command-router.js` |
| `!기본검증 연장결제 카드` | 개별 스크립트 조합 | `src/slack/command-router.js` |
| `!기본검증 연장결제 무통장` | 개별 스크립트 조합 | `src/slack/command-router.js` |
| `!게스트 로그인` | `login.guest.yaml` | `src/tests/login.test.js` |
| `!게스트 로그아웃` | `logout.guest.yaml` | `src/tests/logout.test.js` |
| `!게스트 집검색` | `search.guest.yaml` | `src/tests/search.test.js` |
| `!게스트 검색 정확한일정` | `search.guest.yaml` | `src/tests/search.test.js` |
| `!게스트 검색 유연한일정` | `search-flexible.guest.yaml` | `src/tests/search.test.js` |
| `!게스트 계약 요청` | `contract-request.guest.yaml` | `src/tests/contract-request.test.js` |
| `!게스트 계약 결제 자동카드` | `contract-request.guest.yaml` | `src/tests/contract-request.test.js` |
| `!게스트 계약 결제 일반카드` | `contract-payment.guest.yaml` | `src/tests/contract-payment.test.js` |
| `!게스트 계약 결제 무통장` | `contract-payment.guest.yaml` | `src/tests/contract-payment.test.js` |
| `!게스트 연장요청` | 코드 기반 시나리오 | `src/tests/contract-extension.test.js` |
| `!게스트 연장결제 카드` | 코드 기반 시나리오 | `src/tests/contract-payment.test.js` |
| `!게스트 연장결제 무통장` | 코드 기반 시나리오 | `src/tests/contract-payment.test.js` |
| `!게스트 리브후기 프로필` | 코드 기반 시나리오 | `src/tests/review-profile.test.js` |
| `!게스트 리브후기 일정 선택` | 코드 기반 시나리오 | `src/tests/review-schedule-select.test.js` |
| `!게스트 리브후기 상세` | 코드 기반 시나리오 | `src/tests/review-detail.test.js` |
| `!게스트 쿠폰함` | 코드 기반 시나리오 | `src/tests/coupon-box.test.js` |
| `!게스트 리뷰작성` | 코드 기반 시나리오 | `src/tests/review-write.test.js` |
| `!게스트 리뷰수정` | 코드 기반 시나리오 | `src/tests/review-edit.test.js` |
| `!게스트 리뷰삭제` | 코드 기반 시나리오 | `src/tests/review-delete.test.js` |
| `!무통장 입금 승인` | `toss-deposit-approve.web.yaml` | `src/tests/toss-deposit-approve.test.js` |
| `!게스트 계약 요청 취소` | `contract-cancel-request.guest.yaml` | `src/tests/contract-cancel-request.test.js` |
| `!게스트 계약 확정 취소` | `contract-cancel-confirmed.guest.yaml` | `src/tests/contract-cancel-request.test.js` |
| `!호스트 로그인` | `login.host.yaml` | `src/tests/login.test.js` |
| `!호스트 로그아웃` | `logout.host.yaml` | `src/tests/logout.test.js` |
| `!호스트 계약 승인` | `contract-approve.host.yaml` | `src/tests/contract-approve.test.js` |
| `!호스트 계약 요청 거절` | `contract-reject.host.yaml` | `src/tests/contract-approve.test.js` |
| `!호스트 연장수락` | 코드 기반 시나리오 | `src/tests/contract-extension-approve.test.js` |
| `!호스트 연장승인` | 코드 기반 시나리오 | `src/tests/contract-extension-approve.test.js` |

## 작성 규칙

- `id`: 테스트 케이스 ID를 적는다.
- `name`: QA 리포트에 노출될 사람이 읽는 이름을 적는다.
- `platform`: 현재는 `aos`를 사용한다.
- `env`: 기본은 `staging`이다.
- `role`: `guest` 또는 `host`를 사용한다.
- `steps`: QA 시나리오 순서를 사람이 이해할 수 있게 작성한다.
- `validations`: PASS/FAIL 판정 기준을 작성한다.
- `artifacts`: 확인해야 할 스크린샷과 로그 파일을 작성한다.
- `pass_criteria`: 최종 PASS 조건을 명확하게 작성한다.

## 운영 방식

1. QA 시나리오를 먼저 YAML로 작성한다.
2. 실제 ADB 조작은 `src/tests/*.test.js`에서 구현한다.
3. Slack 명령어는 YAML의 `runner.test`에 맞는 테스트를 실행한다.
4. 실패하면 YAML의 `validations`와 실제 리포트를 비교해 스크립트를 보강한다.

## 기본검증 조합 시나리오

기본검증은 단일 YAML 하나가 아니라 기존 스크립트를 순서대로 연결하는 스모크 플로우다.

| 명령어 | 연결 순서 |
| --- | --- |
| `!기본검증 일반결제` | `login.guest` -> `contract-request.guest` -> `contract-approve.host` -> `contract-payment.guest(method=card)` |
| `!기본검증 무통장 결제` | `login.guest` -> `contract-request.guest` -> `contract-approve.host` -> `contract-payment.guest(method=bank-transfer)` -> `toss-deposit-approve.web` |
| `!기본검증 등록카드결제` | `login.guest` -> `contract-request.guest(method=auto-card)` -> `contract-approve.host` |
| `!기본검증 연장결제 카드` | `login.guest` -> `contract-extension.guest` -> `contract-extension-approve.host` -> `contract-payment.guest(extension, method=card)` |
| `!기본검증 연장결제 무통장` | `login.guest` -> `contract-extension.guest` -> `contract-extension-approve.host` -> `contract-payment.guest(extension, method=bank-transfer)` |

운영 기준:

- 중간 단계가 FAIL이면 이후 단계는 실행하지 않는다.
- 계약 요청/승인/결제/취소 계열은 필요한 게스트/호스트 로그인 상태를 먼저 확인하고, 풀려 있으면 자동 로그인 후 이어서 진행한다.
- 기본검증 내부에서는 계약 요청의 자동 승인 연결을 우회해 호스트 승인을 한 번만 실행한다.

## 환경 선택

대부분의 한국어 단축 명령어는 뒤에 `dev` 또는 `stg`를 붙여 실행 환경을 선택한다.

```text
!게스트 계약 요청 dev
!게스트 계약 요청 stg
!기본검증 일반결제 dev
!기본검증 무통장 결제 dev
!기본검증 등록카드결제 dev
!기본검증 연장결제 카드 dev
!기본검증 연장결제 무통장 dev
!호스트 계약 승인 dev
!호스트 계약 승인 stg
!호스트 연장수락 dev
!호스트 연장수락 stg
!게스트 리뷰작성 dev
!게스트 리뷰수정 dev
!게스트 리뷰삭제 dev
```

환경을 생략하면 `stg`로 실행한다.
