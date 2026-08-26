let testCatalog = [];
let selectedPlatform = "android";

function renderTestOptions() {
  const select = document.getElementById("test-select");
  const filtered = testCatalog.filter((t) => t.platform === selectedPlatform || t.platform === "both");
  select.innerHTML = filtered.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}</option>`).join("");
}

function renderExtraFields() {
  const testId = document.getElementById("test-select").value;
  const test = testCatalog.find((t) => t.id === testId);
  const container = document.getElementById("extra-fields");

  if (!test || !test.extraFields || !test.extraFields.length) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = test.extraFields
    .map((field) => {
      const id = `extra-${field.key}`;
      if (field.type === "select") {
        const options = field.options
          .map((opt) => `<option value="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</option>`)
          .join("");
        return `
          <div class="runner-field">
            <label for="${id}">${escapeHtml(field.label)}</label>
            <select id="${id}" data-key="${escapeHtml(field.key)}">${options}</select>
          </div>`;
      }
      return `
        <div class="runner-field">
          <label for="${id}">${escapeHtml(field.label)}</label>
          <input id="${id}" data-key="${escapeHtml(field.key)}" type="text" placeholder="${field.optional ? "선택 입력" : "필수 입력"}">
        </div>`;
    })
    .join("");
}

function updateEnvField() {
  const testId = document.getElementById("test-select").value;
  const test = testCatalog.find((t) => t.id === testId);
  const envSelect = document.getElementById("env-select");
  const existingFixedOption = envSelect.querySelector('option[data-fixed="true"]');
  if (existingFixedOption) existingFixedOption.remove();

  if (test && test.fixedEnv) {
    const opt = document.createElement("option");
    opt.value = test.fixedEnv;
    opt.textContent = `${test.fixedEnv} (이 테스트는 환경 고정)`;
    opt.dataset.fixed = "true";
    envSelect.appendChild(opt);
    envSelect.value = test.fixedEnv;
    envSelect.disabled = true;
  } else {
    envSelect.disabled = false;
    if (envSelect.value !== "stg" && envSelect.value !== "dev") {
      envSelect.value = "stg";
    }
  }
}

function collectExtraFieldValues() {
  const values = {};
  document.querySelectorAll("#extra-fields [data-key]").forEach((el) => {
    if (el.value) values[el.dataset.key] = el.value;
  });
  return values;
}

function selectPlatform(platform) {
  selectedPlatform = platform;
  document.querySelectorAll(".platform-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.platform === platform);
  });
  document.getElementById("run-status").innerHTML = "";
  renderTestOptions();
  renderExtraFields();
  updateEnvField();
}

document.querySelectorAll(".platform-btn").forEach((btn) => {
  btn.addEventListener("click", () => selectPlatform(btn.dataset.platform));
});

async function loadCatalog() {
  const data = await fetchJson("/api/test-catalog");
  testCatalog = data.tests || [];
  renderTestOptions();
  renderExtraFields();
  updateEnvField();
}

document.getElementById("test-select").addEventListener("change", () => {
  renderExtraFields();
  updateEnvField();
});

function pollForCompletion(env, role, requestedAt, statusEl) {
  const deadline = requestedAt + 10 * 60 * 1000; // 10분 지나면 폴링 포기

  const tick = async () => {
    if (Date.now() > deadline) {
      statusEl.innerHTML = `
        <p class="runner-pending">아직 실행 중일 수 있어요. <a href="/runs.html">실행 기록</a>에서 확인해주세요.</p>`;
      return;
    }

    try {
      const data = await fetchJson("/api/runs?limit=20");
      const match = (data.runs || []).find(
        (r) => r.source === "dashboard" && r.env === env && new Date(r.ran_at).getTime() >= requestedAt - 2000
      );

      if (match) {
        const isPass = match.status === "pass";
        statusEl.innerHTML = `
          <p class="${isPass ? "runner-ok" : "runner-error"}">
            ${isPass ? "✓ 완료: PASS" : "✗ 완료: FAIL"} — ${escapeHtml(match.name || match.test_id)}
            (<a href="/runs.html">실행 기록에서 자세히 보기</a>)
          </p>`;
        return;
      }
    } catch (error) {
      // 다음 폴링에서 재시도
    }

    setTimeout(tick, 3000);
  };

  setTimeout(tick, 3000);
}

document.getElementById("run-btn").addEventListener("click", async () => {
  const testId = document.getElementById("test-select").value;
  const test = testCatalog.find((t) => t.id === testId);
  const role = document.getElementById("role-select").value;
  const env = document.getElementById("env-select").value;
  const extra = collectExtraFieldValues();
  const statusEl = document.getElementById("run-status");

  if (!test) {
    statusEl.innerHTML = `<p class="runner-error">테스트 항목을 선택해주세요.</p>`;
    return;
  }

  const requiredMissing = (test.extraFields || []).find((f) => !f.optional && !extra[f.key]);
  if (requiredMissing) {
    statusEl.innerHTML = `<p class="runner-error">"${escapeHtml(requiredMissing.label)}" 값을 입력해주세요.</p>`;
    return;
  }

  const btn = document.getElementById("run-btn");
  btn.disabled = true;
  statusEl.innerHTML = `<p class="runner-pending">요청 보내는 중…</p>`;

  try {
    const requestedAt = Date.now();
    const response = await fetch("/api/run-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: testId, role, env, platform: selectedPlatform, ...extra })
    });
    const data = await response.json();

    if (!response.ok) {
      statusEl.innerHTML = `<p class="runner-error">실행 요청 실패: ${escapeHtml(data.error || response.status)}</p>`;
      return;
    }

    statusEl.innerHTML = `
      <p class="runner-pending">실행되고 있습니다… 완료되면 자동으로 결과가 표시돼요.</p>`;
    pollForCompletion(env, role, requestedAt, statusEl);
  } catch (error) {
    statusEl.innerHTML = `<p class="runner-error">요청 실패: ${escapeHtml(error.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
});

loadCatalog();

// ===== 유니버설 링크 검증 =====
let ulinkPlatform = "android";
let ulinkRole = "guest";
let ulinkScope = "all";
let ulinkCatalog = { guest: [], host: [] };

function renderUlinkLinkOptions() {
  const select = document.getElementById("ulink-link-select");
  const links = ulinkCatalog[ulinkRole] || [];
  select.innerHTML = links.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.label)}</option>`).join("");
}

async function loadUlinkCatalog() {
  try {
    const data = await fetchJson("/api/universal-link-catalog");
    ulinkCatalog = { guest: data.guest || [], host: data.host || [] };
    renderUlinkLinkOptions();
  } catch (error) {
    // 카탈로그 로드 실패해도 "전체" 실행은 가능하므로 조용히 넘어감
  }
}

document.querySelectorAll("[data-ulink-role]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    ulinkRole = btn.dataset.ulinkRole;
    document.querySelectorAll("[data-ulink-role]").forEach((b) => b.classList.toggle("active", b === btn));
    renderUlinkLinkOptions();
  });
});

document.querySelectorAll("[data-ulink-platform]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    ulinkPlatform = btn.dataset.ulinkPlatform;
    document.querySelectorAll("[data-ulink-platform]").forEach((b) => b.classList.toggle("active", b === btn));
  });
});

document.querySelectorAll("[data-ulink-scope]").forEach((btn) => {
  btn.addEventListener("click", () => {
    ulinkScope = btn.dataset.ulinkScope;
    document.querySelectorAll("[data-ulink-scope]").forEach((b) => b.classList.toggle("active", b === btn));
    document.getElementById("ulink-single-field").style.display = ulinkScope === "single" ? "block" : "none";
  });
});

function pollUlinkCompletion(platform, role, env, requestedAt, statusEl) {
  const deadline = requestedAt + 15 * 60 * 1000; // 링크 여러 개 도니까 넉넉하게 15분

  const tick = async () => {
    if (Date.now() > deadline) {
      statusEl.innerHTML = `
        <p class="runner-pending">아직 실행 중일 수 있어요. <a href="/runs.html">실행 기록</a>에서 확인해주세요.</p>`;
      return;
    }

    try {
      const data = await fetchJson("/api/runs?limit=20");
      const match = (data.runs || []).find(
        (r) =>
          r.source === "dashboard" &&
          r.test_id === (platform === "ios" ? "TC-IOS-UNIVERSAL-LINK-001" : "TC-UNIVERSAL-LINK-001") &&
          r.role === role &&
          r.env === env &&
          new Date(r.ran_at).getTime() >= requestedAt - 2000
      );

      if (match) {
        const isPass = match.status === "pass";
        statusEl.innerHTML = `
          <p class="${isPass ? "runner-ok" : "runner-error"}">
            ${isPass ? "✓ 완료: PASS" : "✗ 완료: FAIL"}
            (<a href="/runs.html">실행 기록에서 자세히 보기</a>)
          </p>`;
        return;
      }
    } catch (error) {
      // 다음 폴링에서 재시도
    }

    setTimeout(tick, 3000);
  };

  setTimeout(tick, 3000);
}

document.getElementById("ulink-run-btn").addEventListener("click", async () => {
  const env = document.getElementById("ulink-env-select").value;
  const statusEl = document.getElementById("ulink-run-status");
  const btn = document.getElementById("ulink-run-btn");

  let linkId;
  if (ulinkScope === "single") {
    linkId = document.getElementById("ulink-link-select").value;
    if (!linkId) {
      statusEl.innerHTML = `<p class="runner-error">테스트할 링크를 선택해주세요.</p>`;
      return;
    }
  }

  btn.disabled = true;
  statusEl.innerHTML = `<p class="runner-pending">요청 보내는 중…</p>`;

  try {
    const requestedAt = Date.now();
    const response = await fetch("/api/run-universal-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: ulinkPlatform, env, role: ulinkRole, link_id: linkId })
    });
    const data = await response.json();

    if (!response.ok) {
      statusEl.innerHTML = `<p class="runner-error">실행 요청 실패: ${escapeHtml(data.error || response.status)}</p>`;
      return;
    }

    statusEl.innerHTML = `
      <p class="runner-pending">실행되고 있습니다… 완료되면 자동으로 결과가 표시돼요.</p>`;
    pollUlinkCompletion(ulinkPlatform, ulinkRole, env, requestedAt, statusEl);
  } catch (error) {
    statusEl.innerHTML = `<p class="runner-error">요청 실패: ${escapeHtml(error.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
});

loadUlinkCatalog();

// ===== 딥링크 검증 =====
let dlinkPlatform = "android";
let dlinkRole = "guest";
let dlinkScope = "all";
let dlinkCatalog = { guest: [], host: [] };

function renderDlinkOptions() {
  const select = document.getElementById("dlink-link-select");
  const links = dlinkCatalog[dlinkRole] || [];
  select.innerHTML = links
    .map((link) => `<option value="${escapeHtml(link.id)}">${escapeHtml(link.label)}</option>`)
    .join("");
}

async function loadDlinkCatalog() {
  try {
    const data = await fetchJson("/api/deep-link-catalog");
    dlinkCatalog = { guest: data.guest || [], host: data.host || [] };
    renderDlinkOptions();
  } catch (error) {
    document.getElementById("dlink-run-status").innerHTML =
      `<p class="runner-error">딥링크 목록을 불러오지 못했습니다.</p>`;
  }
}

document.querySelectorAll("[data-dlink-role]").forEach((btn) => {
  btn.addEventListener("click", () => {
    dlinkRole = btn.dataset.dlinkRole;
    document.querySelectorAll("[data-dlink-role]").forEach((item) => item.classList.toggle("active", item === btn));
    renderDlinkOptions();
  });
});

document.querySelectorAll("[data-dlink-platform]").forEach((btn) => {
  btn.addEventListener("click", () => {
    dlinkPlatform = btn.dataset.dlinkPlatform;
    document.querySelectorAll("[data-dlink-platform]").forEach((item) => item.classList.toggle("active", item === btn));
  });
});

document.querySelectorAll("[data-dlink-scope]").forEach((btn) => {
  btn.addEventListener("click", () => {
    dlinkScope = btn.dataset.dlinkScope;
    document.querySelectorAll("[data-dlink-scope]").forEach((item) => item.classList.toggle("active", item === btn));
    document.getElementById("dlink-single-field").style.display = dlinkScope === "single" ? "block" : "none";
  });
});

function pollDlinkCompletion(platform, role, env, requestedAt, statusEl) {
  const deadline = requestedAt + 15 * 60 * 1000;

  const tick = async () => {
    if (Date.now() > deadline) {
      statusEl.innerHTML = `<p class="runner-pending">아직 실행 중일 수 있어요. <a href="/runs.html">실행 기록</a>에서 확인해주세요.</p>`;
      return;
    }

    try {
      const data = await fetchJson("/api/runs?limit=20");
      const testId = platform === "ios" ? "TC-IOS-DEEP-LINK-001" : "TC-DEEP-LINK-001";
      const match = (data.runs || []).find(
        (run) =>
          run.source === "dashboard" &&
          run.test_id === testId &&
          run.role === role &&
          run.env === env &&
          new Date(run.ran_at).getTime() >= requestedAt - 2000
      );

      if (match) {
        const isPass = match.status === "pass";
        statusEl.innerHTML = `<p class="${isPass ? "runner-ok" : "runner-error"}">
          ${isPass ? "✓ 완료: PASS" : "✗ 완료: FAIL"}
          (<a href="/runs.html">실행 기록에서 자세히 보기</a>)
        </p>`;
        return;
      }
    } catch (error) {
      // 다음 폴링에서 재시도한다.
    }

    setTimeout(tick, 3000);
  };

  setTimeout(tick, 3000);
}

document.getElementById("dlink-run-btn").addEventListener("click", async () => {
  const env = document.getElementById("dlink-env-select").value;
  const statusEl = document.getElementById("dlink-run-status");
  const btn = document.getElementById("dlink-run-btn");

  let linkId;
  if (dlinkScope === "single") {
    linkId = document.getElementById("dlink-link-select").value;
    if (!linkId) {
      statusEl.innerHTML = `<p class="runner-error">테스트할 링크를 선택해주세요.</p>`;
      return;
    }
  }

  btn.disabled = true;
  statusEl.innerHTML = `<p class="runner-pending">요청 보내는 중…</p>`;

  try {
    const requestedAt = Date.now();
    const response = await fetch("/api/run-deep-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: dlinkPlatform, env, role: dlinkRole, link_id: linkId })
    });
    const data = await response.json();

    if (!response.ok) {
      statusEl.innerHTML = `<p class="runner-error">실행 요청 실패: ${escapeHtml(data.error || response.status)}</p>`;
      return;
    }

    statusEl.innerHTML = `<p class="runner-pending">실행되고 있습니다… 완료되면 자동으로 결과가 표시돼요.</p>`;
    pollDlinkCompletion(dlinkPlatform, dlinkRole, env, requestedAt, statusEl);
  } catch (error) {
    statusEl.innerHTML = `<p class="runner-error">요청 실패: ${escapeHtml(error.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
});

loadDlinkCatalog();
