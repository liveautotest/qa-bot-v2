# AOS QA Scripts

이 디렉토리는 AOS 자동화 테스트의 기준 스크립트를 관리한다.

현재 Slack 명령어와 스크립트 매핑은 다음과 같다.

| Slack 명령어 | 스크립트 | 실행 코드 |
| --- | --- | --- |
| `!게스트 로그인` | `login.guest.yaml` | `src/tests/login.test.js` |
| `!게스트 로그아웃` | `logout.guest.yaml` | `src/tests/logout.test.js` |
| `!게스트 집검색` | `search.guest.yaml` | `src/tests/search.test.js` |
| `!게스트 정확한일정 검색` | `search.guest.yaml` | `src/tests/search.test.js` |
| `!게스트 유연한일정 검색` | `search-flexible.guest.yaml` | `src/tests/search.test.js` |
| `!게스트 계약 요청` | `contract-request.guest.yaml` | `src/tests/contract-request.test.js` |
| `!게스트 계약 결제 자동카드` | `contract-request.guest.yaml` | `src/tests/contract-request.test.js` |
| `!게스트 계약 결제 일반카드` | `contract-payment.guest.yaml` | `src/tests/contract-payment.test.js` |
| `!게스트 계약 결제 무통장` | `contract-payment.guest.yaml` | `src/tests/contract-payment.test.js` |
| `!게스트 계약 요청 취소` | `contract-cancel-request.guest.yaml` | `src/tests/contract-cancel-request.test.js` |
| `!게스트 계약 확정 취소` | `contract-cancel-confirmed.guest.yaml` | `src/tests/contract-cancel-request.test.js` |
| `!호스트 로그인` | `login.host.yaml` | `src/tests/login.test.js` |
| `!호스트 로그아웃` | `logout.host.yaml` | `src/tests/logout.test.js` |
| `!호스트 계약 승인` | `contract-approve.host.yaml` | `src/tests/contract-approve.test.js` |
| `!호스트 계약 요청 거절` | `contract-reject.host.yaml` | `src/tests/contract-approve.test.js` |

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

## 환경 선택

모든 한국어 단축 명령어는 뒤에 `dev` 또는 `stg`를 붙여 실행 환경을 선택한다.

```text
!게스트 계약 요청 dev
!게스트 계약 요청 stg
!호스트 계약 승인 dev
!호스트 계약 승인 stg
```

환경을 생략하면 `stg`로 실행한다.
