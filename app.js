/**
 * app.js
 * 横浜市保育園マップ - メインアプリケーションロジック
 */

// ========================================
// 定数・設定
// ========================================
const YOKOHAMA_CENTER = [35.4437, 139.6380];
const DEFAULT_ZOOM    = 12;

// 横浜市の18区
const WARDS = [
  "鶴見区", "神奈川区", "西区", "中区", "南区",
  "港南区", "保土ケ谷区", "旭区", "磯子区", "金沢区",
  "港北区", "緑区", "青葉区", "都筑区", "戸塚区",
  "栄区", "泉区", "瀬谷区"
];

// 年齢ラベル（CSV/JSON内のキー）
const AGE_KEYS = ["０歳", "１歳", "２歳", "３歳", "４歳", "５歳"];
const AGE_LABELS = ["0歳", "1歳", "2歳", "3歳", "4歳", "5歳"];

// 年度設定
const YEARS = [
  { key: "R5", label: "令和5年", dataFile: "data/r5_data.json" },
  { key: "R6", label: "令和6年", dataFile: "data/r6_data.json" },
  { key: "R7", label: "令和7年", dataFile: "data/r7_data.json" },
  { key: "R8", label: "令和8年", dataFile: "data/r8_202602.json" },
];
const DEFAULT_YEAR_IDX = 3;  // 令和8年をデフォルト

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
  geoData:      null,  // nurseries_geo.json
  yearData:     {},    // { "R8": {facilities: {...}} }
  yearIdx:      DEFAULT_YEAR_IDX,

  // フィルター条件
  filterType:   "all",  // "認可保育所" | "小規模保育" | "all"
  filterWard:   "all",  // "鶴見区" | ... | "all"
  filterStatus: "all",  // "ok" | "waiting" | "all"
  filterAges:   [],     // [] = 全年齢（フィルタなし）
  searchQuery:  "",

  // サイドパネル
  activeTab:    "list",  // "list" | "rank_ok" | "rank_wait"
  sortKey:      "name",  // "name" | "ward" | "ok" | "wait"

  // 表示中施設（フィルター後）
  visibleFacilities: [],
  selectedId:        null,
};

// ========================================
// DOM参照
// ========================================
let map;
let markerLayer;
let markerMap = {};  // id → Leafletマーカー

// ========================================
// 初期化
// ========================================
document.addEventListener("DOMContentLoaded", async () => {
  initMap();
  initUI();
  await loadData();
  renderAll();
});

function initMap() {
  map = L.map("map", {
    center: YOKOHAMA_CENTER,
    zoom: DEFAULT_ZOOM,
    zoomControl: true,
  });

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
    html: `<div class="cluster-icon" style="
      width:${size}px; height:${size}px;
      border-radius:50%;
      background:var(--color-primary);
      color:#fff;
      display:flex; align-items:center; justify-content:center;
      font-weight:900; font-size:${size > 40 ? 14 : 12}px;
      border:3px solid #fff;
      box-shadow:0 2px 8px rgba(0,0,0,0.2);
    ">${count}</div>`,
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function initUI() {
  // 区ドロップダウン生成
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

  // 区ドロップダウン
  wardSelect.addEventListener("change", () => {
    state.filterWard = wardSelect.value;
    applyFilters();
  });

  // 年齢チェックボックス
  document.querySelectorAll(".filter-age-cb").forEach(cb => {
    cb.addEventListener("change", () => {
      const checked = Array.from(document.querySelectorAll(".filter-age-cb:checked"))
        .map(el => el.value);
      state.filterAges = checked;
      applyFilters();
    });
  });

  // 検索
  const searchInput = document.getElementById("search-input");
  searchInput.addEventListener("input", () => {
    state.searchQuery = searchInput.value.trim();
    applyFilters();
  });

  // 年度スライダー
  const slider = document.getElementById("year-slider");
  slider.min = 0;
  slider.max = YEARS.length - 1;
  slider.value = DEFAULT_YEAR_IDX;
  slider.addEventListener("input", () => {
    updateYear(parseInt(slider.value));
  });

  // 年度ステップボタン
  const stepsContainer = document.getElementById("year-steps");
  YEARS.forEach((y, i) => {
    const btn = document.createElement("button");
    btn.className = "year-step-btn" + (i === DEFAULT_YEAR_IDX ? " active" : "");
    btn.textContent = y.label;
    btn.dataset.idx = i;
    btn.addEventListener("click", () => {
      updateYear(i);
      slider.value = i;
    });
    stepsContainer.appendChild(btn);
  });

  // サイドパネルタブ
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.activeTab = btn.dataset.tab;
      renderSidebar();
    });
  });

  // ソート
  const sortSelect = document.getElementById("sort-select");
  sortSelect.addEventListener("change", () => {
    state.sortKey = sortSelect.value;
    renderSidebar();
  });

  // モバイル用ドロワー
  const drawerHandle = document.getElementById("drawer-handle");
  const sidebar = document.getElementById("sidebar");
  if (drawerHandle) {
    drawerHandle.addEventListener("click", () => {
      sidebar.classList.toggle("open");
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
    // フィルター変更時にパネルを閉じる（UX向上）
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
    // 施設マスター（緯度経度付き）
    const geoRes = await fetch("data/nurseries_geo.json");
    if (geoRes.ok) {
      state.geoData = await geoRes.json();
    } else {
      showError("施設マスターデータ（nurseries_geo.json）が見つかりません。geocode.pyを実行してください。");
      state.geoData = { facilities: [] };
    }

    // 各年度データ
    for (const year of YEARS) {
      try {
        const res = await fetch(year.dataFile);
        if (res.ok) {
          state.yearData[year.key] = await res.json();
        }
      } catch {
        // データなし年度はスキップ
      }
    }
  } catch (e) {
    showError("データの読み込みに失敗しました。scripts/を実行してdata/を生成してください。");
    console.error(e);
  } finally {
    hideLoading();
  }
}

// ========================================
// 施設データ結合（マスター＋年度データ）
// ========================================
function getMergedFacilities() {
  const yearKey = YEARS[state.yearIdx].key;
  const yearData = state.yearData[yearKey];
  const geoFacilities = state.geoData?.facilities || [];

  if (!yearData) {
    return geoFacilities.map(f => ({
      ...f,
      enrolled: null,
      capacity: null,
      waiting:  null,
    }));
  }

  const yearMap = yearData.facilities || {};

  return geoFacilities.map(geo => {
    const stat = yearMap[geo.id] || null;
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
  let totalEnrolled = 0, totalCapacity = 0, totalWaiting = 0;

  ages.forEach(age => {
    totalEnrolled  += (facility.enrolled?.[age] || 0);
    totalCapacity  += (facility.capacity?.[age] || 0);
    totalWaiting   += (facility.waiting?.[age]  || 0);
  });

  return {
    enrolled: totalEnrolled,
    capacity: totalCapacity,
    waiting:  totalWaiting,
    vacancy:  Math.max(0, totalCapacity - totalEnrolled),
  };
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
  const allFacilities = getMergedFacilities();

  state.visibleFacilities = allFacilities.filter(f => {
    // 位置情報なし施設は除外
    if (f.lat == null || f.lng == null) return false;

    // 施設種別
    if (state.filterType !== "all" && f.type !== state.filterType) return false;

    // 区
    if (state.filterWard !== "all" && f.ward !== state.filterWard) return false;

    // 空き状況
    if (state.filterStatus !== "all") {
      const totals = calcTotals(f, state.filterAges);
      const status = getStatus(totals);
      if (state.filterStatus === "ok"      && status !== "ok")      return false;
      if (state.filterStatus === "waiting" && status !== "waiting") return false;
    }

    // 検索
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      if (!f.name.toLowerCase().includes(q) && !f.address.toLowerCase().includes(q)) {
        return false;
      }
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

    const colorClass = {
      ok:      "marker-ok",
      full:    "marker-full",
      waiting: "marker-waiting",
    }[status];

    const icon = L.divIcon({
      html: `<div class="custom-marker ${colorClass}"></div>`,
      className: "",
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -18],
    });

    const marker = L.marker([f.lat, f.lng], { icon });
    marker.bindPopup(() => createPopupContent(f, totals), {
      maxWidth: 320,
      className: "facility-popup",
    });

    marker.on("click", () => {
      state.selectedId = f.id;
      highlightCard(f.id);
    });

    markerLayer.addLayer(marker);
    markerMap[f.id] = marker;
  });
}

function createPopupContent(f, totals) {
  const ageRows = AGE_KEYS.map((age, i) => {
    const enrolled = f.enrolled?.[age] ?? "-";
    const capacity = f.capacity?.[age] ?? "-";
    const waiting  = f.waiting?.[age]  ?? "-";
    const vacancy  = (typeof capacity === "number" && typeof enrolled === "number")
      ? Math.max(0, capacity - enrolled) : "-";
    return `<tr>
      <th>${AGE_LABELS[i]}</th>
      <td class="enrolled">${enrolled}</td>
      <td class="vacancy">${vacancy}</td>
      <td class="waiting">${waiting}</td>
    </tr>`;
  }).join("");

  const el = document.createElement("div");
  el.className = "popup-inner";
  el.innerHTML = `
    <div class="popup-name">${escHtml(f.name)}</div>
    <div class="popup-ward">${escHtml(f.ward)} ・ ${escHtml(f.type)}</div>
    ${f.address ? `<div class="popup-address">📍 ${escHtml(f.address)}</div>` : ""}
    ${f.tel ? `<div class="popup-tel">📞 ${escHtml(f.tel)}</div>` : ""}
    <table class="popup-table">
      <thead>
        <tr>
          <th>年齢</th>
          <th class="enrolled">入所中</th>
          <th class="vacancy">空き</th>
          <th class="waiting">待ち</th>
        </tr>
      </thead>
      <tbody>
        ${ageRows}
        <tr style="font-weight:700; background:#f9f9f9">
          <th>合計</th>
          <td class="enrolled">${totals.enrolled}</td>
          <td class="vacancy">${totals.vacancy}</td>
          <td class="waiting">${totals.waiting}</td>
        </tr>
      </tbody>
    </table>
    ${f.ward && WARD_OFFICIAL_URLS[f.ward] ? `<a class="popup-link" href="${WARD_OFFICIAL_URLS[f.ward]}" target="_blank" rel="noopener">🏛️ ${escHtml(f.ward)}の公式保育所案内 ↗</a>` : ""}
  `;
  return el;
}

// ========================================
// サイドパネル描画
// ========================================
function renderSidebar() {
  const container = document.getElementById("facility-list");

  if (state.activeTab === "list") {
    renderFacilityList(container);
  } else if (state.activeTab === "rank_ok") {
    renderRanking(container, "ok");
  } else if (state.activeTab === "rank_wait") {
    renderRanking(container, "wait");
  }
}

function getSortedFacilities() {
  const facilities = [...state.visibleFacilities];

  facilities.forEach(f => {
    f._totals = calcTotals(f, state.filterAges);
    f._status = getStatus(f._totals);
  });

  return facilities.sort((a, b) => {
    switch (state.sortKey) {
      case "ward": {
        const cmp = (a.ward || "").localeCompare(b.ward || "", "ja");
        return cmp !== 0 ? cmp : (a.name || "").localeCompare(b.name || "", "ja");
      }
      case "ok":
        return b._totals.vacancy - a._totals.vacancy;
      case "wait":
        return b._totals.waiting - a._totals.waiting;
      default: // name
        return (a.name || "").localeCompare(b.name || "", "ja");
    }
  });
}

function renderFacilityList(container) {
  const sorted = getSortedFacilities();

  if (sorted.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🔍</div>
        <div class="empty-state-text">条件に合う施設が見つかりません</div>
      </div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  sorted.forEach(f => {
    const totals = f._totals;
    const status = f._status;

    const dotColor = { ok: "var(--color-ok)", full: "var(--color-full)", waiting: "var(--color-waiting)" }[status];

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
        <div class="card-num">
          <span class="card-num-label">入所中</span>
          <span class="card-num-val val-enrolled">${totals.enrolled}</span>
        </div>
        <div class="card-num">
          <span class="card-num-label">空き</span>
          <span class="card-num-val val-ok">${totals.vacancy}</span>
        </div>
        <div class="card-num">
          <span class="card-num-label">待ち</span>
          <span class="card-num-val val-waiting">${totals.waiting}</span>
        </div>
      </div>`;

    card.addEventListener("click", () => {
      focusFacility(f);
    });

    fragment.appendChild(card);
  });

  container.innerHTML = "";
  container.appendChild(fragment);
}

function renderRanking(container, rankType) {
  const sorted = [...state.visibleFacilities]
    .map(f => ({ ...f, _totals: calcTotals(f, state.filterAges) }))
    .sort((a, b) => {
      if (rankType === "ok") return b._totals.vacancy - a._totals.vacancy;
      return b._totals.waiting - a._totals.waiting;
    })
    .slice(0, 30);  // 上位30件

  if (sorted.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📊</div><div class="empty-state-text">データなし</div></div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  sorted.forEach((f, i) => {
    const val = rankType === "ok" ? f._totals.vacancy : f._totals.waiting;
    const valClass = rankType === "ok" ? "val-ok" : "val-waiting";
    const unit = rankType === "ok" ? "名 空き" : "名 待ち";

    const card = document.createElement("div");
    card.className = "rank-card";
    const rankClass = i < 3 ? `rank-${i + 1}` : "";
    card.innerHTML = `
      <div class="rank-num ${rankClass}">${i + 1}</div>
      <div class="rank-info">
        <div class="rank-name">${escHtml(f.name)}</div>
        <div class="rank-ward">${escHtml(f.ward)}</div>
      </div>
      <div class="rank-val ${valClass}">${val}<small style="font-size:11px">${unit}</small></div>`;

    card.addEventListener("click", () => focusFacility(f));
    fragment.appendChild(card);
  });

  container.innerHTML = "";
  container.appendChild(fragment);
}

// ========================================
// 年度切り替え
// ========================================
function updateYear(idx) {
  state.yearIdx = idx;
  const year = YEARS[idx];

  document.getElementById("year-label").textContent = year.label;

  // ステップボタン更新
  document.querySelectorAll(".year-step-btn").forEach(btn => {
    btn.classList.toggle("active", parseInt(btn.dataset.idx) === idx);
  });

  // スライダーグラデーション更新
  const slider = document.getElementById("year-slider");
  const pct = (idx / (YEARS.length - 1)) * 100;
  slider.style.background = `linear-gradient(to right, var(--color-primary) ${pct}%, var(--color-border) ${pct}%)`;

  // データがなければ読み込み
  if (!state.yearData[year.key]) {
    loadYearData(year).then(() => applyFilters());
  } else {
    applyFilters();
  }
}

async function loadYearData(year) {
  try {
    const res = await fetch(year.dataFile);
    if (res.ok) {
      state.yearData[year.key] = await res.json();
    }
  } catch (e) {
    console.warn(`[WARN] ${year.label} のデータが読み込めませんでした`);
  }
}

// ========================================
// ユーティリティ
// ========================================
function focusFacility(f) {
  state.selectedId = f.id;
  map.setView([f.lat, f.lng], 15, { animate: true });

  const marker = markerMap[f.id];
  if (marker) {
    markerLayer.zoomToShowLayer(marker, () => {
      marker.openPopup();
    });
  }

  highlightCard(f.id);

  // モバイルではドロワーを閉じる
  if (window.innerWidth <= 768) {
    document.getElementById("sidebar").classList.remove("open");
  }
}

function highlightCard(id) {
  document.querySelectorAll(".facility-card").forEach(card => {
    card.classList.toggle("active", card.dataset.id === id);
  });

  // アクティブカードをスクロール表示
  const activeCard = document.querySelector(`.facility-card[data-id="${id}"]`);
  if (activeCard) {
    activeCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function updateStats() {
  const facilities = state.visibleFacilities.map(f => ({
    ...f,
    _totals: calcTotals(f, state.filterAges),
    _status: getStatus(calcTotals(f, state.filterAges)),
  }));

  const okCount      = facilities.filter(f => f._status === "ok").length;
  const fullCount    = facilities.filter(f => f._status === "full").length;
  const waitCount    = facilities.filter(f => f._status === "waiting").length;

  document.getElementById("stat-ok").textContent      = okCount;
  document.getElementById("stat-full").textContent    = fullCount;
  document.getElementById("stat-waiting").textContent = waitCount;
}

function renderAll() {
  updateYear(state.yearIdx);
}

function showLoading(msg) {
  const overlay = document.getElementById("loading-overlay");
  const text    = document.getElementById("loading-text");
  if (text) text.textContent = msg;
  overlay.classList.remove("hidden");
}

function hideLoading() {
  document.getElementById("loading-overlay").classList.add("hidden");
}

function showError(msg) {
  const el = document.getElementById("error-msg");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 8000);
}

function escHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
