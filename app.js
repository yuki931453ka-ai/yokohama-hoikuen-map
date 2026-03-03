/**
 * app.js
 * 横浜市保育園マップ - メインアプリケーションロジック
 * 月次データ対応版（令和7年4月〜令和8年2月）
 */

// ========================================
// 定数・設定
// ========================================
const YOKOHAMA_CENTER = [35.4437, 139.6380];
const DEFAULT_ZOOM    = 12;

const WARDS = [
  "鶴見区", "神奈川区", "西区", "中区", "南区",
  "港南区", "保土ケ谷区", "旭区", "磯子区", "金沢区",
  "港北区", "緑区", "青葉区", "都筑区", "戸塚区",
  "栄区", "泉区", "瀬谷区"
];

const AGE_KEYS   = ["０歳", "１歳", "２歳", "３歳", "４歳", "５歳"];
const AGE_LABELS = ["0歳", "1歳", "2歳", "3歳", "4歳", "5歳"];

// 月次データリスト（古い順）
const MONTHS = [
  { key: "r7_04", label: "令和7年4月",  file: "data/monthly/r7_04.json" },
  { key: "r7_05", label: "令和7年5月",  file: "data/monthly/r7_05.json" },
  { key: "r7_06", label: "令和7年6月",  file: "data/monthly/r7_06.json" },
  { key: "r7_07", label: "令和7年7月",  file: "data/monthly/r7_07.json" },
  { key: "r7_08", label: "令和7年8月",  file: "data/monthly/r7_08.json" },
  { key: "r7_09", label: "令和7年9月",  file: "data/monthly/r7_09.json" },
  { key: "r7_10", label: "令和7年10月", file: "data/monthly/r7_10.json" },
  { key: "r7_11", label: "令和7年11月", file: "data/monthly/r7_11.json" },
  { key: "r7_12", label: "令和7年12月", file: "data/monthly/r7_12.json" },
  { key: "r8_01", label: "令和8年1月",  file: "data/monthly/r8_01.json" },
  { key: "r8_02", label: "令和8年2月",  file: "data/monthly/r8_02.json" },
];
const DEFAULT_MONTH_IDX = MONTHS.length - 1;  // 最新月（令和8年2月）

// 区ごとの横浜市公式保育所案内ページ
const WARD_OFFICIAL_URLS = {
  "鶴見区":    "https://www.city.yokohama.lg.jp/tsurumi/kurashi/kosodatekyoiku/hoikusho/",
  "神奈川区":  "https://www.city.yokohama.lg.jp/kanagawa/kurashi/kosodatekyoiku/hoikusho/",
  "西区":      "https://www.city.yokohama.lg.jp/nishi/kurashi/kosodatekyoiku/hoikusho/",
  "中区":      "https://www.city.yokohama.lg.jp/naka/kurashi/kosodatekyoiku/hoikusho/",
  "南区":      "https://www.city.yokohama.lg.jp/minami/kurashi/kosodatekyoiku/hoikusho/",
  "港南区":    "https://www.city.yokohama.lg.jp/konan/kurashi/kosodatekyoiku/hoikusho/",
  "保土ケ谷区":"https://www.city.yokohama.lg.jp/hodogaya/kurashi/kosodatekyoiku/hoikusho/",
  "旭区":      "https://www.city.yokohama.lg.jp/asahi/kurashi/kosodatekyoiku/hoikusho/",
  "磯子区":    "https://www.city.yokohama.lg.jp/isogo/kurashi/kosodatekyoiku/hoikusho/",
  "金沢区":    "https://www.city.yokohama.lg.jp/kanazawa/kurashi/kosodatekyoiku/hoikusho/",
  "港北区":    "https://www.city.yokohama.lg.jp/kohoku/kurashi/kosodatekyoiku/hoikusho/",
  "緑区":      "https://www.city.yokohama.lg.jp/midori/kurashi/kosodatekyoiku/hoikusho/",
  "青葉区":    "https://www.city.yokohama.lg.jp/aoba/kurashi/kosodatekyoiku/hoikusho/",
  "都筑区":    "https://www.city.yokohama.lg.jp/tsuzuki/kurashi/kosodatekyoiku/hoikusho/",
  "戸塚区":    "https://www.city.yokohama.lg.jp/totsuka/kurashi/kosodatekyoiku/hoikusho/",
  "栄区":      "https://www.city.yokohama.lg.jp/sakae/kurashi/kosodatekyoiku/hoikusho/",
  "泉区":      "https://www.city.yokohama.lg.jp/izumi/kurashi/kosodatekyoiku/hoikusho/",
  "瀬谷区":    "https://www.city.yokohama.lg.jp/seya/kurashi/kosodatekyoiku/hoikusho/",
};

// ========================================
// アプリ状態
// ========================================
const state = {
  geoData:    null,
  monthData:  {},       // { "r7_04": {facilities:{...}}, ... }
  monthIdx:   DEFAULT_MONTH_IDX,

  filterType:   "all",
  filterWard:   "all",
  filterStatus: "all",
  filterAges:   [],
  searchQuery:  "",

  activeTab:  "list",
  sortKey:    "name",

  visibleFacilities: [],
  selectedId:        null,
};

// ========================================
// DOM / 地図
// ========================================
let map, markerLayer;
let markerMap = {};

document.addEventListener("DOMContentLoaded", async () => {
  initMap();
  initUI();
  await loadData();
  updateMonth(state.monthIdx);
});

function initMap() {
  map = L.map("map", { center: YOKOHAMA_CENTER, zoom: DEFAULT_ZOOM });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18,
  }).addTo(map);

  markerLayer = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 50,
    iconCreateFunction: createClusterIcon,
  });
  map.addLayer(markerLayer);
}

function createClusterIcon(cluster) {
  const count = cluster.getChildCount();
  const size = count < 10 ? 36 : count < 50 ? 44 : 52;
  return L.divIcon({
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:var(--color-primary);color:#fff;
      display:flex;align-items:center;justify-content:center;
      font-weight:900;font-size:${size>40?14:12}px;
      border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.2)
    ">${count}</div>`,
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// ========================================
// UI初期化
// ========================================
function initUI() {
  // 区ドロップダウン
  const wardSelect = document.getElementById("filter-ward");
  WARDS.forEach(ward => {
    const opt = document.createElement("option");
    opt.value = ward;
    opt.textContent = ward;
    wardSelect.appendChild(opt);
  });

  // 施設種別ボタン
  document.querySelectorAll(".filter-type-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-type-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.filterType = btn.dataset.type;
      applyFilters();
    });
  });

  // 空き状況ボタン
  document.querySelectorAll(".filter-status-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-status-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.filterStatus = btn.dataset.status;
      applyFilters();
    });
  });

  wardSelect.addEventListener("change", () => {
    state.filterWard = wardSelect.value;
    applyFilters();
  });

  document.querySelectorAll(".filter-age-cb").forEach(cb => {
    cb.addEventListener("change", () => {
      state.filterAges = Array.from(document.querySelectorAll(".filter-age-cb:checked")).map(el => el.value);
      applyFilters();
    });
  });

  document.getElementById("search-input").addEventListener("input", e => {
    state.searchQuery = e.target.value.trim();
    applyFilters();
  });

  // 月次スライダー
  const slider = document.getElementById("month-slider");
  slider.min   = 0;
  slider.max   = MONTHS.length - 1;
  slider.value = DEFAULT_MONTH_IDX;
  updateSliderGradient(slider, DEFAULT_MONTH_IDX);

  slider.addEventListener("input", () => {
    updateMonth(parseInt(slider.value));
  });

  // ← → 矢印ボタン
  document.getElementById("month-prev").addEventListener("click", () => {
    if (state.monthIdx > 0) {
      const newIdx = state.monthIdx - 1;
      document.getElementById("month-slider").value = newIdx;
      updateMonth(newIdx);
    }
  });
  document.getElementById("month-next").addEventListener("click", () => {
    if (state.monthIdx < MONTHS.length - 1) {
      const newIdx = state.monthIdx + 1;
      document.getElementById("month-slider").value = newIdx;
      updateMonth(newIdx);
    }
  });

  // タブ
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.activeTab = btn.dataset.tab;
      renderSidebar();
    });
  });

  // ソート
  document.getElementById("sort-select").addEventListener("change", e => {
    state.sortKey = e.target.value;
    renderSidebar();
  });

  // モバイル用ドロワー
  const drawerHandle = document.getElementById("drawer-handle");
  if (drawerHandle) {
    drawerHandle.addEventListener("click", () => {
      document.getElementById("sidebar").classList.toggle("open");
    });
  }

  // モバイル用フィルタートグル
  const filterToggleBtn = document.getElementById("filter-toggle-btn");
  const filterBar = document.getElementById("filter-bar");
  if (filterToggleBtn && filterBar) {
    filterToggleBtn.addEventListener("click", () => {
      const isOpen = filterBar.classList.toggle("open");
      filterToggleBtn.textContent = isOpen ? "✕ 閉じる" : "🔧 絞込";
    });
    filterBar.addEventListener("change", () => {
      if (window.innerWidth <= 768) {
        filterBar.classList.remove("open");
        filterToggleBtn.textContent = "🔧 絞込";
      }
    });
  }
}

// ========================================
// データ読み込み
// ========================================
async function loadData() {
  showLoading("データを読み込んでいます...");
  try {
    const geoRes = await fetch("data/nurseries_geo.json");
    if (geoRes.ok) {
      state.geoData = await geoRes.json();
    } else {
      showError("施設マスターデータが見つかりません。geocode.pyを実行してください。");
      state.geoData = { facilities: [] };
    }

    // 最新月だけ先読み（他は遅延読み込み）
    const latestMonth = MONTHS[DEFAULT_MONTH_IDX];
    const res = await fetch(latestMonth.file);
    if (res.ok) state.monthData[latestMonth.key] = await res.json();

  } catch (e) {
    showError("データの読み込みに失敗しました。");
    console.error(e);
  } finally {
    hideLoading();
  }
}

async function ensureMonthData(monthKey) {
  if (state.monthData[monthKey]) return;
  const month = MONTHS.find(m => m.key === monthKey);
  if (!month) return;
  try {
    const res = await fetch(month.file);
    if (res.ok) state.monthData[monthKey] = await res.json();
  } catch (e) {
    console.warn(`[WARN] ${month.label} のデータを読み込めませんでした`);
  }
}

// ========================================
// 施設データ結合
// ========================================
function getMergedFacilities() {
  const monthKey   = MONTHS[state.monthIdx].key;
  const monthData  = state.monthData[monthKey];
  const geoFacilities = state.geoData?.facilities || [];

  const monthMap = monthData?.facilities || {};
  return geoFacilities.map(geo => {
    const stat = monthMap[geo.id] || null;
    return {
      ...geo,
      enrolled: stat?.enrolled || null,
      capacity: stat?.capacity || null,
      waiting:  stat?.waiting  || null,
    };
  });
}

function calcTotals(facility, ageFilter) {
  const ages = ageFilter.length > 0 ? ageFilter : AGE_KEYS;
  let enrolled = 0, capacity = 0, waiting = 0;
  ages.forEach(age => {
    enrolled += (facility.enrolled?.[age] || 0);
    capacity += (facility.capacity?.[age] || 0);
    waiting  += (facility.waiting?.[age]  || 0);
  });
  return { enrolled, capacity, waiting, vacancy: Math.max(0, capacity - enrolled) };
}

function getStatus(totals) {
  if (totals.waiting > 0) return "waiting";
  if (totals.vacancy > 0) return "ok";
  return "full";
}

// ========================================
// フィルタリング
// ========================================
function applyFilters() {
  state.visibleFacilities = getMergedFacilities().filter(f => {
    if (f.lat == null || f.lng == null) return false;
    if (state.filterType !== "all" && f.type !== state.filterType) return false;
    if (state.filterWard !== "all" && f.ward !== state.filterWard) return false;
    if (state.filterStatus !== "all") {
      const status = getStatus(calcTotals(f, state.filterAges));
      if (state.filterStatus === "ok"      && status !== "ok")      return false;
      if (state.filterStatus === "waiting" && status !== "waiting") return false;
    }
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      if (!f.name.toLowerCase().includes(q) && !(f.address || "").toLowerCase().includes(q)) return false;
    }
    return true;
  });
  renderMap();
  renderSidebar();
  updateStats();
}

// ========================================
// 地図描画
// ========================================
function renderMap() {
  markerLayer.clearLayers();
  markerMap = {};

  state.visibleFacilities.forEach(f => {
    const totals = calcTotals(f, state.filterAges);
    const status = getStatus(totals);
    const colorClass = { ok:"marker-ok", full:"marker-full", waiting:"marker-waiting" }[status];

    const icon = L.divIcon({
      html: `<div class="custom-marker ${colorClass}"></div>`,
      className: "",
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -18],
    });

    const marker = L.marker([f.lat, f.lng], { icon });
    marker.bindPopup(() => createPopupContent(f, totals), { maxWidth: 320 });
    marker.on("click", () => { state.selectedId = f.id; highlightCard(f.id); });
    markerLayer.addLayer(marker);
    markerMap[f.id] = marker;
  });
}

function createPopupContent(f, totals) {
  const monthLabel = MONTHS[state.monthIdx].label;
  const ageRows = AGE_KEYS.map((age, i) => {
    const e = f.enrolled?.[age] ?? "-";
    const c = f.capacity?.[age] ?? "-";
    const w = f.waiting?.[age]  ?? "-";
    const v = (typeof c === "number" && typeof e === "number") ? Math.max(0, c - e) : "-";
    return `<tr>
      <th>${AGE_LABELS[i]}</th>
      <td class="enrolled">${e}</td>
      <td class="vacancy">${v}</td>
      <td class="waiting">${w}</td>
    </tr>`;
  }).join("");

  const el = document.createElement("div");
  el.className = "popup-inner";
  el.innerHTML = `
    <div class="popup-name">${escHtml(f.name)}</div>
    <div class="popup-ward">${escHtml(f.ward)} ・ ${escHtml(f.type || "")} <span style="font-size:11px;color:#aaa;">（${monthLabel}）</span></div>
    ${f.address ? `<div class="popup-address">📍 ${escHtml(f.address)}</div>` : ""}
    ${f.tel     ? `<div class="popup-tel">📞 ${escHtml(f.tel)}</div>` : ""}
    <table class="popup-table">
      <thead><tr><th>年齢</th><th class="enrolled">入所中</th><th class="vacancy">空き</th><th class="waiting">待ち</th></tr></thead>
      <tbody>
        ${ageRows}
        <tr style="font-weight:700;background:#f9f9f9">
          <th>計</th>
          <td class="enrolled">${totals.enrolled}</td>
          <td class="vacancy">${totals.vacancy}</td>
          <td class="waiting">${totals.waiting}</td>
        </tr>
      </tbody>
    </table>
    ${f.ward && WARD_OFFICIAL_URLS[f.ward]
      ? `<a class="popup-link" href="${WARD_OFFICIAL_URLS[f.ward]}" target="_blank" rel="noopener">🏛️ ${escHtml(f.ward)}の公式保育所案内 ↗</a>`
      : ""}
  `;
  return el;
}

// ========================================
// サイドパネル
// ========================================
function renderSidebar() {
  const container = document.getElementById("facility-list");
  if (state.activeTab === "list") renderFacilityList(container);
  else if (state.activeTab === "rank_ok")   renderRanking(container, "ok");
  else if (state.activeTab === "rank_wait") renderRanking(container, "wait");
}

function getSortedFacilities() {
  return [...state.visibleFacilities]
    .map(f => ({ ...f, _totals: calcTotals(f, state.filterAges), _status: getStatus(calcTotals(f, state.filterAges)) }))
    .sort((a, b) => {
      switch (state.sortKey) {
        case "ward": { const c = (a.ward||"").localeCompare(b.ward||"","ja"); return c||((a.name||"").localeCompare(b.name||"","ja")); }
        case "ok":   return b._totals.vacancy - a._totals.vacancy;
        case "wait": return b._totals.waiting - a._totals.waiting;
        default:     return (a.name||"").localeCompare(b.name||"","ja");
      }
    });
}

function renderFacilityList(container) {
  const sorted = getSortedFacilities();
  if (!sorted.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔍</div><div class="empty-state-text">条件に合う施設が見つかりません</div></div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  sorted.forEach(f => {
    const { vacancy, waiting, enrolled } = f._totals;
    const dotColor = { ok:"var(--color-ok)", full:"var(--color-full)", waiting:"var(--color-waiting)" }[f._status];
    const card = document.createElement("div");
    card.className = "facility-card" + (f.id === state.selectedId ? " active" : "");
    card.dataset.id = f.id;
    card.innerHTML = `
      <div class="card-header">
        <div class="card-status-dot" style="background:${dotColor}"></div>
        <div class="card-name">${escHtml(f.name)}</div>
        <div class="card-ward">${escHtml(f.ward)}</div>
      </div>
      <div class="card-numbers">
        <div class="card-num"><span class="card-num-label">入所中</span><span class="card-num-val val-enrolled">${enrolled}</span></div>
        <div class="card-num"><span class="card-num-label">空き</span><span class="card-num-val val-ok">${vacancy}</span></div>
        <div class="card-num"><span class="card-num-label">待ち</span><span class="card-num-val val-waiting">${waiting}</span></div>
      </div>`;
    card.addEventListener("click", () => focusFacility(f));
    frag.appendChild(card);
  });
  container.innerHTML = "";
  container.appendChild(frag);
}

function renderRanking(container, rankType) {
  const sorted = [...state.visibleFacilities]
    .map(f => ({ ...f, _totals: calcTotals(f, state.filterAges) }))
    .sort((a, b) => rankType === "ok" ? b._totals.vacancy - a._totals.vacancy : b._totals.waiting - a._totals.waiting)
    .slice(0, 30);

  if (!sorted.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📊</div><div class="empty-state-text">データなし</div></div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  sorted.forEach((f, i) => {
    const val = rankType === "ok" ? f._totals.vacancy : f._totals.waiting;
    const valClass = rankType === "ok" ? "val-ok" : "val-waiting";
    const unit = rankType === "ok" ? "名 空き" : "名 待ち";
    const card = document.createElement("div");
    card.className = "rank-card";
    const rankClass = i < 3 ? `rank-${i+1}` : "";
    card.innerHTML = `
      <div class="rank-num ${rankClass}">${i+1}</div>
      <div class="rank-info"><div class="rank-name">${escHtml(f.name)}</div><div class="rank-ward">${escHtml(f.ward)}</div></div>
      <div class="rank-val ${valClass}">${val}<small style="font-size:11px">${unit}</small></div>`;
    card.addEventListener("click", () => focusFacility(f));
    frag.appendChild(card);
  });
  container.innerHTML = "";
  container.appendChild(frag);
}

// ========================================
// 月次切り替え
// ========================================
function updateMonth(idx) {
  state.monthIdx = idx;
  const month = MONTHS[idx];

  document.getElementById("month-label").textContent = month.label;

  // ← → ボタンの活性制御
  document.getElementById("month-prev").disabled = (idx === 0);
  document.getElementById("month-next").disabled = (idx === MONTHS.length - 1);

  // スライダーのグラデーション更新
  const slider = document.getElementById("month-slider");
  updateSliderGradient(slider, idx);

  // データ読み込み後にフィルター適用
  ensureMonthData(month.key).then(() => applyFilters());
}

function updateSliderGradient(slider, idx) {
  const pct = MONTHS.length > 1 ? (idx / (MONTHS.length - 1)) * 100 : 100;
  slider.style.background = `linear-gradient(to right, var(--color-primary) ${pct}%, var(--color-border) ${pct}%)`;
}

// ========================================
// ユーティリティ
// ========================================
function focusFacility(f) {
  state.selectedId = f.id;
  map.setView([f.lat, f.lng], 15, { animate: true });
  const marker = markerMap[f.id];
  if (marker) markerLayer.zoomToShowLayer(marker, () => marker.openPopup());
  highlightCard(f.id);
  if (window.innerWidth <= 768) document.getElementById("sidebar").classList.remove("open");
}

function highlightCard(id) {
  document.querySelectorAll(".facility-card").forEach(c => c.classList.toggle("active", c.dataset.id === id));
  const active = document.querySelector(`.facility-card[data-id="${id}"]`);
  if (active) active.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function updateStats() {
  const facs = state.visibleFacilities.map(f => ({ _status: getStatus(calcTotals(f, state.filterAges)) }));
  document.getElementById("stat-ok").textContent      = facs.filter(f => f._status === "ok").length;
  document.getElementById("stat-full").textContent    = facs.filter(f => f._status === "full").length;
  document.getElementById("stat-waiting").textContent = facs.filter(f => f._status === "waiting").length;
}

function showLoading(msg) {
  const el = document.getElementById("loading-overlay");
  const t  = document.getElementById("loading-text");
  if (t) t.textContent = msg;
  el.classList.remove("hidden");
}
function hideLoading() { document.getElementById("loading-overlay").classList.add("hidden"); }

function showError(msg) {
  const el = document.getElementById("error-msg");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 8000);
}

function escHtml(str) {
  if (!str) return "";
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
