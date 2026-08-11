const { withDeviceLock } = require("../infra/device-lock");
const { keyEvent, runAdb, tap } = require("../infra/adb");
const {
  dumpUiStable,
  findExactNode,
  findNode,
  isVisibleNode,
  nodeLabel,
  parseNodes,
  saveFailureArtifacts,
  saveXml,
  waitForUi,
  xmlTextLines
} = require("./helpers/ui-automation");

function addStep(steps, name, status = "pass", message) {
  const step = { name, status };
  if (message) step.message = message;
  steps.push(step);
}

function fail(message, steps, details = []) {
  const error = new Error(message);
  error.steps = steps;
  error.details = details;
  throw error;
}

async function wakeAndUnlock(config, device, steps, store) {
  await keyEvent(config, device, 224);
  await runAdb(config, device, ["shell", "wm", "dismiss-keyguard"]).catch((error) => {
    store.appendLog("runner.log", `dismiss-keyguard failed: ${error.message}`);
  });
  addStep(steps, "단말 깨우기 및 잠금 해제 시도");
}

async function launchFresh(config, device, appPackage, steps) {
  await runAdb(config, device, ["shell", "am", "force-stop", appPackage]);
  addStep(steps, "앱 완전 종료");
  await new Promise((resolve) => setTimeout(resolve, 450));
  await runAdb(config, device, [
    "shell",
    "monkey",
    "-p",
    appPackage,
    "-c",
    "android.intent.category.LAUNCHER",
    "1"
  ]);
  addStep(steps, "앱 재실행");
}

function hasGuestHomeShell(xml) {
  return (
    xml.includes("홈") &&
    xml.includes("찜") &&
    xml.includes("리브후기") &&
    xml.includes("내 정보")
  );
}

function hasAppError(xml) {
  return [
    "일시적인 오류",
    "오류가 발생",
    "다시 시도해 주세요",
    "네트워크 연결 상태",
    "문제가 발생"
  ].some((text) => xml.includes(text));
}

function findBottomTab(xml, label) {
  return parseNodes(xml).find((node) => (
    node.bounds &&
    node.bounds.top >= 2100 &&
    isVisibleNode(node) &&
    nodeLabel(node).includes(label)
  ));
}

function hasMyInfoScreen(xml) {
  if (!xml.includes("내 정보")) return false;
  const signals = ["쿠폰", "알림", "리뷰", "메시지", "로그아웃", "내가 둘러본 집"];
  return signals.filter((text) => xml.includes(text)).length >= 2;
}

function findCouponEntry(xml) {
  const exact = findExactNode(xml, ["쿠폰", "내 쿠폰", "쿠폰함", "내 쿠폰함"], {
    visible: true,
    clickable: true,
    enabled: true
  });
  if (exact) return exact;

  return parseNodes(xml)
    .filter((node) => {
      if (!node.bounds || !isVisibleNode(node)) return false;
      if (node.attrs.enabled === "false") return false;
      const label = nodeLabel(node).trim();
      return (
        label.includes("쿠폰") &&
        node.bounds.top >= 180 &&
        node.bounds.top <= 1050 &&
        node.bounds.left <= 650
      );
    })
    .sort((leftNode, rightNode) => {
      const clickableGap = Number(rightNode.attrs.clickable === "true") - Number(leftNode.attrs.clickable === "true");
      return clickableGap || leftNode.bounds.top - rightNode.bounds.top;
    })[0] || null;
}

function couponContentNodes(xml) {
  const keywords = ["쿠폰", "할인", "원", "%", "사용", "만료", "유효", "혜택"];
  return parseNodes(xml).filter((node) => {
    if (!node.bounds || !isVisibleNode(node)) return false;
    if (node.bounds.top < 260 || node.bounds.top > 2200) return false;
    const label = nodeLabel(node).trim();
    return label && keywords.some((keyword) => label.includes(keyword));
  });
}

function hasCouponScreen(xml) {
  if (!xml.includes("쿠폰")) return false;
  if (hasMyInfoScreen(xml)) return false;
  return (
    couponContentNodes(xml).length > 0 ||
    ["보유 쿠폰", "사용 가능", "쿠폰이 없습니다", "등록된 쿠폰", "쿠폰함"].some((text) => xml.includes(text))
  );
}

function findCouponCard(xml) {
  const candidates = parseNodes(xml)
    .filter((node) => {
      if (!node.bounds || !isVisibleNode(node)) return false;
      if (node.attrs.clickable !== "true" || node.attrs.enabled === "false") return false;
      if (node.bounds.top < 320 || node.bounds.bottom > 2220) return false;
      const width = node.bounds.right - node.bounds.left;
      const height = node.bounds.bottom - node.bounds.top;
      const label = nodeLabel(node).trim();
      return (
        width >= 260 &&
        height >= 90 &&
        ["쿠폰", "할인", "원", "%", "사용", "만료", "유효"].some((text) => label.includes(text)) &&
        !["쿠폰", "쿠폰함", "내 쿠폰함"].includes(label)
      );
    })
    .sort((leftNode, rightNode) => leftNode.bounds.top - rightNode.bounds.top);

  if (candidates.length) return candidates[Math.floor(Math.random() * candidates.length)];

  const contentNode = couponContentNodes(xml)
    .filter((node) => node.bounds.top >= 320 && node.bounds.bottom <= 2220)
    .sort((leftNode, rightNode) => leftNode.bounds.top - rightNode.bounds.top)[0];
  return contentNode || null;
}

function hasCouponDialog(xml) {
  const confirmButtons = parseNodes(xml).filter((node) => (
    node.bounds &&
    isVisibleNode(node) &&
    nodeLabel(node).trim() === "확인" &&
    node.bounds.top >= 650
  ));
  const dialogSignals = ["쿠폰", "할인", "유효", "사용", "만료", "혜택", "유의"];
  return confirmButtons.length > 0 && dialogSignals.some((text) => xml.includes(text));
}

function findDialogConfirm(xml) {
  return parseNodes(xml)
    .filter((node) => (
      node.bounds &&
      isVisibleNode(node) &&
      node.attrs.enabled !== "false" &&
      nodeLabel(node).trim() === "확인" &&
      node.bounds.top >= 650
    ))
    .sort((leftNode, rightNode) => rightNode.bounds.top - leftNode.bounds.top)[0] ||
    findNode(xml, "확인", { visible: true, clickable: true, enabled: true });
}

function screenSignature(xml) {
  return xmlTextLines(xml)
    .slice(0, 40)
    .join("|")
    .replace(/\d{1,2}:\d{2}/g, "");
}

async function openCouponBox(config, device, store, steps) {
  let xml = await waitForUi(config, device, hasGuestHomeShell, 8000);
  saveXml(store, "coupon-home", xml);
  if (!hasGuestHomeShell(xml)) {
    await saveFailureArtifacts(config, device, store, "coupon-home-not-found", xml);
    fail(
      "앱 실행 후 게스트 홈 화면을 확인하지 못했습니다.",
      steps,
      ["게스트 로그인 상태와 하단 홈/찜/리브후기/내 정보 메뉴를 확인해주세요."]
    );
  }

  const myInfoTab = findBottomTab(xml, "내 정보");
  if (!myInfoTab?.bounds) {
    await saveFailureArtifacts(config, device, store, "coupon-my-info-tab-not-found", xml);
    fail("하단 내 정보 탭을 찾지 못했습니다.", steps);
  }
  await tap(config, device, myInfoTab.bounds.x, myInfoTab.bounds.y);
  addStep(steps, "하단 내 정보 탭 선택");

  xml = await waitForUi(config, device, hasMyInfoScreen, 5000);
  saveXml(store, "coupon-my-info", xml);
  if (!hasMyInfoScreen(xml)) {
    await saveFailureArtifacts(config, device, store, "coupon-my-info-not-found", xml);
    fail("내 정보 화면으로 진입하지 못했습니다.", steps);
  }

  const couponEntry = findCouponEntry(xml);
  if (!couponEntry?.bounds) {
    await saveFailureArtifacts(config, device, store, "coupon-entry-not-found", xml);
    fail(
      "내 정보 화면 왼쪽 상단의 쿠폰 항목을 찾지 못했습니다.",
      steps,
      ["화면 크기 또는 내 정보 상단 메뉴 구조가 변경되었는지 확인해주세요."]
    );
  }
  await tap(config, device, couponEntry.bounds.x, couponEntry.bounds.y);
  addStep(steps, "내 정보 왼쪽 상단 쿠폰 선택");

  xml = await waitForUi(config, device, hasCouponScreen, 6000);
  saveXml(store, "coupon-list", xml);
  if (!hasCouponScreen(xml)) {
    await saveFailureArtifacts(config, device, store, "coupon-list-not-found", xml);
    fail("쿠폰함 화면으로 진입하지 못했습니다.", steps);
  }
  addStep(steps, "쿠폰함 화면 진입 확인");
  return xml;
}

async function openCouponDialog(config, device, store, steps, listXml) {
  const couponCard = findCouponCard(listXml);
  if (!couponCard?.bounds) {
    await saveFailureArtifacts(config, device, store, "coupon-card-not-found", listXml);
    fail(
      "쿠폰함에서 상세를 확인할 쿠폰을 찾지 못했습니다.",
      steps,
      ["테스트 계정에 선택 가능한 쿠폰이 있는지 확인해주세요."]
    );
  }

  const selectedCoupon = nodeLabel(couponCard).replace(/\s+/g, " ").trim().slice(0, 120) || "화면 내 쿠폰";
  await tap(config, device, couponCard.bounds.x, couponCard.bounds.y);
  addStep(steps, "쿠폰함 임의 쿠폰 선택", "pass", selectedCoupon);

  let xml = await waitForUi(config, device, hasCouponDialog, 5000);
  saveXml(store, "coupon-dialog", xml);
  if (!hasCouponDialog(xml)) {
    await saveFailureArtifacts(config, device, store, "coupon-dialog-not-found", xml);
    fail(
      "쿠폰을 선택했지만 쿠폰 상세 다이얼로그를 확인하지 못했습니다.",
      steps,
      ["선택한 쿠폰 카드가 실제로 탭되었는지 확인해주세요."]
    );
  }
  addStep(steps, "쿠폰 상세 다이얼로그 확인");

  const confirmButton = findDialogConfirm(xml);
  if (!confirmButton?.bounds) {
    await saveFailureArtifacts(config, device, store, "coupon-dialog-confirm-not-found", xml);
    fail("쿠폰 상세 다이얼로그에서 확인 버튼을 찾지 못했습니다.", steps);
  }
  await tap(config, device, confirmButton.bounds.x, confirmButton.bounds.y);
  addStep(steps, "쿠폰 상세 다이얼로그 확인 버튼 선택");

  xml = await waitForUi(config, device, (currentXml) => hasCouponScreen(currentXml) && !hasCouponDialog(currentXml), 4000);
  saveXml(store, "coupon-list-after-dialog", xml);
  if (!hasCouponScreen(xml) || hasCouponDialog(xml)) {
    await saveFailureArtifacts(config, device, store, "coupon-dialog-not-dismissed", xml);
    fail("쿠폰 상세 다이얼로그의 확인 버튼을 눌렀지만 쿠폰 목록으로 돌아오지 않았습니다.", steps);
  }
  addStep(steps, "쿠폰 상세 다이얼로그 닫힘 및 목록 복귀 확인");
  return { xml, selectedCoupon };
}

async function scrollCouponGrid(config, device, store, steps, initialXml) {
  let xml = initialXml;
  let previousSignature = screenSignature(xml);
  let stableCount = 0;
  let changedScreens = 0;
  let checkedScreens = 1;
  let maxContentNodes = couponContentNodes(xml).length;

  for (let count = 0; count < 5; count += 1) {
    await runAdb(config, device, ["shell", "input", "swipe", "540", "2050", "540", "720", "240"]);
    await new Promise((resolve) => setTimeout(resolve, 220));
    xml = await dumpUiStable(config, device);
    checkedScreens += 1;
    saveXml(store, `coupon-grid-scroll-${count + 1}`, xml);

    if (hasAppError(xml)) {
      await saveFailureArtifacts(config, device, store, "coupon-grid-app-error", xml);
      fail("쿠폰 목록 스크롤 중 앱 오류가 노출되었습니다.", steps);
    }

    maxContentNodes = Math.max(maxContentNodes, couponContentNodes(xml).length);
    const signature = screenSignature(xml);
    if (signature === previousSignature) {
      stableCount += 1;
    } else {
      stableCount = 0;
      changedScreens += 1;
    }
    previousSignature = signature;
    if (stableCount >= 1) break;
  }

  saveXml(store, "coupon-grid-bottom", xml);
  if (!hasCouponScreen(xml) || maxContentNodes === 0) {
    await saveFailureArtifacts(config, device, store, "coupon-grid-content-lost", xml);
    fail("쿠폰 목록 스크롤 후 쿠폰 그리드 내용을 확인하지 못했습니다.", steps);
  }

  addStep(
    steps,
    "쿠폰 그리드 하단 스크롤 확인",
    "pass",
    changedScreens > 0
      ? `${checkedScreens}개 화면 확인, 화면 변화 ${changedScreens}회`
      : "쿠폰 목록이 한 화면이거나 이미 하단인 상태"
  );

  return {
    checked_screens: checkedScreens,
    changed_screens: changedScreens,
    max_content_nodes: maxContentNodes
  };
}

async function runCouponBoxTest({ request, config, store }) {
  const role = request.role || "guest";
  const env = request.env || "dev";
  const device = config.devices.guest || "";
  const appPackage = config.androidPackages[env];
  const steps = [];

  if (role !== "guest") throw new Error("쿠폰함 테스트는 guest role에서만 실행할 수 있습니다.");
  if (!device) throw new Error("Missing device id for role: guest");
  if (!appPackage) throw new Error(`Unknown Android package for env: ${env}`);

  return withDeviceLock(device, async () => {
    addStep(steps, "환경 설정 확인");
    await wakeAndUnlock(config, device, steps, store);
    await launchFresh(config, device, appPackage, steps);

    const listXml = await openCouponBox(config, device, store, steps);
    const dialog = await openCouponDialog(config, device, store, steps, listXml);
    const grid = await scrollCouponGrid(config, device, store, steps, dialog.xml);

    return {
      test_id: "TC-INTERNAL-REFACTOR-004",
      name: "guest 쿠폰함",
      env,
      status: "pass",
      device,
      steps,
      coupon_box: {
        selected_coupon: dialog.selectedCoupon,
        detail_dialog_confirmed: true,
        checked_screens: grid.checked_screens,
        changed_screens: grid.changed_screens,
        max_content_nodes: grid.max_content_nodes,
        grid_validation: "쿠폰 목록 스크롤 중 콘텐츠 유지 및 앱 오류 미노출 확인",
        manual_check_required: [
          "쿠폰 카드 그리드 간격과 정렬의 픽셀 단위 동일 여부",
          "쿠폰 상세 다이얼로그의 시각 디자인 동일 여부"
        ]
      }
    };
  });
}

module.exports = {
  runCouponBoxTest
};
