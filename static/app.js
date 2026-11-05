/* 鲁趣寻踪 —— 前端逻辑（v3：自然语言 → 旅行偏好画像 → 画像驱动匹配）
 * 匹配引擎见 static/matcher.js（纯逻辑模块）
 */
(function () {
  "use strict";

  const API_DATA = "/data/attractions.json";
  const API_ATTRS = "/data/attributes.json";
  const API_PROFILE = "/api/profile";
  const API_COPY = "/api/copywriting";

  // 画像维度的展示配置
  const DIMS = [
    { key: "companion", label: "同行偏好", type: "text" },
    { key: "environment", label: "环境偏好", type: "text" },
    { key: "pace", label: "行程节奏", type: "text" },
    { key: "stamina", label: "体力接受度", type: "text" },
    { key: "interests", label: "内容兴趣", type: "list" },
    { key: "excludes", label: "明确排除项", type: "list" }
  ];

  const EXAMPLE_CHIPS = ["日出", "拍照", "美食", "夜景", "海边", "古城", "亲子", "历史文化"];

  let attractions = [];
  let attributes = {};
  let currentProfile = null;
  let isMock = false;
  let initialProfile = null;
  let profileInput = '';
  let currentRun = null;
  let profileRequest = 0;
  let profileController = null;
  let modelName = '';
  let copyController = new AbortController();
  let copyQueue = Promise.resolve();

  let descriptionInput, citySelect, profileBtn, directBtn, chipsBox, tipsBox;
  let profileArea, profileList, profileMockNote, confirmBtn, matchNote, conflictBox;
  let resultArea, cardsBox, summaryBox, configTip;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    descriptionInput = document.getElementById("description");
    citySelect = document.getElementById("city");
    profileBtn = document.getElementById("profile-btn");
    directBtn = document.getElementById("direct-btn");
    chipsBox = document.getElementById("chips");
    tipsBox = document.getElementById("tips");
    profileArea = document.getElementById("profile-area");
    profileList = document.getElementById("profile-list");
    profileMockNote = document.getElementById("profile-mock-note");
    confirmBtn = document.getElementById("confirm-btn");
    matchNote = document.getElementById("match-note");
    conflictBox = document.getElementById("conflict-box");
    resultArea = document.getElementById("result-area");
    cardsBox = document.getElementById("cards");
    summaryBox = document.getElementById("result-summary");
    configTip = document.getElementById("config-tip");
    document.getElementById('export-txt').addEventListener('click', function () { exportRun('txt'); });
    document.getElementById('export-json').addEventListener('click', function () { exportRun('json'); });
    descriptionInput.addEventListener('input', invalidateProfile);
    citySelect.addEventListener('change', clearResult);
    document.querySelectorAll('.scenario').forEach(function (button) {
      button.addEventListener('click', function () {
        descriptionInput.value = button.dataset.description;
        invalidateProfile();
        descriptionInput.focus({preventScroll:true});
      });
    });

    renderChips();
    profileBtn.addEventListener("click", onProfile);
    directBtn.addEventListener("click", onDirect);
    confirmBtn.addEventListener("click", onConfirm);

    try {
      const [r1, r2] = await Promise.all([fetch(API_DATA), fetch(API_ATTRS)]);
      attractions = await r1.json();
      attributes = await r2.json();
      fillCityOptions();
      document.getElementById('data-count').textContent = attractions.length + ' 个山东景点';
      document.getElementById('city-count').textContent = '覆盖 ' + new Set(attractions.map(a => a.city)).size + ' 座山东城市';
    } catch (err) {
      tipsBox.textContent = "景点/属性数据加载失败，请确认服务已启动。";
      tipsBox.className = "tips warn";
      return;
    }

    try {
      const h = await (await fetch("/api/health")).json();
      isMock = !!h.mock;
      modelName = h.model || '';
      document.getElementById('mode-status').textContent = h.mock ? '示例预览 · 未调用真实模型' : (h.configured ? '真实模型模式' : '等待配置模型');
      if (!h.configured && !h.mock) configTip.classList.remove("hidden");
    } catch (e) { document.getElementById('mode-status').textContent = '服务状态暂不可用'; }
  }

  function renderChips() {
    chipsBox.innerHTML = "";
    EXAMPLE_CHIPS.forEach(function (w) {
      const s = document.createElement("button");
      s.type = 'button';
      s.className = "chip";
      s.textContent = w;
      s.addEventListener("click", function () {
        const cur = descriptionInput.value.trim();
        descriptionInput.value = cur ? cur + " " + w : w;
        invalidateProfile();
        descriptionInput.focus();
      });
      chipsBox.appendChild(s);
    });
  }

  function fillCityOptions() {
    const cities = [...new Set(attractions.map(function (a) { return a.city; }))].sort();
    cities.forEach(function (c) {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      citySelect.appendChild(opt);
    });
  }

  function showTip(text, kind) {
    tipsBox.textContent = text;
    tipsBox.className = "tips" + (kind ? " " + kind : "");
  }

  function setBusy(btn, busy, loadingText) {
    if (busy) {
      btn.dataset.origin = btn.textContent;
      btn.dataset.originHtml = btn.innerHTML;
      btn.disabled = true;
      btn.textContent = loadingText;
    } else {
      btn.disabled = false;
      if (btn.dataset.originHtml) btn.innerHTML = btn.dataset.originHtml;
      else btn.textContent = btn.dataset.origin || btn.textContent;
    }
  }

  // 匹配前清空旧结果（需求 8：修改画像后重新匹配时清除旧结果）
  function clearResult() {
    copyController.abort();
    copyController = new AbortController();
    copyQueue = Promise.resolve();
    currentRun = null;
    document.getElementById('export-actions').classList.add('hidden');
    cardsBox.innerHTML = "";
    summaryBox.textContent = "";
    resultArea.classList.add("hidden");
    matchNote.classList.add("hidden");
    conflictBox.classList.add("hidden");
    conflictBox.innerHTML = "";
  }

  function invalidateProfile() {
    profileRequest++;
    if (profileController) profileController.abort();
    if (profileBtn.disabled) setBusy(profileBtn, false);
    currentProfile = null;
    initialProfile = null;
    profileArea.classList.add('hidden');
    clearResult();
    showTip('描述已更新，点击“发送，理解我的偏好”继续。', 'ok');
  }

  // ---------------- 画像提取 ----------------
  async function onProfile() {
    const desc = descriptionInput.value.trim();
    if (!desc) {
      showTip("请先输入对旅行的描述或偏好关键词。", "warn");
      return;
    }
    setBusy(profileBtn, true, "提取中…");
    currentProfile = null;
    profileArea.classList.add("hidden");
    clearResult();
    showTip("正在提取旅行偏好画像…", "ok");
    const requestId = ++profileRequest;
    const controller = new AbortController();
    profileController = controller;

    try {
      const resp = await fetch(API_PROFILE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: desc }),
        signal: controller.signal
      });
      const data = await resp.json();
      if (requestId !== profileRequest) return;
      if (!data.ok) {
        if (data.error === "API_KEY_NOT_CONFIGURED" || data.error === "MODEL_NOT_CONFIGURED") {
          configTip.classList.remove("hidden");
        }
        showTip("画像提取失败：" + (data.message || data.error || "未知错误"), "warn");
        setBusy(profileBtn, false);
        return;
      }
      currentProfile = data.profile;
      initialProfile = JSON.parse(JSON.stringify(data.profile));
      profileInput = desc;
      isMock = !!data.mock;
      clearResult();
      renderProfile(data.profile);
      if (data.mock) {
        profileMockNote.classList.remove("hidden");
        profileMockNote.textContent = "当前为演示模式，以下为示例画像（未调用真实模型）";
      } else {
        profileMockNote.classList.add("hidden");
      }
      showTip("画像已生成，请核对下方「我的旅行偏好」，可修改或删除后确认。", "ok");
    } catch (err) {
      if (requestId !== profileRequest) return;
      showTip("画像提取失败：" + String(err), "warn");
    } finally {
      if (requestId === profileRequest) setBusy(profileBtn, false);
    }
  }

  function renderProfile(profile) {
    profileArea.classList.remove("hidden");
    profileList.innerHTML = "";
    DIMS.forEach(function (dim) {
      const item = profile[dim.key] || { value: "未说明", evidence: "" };
      const row = document.createElement("div");
      row.className = "profile-row" + (isUnset(item.value) ? " unset" : "");
      row.dataset.key = dim.key;

      const info = document.createElement("div");
      info.className = "profile-info";

      const label = document.createElement("span");
      label.className = "profile-label";
      label.textContent = dim.label;
      const dimensionIcons = {companion:'user',environment:'pin',pace:'leaf',stamina:'compass',interests:'spark',excludes:'check'};
      const icon = document.createElementNS('http://www.w3.org/2000/svg','svg');
      icon.setAttribute('class','icon');
      icon.setAttribute('aria-hidden','true');
      const use = document.createElementNS('http://www.w3.org/2000/svg','use');
      use.setAttribute('href','#i-' + dimensionIcons[dim.key]);
      icon.appendChild(use);
      label.prepend(icon);

      const valueBox = document.createElement("div");
      valueBox.className = "profile-value";
      valueBox.textContent = formatValue(item.value);
      if (isUnset(item.value)) valueBox.classList.add("unset-text");

      const ev = document.createElement("div");
      ev.className = "profile-evidence";
      ev.textContent = item.evidence || "";

      info.appendChild(label);
      info.appendChild(valueBox);
      info.appendChild(ev);
      row.appendChild(info);

      const ops = document.createElement("div");
      ops.className = "profile-ops";
      const editBtn = document.createElement("button");
      editBtn.className = "mini-btn";
      editBtn.textContent = "修改";
      editBtn.addEventListener("click", function () { enterEdit(row, dim, item); });
      const delBtn = document.createElement("button");
      delBtn.className = "mini-btn danger";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", function () {
        currentProfile[dim.key] = { value: "未说明", evidence: "" };
        clearResult();
        renderProfile(currentProfile);
      });
      ops.appendChild(editBtn);
      ops.appendChild(delBtn);
      row.appendChild(ops);

      profileList.appendChild(row);
    });
  }

  function enterEdit(row, dim, item) {
    const info = row.querySelector(".profile-info");
    const label = info.querySelector(".profile-label");
    const input = document.createElement("input");
    input.className = "profile-edit-input";
    input.value = formatValue(item.value);
    if (dim.type === "list") input.placeholder = "多个用逗号分隔，如：美食,拍照";

    info.innerHTML = "";
    info.appendChild(label);
    info.appendChild(input);

    const ops = row.querySelector(".profile-ops");
    ops.innerHTML = "";
    const saveBtn = document.createElement("button");
    saveBtn.className = "mini-btn primary";
    saveBtn.textContent = "保存";
    saveBtn.addEventListener("click", function () {
      const raw = input.value.trim();
      if (dim.type === "list") {
        const arr = raw.split(/[,，、;；]+/).map(function (s) { return s.trim(); }).filter(Boolean);
        const values = arr.filter(function (v) { return v !== "未说明"; });
        currentProfile[dim.key] = { value: values.length ? values : "未说明", evidence: values.length ? "用户手动修改" : "" };
      } else {
        currentProfile[dim.key] = { value: raw || "未说明", evidence: raw && raw !== "未说明" ? "用户手动修改" : "" };
      }
      clearResult();
      renderProfile(currentProfile);
    });
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "mini-btn";
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", function () { renderProfile(currentProfile); });
    ops.appendChild(saveBtn);
    ops.appendChild(cancelBtn);

    input.focus();
  }

  // ---------------- 匹配（画像驱动） ----------------
  function onDirect() {
    // 保留关键词输入方式：跳过画像，把输入文本分词作为"内容兴趣"直接匹配
    const raw = descriptionInput.value.trim();
    if (/(不想|不要|不去|不爬|避免|排除)/.test(raw)) {
      showTip('这段描述含有排除条件，请点击“发送，理解我的偏好”，以免遗漏你的要求。', 'warn');
      return;
    }
    const keywords = parseKeywords(raw);
    if (keywords.length === 0) {
      showTip("请输入偏好描述或关键词。", "warn");
      return;
    }
    profileRequest++;
    if (profileController) profileController.abort();
    if (profileBtn.disabled) setBusy(profileBtn, false);
    currentProfile = null;
    initialProfile = null;
    profileArea.classList.add('hidden');
    const profile = {
      companion: { value: "未说明", evidence: "" },
      environment: { value: "未说明", evidence: "" },
      pace: { value: "未说明", evidence: "" },
      stamina: { value: "未说明", evidence: "" },
      interests: { value: keywords, evidence: "直接关键词输入" },
      excludes: { value: "未说明", evidence: "" }
    };
    showTip("正在按关键词直接匹配（已跳过画像提取）…", "ok");
    runMatch(profile, citySelect.value, "关键词直接匹配");
  }

  function onConfirm() {
    clearResult();
    if (!currentProfile) {
      showTip("请先生成并确认旅行偏好画像。", "warn");
      return;
    }
    if (profileList.querySelector('.profile-edit-input')) {
      showTip('请先保存或取消正在修改的画像，再确认匹配。', 'warn');
      return;
    }
    // 冲突检测：兴趣 ↔ 排除 指向同一类活动时明确提示，不擅自删除条件（需求 1）
    const conflicts = window.Matcher.detectConflicts(currentProfile);
    if (conflicts.length > 0) {
      renderConflict(conflicts);
      showTip("检测到画像条件冲突，请修改后重新匹配。", "warn");
      makeRun(currentProfile, citySelect.value, [], '偏好冲突', conflicts.map(c=>c.interest+' 与排除 '+c.exclude+' 冲突').join('；'));
      return;
    }
    conflictBox.classList.add("hidden");
    conflictBox.innerHTML = "";
    showTip("正在按你的旅行偏好画像匹配景点…", "ok");
    runMatch(currentProfile, citySelect.value, "画像确认匹配");
  }

  function renderConflict(conflicts) {
    conflictBox.classList.remove("hidden");
    conflictBox.innerHTML =
      '<div class="conflict-title">⚠️ 画像条件冲突，请修改后再匹配</div>' +
      conflicts.map(function (c) {
        return '<div class="conflict-line">你的「内容兴趣·' + escapeHtml(c.interest) +
          '」与「明确排除项·' + escapeHtml(c.exclude) +
          '」指向同一类活动（' + escapeHtml(c.sharedTags.join("、")) +
          '），无法同时成立。请修改或删除其中一项。</div>';
      }).join("");
  }

  function runMatch(profile, city, modeLabel) {
    clearResult();
    const cityName = city || "不限";
    const res = window.Matcher.matchAll(profile, attractions, attributes, city, 3);
    makeRun(profile, city, res, res.length ? '已匹配' : '无匹配结果', '', modeLabel);
    const run = currentRun;
    const signal = copyController.signal;

    if (!res.length) {
      resultArea.classList.add("hidden");
      let msg = "没有找到符合你偏好的景点。试试补充内容兴趣（如美食、拍照、古城），或把城市改为不限。";
      const ex = listValue(profile.excludes);
      if (ex.length) msg += "（已按排除项过滤：" + ex.join("、") + "）";
      showTip(msg, "warn");
      run.message = msg;
      return;
    }

    resultArea.classList.remove("hidden");
    matchNote.classList.remove("hidden");
    matchNote.innerHTML =
      '推荐依据见每张卡片。标为“尚不能确认”的条件需要进一步了解，不能视为已经满足。';

    const ex = listValue(profile.excludes);
    summaryBox.textContent =
      "匹配结果 · 城市：" + cityName +
      (ex.length ? " · 已排除：" + ex.join("、") : "") +
      (profile && !isUnset(profile.interests && profile.interests.value) ? " · 兴趣：" + formatValue(profile.interests.value) : "");

    cardsBox.innerHTML = "";
    // 先显示所有卡片；初次生成和手动重试共用队列，控制请求并发。
    Promise.all(res.map(function (r) {
      return renderCard(r, keywordsFromProfile(profile), profile);
    })).then(function (cards) {
      for (let index = 0; index < cards.length; index++) {
        if (currentRun !== run || signal.aborted) return;
        queueCopy(res[index].spot, keywordsFromProfile(profile), cards[index], profile, run.results[index], signal);
      }
    });
  }

  function keywordsFromProfile(profile) {
    if (!profile) return [];
    const kws = listValue(profile.interests);
    const env = profile.environment && profile.environment.value;
    if (env && !isUnset(env)) kws.push(env);
    return kws.filter(function (v, idx) { return kws.indexOf(v) === idx; });
  }

  function parseKeywords(raw) {
    return raw.split(/[\s,，、;；]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  // ---------------- 结果卡片（含画像匹配说明） ----------------
  function renderCard(result, keywords, profile) {
    const spot = result.spot;
    return new Promise(function (resolve) {
      const card = document.createElement("div");
      card.className = "card";
      card.dataset.id = spot.id;

      const top = document.createElement("div");
      top.className = "card-top";

      const photo = document.createElement("div");
      photo.className = "card-photo";
      if (spot.image) {
        const img = document.createElement("img");
        img.alt = spot.name;
        img.loading = "lazy";
        img.src = spot.image;
        img.addEventListener("error", function () {
          photo.classList.add("noimg");
          photo.textContent = "图片暂不可用，仅显示文字";
        });
        photo.appendChild(img);
      } else {
        photo.classList.add("noimg");
        photo.textContent = (spot.note || "").includes("配图待核验") ? "配图待核验，先看景点介绍" : "暂无图片";
      }
      top.appendChild(photo);

      const titleBox = document.createElement("div");
      titleBox.className = "card-title";
      const h3 = document.createElement("h3");
      h3.textContent = spot.name;
      const cityTag = document.createElement("span");
      cityTag.className = "city-tag";
      cityTag.textContent = spot.city;
      titleBox.appendChild(h3);
      titleBox.appendChild(cityTag);
      top.appendChild(titleBox);
      card.appendChild(top);

      const body = document.createElement("div");
      body.className = "card-body";

      // ---- 匹配说明（区分符合 / 尚不能确认 / 不符，引用资料依据）----
      const md = buildMatchDetail(result);
      body.appendChild(md);

      const reasonBlock = document.createElement("div");
      const reasonLabel = document.createElement("div");
      reasonLabel.className = "field-label";
      reasonLabel.textContent = "景点内容策划参考";
      const reasonText = document.createElement("div");
      reasonText.className = "reason";
      reasonText.textContent = spot.match_reason;
      reasonBlock.appendChild(reasonLabel);
      reasonBlock.appendChild(reasonText);
      body.appendChild(reasonBlock);

      const seasonLine = document.createElement("div");
      seasonLine.className = "season-line";
      seasonLine.innerHTML = "推荐季节：<b>" + escapeHtml(spot.season) + "</b>" + (spot.caution ? " · 提示：" + escapeHtml(spot.caution) : "");
      body.appendChild(seasonLine);

      const copyBlock = document.createElement("div");
      copyBlock.className = "copy-block";
      copyBlock.innerHTML = '<div class="field-label">传播标题与文案（80～120字）</div><div class="copy-loading">等待生成文案…</div>';
      body.appendChild(copyBlock);
      card.appendChild(body);

      const foot = document.createElement("div");
      foot.className = "card-foot";
      const src = document.createElement("span");
      if (spot.source) {
        const sourceUrl = new URL(spot.source);
        const homepage = sourceUrl.pathname === "/" || sourceUrl.pathname === "";
        src.innerHTML = (homepage ? "来源官网（待补具体页面）：" : "资料来源：") + "<a href=\"" + escapeAttr(spot.source) + "\" target=\"_blank\" rel=\"noopener\">" + escapeHtml(sourceUrl.hostname) + "</a>";
      } else {
        src.textContent = "事实来源：表格未提供";
      }
      const meta = document.createElement("span");
      meta.textContent = "表格标注核验日 " + spot.verified_date + (spot.license ? " · 表格所列授权：" + spot.license : "");
      foot.appendChild(src);
      foot.appendChild(meta);
      card.appendChild(foot);

      cardsBox.appendChild(card);
      resolve(card);
    });
  }

  function buildMatchDetail(result) {
    const wrap = document.createElement("div");
    wrap.className = "match-detail";

    // 部分符合提示（需求 6：只明确提示部分符合，不显示无依据的百分比）
    const summary = document.createElement("div");
    summary.className = "match-summary";
    summary.textContent =
      "该景点符合你 " + result.matched.length + " 项偏好，另有 " +
      result.unconfirmed.length + " 项暂无法确认" +
      (result.mismatched.length ? "，" + result.mismatched.length + " 项与偏好不符" : "") +
      "（仅供参考，非评分）。";
    wrap.appendChild(summary);

    if (result.matched.length) {
      const b = document.createElement("div");
      b.className = "md-block md-matched";
      b.innerHTML = '<div class="md-title">✓ 符合你的偏好</div>';
      result.matched.forEach(function (m) {
        const row = document.createElement("div");
        row.className = "md-row";
        row.innerHTML = "<b>" + escapeHtml(m.label) + "</b> —— " + escapeHtml(m.evidence);
        b.appendChild(row);
      });
      wrap.appendChild(b);
    }

    if (result.unconfirmed.length) {
      const b = document.createElement("div");
      b.className = "md-block md-unconfirmed";
      b.innerHTML = '<div class="md-title">？ 尚不能确认的条件</div>';
      result.unconfirmed.forEach(function (u) {
        const row = document.createElement("div");
        row.className = "md-row";
        row.textContent = u.note;
        b.appendChild(row);
      });
      wrap.appendChild(b);
    }

    if (result.mismatched.length) {
      const b = document.createElement("div");
      b.className = "md-block md-mismatched";
      b.innerHTML = '<div class="md-title">✗ 与你的偏好不符</div>';
      result.mismatched.forEach(function (m) {
        const row = document.createElement("div");
        row.className = "md-row";
        row.textContent = m.note;
        b.appendChild(row);
      });
      wrap.appendChild(b);
    }

    return wrap;
  }

  function waitForRetry(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal.aborted) { reject(new DOMException('请求已取消', 'AbortError')); return; }
      const onAbort = function () {
        clearTimeout(timer);
        reject(new DOMException('请求已取消', 'AbortError'));
      };
      const timer = setTimeout(function () {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function requestCopy(payload, signal, onRetry = function () {}) {
    // 后端已经重试模型接口；前端仅在连接失败时补试一次，避免重试层层叠加。
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) throw new DOMException('请求已取消', 'AbortError');
      let resp;
      try {
        resp = await fetch(API_COPY, {
          signal: signal,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      } catch (err) {
        if (signal.aborted || !(err instanceof TypeError) || attempt > 0) throw err;
        onRetry();
        await waitForRetry(1200, signal);
        continue;
      }
      let data;
      try { data = await resp.json(); }
      catch (err) { throw new Error('服务返回的内容不完整，请稍后重试。'); }
      if (!resp.ok || !data || !data.ok) {
        if (data && (data.error === 'API_KEY_NOT_CONFIGURED' || data.error === 'MODEL_NOT_CONFIGURED')) {
          configTip.classList.remove('hidden');
        }
        throw new Error((data && (data.message || data.error)) || '文案服务暂不可用，请稍后重试。');
      }
      return data;
    }
  }

  function queueCopy(spot, keywords, cardEl, profile, item, signal) {
    if (signal.aborted) return;
    item.copyStatus = 'pending';
    delete item.error;
    cardEl.querySelector('.copy-block').innerHTML = '<div class="copy-loading" role="status">等待生成文案…</div>';
    copyQueue = copyQueue.then(function () {
      if (signal.aborted) return;
      return genCopy(spot, keywords, cardEl, profile, item, signal);
    });
  }

  async function genCopy(spot, keywords, cardEl, profile, item, signal) {
    const copyBlock = cardEl.querySelector(".copy-block");
    copyBlock.innerHTML = '<div class="copy-loading" role="status">正在生成传播文案…</div>';
    try {
      const data = await requestCopy({
          keywords: keywords,
          profile: profile || null,
          spot: {
            name: spot.name,
            city: spot.city,
            intro: spot.intro,
            match_reason: spot.match_reason,
            season: spot.season,
            caution: spot.caution
          }
        }, signal, function () {
          copyBlock.innerHTML = '<div class="copy-loading" role="status">连接暂时中断，正在自动重试一次…</div>';
        });
      if (signal.aborted) return;
      if (typeof data.title !== 'string' || typeof data.copy !== 'string') throw new Error('模型未返回有效文案。');
      window.DemoRecords.setGenerated(item, data.title, data.copy);
      delete item.error;
      renderCopyEditor(copyBlock, item);
    } catch (err) {
      if (signal.aborted) return;
      item.copyStatus = 'error'; item.error = String(err);
      const message = err instanceof TypeError ? '连接暂时中断，请确认启动窗口仍开着，然后重试本张文案。' : err.message;
      copyBlock.innerHTML = '<div class="copy-error">文案生成失败：' + escapeHtml(message) +
        '</div><button type="button" class="mini-btn retry-copy">重新生成文案</button>';
      copyBlock.querySelector('.retry-copy').addEventListener('click', function () {
        queueCopy(spot, keywords, cardEl, profile, item, signal);
      });
    }
  }

  function makeRun(profile, city, results, status, message, modeLabel) {
    const direct = modeLabel === '关键词直接匹配';
    currentRun = window.DemoRecords.create(direct ? descriptionInput.value.trim() : profileInput, city,
      profile, direct ? null : initialProfile, isMock ? '模拟示例' : '真实模型请求', results, status, message);
    currentRun.model = modelName;
    document.getElementById('export-actions').classList.remove('hidden');
  }

  function exportRun(format) {
    if (!currentRun) return;
    if (cardsBox.querySelector('.copy-edit-title')) {
      showTip('请先保存或取消正在编辑的文案，再导出。', 'warn');
      return;
    }
    const content = format === 'json' ? JSON.stringify(currentRun, null, 2) : window.DemoRecords.toText(currentRun);
    const blob = new Blob(['\ufeff',content], {type:format === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = '鲁趣寻踪_演示记录_' + new Date().toISOString().replace(/[:.]/g,'-') + '.' + format;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    showTip('已导出演示记录。生成中或失败的文案会如实记录状态。', 'ok');
  }

  function renderCopyEditor(block, item) {
    const chars = Array.from(item.final.copy).length;
    block.innerHTML = '<div class="field-label">传播文案 · '+(isMock?'示例':'生成初稿')+'</div>' +
      '<div class="copy-title"></div><div class="copy-text"></div><div class="copy-meta"></div>' +
      '<div class="copy-actions"><button type="button" class="mini-btn edit-copy">编辑文案</button>' +
      '<button type="button" class="mini-btn copy-copy">复制标题与文案</button></div>' +
      '<label class="review-check"><input type="checkbox"> 我已对照资料审阅当前文案</label><div class="copy-feedback" role="status"></div>';
    block.querySelector('.copy-title').textContent = item.final.title;
    block.querySelector('.copy-text').textContent = item.final.copy;
    block.querySelector('.copy-meta').textContent = chars + ' 字符（含标点，建议 80～120） · '+(item.edits.length?'已人工修改':'尚未修改');
    block.querySelector('.copy-meta').classList.toggle('warn',chars<80||chars>120);
    const checkbox=block.querySelector('input'); checkbox.checked=item.reviewed;
    checkbox.addEventListener('change',function(){item.reviewed=checkbox.checked;});
    block.querySelector('.edit-copy').addEventListener('click',function(){
      block.innerHTML = '<label>传播标题<input class="copy-edit-title" type="text"></label>' +
        '<label>传播文案<textarea class="copy-edit-text" rows="6"></textarea></label>' +
        '<div class="copy-meta"></div><div class="copy-actions"><button type="button" class="mini-btn primary save-copy">保存修改</button>' +
        '<button type="button" class="mini-btn cancel-copy">取消</button></div><div class="copy-feedback" role="status"></div>';
      const title=block.querySelector('input'),body=block.querySelector('textarea');
      title.value=item.final.title; body.value=item.final.copy;
      const count=function(){block.querySelector('.copy-meta').textContent=Array.from(body.value).length+' 字符（含标点，建议 80～120）';};count();body.addEventListener('input',count);
      block.querySelector('.save-copy').addEventListener('click',function(){
        try {window.DemoRecords.saveEdit(item,title.value,body.value);renderCopyEditor(block,item);}
        catch(e){block.querySelector('.copy-feedback').textContent=e.message;}
      });
      block.querySelector('.cancel-copy').addEventListener('click',function(){renderCopyEditor(block,item);});
      title.focus();
    });
    block.querySelector('.copy-copy').addEventListener('click',async function(){
      try {await navigator.clipboard.writeText(item.final.title+'\n\n'+item.final.copy);block.querySelector('.copy-feedback').textContent='已复制。';}
      catch(e){block.querySelector('.copy-feedback').textContent='浏览器未允许复制，请选中文字后按 Ctrl+C。';}
    });
  }

  // ---------------- 工具函数 ----------------
  function formatValue(value) {
    if (Array.isArray(value)) return value.join("、");
    return String(value == null ? "" : value);
  }
  function isUnset(value) {
    if (Array.isArray(value)) return value.length === 0;
    return !value || String(value).trim() === "" || String(value).trim() === "未说明";
  }
  function listValue(item) {
    if (!item) return [];
    const v = item.value;
    if (Array.isArray(v)) return v.filter(Boolean);
    if (v && !isUnset(v)) return [v];
    return [];
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function escapeAttr(s) {
    return String(s == null ? "" : s).replace(/"/g, "&quot;");
  }
})();
