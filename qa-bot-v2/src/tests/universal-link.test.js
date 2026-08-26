const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { withDeviceLock } = require("../infra/device-lock");
const { dumpUi, keyEvent, runAdb, screenshotPng: androidScreenshotPng } = require("../infra/adb");
const { launchAppWithUrl } = require("../infra/ios-devicectl");
const {
  createSession,
  releaseSession,
  screenshotPng: iosScreenshotPng
} = require("../infra/ios-wda");
const { waitForUi } = require("./helpers/ui-automation");
const {
  dumpNodes,
  nodeLabel: iosNodeLabel,
  saveNodesSnapshot,
  waitForNodes
} = require("./helpers/ios-automation");

const execFileAsync = promisify(execFile);

function addStep(steps, name, status = "pass", message) {
  const step = { name, status };
  if (message) step.message = message;
  steps.push(step);
}

// 랜덤으로 뽑을 숙소 ID 풀 (앨빈 제공)
const ACCOMMODATION_IDS = [
  30742, 30724, 30759, 30721, 30539, 30769, 29711, 26802, 30756, 30686,
  30757, 30774, 30681, 30737, 30751, 30367, 29611, 29754, 30334, 29816,
  30685, 30348, 29845, 30385, 28348, 30372, 30739, 29770, 30770, 29739,
  30755, 30719, 30754, 30702, 30746, 30722, 30732, 30718, 30246, 30335,
  30738, 30369, 30731, 859, 30697, 30333, 30533, 29728, 30284, 1395,
  30374, 29687, 29614, 93, 196, 29727, 29804, 30094, 30239, 29532,
  30220, 29820, 26319, 14, 29818, 29785, 29724, 29696, 478, 29703,
  442, 29729, 30647, 30384, 30120, 30651, 492, 29694, 29786, 28441,
  29730, 29837, 511, 26784, 29752, 315, 29833, 29458, 29829, 29839,
  24521, 29828, 30241, 29750, 30124, 29753, 29636, 29731, 29776, 30259
];

function pickRandomAccommodationId() {
  return ACCOMMODATION_IDS[Math.floor(Math.random() * ACCOMMODATION_IDS.length)];
}

async function readScreenshotText(screenshotPath) {
  const visionOcrScript = path.join(__dirname, "../../scripts/ocr-image.swift");
  if (process.platform === "darwin" && fs.existsSync(visionOcrScript)) {
    try {
      const { stdout } = await execFileAsync(
        "/usr/bin/swift",
        [visionOcrScript, screenshotPath],
        { maxBuffer: 5 * 1024 * 1024 }
      );
      if (stdout.trim()) return stdout;
    } catch (error) {
      // Vision OCR이 실행되지 않는 호스트에서는 기존 Tesseract 경로로 복구한다.
    }
  }

  const tesseractPath = process.env.TESSERACT_PATH || "tesseract";
  const { stdout } = await execFileAsync(
    tesseractPath,
    [screenshotPath, "stdout", "-l", "eng+snum", "--psm", "6"],
    { maxBuffer: 5 * 1024 * 1024 }
  );
  return stdout;
}

function findAccommodationIds(ocrText) {
  return [...String(ocrText || "").matchAll(/#\s*(\d{1,6})\b/g)]
    .map((match) => match[1]);
}

async function evaluateAccommodationDetail({ xml, screenshotPath, target }) {
  const hasDetailAction = xml.includes("계약 조건 확인");
  if (!hasDetailAction) {
    return {
      status: "fail",
      message: `요청 ID #${target.accommodationId} / 계약 조건 확인 버튼 미노출`
    };
  }

  try {
    const ocrText = await readScreenshotText(screenshotPath);
    const expectedId = String(target.accommodationId);
    const observedIds = findAccommodationIds(ocrText);
    if (observedIds.includes(expectedId)) {
      return {
        status: "pass",
        message: `요청 ID #${expectedId} / 화면 ID #${expectedId} / 계약 조건 확인 노출`,
        observedId: expectedId
      };
    }

    const knownObservedId = observedIds.find((id) =>
      ACCOMMODATION_IDS.includes(Number(id))
    );
    if (!knownObservedId) {
      return {
        status: "needs_review",
        message: `요청 ID #${expectedId} / 화면 ID OCR 인식 불가 / 숙소명 및 ID 수동 확인 필요`
      };
    }

    return {
      status: "fail",
      message: `요청 ID #${expectedId} / 화면 ID #${knownObservedId} / 계약 조건 확인 노출`,
      observedId: knownObservedId
    };
  } catch (error) {
    return {
      status: "needs_review",
      message: `요청 ID #${target.accommodationId} / OCR 실행 불가: ${error.message}`
    };
  }
}

// 고정으로 사용하는 예약/연장 등 ID (앨빈 제공)
const FIXED_IDS = {
  reservationId: "146767",
  extensionId: "862",
  cancelType: "REQUESTED_CANCEL",
  channelUrl: "sendbird_group_channel_94346024_439a38fcc320532fd3157cb960f0ea13f28b9a93",
  eventId: "3",
  postId: "610",
  latitude: "37.3870822",
  longitude: "127.1008908",
  placeName: "수수료",
  step: "SPACE",
  hostId: "21528",
  bankAccountId: "7444",
  businessLicenseId: "1076",
  receiptId: "1912",
  faqId: "149089253",
  autoMessageId: "141"
};

function guestBaseUrl(env) {
  return "https://staging-m.liveanywhere.me";
}

function hostBaseUrl(env) {
  return "https://staging-console.liveanywhere.me";
}

function hostBusinessBaseUrl(env) {
  return "https://staging-biz.liveanywhere.me";
}

function hostFaqBaseUrl(env) {
  return "https://host.liveanywhere.me";
}

function deepLinkBase() {
  // routeEntry가 /로 시작하는 경로를 붙이므로 live1month:// 형태가 된다.
  return "live1month:/";
}

function includesAny(text, signals) {
  return signals.some((signal) => String(text || "").includes(signal));
}

function includesAll(text, signals) {
  const normalized = String(text || "");
  return signals.every((signal) => normalized.includes(signal));
}

function futureDate(days = 30) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

const INPUTS = {
  accessToken: { name: "accessToken", label: "액세스 토큰", required: true, secret: true },
  refreshToken: { name: "refreshToken", label: "리프레시 토큰", required: true, secret: true },
  thirdPartyRefreshToken: { name: "thirdPartyRefreshToken", label: "서드파티 리프레시 토큰", required: true, secret: true },
  channelUrl: { name: "channelUrl", label: "채널 URL", required: true },
  autoMessageId: { name: "autoMessageId", label: "자동 메시지 ID", required: true },
  bankAccountId: { name: "bankAccountId", label: "정산 계좌 ID", required: true },
  businessLicenseId: { name: "businessLicenseId", label: "사업자 ID", required: true },
  receiptId: { name: "receiptId", label: "증빙 ID", required: true }
};

function routeEntry({
  id,
  label,
  route,
  base = guestBaseUrl,
  signals = [],
  signalMatch = "any",
  defaults = {},
  inputs = [],
  manual = false
}) {
  return {
    id,
    label,
    route,
    inputs,
    captureScreenshot: manual,
    buildTarget: (env, supplied = {}) => {
      const values = { ...defaults, ...supplied };
      const missing = inputs.filter((input) => input.required && !String(values[input.name] || "").trim());
      if (missing.length) {
        return {
          skipMessage: `입력값 필요: ${missing.map((input) => input.label).join(", ")}`,
          url: ""
        };
      }
      const rendered = route.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_, key) =>
        encodeURIComponent(values[key] == null ? "" : String(values[key]))
      );
      return { url: `${base(env)}${rendered}` };
    },
    expectedSignals: signals,
    verify: (text) => signals.length > 0 && (signalMatch === "all" ? includesAll(text, signals) : includesAny(text, signals)),
    manual
  };
}

function accommodationEntry({ id, label, suffix = "", signals, base = guestBaseUrl, prefix = "/accommodations" }) {
  return {
    id,
    label,
    route: `${prefix}/:accommodationId${suffix}`,
    buildTarget: (env) => {
      const accommodationId = pickRandomAccommodationId();
      return {
        accommodationId,
        url: `${base(env)}${prefix}/${accommodationId}${suffix}`
      };
    },
    waitUntil: (text) => includesAny(text, signals),
    verify: (text) => includesAny(text, signals)
  };
}

const GUEST_LINK_CATALOG = [
  routeEntry({ id: "guest-home", label: "게스트 홈 탭 이동", route: "/main", signals: ["동네 · 주변 장소로 검색", "동네 주변 장소로 검색"] }),
  routeEntry({ id: "guest-sign-in", label: "로그인 웹뷰", route: "/sign-in", signals: ["로그인", "이메일 혹은 휴대폰 번호"] }),
  routeEntry({ id: "guest-sign-up", label: "회원가입 웹뷰", route: "/sign-up", signals: ["회원가입"] }),
  routeEntry({ id: "guest-reset-password", label: "비밀번호 재설정 웹뷰", route: "/reset-password", signals: ["비밀번호 재설정", "비밀번호"] }),
  routeEntry({ id: "guest-third-party-sign-up", label: "로그인 화면(네이티브)", route: "/third-party-sign-up", signals: ["로그인", "이메일 혹은 휴대폰 번호"] }),
  {
    ...routeEntry({
      id: "guest-third-party-sign-up-info",
      label: "소셜 가입 오류 처리 (USER_CANCELED / REQUEST_FAILED)",
      route: "/third-party-sign-up/info?error=:error",
      signals: ["로그인", "홈", "오류"],
      manual: true
    }),
    buildTarget: (env) => {
      const error = Math.random() < 0.5 ? "USER_CANCELED" : "REQUEST_FAILED";
      return { error, url: `${guestBaseUrl(env)}/third-party-sign-up/info?error=${error}` };
    }
  },
  routeEntry({ id: "guest-account", label: "프로필 화면", route: "/account", signals: ["프로필", "내 정보"] }),
  routeEntry({ id: "guest-member-info", label: "회원 정보 웹뷰", route: "/members/info", signals: ["회원 정보", "내 정보"] }),
  routeEntry({ id: "guest-notification-reception", label: "알림 수신 설정 웹뷰", route: "/members/notification-reception-setting", signals: ["알림", "수신"] }),
  routeEntry({ id: "guest-notification-setting", label: "알림 설정 화면(네이티브)", route: "/notification/setting", signals: ["알림 설정", "알림"] }),
  routeEntry({ id: "guest-member-delete", label: "회원 탈퇴 웹뷰", route: "/members/delete", signals: ["회원 탈퇴", "탈퇴"] }),
  routeEntry({ id: "guest-accommodations", label: "숙소 검색 결과 (기본 필터)", route: "/accommodations", signals: ["개의 집", "필터", "지도로 보기"] }),
  routeEntry({ id: "guest-search-result", label: "숙소 검색 결과 (필터 적용)", route: "/accommodations/search-result", signals: ["개의 집", "필터", "지도로 보기"] }),
  routeEntry({ id: "guest-recent-viewed", label: "최근 본 숙소", route: "/accommodations/recent-viewed", signals: ["최근 본", "최근 본 숙소"] }),
  {
    ...accommodationEntry({ id: "guest-accommodation-detail", label: "숙소 상세", signals: ["계약 조건 확인"] }),
    captureScreenshot: true,
    evaluate: evaluateAccommodationDetail
  },
  accommodationEntry({ id: "guest-accommodation-gallery", label: "숙소 사진 갤러리", suffix: "/gallery", signals: ["사진", "갤러리"] }),
  accommodationEntry({ id: "guest-accommodation-reviews", label: "숙소 리뷰 목록", suffix: "/reviews", signals: ["후기", "리뷰"] }),
  accommodationEntry({ id: "guest-accommodation-reserve", label: "예약 요청 화면", suffix: "/reserve", signals: ["계약 요청", "계약 조건"] }),
  routeEntry({ id: "guest-search", label: "검색 화면", route: "/search", signals: ["위치", "일정", "게스트"] }),
  routeEntry({ id: "guest-search-summary", label: "검색 요약 화면", route: "/search-summary", signals: ["위치", "일정", "인원"] }),
  routeEntry({ id: "guest-member-reservations", label: "내 예약 탭 (/members)", route: "/members/reservations", signals: ["계약", "진행 중인 계약"] }),
  routeEntry({ id: "guest-reservations", label: "내 예약 탭 (/reservations)", route: "/reservations", signals: ["계약", "진행 중인 계약"] }),
  routeEntry({ id: "guest-member-reservation-detail", label: "예약 상세 (/members)", route: "/members/reservations/:reservationId", defaults: { reservationId: FIXED_IDS.reservationId }, signals: ["계약 번호", "계약 상세", "계약 연장"] }),
  routeEntry({ id: "guest-reservation-detail", label: "예약 상세 (/reservations)", route: "/reservations/:reservationId", defaults: { reservationId: FIXED_IDS.reservationId }, signals: ["계약 번호", "계약 상세", "계약 연장"] }),
  routeEntry({ id: "guest-member-extension-request", label: "예약 연장 요청 (/members)", route: "/members/reservations/:reservationId/extension?end-date=:endDate", defaults: { reservationId: FIXED_IDS.reservationId, endDate: futureDate() }, signals: ["계약 연장", "연장 퇴실일"] }),
  routeEntry({ id: "guest-extension-request", label: "예약 연장 요청 (/reservations)", route: "/reservations/:reservationId/extension?end-date=:endDate", defaults: { reservationId: FIXED_IDS.reservationId, endDate: futureDate() }, signals: ["계약 연장", "연장 퇴실일"] }),
  routeEntry({ id: "guest-member-extension-detail", label: "예약 연장 상세 (/members)", route: "/members/reservations/:reservationId/extension/:extensionId", defaults: FIXED_IDS, signals: ["계약 연장", "연장 요청"] }),
  routeEntry({ id: "guest-extension-detail", label: "예약 연장 상세 (/reservations)", route: "/reservations/:reservationId/extension/:extensionId", defaults: FIXED_IDS, signals: ["계약 연장", "연장 요청"] }),
  routeEntry({ id: "guest-member-extension-payment", label: "예약 연장 결제 (/members)", route: "/members/reservations/:reservationId/extension/:extensionId/payment", defaults: FIXED_IDS, signals: ["결제하기", "결제"] }),
  routeEntry({ id: "guest-extension-payment", label: "예약 연장 결제 (/reservations)", route: "/reservations/:reservationId/extension/:extensionId/payment", defaults: FIXED_IDS, signals: ["결제하기", "결제"] }),
  routeEntry({ id: "guest-reservation-cancel", label: "예약 취소 화면", route: "/members/reservations/:reservationId/cancel?page-type=:cancelType", defaults: FIXED_IDS, signals: ["계약 요청 취소", "계약 취소", "취소"] })
];

function hostPair(key, label, route, options = {}) {
  return [
    routeEntry({ id: `host-${key}-alias`, label: `${label} (${route})`, route, base: hostBaseUrl, ...options }),
    routeEntry({ id: `host-${key}`, label: `${label} (/host${route === "/" ? "" : route})`, route: route === "/" ? "/host" : `/host${route}`, base: hostBaseUrl, ...options })
  ];
}

const HOST_LINK_CATALOG = [
  routeEntry({ id: "host-home-root", label: "호스트 홈 탭 (/)", route: "/", base: hostBaseUrl, signals: ["할 일", "수락이 필요한 계약", "호스트"] }),
  routeEntry({ id: "host-home", label: "호스트 홈 탭 (/host)", route: "/host", base: hostBaseUrl, signals: ["할 일", "수락이 필요한 계약", "호스트"] }),
  ...hostPair("mypage", "호스트 마이페이지 탭", "/mypage", { signals: ["내 정보", "마이페이지"] }),
  ...hostPair("settlement", "정산 화면", "/settlement", { signals: ["정산"] }),
  ...hostPair("settlement-information", "정산 정보", "/settlement/information", { signals: ["정산 정보", "정산"] }),
  ...hostPair("settlement-info", "정산 정보", "/settlementInfo", { signals: ["정산 정보", "정산"] }),
  ...hostPair("messages", "호스트 메시지 탭", "/messages", { signals: ["메시지", "채팅"] }),
  ...hostPair("auto-messages", "자동 메시지 목록", "/message/auto-messages", { signals: ["자동 메시지"] }),
  ...hostPair("auto-message-add", "자동 메시지 추가", "/message/auto-messages/add", { signals: ["자동 메시지", "추가"] }),
  ...hostPair("auto-message-edit", "자동 메시지 수정", "/message/auto-messages/:autoMessageId", { signals: ["자동 메시지", "수정"], defaults: FIXED_IDS }),
  ...hostPair("chat", "호스트 메시지 탭", "/chat", { signals: ["메시지", "채팅"] }),
  ...hostPair("chat-channels", "호스트 메시지 탭", "/chat/channels", { signals: ["메시지", "채팅"] }),
  ...hostPair("chat-channels-host", "호스트 메시지 탭", "/chat/channels/host", { signals: ["메시지", "채팅"] }),
  ...hostPair("chat-channel", "채팅 채널", "/chat/channels/:channelUrl", { signals: ["메시지", "채팅"], defaults: FIXED_IDS }),
  ...hostPair("accommodations", "호스트 숙소 탭", "/accommodations", { signals: ["집 목록", "숙소"] }),
  ...hostPair("accommodation-register", "집 등록", "/accommodations/register", { base: hostBusinessBaseUrl, signals: ["집 등록", "숙소 등록"] }),
  ...hostPair("accommodation-register-edit", "집 수정 (단계 진입)", "/accommodations/register/:accommodationId?step=:step", { base: hostBusinessBaseUrl, defaults: { ...FIXED_IDS, accommodationId: pickRandomAccommodationId() }, signals: ["집 수정", "숙소 정보"] }),
  ...hostPair("accommodation-detail", "집 수정", "/accommodations/:accommodationId", { base: hostBusinessBaseUrl, defaults: { accommodationId: pickRandomAccommodationId() }, signals: ["집 수정", "숙소 정보", "달력"] }),
  ...hostPair("accommodation-calendar", "숙소 캘린더", "/accommodations/:accommodationId/calendar", { defaults: { accommodationId: pickRandomAccommodationId() }, signals: ["달력", "예약"] }),
  ...hostPair("reservations", "호스트 예약 탭", "/reservations", { signals: ["계약 관리", "계약 요청"] }),
  ...hostPair("reservation-detail", "호스트 예약 상세", "/reservations/:reservationId", { defaults: FIXED_IDS, signals: ["계약 번호", "계약 상세", "연장 요청"] }),
  ...hostPair("reservation-extension", "호스트 예약 연장 상세", "/reservations/:reservationId/extension/:extensionId", { defaults: FIXED_IDS, signals: ["계약 연장", "연장 요청"] }),
  ...hostPair("reservation-extension-singular", "호스트 예약 연장 상세 (단수형)", "/reservation/:reservationId/extension/:extensionId", { defaults: FIXED_IDS, signals: ["계약 연장", "연장 요청"] }),
  ...hostPair("reviews", "호스트 리뷰 목록", "/reviews", { signals: ["리뷰", "후기"] }),
  ...hostPair("review", "호스트 리뷰 목록", "/review", { signals: ["리뷰", "후기"] }),
  ...hostPair("faq", "호스트 FAQ 목록", "/faq", { signals: ["FAQ", "자주 묻는 질문"] }),
  routeEntry({ id: "host-faq-detail", label: "FAQ 상세 (host.liveanywhere.me)", route: "/faq/?q=YToxOntzOjEyOiJrZXl3b3JkX3R5cGUiO3M6MzoiYWxsIjt9&bmode=view&idx=:faqId&t=board", base: hostFaqBaseUrl, defaults: FIXED_IDS, signals: ["FAQ", "자주 묻는 질문"], manual: true }),
  ...hostPair("notice", "호스트 공지사항", "/notice", { signals: ["공지사항", "공지"] }),
  ...hostPair("foreign-guide", "외국인 게스트 가이드", "/foreign-guide", { signals: ["외국인", "가이드"] }),
  ...hostPair("bank-account-register", "정산 계좌 등록", "/settlementInfo/bankAccount/register", { signals: ["계좌 등록", "정산 계좌"] }),
  ...hostPair("bank-account-edit", "정산 계좌 수정", "/settlementInfo/bankAccount/:bankAccountId/edit?hostId=:hostId", { signals: ["계좌 수정", "정산 계좌"], defaults: FIXED_IDS }),
  ...hostPair("business-license-register", "사업자등록증 등록", "/settlementInfo/businessLicense/register", { signals: ["사업자등록증", "사업자"] }),
  ...hostPair("business-license-edit", "사업자등록증 수정", "/settlementInfo/businessLicense/:businessLicenseId/edit?hostId=:hostId", { signals: ["사업자등록증", "사업자"], defaults: FIXED_IDS }),
  ...hostPair("receipt-register", "증빙(영수증) 등록", "/settlementInfo/receipt/register", { signals: ["증빙", "영수증"] }),
  ...hostPair("receipt-edit", "증빙(영수증) 수정", "/settlementInfo/receipt/:receiptId/edit?hostId=:hostId", { signals: ["증빙", "영수증"], defaults: FIXED_IDS })
];

function deepRouteEntry(options) {
  return routeEntry({ ...options, base: deepLinkBase });
}

function deepAccommodationEntry(options) {
  return accommodationEntry({ ...options, base: deepLinkBase });
}

// 첨부된 게스트 딥링크 명세의 순서를 그대로 유지한다.
const GUEST_DEEP_LINK_CATALOG = [
  deepRouteEntry({ id: "deep-guest-home", label: "게스트 홈 탭", route: "/main", signals: ["동네 · 주변 장소로 검색", "동네 주변 장소로 검색"] }),
  deepRouteEntry({
    id: "deep-guest-third-party-sign-up",
    label: "로그인 화면(네이티브)",
    route: "/third-party-sign-up",
    signals: ["이메일 혹은 휴대폰 번호", "비밀번호"],
    signalMatch: "all"
  }),
  deepRouteEntry({ id: "deep-guest-account", label: "프로필 화면", route: "/account", signals: ["프로필", "내 정보"] }),
  deepRouteEntry({ id: "deep-guest-notification-setting", label: "알림 설정 화면(네이티브)", route: "/notification/setting", signals: ["알림 설정", "알림"] }),
  deepRouteEntry({ id: "deep-guest-accommodations", label: "숙소 검색 결과 (기본 필터)", route: "/accommodations", signals: ["개의 집", "필터", "지도로 보기"] }),
  deepRouteEntry({ id: "deep-guest-search-result", label: "숙소 검색 결과 (필터 적용)", route: "/accommodations/search-result", signals: ["개의 집", "필터", "지도로 보기"] }),
  deepRouteEntry({ id: "deep-guest-recent-viewed", label: "최근 본 숙소", route: "/accommodations/recent-viewed", signals: ["최근 본", "최근 본 숙소"] }),
  {
    ...deepAccommodationEntry({ id: "deep-guest-accommodation-detail", label: "숙소 상세", signals: ["계약 조건 확인"] }),
    captureScreenshot: true,
    evaluate: evaluateAccommodationDetail
  },
  deepAccommodationEntry({ id: "deep-guest-accommodation-reviews", label: "숙소 리뷰 목록", suffix: "/reviews", signals: ["후기", "리뷰"] }),
  deepRouteEntry({ id: "deep-guest-search", label: "검색 화면", route: "/search", signals: ["위치", "일정", "게스트"] }),
  deepRouteEntry({ id: "deep-guest-search-summary", label: "검색 요약 화면", route: "/search-summary", signals: ["위치", "일정", "인원"] }),
  deepRouteEntry({ id: "deep-guest-event-detail", label: "이벤트 상세", route: "/events/:eventId", defaults: FIXED_IDS, signals: ["이벤트"], manual: true }),
  deepRouteEntry({ id: "deep-guest-member-reservations", label: "내 예약 탭 (/members)", route: "/members/reservations", signals: ["계약", "진행 중인 계약"] }),
  deepRouteEntry({ id: "deep-guest-reservations", label: "내 예약 탭 (/reservations)", route: "/reservations", signals: ["계약", "진행 중인 계약"] }),
  deepRouteEntry({ id: "deep-guest-member-reservation-detail", label: "예약 상세 (/members)", route: "/members/reservations/:reservationId", defaults: FIXED_IDS, signals: ["계약 번호", "계약 상세", "계약 연장"] }),
  deepRouteEntry({ id: "deep-guest-reservation-detail", label: "예약 상세 (/reservations)", route: "/reservations/:reservationId", defaults: FIXED_IDS, signals: ["계약 번호", "계약 상세", "계약 연장"] }),
  deepRouteEntry({ id: "deep-guest-member-extension-request", label: "예약 연장 요청 (/members)", route: "/members/reservations/:reservationId/extension?end-date=:endDate", defaults: { ...FIXED_IDS, endDate: futureDate() }, signals: ["계약 연장", "연장 퇴실일"] }),
  deepRouteEntry({ id: "deep-guest-extension-request", label: "예약 연장 요청 (/reservations)", route: "/reservations/:reservationId/extension?end-date=:endDate", defaults: { ...FIXED_IDS, endDate: futureDate() }, signals: ["계약 연장", "연장 퇴실일"] }),
  deepRouteEntry({ id: "deep-guest-member-extension-detail", label: "예약 연장 상세 (/members)", route: "/members/reservations/:reservationId/extension/:extensionId", defaults: FIXED_IDS, signals: ["계약 연장", "연장 요청"] }),
  deepRouteEntry({ id: "deep-guest-extension-detail", label: "예약 연장 상세 (/reservations)", route: "/reservations/:reservationId/extension/:extensionId", defaults: FIXED_IDS, signals: ["계약 연장", "연장 요청"] }),
  deepRouteEntry({ id: "deep-guest-member-extension-payment", label: "예약 연장 결제 (/members)", route: "/members/reservations/:reservationId/extension/:extensionId/payment", defaults: FIXED_IDS, signals: ["결제하기", "결제"] }),
  deepRouteEntry({ id: "deep-guest-extension-payment", label: "예약 연장 결제 (/reservations)", route: "/reservations/:reservationId/extension/:extensionId/payment", defaults: FIXED_IDS, signals: ["결제하기", "결제"] }),
  deepRouteEntry({ id: "deep-guest-member-check-in", label: "예약 상세 + 입주 확인 다이얼로그 (/members)", route: "/members/reservations/:reservationId/check-in", defaults: FIXED_IDS, signals: ["입주", "체크인"] }),
  deepRouteEntry({ id: "deep-guest-check-in", label: "예약 상세 + 입주 확인 다이얼로그 (/reservations)", route: "/reservations/:reservationId/check-in", defaults: FIXED_IDS, signals: ["입주", "체크인"] }),
  deepRouteEntry({ id: "deep-guest-member-check-out", label: "예약 상세 + 퇴실 확인 다이얼로그 (/members)", route: "/members/reservations/:reservationId/check-out", defaults: FIXED_IDS, signals: ["퇴실", "체크아웃"] }),
  deepRouteEntry({ id: "deep-guest-check-out", label: "예약 상세 + 퇴실 확인 다이얼로그 (/reservations)", route: "/reservations/:reservationId/check-out", defaults: FIXED_IDS, signals: ["퇴실", "체크아웃"] }),
  deepRouteEntry({ id: "deep-guest-member-write-review", label: "리뷰 작성 화면 (/members)", route: "/members/reservations/:reservationId/write-review", defaults: FIXED_IDS, signals: ["리뷰 작성", "머무는 동안"] }),
  deepRouteEntry({ id: "deep-guest-write-review", label: "리뷰 작성 화면 (/reservations)", route: "/reservations/:reservationId/write-review", defaults: FIXED_IDS, signals: ["리뷰 작성", "머무는 동안"] }),
  deepRouteEntry({ id: "deep-guest-member-reviews", label: "내 리뷰 목록 (/members)", route: "/members/reviews", signals: ["내 리뷰", "리뷰"] }),
  deepRouteEntry({ id: "deep-guest-reviews", label: "내 리뷰 목록 (/reviews)", route: "/reviews", signals: ["내 리뷰", "리뷰"] }),
  deepRouteEntry({ id: "deep-guest-member-edit-review", label: "리뷰 수정 화면 (/members)", route: "/members/reviews/:reservationId/edit-review", defaults: FIXED_IDS, signals: ["리뷰 수정", "저장"] }),
  deepRouteEntry({ id: "deep-guest-edit-review", label: "리뷰 수정 화면 (/reviews)", route: "/reviews/:reservationId/edit-review", defaults: FIXED_IDS, signals: ["리뷰 수정", "저장"] }),
  deepRouteEntry({ id: "deep-guest-member-wishlist", label: "찜 탭 (/members/wishlist)", route: "/members/wishlist", signals: ["찜"] }),
  deepRouteEntry({ id: "deep-guest-favorites", label: "찜 탭 (/favorites)", route: "/favorites", signals: ["찜"] }),
  deepRouteEntry({ id: "deep-guest-chat", label: "게스트 메시지 목록 (/chat)", route: "/chat", signals: ["메시지", "채팅"] }),
  deepRouteEntry({ id: "deep-guest-chat-channel-query", label: "해당 채팅 채널 화면", route: "/chat?channel-url=:channelUrl", defaults: FIXED_IDS, signals: ["메시지", "채팅"] }),
  deepRouteEntry({ id: "deep-guest-chat-channels", label: "게스트 메시지 목록 (/chat/channels)", route: "/chat/channels", signals: ["메시지", "채팅"] }),
  deepRouteEntry({ id: "deep-guest-chat-channels-guest", label: "게스트 메시지 목록 (/chat/channels/guest)", route: "/chat/channels/guest", signals: ["메시지", "채팅"] }),
  deepRouteEntry({ id: "deep-guest-chat-channels-host", label: "호스트 메시지 탭 (모드 전환)", route: "/chat/channels/host", signals: ["메시지", "채팅", "호스트"] }),
  deepRouteEntry({ id: "deep-guest-inbox", label: "알림함", route: "/inbox", signals: ["알림"] }),
  deepRouteEntry({ id: "deep-guest-posts", label: "피드 탭", route: "/posts", signals: ["리브후기", "후기"] }),
  deepRouteEntry({ id: "deep-guest-post-detail", label: "포스트 상세", route: "/posts/:postId", defaults: FIXED_IDS, signals: ["리브후기", "후기"] }),
  deepRouteEntry({ id: "deep-guest-feeds", label: "피드 탭 (/feeds)", route: "/feeds", signals: ["리브후기", "후기"] }),
  deepRouteEntry({ id: "deep-guest-my-posts", label: "내 게시글 목록", route: "/feeds/my-posts", signals: ["내 게시글", "리브후기"] }),
  deepRouteEntry({ id: "deep-guest-banners", label: "배너 목록", route: "/banners", signals: ["배너", "이벤트"], manual: true }),
  deepRouteEntry({ id: "deep-guest-mypage", label: "마이페이지 탭", route: "/mypage", signals: ["내 정보", "마이페이지"] }),
  deepRouteEntry({ id: "deep-guest-mypage-coupons", label: "내 쿠폰함 (/mypage)", route: "/mypage/coupons", signals: ["쿠폰"] }),
  deepRouteEntry({ id: "deep-guest-my-page-coupons", label: "내 쿠폰함 (/my-page)", route: "/my-page/coupons", signals: ["쿠폰"] }),
  deepRouteEntry({ id: "deep-guest-payment-manage", label: "결제수단 관리", route: "/mypage/payment-manage", signals: ["결제수단", "카드"] }),
  deepRouteEntry({ id: "deep-guest-register-payment-card", label: "카드 등록 화면", route: "/register-payment-card", signals: ["카드 등록", "결제"] }),
  deepRouteEntry({ id: "deep-guest-faq", label: "게스트 FAQ", route: "/faq", signals: ["FAQ", "자주 묻는 질문"] }),
  deepRouteEntry({ id: "deep-guest-notice", label: "게스트 공지사항", route: "/notice", signals: ["공지사항", "공지"] }),
  deepRouteEntry({ id: "deep-guest-host-inquiry", label: "호스트 등록 문의", route: "/host-registration-inquiry", signals: ["호스트", "문의"] }),
  deepRouteEntry({ id: "deep-guest-host-registration", label: "호스트 등록 화면(네이티브)", route: "/host-registration", signals: ["호스트 등록", "호스트"] }),
  deepRouteEntry({ id: "deep-guest-help", label: "헬프 채팅 (1:1 문의)", route: "/help", signals: ["문의", "채팅"] }),
  deepRouteEntry({ id: "deep-guest-terms", label: "이용약관 화면(네이티브)", route: "/terms-of-use", signals: ["이용약관", "약관"] }),
  deepRouteEntry({ id: "deep-guest-privacy", label: "개인정보처리방침 화면(네이티브)", route: "/privacy-policy", signals: ["개인정보처리방침", "개인정보"] }),
  deepRouteEntry({ id: "deep-guest-proxy-mediate", label: "이벤트 쿠폰 발급 중개 화면", route: "/proxy/mediate?request-url=:requestUrl&redirect-url=:redirectUrl", defaults: { requestUrl: "https://staging-m.liveanywhere.me/events/3", redirectUrl: "https://staging-m.liveanywhere.me/main" }, signals: ["이벤트", "쿠폰"], manual: true }),
  deepRouteEntry({ id: "deep-guest-webview", label: "지정 URL 웹뷰", route: "/webview?url=:webviewUrl&title=:title&show-app-bar=true", defaults: { webviewUrl: "https://staging-m.liveanywhere.me/main", title: "딥링크 검증" }, signals: ["딥링크 검증", "동네 · 주변 장소로 검색"], manual: true }),
  deepRouteEntry({ id: "deep-guest-identity-verification", label: "외국인 본인인증 확인 화면", route: "/identity-verification", signals: ["본인인증", "인증"], manual: true }),
  deepRouteEntry({ id: "deep-guest-test-route", label: "딥링크 테스트 화면", route: "/deeplink/main", signals: ["딥링크", "테스트"], manual: true })
];

// 첨부된 호스트 딥링크 명세의 순서를 그대로 유지한다.
const HOST_DEEP_LINK_CATALOG = [
  deepRouteEntry({ id: "deep-host-home", label: "호스트 홈 탭", route: "/host", signals: ["할 일", "수락이 필요한 계약", "호스트"] }),
  deepRouteEntry({ id: "deep-host-mypage", label: "호스트 마이페이지 탭", route: "/host/mypage", signals: ["내 정보", "마이페이지"] }),
  deepRouteEntry({ id: "deep-host-settlement", label: "정산 화면", route: "/host/settlement", signals: ["정산"] }),
  deepRouteEntry({ id: "deep-host-settlement-information", label: "정산 정보 (/information)", route: "/host/settlement/information", signals: ["정산 정보", "정산"] }),
  deepRouteEntry({ id: "deep-host-settlement-info", label: "정산 정보 (/settlementInfo)", route: "/host/settlementInfo", signals: ["정산 정보", "정산"] }),
  deepRouteEntry({ id: "deep-host-messages", label: "호스트 메시지 탭 (/messages)", route: "/host/messages", signals: ["메시지", "채팅"] }),
  deepRouteEntry({ id: "deep-host-auto-messages", label: "자동 메시지 목록", route: "/host/message/auto-messages", signals: ["자동 메시지"] }),
  deepRouteEntry({ id: "deep-host-auto-message-add", label: "자동 메시지 추가", route: "/host/message/auto-messages/add", signals: ["자동 메시지", "추가"] }),
  deepRouteEntry({ id: "deep-host-auto-message-edit", label: "자동 메시지 수정", route: "/host/message/auto-messages/:autoMessageId", defaults: FIXED_IDS, signals: ["자동 메시지", "수정"] }),
  deepRouteEntry({ id: "deep-host-chat", label: "호스트 메시지 탭 (/chat)", route: "/host/chat", signals: ["메시지", "채팅"] }),
  deepRouteEntry({ id: "deep-host-chat-channels", label: "호스트 메시지 탭 (/chat/channels)", route: "/host/chat/channels", signals: ["메시지", "채팅"] }),
  deepRouteEntry({ id: "deep-host-chat-channels-host", label: "호스트 메시지 탭 (/chat/channels/host)", route: "/host/chat/channels/host", signals: ["메시지", "채팅"] }),
  deepRouteEntry({ id: "deep-host-chat-channel", label: "채팅 채널", route: "/host/chat/channels/:channelUrl", defaults: FIXED_IDS, signals: ["메시지", "채팅"] }),
  deepRouteEntry({ id: "deep-host-accommodations", label: "호스트 숙소 탭", route: "/host/accommodations", signals: ["집 목록", "숙소"] }),
  deepRouteEntry({ id: "deep-host-accommodation-register", label: "집 등록", route: "/host/accommodations/register", signals: ["집 등록", "숙소 등록"] }),
  deepRouteEntry({ id: "deep-host-accommodation-register-edit", label: "집 수정 (단계 진입)", route: "/host/accommodations/register/:accommodationId?step=:step", defaults: { ...FIXED_IDS, accommodationId: pickRandomAccommodationId() }, signals: ["집 수정", "숙소 정보"] }),
  deepRouteEntry({ id: "deep-host-accommodation-detail", label: "집 수정", route: "/host/accommodations/:accommodationId", defaults: { accommodationId: pickRandomAccommodationId() }, signals: ["집 수정", "숙소 정보", "달력"] }),
  deepRouteEntry({ id: "deep-host-accommodation-calendar", label: "숙소 캘린더", route: "/host/accommodations/:accommodationId/calendar", defaults: { accommodationId: pickRandomAccommodationId() }, signals: ["달력", "예약"] }),
  deepRouteEntry({ id: "deep-host-reservations", label: "호스트 예약 탭", route: "/host/reservations", signals: ["계약 관리", "계약 요청"] }),
  deepRouteEntry({ id: "deep-host-reservation-detail", label: "호스트 예약 상세", route: "/host/reservations/:reservationId", defaults: FIXED_IDS, signals: ["계약 번호", "계약 상세", "연장 요청"] }),
  deepRouteEntry({ id: "deep-host-reservation-extension", label: "호스트 예약 연장 상세", route: "/host/reservations/:reservationId/extension/:extensionId", defaults: FIXED_IDS, signals: ["계약 연장", "연장 요청"] }),
  deepRouteEntry({ id: "deep-host-reservation-extension-singular", label: "호스트 예약 연장 상세 (단수형)", route: "/host/reservation/:reservationId/extension/:extensionId", defaults: FIXED_IDS, signals: ["계약 연장", "연장 요청"] }),
  deepRouteEntry({ id: "deep-host-reviews", label: "호스트 리뷰 목록 (/reviews)", route: "/host/reviews", signals: ["리뷰", "후기"] }),
  deepRouteEntry({ id: "deep-host-review", label: "호스트 리뷰 목록 (/review)", route: "/host/review", signals: ["리뷰", "후기"] }),
  deepRouteEntry({ id: "deep-host-faq", label: "호스트 FAQ 목록", route: "/host/faq", signals: ["FAQ", "자주 묻는 질문"] }),
  deepRouteEntry({ id: "deep-host-faq-query", label: "FAQ 상세 (?idx)", route: "/host/faq?idx=:faqId", defaults: FIXED_IDS, signals: ["FAQ", "자주 묻는 질문"], manual: true }),
  deepRouteEntry({ id: "deep-host-faq-path", label: "FAQ 상세 (/faq/{글번호})", route: "/host/faq/:faqId", defaults: FIXED_IDS, signals: ["FAQ", "자주 묻는 질문"], manual: true }),
  deepRouteEntry({ id: "deep-host-notice", label: "호스트 공지사항", route: "/host/notice", signals: ["공지사항", "공지"] }),
  deepRouteEntry({ id: "deep-host-foreign-guide", label: "외국인 게스트 가이드", route: "/host/foreign-guide", signals: ["외국인", "가이드"] }),
  deepRouteEntry({ id: "deep-host-bank-account-register", label: "정산 계좌 등록", route: "/host/settlementInfo/bankAccount/register", signals: ["계좌 등록", "정산 계좌"] }),
  deepRouteEntry({ id: "deep-host-bank-account-edit", label: "정산 계좌 수정", route: "/host/settlementInfo/bankAccount/:bankAccountId/edit", defaults: FIXED_IDS, signals: ["계좌 수정", "정산 계좌"] }),
  deepRouteEntry({ id: "deep-host-business-license-register", label: "사업자등록증 등록", route: "/host/settlementInfo/businessLicense/register", signals: ["사업자등록증", "사업자"] }),
  deepRouteEntry({ id: "deep-host-business-license-edit", label: "사업자등록증 수정", route: "/host/settlementInfo/businessLicense/:businessLicenseId/edit", defaults: FIXED_IDS, signals: ["사업자등록증", "사업자"] }),
  deepRouteEntry({ id: "deep-host-receipt-register", label: "증빙(영수증) 등록", route: "/host/settlementInfo/receipt/register", signals: ["증빙", "영수증"] }),
  deepRouteEntry({ id: "deep-host-receipt-edit", label: "증빙(영수증) 수정", route: "/host/settlementInfo/receipt/:receiptId/edit", defaults: FIXED_IDS, signals: ["증빙", "영수증"] })
];

function catalogForRole(role) {
  return role === "host" ? HOST_LINK_CATALOG : GUEST_LINK_CATALOG;
}

function deepLinkCatalogForRole(role) {
  return role === "host" ? HOST_DEEP_LINK_CATALOG : GUEST_DEEP_LINK_CATALOG;
}

function iosNodesText(nodes) {
  return nodes.map(iosNodeLabel).filter(Boolean).join("\n");
}

function createTarget(entry, env) {
  return entry.buildTarget ? entry.buildTarget(env) : { url: entry.buildUrl(env) };
}

async function evaluateEntry(entry, target, pageText, screenshotPath) {
  if (typeof entry.evaluate === "function") {
    return screenshotPath
      ? entry.evaluate({ xml: pageText, screenshotPath, target })
      : {
          status: "needs_review",
          message: `요청 ID #${target.accommodationId} / 화면 캡처 실패`
        };
  }

  if (entry.verify(pageText)) return { status: "pass" };
  if (entry.manual) {
    return {
      status: "needs_review",
      message: "자동 판정에 필요한 화면 텍스트가 없어 수동 확인이 필요합니다."
    };
  }
  return {
    status: "fail",
    message: entry.expectedSignals?.length
      ? `목표 화면 신호 미확인: ${entry.expectedSignals.join(" / ")}`
      : "목표 화면으로 이동한 증거를 확인하지 못했습니다."
  };
}

async function wakeAndUnlock(config, device, steps, store) {
  await keyEvent(config, device, 224);
  let wasLocked = false;
  try {
    const windowState = await runAdb(config, device, ["shell", "dumpsys", "window"]);
    wasLocked = /mDreamingLockscreen=true|mShowingLockscreen=true|isStatusBarKeyguard=true/.test(windowState);
  } catch (error) {
    store.appendLog("runner.log", `keyguard state check failed: ${error.message}`);
  }

  await runAdb(config, device, ["shell", "wm", "dismiss-keyguard"]).catch((error) => {
    store.appendLog("runner.log", `dismiss-keyguard failed: ${error.message}`);
  });

  if (wasLocked) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "2200", "540", "600", "300"]);
    store.appendLog("runner.log", "wakeAndUnlock sent unlock swipe because keyguard was visible");
  } else {
    store.appendLog("runner.log", "wakeAndUnlock skipped unlock swipe because device was already usable");
  }

  await new Promise((resolve) => setTimeout(resolve, wasLocked ? 500 : 250));
  addStep(steps, "단말 깨우기 및 잠금 해제 시도");
}

async function openUniversalLink(config, device, appPackage, url) {
  await runAdb(config, device, [
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    url,
    appPackage
  ]);
}

async function runOneAndroidLink(config, device, appPackage, store, entry, env) {
  const target = createTarget(entry, env);
  const url = target.url;
  const steps = [];

  await wakeAndUnlock(config, device, steps, store);

  addStep(steps, `${entry.label} 링크 열기`, "pass", url);

  await openUniversalLink(config, device, appPackage, url);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const waitPredicate = entry.waitUntil || entry.verify || (() => true);
  const xml = await waitForUi(
    config,
    device,
    waitPredicate,
    entry.waitUntil || typeof entry.verify === "function" ? 8000 : 3000
  ).catch(() => dumpUi(config, device));

  const logPath = path.join(store.logsDir, `${entry.id}.xml`);
  fs.writeFileSync(logPath, xml);

  let screenshotPath = null;
  if (entry.captureScreenshot) {
    try {
      const png = await androidScreenshotPng(config, device);
      screenshotPath = path.join(store.screenshotsDir, `${entry.id}.png`);
      fs.writeFileSync(screenshotPath, png);
    } catch (error) {
      store.appendLog("runner.log", `screenshot failed for ${entry.id}: ${error.message}`);
    }
  }

  const evaluation = await evaluateEntry(entry, target, xml, screenshotPath);

  const status = evaluation.status;
  if (status !== "pass") {
    if (!screenshotPath) {
      try {
        const png = await androidScreenshotPng(config, device);
        screenshotPath = path.join(store.screenshotsDir, `${entry.id}-${status}.png`);
        fs.writeFileSync(screenshotPath, png);
      } catch (error) {
        store.appendLog("runner.log", `screenshot failed for ${entry.id}: ${error.message}`);
      }
    }
  }

  return {
    id: entry.id,
    label: entry.label,
    url,
    status,
    message: evaluation.message,
    expected_accommodation_id: target.accommodationId,
    observed_accommodation_id: evaluation.observedId,
    screenshotPath
  };
}

async function runOneIosLink(config, device, wdaUrl, bundleId, store, entry, env) {
  const target = createTarget(entry, env);
  const url = target.url;
  const steps = [];
  let sessionId;

  addStep(steps, `${entry.label} 링크 열기`, "pass", url);
  await launchAppWithUrl(device, bundleId, url);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  try {
    sessionId = await createSession(wdaUrl, bundleId);
    const waitPredicate = entry.waitUntil || entry.verify || (() => true);
    const nodes = await waitForNodes(
      wdaUrl,
      sessionId,
      (candidate) => waitPredicate(iosNodesText(candidate)),
      entry.waitUntil || typeof entry.verify === "function" ? 8000 : 3000
    ).catch(() => dumpNodes(wdaUrl, sessionId));
    const pageText = iosNodesText(nodes);
    const logPath = saveNodesSnapshot(store, entry.id, nodes);

    let screenshotPath = null;
    if (entry.captureScreenshot) {
      try {
        screenshotPath = path.join(store.screenshotsDir, `${entry.id}.png`);
        fs.writeFileSync(screenshotPath, await iosScreenshotPng(wdaUrl, sessionId));
      } catch (error) {
        store.appendLog("runner.log", `iOS screenshot failed for ${entry.id}: ${error.message}`);
      }
    }

    const evaluation = await evaluateEntry(entry, target, pageText, screenshotPath);
    if (evaluation.status !== "pass" && !screenshotPath) {
      try {
        screenshotPath = path.join(store.screenshotsDir, `${entry.id}-${evaluation.status}.png`);
        fs.writeFileSync(screenshotPath, await iosScreenshotPng(wdaUrl, sessionId));
      } catch (error) {
        store.appendLog("runner.log", `iOS screenshot failed for ${entry.id}: ${error.message}`);
      }
    }

    return {
      id: entry.id,
      label: entry.label,
      url,
      status: evaluation.status,
      message: evaluation.message,
      expected_accommodation_id: target.accommodationId,
      observed_accommodation_id: evaluation.observedId,
      screenshotPath,
      logPath
    };
  } finally {
    if (sessionId) await releaseSession(wdaUrl, sessionId);
  }
}

async function runLinkValidationTest(
  { request, config, store },
  { kind, catalogResolver, androidTestId, iosTestId, summaryKey }
) {
  const env = request.env || "staging";
  const role = request.role || "guest";
  const platform = request.platform === "ios" ? "ios" : "android";
  const roleLabel = role === "host" ? "호스트" : "게스트";
  const iosBuild = config.appBuild?.ios || {};
  const device = platform === "ios"
    ? iosBuild.devices?.[role] || ""
    : config.devices[role] || config.devices.guest || "";
  const appPackage = config.androidPackages[env];
  const bundleId = iosBuild.bundleIds?.[env === "stg" ? "staging" : env] || "";
  const wdaUrl = iosBuild.wdaUrls?.[role] || "";
  const steps = [];

  if (!device) throw new Error(`Missing device id for role: ${role}`);
  if (!["stg", "staging"].includes(env)) {
    throw new Error(`${kind} validation currently supports staging only.`);
  }
  if (platform === "android" && !appPackage) throw new Error(`Unknown Android package for env: ${env}`);
  if (platform === "ios" && !bundleId) throw new Error(`Unknown iOS bundle id for env: ${env}`);
  if (platform === "ios" && !wdaUrl) throw new Error(`Missing iOS WDA URL for role: ${role}`);

  const catalog = catalogResolver(role);

  return withDeviceLock(platform === "ios" ? wdaUrl : device, async () => {
    addStep(steps, "환경 설정 확인");

    const linksToRun = request.link_id ? catalog.filter((entry) => entry.id === request.link_id) : catalog;
    if (!linksToRun.length) {
      throw new Error(`Unknown ${kind} id: ${request.link_id}`);
    }

    const results = [];
    for (const entry of linksToRun) {
      const result = platform === "ios"
        ? await runOneIosLink(config, device, wdaUrl, bundleId, store, entry, env)
        : await runOneAndroidLink(config, device, appPackage, store, entry, env);
      results.push(result);
      addStep(
        steps,
        `${entry.label} 확인`,
        result.status === "fail" ? "fail" : "pass",
        result.message || (result.status === "needs_review" ? "화면 수동 확인 필요" : undefined)
      );
    }

    const failed = results.filter((r) => r.status === "fail");
    const needsReview = results.filter((r) => r.status === "needs_review");
    const overallStatus = failed.length > 0 ? "fail" : "pass";

    const summary = {
      total: results.length,
      passed: results.filter((r) => r.status === "pass").length,
      failed: failed.length,
      needs_review: needsReview.length,
      failed_links: failed.map((r) => r.label),
      needs_review_links: needsReview.map((r) => r.label),
      link_results: results.map((result) => ({
        id: result.id,
        label: result.label,
        url: result.url,
        status: result.status,
        message: result.message,
        expected_accommodation_id: result.expected_accommodation_id,
        observed_accommodation_id: result.observed_accommodation_id
      }))
    };

    return {
      test_id: platform === "ios" ? iosTestId : androidTestId,
      name: request.link_id
        ? linksToRun[0].label
        : `${roleLabel} ${kind} 전체`,
      env,
      status: overallStatus,
      device,
      platform,
      role,
      steps,
      [summaryKey]: summary,
      artifacts: {
        screenshots: results.filter((r) => r.screenshotPath).map((r) => r.screenshotPath),
        logs: [
          path.join(store.logsDir, "runner.log"),
          ...results.map((result) => result.logPath || path.join(store.logsDir, `${result.id}.xml`))
        ].filter((filePath) => fs.existsSync(filePath))
      }
    };
  });
}

async function runUniversalLinkTest(context) {
  return runLinkValidationTest(context, {
    kind: "유니버설 링크",
    catalogResolver: catalogForRole,
    androidTestId: "TC-UNIVERSAL-LINK-001",
    iosTestId: "TC-IOS-UNIVERSAL-LINK-001",
    summaryKey: "universal_link_summary"
  });
}

async function runDeepLinkTest(context) {
  return runLinkValidationTest(context, {
    kind: "딥링크",
    catalogResolver: deepLinkCatalogForRole,
    androidTestId: "TC-DEEP-LINK-001",
    iosTestId: "TC-IOS-DEEP-LINK-001",
    summaryKey: "deep_link_summary"
  });
}

module.exports = {
  GUEST_DEEP_LINK_CATALOG,
  GUEST_LINK_CATALOG,
  HOST_DEEP_LINK_CATALOG,
  HOST_LINK_CATALOG,
  runDeepLinkTest,
  runUniversalLinkTest
};
