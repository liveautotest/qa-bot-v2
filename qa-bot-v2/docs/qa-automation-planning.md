# QA 자동화 기획 및 설계 문서

작성일: 2026-07-20  
대상 프로젝트: `qa-bot-v2`  
대상 서비스: LiveAnywhere Android 앱 Staging 환경

---

## 1. 문서 목적

이 문서는 LiveAnywhere QA 자동화의 목적, 자동화 범위, 실행 구조, 단계별 진행 순서, 운영 기준을 정리하기 위한 문서이다.

Notion에 업로드하여 QA, 개발, PM, 운영 담당자가 같은 기준으로 자동화 범위와 진행 상태를 확인할 수 있도록 한다.

---

## 2. 자동화 도입 목적

### 2.1 핵심 목적

반복적으로 수행되는 모바일 앱 QA 시나리오를 Slack 명령어로 실행하고, 실행 결과를 구조화된 리포트로 남겨 QA 속도와 재현성을 높인다.

### 2.2 기대 효과

- QA 담당자가 매번 수동으로 단말을 조작하지 않아도 주요 시나리오를 빠르게 확인할 수 있다.
- Slack에서 명령어를 입력하면 연결된 QA 단말에서 자동으로 테스트가 실행된다.
- 각 테스트 실행마다 `run_id`가 발급되어 결과 추적이 가능하다.
- 실패 시 스크린샷, UI dump, 로그를 남겨 실패 원인을 빠르게 확인할 수 있다.
- 게스트/호스트 등 역할별 시나리오를 표준화할 수 있다.
- 향후 검색, 계약, 결제, 리뷰 등 핵심 E2E 플로우로 확장할 수 있다.

---

## 3. 자동화 기본 원칙

### 3.1 기존 운영 봇과 분리

기존 `issue-bot.js`는 사용하지 않고, 새 프로젝트 `qa-bot-v2`에서 자동화를 진행한다.

목적:

- 기존 운영 봇 안정성 유지
- 새 구조에서 테스트 실행/리포트/Slack 응답을 분리
- 기능 단위로 안전하게 확장

### 3.2 Slack은 실행 요청 인터페이스

Slack Bot은 테스트 로직을 직접 들고 있는 주체가 아니라, 테스트 실행을 요청하고 결과를 전달하는 ChatOps 인터페이스 역할을 한다.

```text
Slack 명령어
-> qa-bot-v2
-> Test Orchestrator
-> Test Runner
-> Android 단말 테스트 실행
-> reports/{run_id}/result.json 저장
-> Slack 결과 응답
```

### 3.3 모든 실행은 기록으로 남긴다

모든 테스트 실행은 아래 구조로 저장한다.

```text
reports/{run_id}/
  request.json
  result.json
  screenshots/
  logs/
```

저장 항목:

- 요청 정보
- 실행 결과
- 단계별 상태
- 실패 원인
- 마지막 화면 스크린샷
- UI dump XML
- runner log

---

## 4. 현재 자동화 구현 상태

### 4.1 현재 프로젝트 구조

```text
qa-bot-v2/
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
  docs/
```

### 4.2 현재 지원 명령어

```text
!qa help
!qa login env=staging role=guest
!qa login env=staging role=host
```

### 4.3 현재 구현된 테스트

현재 구현된 테스트는 로그인 테스트이다.

```text
TC-LOGIN-001
```

지원 역할:

- `guest`
- `host`

대상 환경:

- `staging`

대상 앱 패키지:

```text
com.live1month.live1month.staging
```

---

## 5. 로그인 자동화 기준

### 5.1 게스트 로그인 기준

게스트 로그인은 깨끗한 상태에서 이메일/비밀번호 로그인을 검증한다.

게스트 로그인 흐름:

```text
1. 단말 깨우기
2. 앱 데이터 초기화
3. 앱 종료 후 재실행
4. 알림 권한 팝업 처리
5. 이메일/휴대폰 번호로 시작하기 진입
6. 이메일 입력
7. 비밀번호 입력
8. 로그인 버튼 탭
9. 홈 화면 진입 확인
10. PASS/FAIL 판정
```

PASS 기준:

- 이메일 값이 정상 입력되어야 한다.
- 비밀번호 값이 정상 입력되어야 한다.
- 로그인 후 홈 화면에 진입해야 한다.
- 로그인 오류 문구가 없어야 한다.

FAIL 기준:

- 이메일/비밀번호가 잘못 입력됨
- 로그인 화면에 그대로 남아 있음
- `유효하지 않은 형식입니다` 등 오류 문구 표시
- 앱이 잠금화면/권한 팝업/업데이트 팝업에서 멈춤

### 5.2 호스트 로그인 기준

호스트 로그인은 단순 앱 로그인만으로 완료로 보지 않는다.

호스트 로그인 완료 기준:

```text
호스트 계정 로그인
-> 내 정보 탭 이동
-> 호스트모드 버튼 탭
-> 호스트모드 화면 확인
```

호스트 로그인 흐름:

```text
1. 단말 깨우기
2. 앱 실행 또는 전면 이동
3. 현재 로그인 상태 확인
4. 이미 로그인되어 있으면 내 정보 탭으로 이동
5. 로그인되어 있지 않으면 이메일/비밀번호 로그인 수행
6. 내 정보 탭 이동
7. 호스트모드 버튼 탭
8. 호스트모드 진입 확인
9. PASS/FAIL 판정
```

호스트는 이미 로그인된 상태일 수 있으므로, 매번 앱 데이터 초기화를 하지 않는다.

PASS 기준:

- 호스트 계정으로 앱에 진입되어야 한다.
- `내 정보` 탭으로 이동 가능해야 한다.
- `호스트모드` 버튼을 찾을 수 있어야 한다.
- 호스트모드 버튼 탭 후 호스트 화면 또는 호스트 상태를 확인해야 한다.

FAIL 기준:

- 로그인되지 않은 상태인데 로그인 화면 진입 실패
- 이메일/비밀번호 입력 실패
- 로그인 후 홈 화면 진입 실패
- `내 정보` 탭을 찾지 못함
- `호스트모드` 버튼을 찾지 못함
- 호스트모드 전환 후 호스트 상태 확인 실패

---

## 6. 자동화 전체 구조

### 6.1 구성 요소

```text
Slack Bot
  - Slack 메시지 수신
  - !qa 명령어 파싱
  - 테스트 실행 요청 생성
  - 결과 메시지 전송

Test Orchestrator
  - run_id 생성
  - 테스트 선택
  - 실행 상태 관리
  - request/result 저장

Test Runner
  - 실제 테스트 단계 실행
  - ADB 명령 실행
  - UI dump 분석
  - 스크린샷 저장
  - PASS/FAIL 판정

Report Store
  - request.json 저장
  - result.json 저장
  - screenshots 저장
  - logs 저장
```

### 6.2 실행 흐름

```text
사용자 Slack 명령 입력
  ↓
Slack Bot 수신
  ↓
command-router에서 명령어 파싱
  ↓
run-test에서 테스트 실행 요청 생성
  ↓
run-store에서 run_id 및 report 폴더 생성
  ↓
test-registry에서 대상 테스트 선택
  ↓
login.test.js 실행
  ↓
ADB로 단말 조작
  ↓
UI dump / screenshot / log 저장
  ↓
result.json 생성
  ↓
Slack에 결과 응답
```

---

## 7. 자동화 진행 단계

### 7.1 1단계: 로그인 자동화 안정화

목표:

- Slack에서 게스트/호스트 로그인 자동화를 실행할 수 있게 한다.
- 실패 시 원인을 확인할 수 있는 리포트를 남긴다.
- 호스트는 호스트모드 진입까지 검증한다.

진행 상태:

- Slack Socket Mode 연결 완료
- `!qa login` 명령어 구현
- `run_id` 발급 구현
- `request.json`, `result.json` 저장 구현
- Android ADB 실행 구현
- 게스트 로그인 구현
- 호스트 로그인 구현
- 호스트모드 진입 검증 추가 중

완료 기준:

- `!qa login env=staging role=guest` 안정 통과
- `!qa login env=staging role=host` 안정 통과
- 실패 시 스크린샷/XML/log로 원인 파악 가능

### 7.2 2단계: 검색 자동화

목표:

- 앱 홈 화면에서 검색 시나리오를 자동화한다.

예상 명령어:

```text
!qa search env=staging mode=flexible
!qa search env=staging mode=exact
```

검증 항목:

- 검색 진입
- 지역/날짜/조건 입력
- 검색 결과 노출
- 결과 카드 노출 여부
- 검색 실패/빈 결과 예외 처리

### 7.3 3단계: 계약 요청 자동화

목표:

- 게스트 계정으로 숙소 계약 요청 플로우를 자동화한다.

예상 명령어:

```text
!qa booking env=staging accommodation=숙소ID payment=direct
```

검증 항목:

- 숙소 상세 진입
- 계약 요청 시작
- 인원/일정/옵션 입력
- 결제 방식 선택
- 계약 요청 완료
- 계약번호 추출

### 7.4 4단계: 호스트 계약 승인 자동화

목표:

- 호스트 계정으로 계약 요청을 확인하고 승인한다.

예상 명령어:

```text
!qa host-approve env=staging contract=계약번호
```

검증 항목:

- 호스트모드 진입
- 계약 관리 화면 진입
- 대상 계약 검색
- 계약 승인
- 승인 상태 확인

### 7.5 5단계: 결제/입금 자동화

목표:

- 무통장 입금, 승인, 카드 결제 등 결제 흐름을 검증한다.

예상 명령어:

```text
!qa payment env=staging type=bank-transfer contract=계약번호
!qa payment env=staging type=card contract=계약번호
```

검증 항목:

- 결제 화면 진입
- 결제 수단 선택
- 결제 요청
- 결제 완료/승인 상태 확인

### 7.6 6단계: 리뷰 자동화

목표:

- 계약 완료 후 리뷰 작성 가능 여부와 리뷰 작성 플로우를 검증한다.

예상 명령어:

```text
!qa review env=staging contract=계약번호
```

검증 항목:

- 리뷰 작성 진입
- 별점 선택
- 키워드 선택
- 상세 리뷰 작성
- 리뷰 등록
- 리뷰 삭제 또는 작성 불가 케이스 검증

---

## 8. 자동화 진행 순서도

### 8.1 전체 진행 순서

```text
[시작]
  ↓
자동화 대상 시나리오 선정
  ↓
테스트 명령어 정의
  ↓
테스트 요청 파라미터 정의
  ↓
테스트 실행 단계 설계
  ↓
PASS/FAIL 기준 정의
  ↓
ADB/UI dump 기반 구현
  ↓
Slack 명령어 연결
  ↓
실제 단말에서 반복 실행
  ↓
실패 로그/스크린샷 보강
  ↓
안정화 완료?
  ├─ 아니오 -> 실패 원인 분석 후 수정
  └─ 예
      ↓
    Notion 문서 업데이트
      ↓
    다음 시나리오로 확장
```

### 8.2 로그인 자동화 순서도

```text
[Slack 명령 입력]
  ↓
!qa login env=staging role=guest/host
  ↓
run_id 생성
  ↓
단말 lock 획득
  ↓
앱 실행
  ↓
권한/팝업 처리
  ↓
role 확인
  ├─ guest
  │   ↓
  │ 앱 데이터 초기화
  │   ↓
  │ 이메일/비밀번호 로그인
  │   ↓
  │ 홈 화면 확인
  │   ↓
  │ PASS/FAIL
  │
  └─ host
      ↓
    기존 로그인 상태 확인
      ├─ 로그인됨
      │   ↓
      │ 내 정보 탭 이동
      │   ↓
      │ 호스트모드 버튼 탭
      │   ↓
      │ 호스트모드 확인
      │   ↓
      │ PASS/FAIL
      │
      └─ 로그인 안 됨
          ↓
        이메일/비밀번호 로그인
          ↓
        내 정보 탭 이동
          ↓
        호스트모드 버튼 탭
          ↓
        호스트모드 확인
          ↓
        PASS/FAIL
```

### 8.3 실패 처리 순서

```text
[테스트 실패]
  ↓
실패 단계 기록
  ↓
마지막 화면 screenshot 저장
  ↓
UI dump XML 저장
  ↓
runner.log 저장
  ↓
result.json에 error/possible_causes 저장
  ↓
Slack에 FAIL 메시지 전송
  ↓
run_id 기준으로 원인 분석
```

---

## 9. 리포트 설계

### 9.1 request.json

테스트 실행 요청 정보를 저장한다.

예시:

```json
{
  "run_id": "qa-20260720-120000-login-staging-host",
  "test": "login",
  "env": "staging",
  "role": "host",
  "requested_by": "U123456",
  "source": "slack",
  "created_at": "2026-07-20T03:00:00.000Z"
}
```

### 9.2 result.json

테스트 실행 결과를 저장한다.

예시:

```json
{
  "run_id": "qa-20260720-120000-login-staging-host",
  "test_id": "TC-LOGIN-001",
  "name": "host 로그인",
  "env": "staging",
  "status": "pass",
  "device": "R3CR30K439K",
  "duration_ms": 41074,
  "steps": [
    {
      "name": "앱 실행",
      "status": "pass"
    },
    {
      "name": "내 정보 탭 진입",
      "status": "pass"
    },
    {
      "name": "호스트모드 버튼 탭",
      "status": "pass"
    }
  ],
  "artifacts": {
    "report_dir": "reports/qa-20260720-120000-login-staging-host"
  }
}
```

---

## 10. 운영 기준

### 10.1 실행 전 체크리스트

- QA Mac이 켜져 있어야 한다.
- Slack Bot이 실행 중이어야 한다.
- Android 단말 2대가 연결되어 있어야 한다.
- 각 단말에서 USB debugging이 허용되어 있어야 한다.
- `.env`에 Slack token, ADB device ID, 계정 정보가 설정되어 있어야 한다.
- Staging 앱이 설치되어 있어야 한다.

### 10.2 실행 명령어

Slack Bot 실행:

```bash
cd "/Users/liveanywhere_test/Documents/자동화 프로젝트/qa-bot-v2"
caffeinate -i /opt/homebrew/bin/node src/app.js
```

Slack 테스트 명령:

```text
!qa login env=staging role=guest
!qa login env=staging role=host
```

### 10.3 단말 역할

현재 기준:

```text
guest: R3CT80QJ3NL
host: R3CR30K439K
```

역할은 `.env`에서 관리한다.

```text
ADB_GUEST_DEVICE=R3CT80QJ3NL
ADB_HOST_DEVICE=R3CR30K439K
```

---

## 11. 리스크 및 대응 방안

### 11.1 UI 변경 리스크

문제:

- 앱 UI 문구, 버튼 위치, 화면 구조가 바뀌면 자동화가 실패할 수 있다.

대응:

- 좌표보다 UI dump 기반 탐색을 우선 사용한다.
- 실패 시 XML과 스크린샷을 저장한다.
- 버튼 텍스트 변경 시 테스트 탐색 조건을 업데이트한다.

### 11.2 단말 상태 리스크

문제:

- 단말 잠금화면, 권한 팝업, 업데이트 팝업, 네트워크 상태에 따라 실패할 수 있다.

대응:

- 테스트 시작 시 단말 깨우기 수행
- 권한 팝업 자동 처리
- WebView 로딩 대기
- 실패 시 마지막 화면 저장

### 11.3 입력기 리스크

문제:

- 일부 Android 단말은 ADB 입력 시 한글 키보드 영향으로 영문/특수문자가 깨질 수 있다.

대응:

- 삼성 단말처럼 ADB 입력이 안정적인 단말을 우선 사용한다.
- 입력 후 XML에서 실제 입력값 검증
- 장기적으로 ADB Keyboard 또는 Appium 입력 방식 검토

### 11.4 잘못된 PASS 판정 리스크

문제:

- 최근 로그인, 둘러보기, 오류 화면을 성공으로 오판할 수 있다.

대응:

- PASS 기준을 명확히 정의한다.
- 오류 문구가 있으면 무조건 FAIL 처리한다.
- 호스트는 호스트모드 진입까지 확인해야 PASS 처리한다.

---

## 12. 향후 개선 방향

### 12.1 명령어 확장

```text
!qa search env=staging mode=flexible
!qa booking env=staging accommodation=...
!qa host-approve env=staging contract=...
!qa payment env=staging type=...
!qa review env=staging contract=...
```

### 12.2 리포트 개선

- HTML 리포트 생성
- Slack에서 클릭 가능한 리포트 링크 제공
- 실패 단계별 스크린샷 정리
- 최근 실행 목록 조회
- `!qa status run_id=...`
- `!qa rerun run_id=...`

### 12.3 안정성 개선

- Appium 도입 검토
- ADB Keyboard 도입 검토
- 테스트별 retry 정책 분리
- 디바이스 상태 사전 점검 명령 추가
- Slack 사용자 권한 제한

---

## 13. 다음 작업

### 13.1 단기 작업

- host 로그인 후 `내 정보 -> 호스트모드` 전환 안정화
- guest/host 로그인 반복 실행 안정성 확인
- 로그인 자동화 결과를 Notion에 정리
- 실패 케이스별 원인/대응 표 작성

### 13.2 다음 자동화 후보

우선순위:

1. 검색 자동화
2. 계약 요청 자동화
3. 호스트 계약 승인 자동화
4. 결제/입금 자동화
5. 리뷰 자동화

---

## 14. 요약

현재 QA 자동화의 1차 목표는 Slack 명령어로 Staging Android 앱의 게스트/호스트 로그인 테스트를 실행하고, 실행 결과를 `reports/{run_id}`에 저장하는 것이다.

게스트는 이메일/비밀번호 로그인 후 홈 화면 진입을 확인한다.

호스트는 이메일/비밀번호 로그인 또는 기존 로그인 상태 확인 후, `내 정보` 탭에서 `호스트모드` 버튼을 눌러 호스트모드 진입까지 확인해야 최종 PASS로 본다.

이후 검색, 계약, 결제, 리뷰 순서로 자동화 범위를 확장한다.
