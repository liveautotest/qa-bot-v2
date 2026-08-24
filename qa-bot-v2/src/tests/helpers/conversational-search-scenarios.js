// Scenario facts are intentionally explicit. They let the runner judge whether
// the agent preserved user constraints without requiring exact AI wording.
const CONVERSATIONAL_SEARCH_SCENARIOS = [
  {
    id: "business-trip",
    label: "출장",
    initialPrompt: "출장으로 잠시 머물 집이 필요해.",
    turns: [
      { intent: "location", text: "여의도로 출장 갈 거야.", expectedSignals: ["여의도"] },
      { intent: "schedule", text: "다음 주 월요일부터 2주 동안 머물 예정이야.", expectedSignals: ["2주", "14"] },
      { intent: "party", text: "성인 한 명이 혼자 머물 거야.", expectedSignals: ["1명", "한 명"] },
      { intent: "budget", text: "주 40만 원 이하로 찾아줘.", expectedSignals: ["40", "400,000"] },
      { intent: "commute", text: "여의도역까지 도보 10분 이내면 좋겠어.", expectedSignals: ["여의도역", "도보", "10분"] },
      { intent: "preference", text: "조용하고 업무용 책상과 세탁기가 있는 집이면 좋겠어.", expectedSignals: ["책상", "업무", "세탁"] },
      { intent: "result", text: "지금까지 말한 조건으로 숙소를 찾아줘.", expectedSignals: [] }
    ]
  },
  {
    id: "week-stay",
    label: "일주일 살기",
    initialPrompt: "제주에서 일주일 살기 좋은 집을 찾고 있어.",
    turns: [
      { intent: "location", text: "제주시에서 바다까지 이동하기 편한 곳이면 좋겠어.", expectedSignals: ["제주", "제주시"] },
      { intent: "schedule", text: "10월 둘째 주에 7박으로 생각하고 있어.", expectedSignals: ["10월", "7박"] },
      { intent: "party", text: "친구와 둘이 갈 거야.", expectedSignals: ["2명", "둘"] },
      { intent: "preference", text: "취사가 가능하고 침대가 두 개면 좋겠어.", expectedSignals: ["취사", "주방", "침대"] },
      { intent: "budget", text: "전체 숙박비는 80만 원 안쪽으로 찾아줘.", expectedSignals: ["80", "800,000"] },
      { intent: "result", text: "이 조건으로 예약 가능한 집을 보여줘.", expectedSignals: [] }
    ]
  },
  {
    id: "monthly-workation",
    label: "한달살기·워케이션",
    initialPrompt: "부산에서 한달살기 하면서 원격근무할 집이 필요해.",
    turns: [
      { intent: "location", text: "광안리나 해운대 근처를 우선 보고 싶어.", expectedSignals: ["광안리", "해운대"] },
      { intent: "schedule", text: "11월 1일부터 30박 정도 머물 거야.", expectedSignals: ["11월", "30박"] },
      { intent: "preference", text: "빠른 와이파이와 업무용 책상은 꼭 있어야 해.", expectedSignals: ["와이파이", "책상", "업무"] },
      { intent: "amenity", text: "세탁기와 주방도 필요해.", expectedSignals: ["세탁", "주방"] },
      { intent: "budget", text: "월 150만 원 이하로 찾아줘.", expectedSignals: ["150", "1,500,000"] },
      { intent: "result", text: "장기 숙박 할인까지 반영해서 결과를 보여줘.", expectedSignals: ["할인", "장기"] }
    ]
  },
  {
    id: "family-travel",
    label: "가족 여행",
    initialPrompt: "아이와 서울 여행을 가는데 가족이 머물 집을 찾아줘.",
    turns: [
      { intent: "location", text: "잠실 근처가 좋아.", expectedSignals: ["잠실"] },
      { intent: "schedule", text: "이번 달 마지막 금요일부터 3박이야.", expectedSignals: ["3박"] },
      { intent: "party", text: "성인 두 명과 어린이 한 명이야.", expectedSignals: ["성인", "어린이", "3명"] },
      { intent: "preference", text: "침실이 분리되고 엘리베이터가 있으면 좋겠어.", expectedSignals: ["침실", "엘리베이터"] },
      { intent: "correction", text: "주차는 필요 없고 대중교통이 편한 곳으로 바꿔줘.", expectedSignals: ["대중교통", "주차"] },
      { intent: "result", text: "수정한 조건으로 집을 보여줘.", expectedSignals: [] }
    ]
  },
  {
    id: "pet-friendly-long-stay",
    label: "반려동물 동반 장기 숙박",
    initialPrompt: "반려견과 두 달 정도 지낼 단기임대 집이 필요해.",
    turns: [
      { intent: "location", text: "서울 성수동 근처로 찾아줘.", expectedSignals: ["성수"] },
      { intent: "schedule", text: "9월 초부터 60박 정도 생각하고 있어.", expectedSignals: ["9월", "60박"] },
      { intent: "pet", text: "소형견 한 마리와 함께 갈 거야.", expectedSignals: ["소형견", "반려", "한 마리"] },
      { intent: "preference", text: "산책하기 편하고 세탁기와 주방이 필요해.", expectedSignals: ["산책", "세탁", "주방"] },
      { intent: "budget", text: "월 200만 원을 넘지 않았으면 해.", expectedSignals: ["200", "2,000,000"] },
      { intent: "result", text: "반려동물 입실 가능한 집만 보여줘.", expectedSignals: ["반려동물", "입실"] }
    ]
  },
  {
    id: "relocation",
    label: "이사 전 장기 숙박",
    initialPrompt: "이사 날짜가 늦어져서 석 달 정도 머물 집을 구하고 있어.",
    turns: [
      { intent: "location", text: "판교 출근이 편한 지역이면 돼.", expectedSignals: ["판교"] },
      { intent: "schedule", text: "다음 달 5일부터 90박 정도 필요해.", expectedSignals: ["90박"] },
      { intent: "party", text: "부부 두 명이 지낼 거야.", expectedSignals: ["2명", "부부"] },
      { intent: "preference", text: "가구가 갖춰져 있고 수납공간이 넉넉했으면 좋겠어.", expectedSignals: ["가구", "수납"] },
      { intent: "correction", text: "예산을 월 180만 원에서 220만 원으로 올릴게.", expectedSignals: ["220", "2,200,000"] },
      { intent: "result", text: "바뀐 예산 기준으로 다시 찾아줘.", expectedSignals: [] }
    ]
  }
];

function chooseScenario(random = Math.random) {
  const index = Math.floor(random() * CONVERSATIONAL_SEARCH_SCENARIOS.length);
  return CONVERSATIONAL_SEARCH_SCENARIOS[index];
}

module.exports = {
  CONVERSATIONAL_SEARCH_SCENARIOS,
  chooseScenario
};
