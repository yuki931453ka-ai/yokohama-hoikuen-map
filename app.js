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
  "鶴見区":    "https://www.city.yokohama.lg.jp/tsurumi/",
  "神奈川区":  "https://www.city.yokohama.lg.jp/kanagawa/",
  "西区":      "https://www.city.yokohama.lg.jp/nishi/",
  "中区":      "https://www.city.yokohama.lg.jp/naka/",
  "南区":      "https://www.city.yokohama.lg.jp/minami/",
  "港南区":    "https://www.city.yokohama.lg.jp/konan/",
  "保土ケ谷区":"https://www.city.yokohama.lg.jp/hodogaya/",
  "旭区":      "https://www.city.yokohama.lg.jp/asahi/",
  "磯子区":    "https://www.city.yokohama.lg.jp/isogo/",
  "金沢区":    "https://www.city.yokohama.lg.jp/kanazawa/",
  "港北区":    "https://www.city.yokohama.lg.jp/kohoku/",
  "緑区":      "https://www.city.yokohama.lg.jp/midori/",
  "青葉区":    "https://www.city.yokohama.lg.jp/aoba/",
  "都筑区":    "https://www.city.yokohama.lg.jp/tsuzuki/",
  "戸塚区":    "https://www.city.yokohama.lg.jp/totsuka/",
  "栄区":      "https://www.city.yokohama.lg.jp/sakae/",
  "泉区":      "https://www.city.yokohama.lg.jp/izumi/",
  "瀬谷区":    "https://www.city.yokohama.lg.jp/seya/",
};

// 移動速度（km/h）※子ども同乗の送迎を想定
const TRAVEL_SPEEDS = {
  walk:    3.5,   // 徒歩（子ども連れ・ベビーカー）
  bicycle: 10.0,  // 自転車（チャイルドシート付き）
  car:     30.0,  // 車（市街地）
};
const HOME_RADIUS_KM = 5;  // 自宅からの検索半径

// OSRM API 設定
const OSRM_BASE = "https://router.project-osrm.org/route/v1";
const OSRM_PROFILES = {
  walk:    "foot",
  bicycle: "bike",
  car:     "driving",
};
const routeCache = {};  // キー: "lat,lng>lat,lng" → { walk, bicycle, car }
let activeRouteLayer = null;  // 地図上のルート表示用

// ========================================
// アプリ状態
// ========================================
const state = {
  geoData:    null,
  monthData:  {},       // { "r7_04": {facilities:{...}}, ... }
  monthIdx:   DEFAULT_MONTH_IDX,

  filterType:          "all",
  filterWard:          "all",
  filterStatus:        "all",
  filterAges:          [],
  filterTempChildcare: false,  // true = 一時保育ありのみ表示
  searchQuery:         "",
  filterHomeRadius:    false,  // true = 自宅5km圏内のみ表示

  activeTab:  "list",
  sortKey:    "name",

  visibleFacilities: [],
  selectedId:        null,

  homeLocation: null,  // { lat, lng, address }
};

// ========================================
// DOM / 地図
// ========================================
let map, markerLayer;
let markerMap = {};
let homeMarker = null;
let homeCircle = null;

document.addEventListener("DOMContentLoaded", async () => {
  initMap();
  initUI();
  initHome();
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

  // ポップアップが開いた時にOSRMルート検索を開始（map レベルで捕捉）
  map.on("popupopen", (e) => {
    if (!state.homeLocation) return;
    const popup = e.popup;
    const marker = popup._source;
    const facility = marker?._facilityData;
    if (!facility) return;
    const popupEl = popup.getElement();
    if (popupEl) {
      console.log("[OSRM] popupopen fired for:", facility.name);
      updatePopupWithRoute(facility, popupEl);
    }
  });
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

  // 一時保育フィルター
  const tempBtn = document.getElementById("filter-temp-btn");
  if (tempBtn) {
    tempBtn.addEventListener("click", () => {
      state.filterTempChildcare = !state.filterTempChildcare;
      tempBtn.classList.toggle("active", state.filterTempChildcare);
      applyFilters();
    });
  }

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
    if (state.filterTempChildcare && f.temp_childcare !== "あり") return false;

    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      if (!f.name.toLowerCase().includes(q) && !(f.address || "").toLowerCase().includes(q)) return false;
    }

    // 自宅5km圏内フィルター
    if (state.filterHomeRadius && state.homeLocation) {
      const dist = calcDistanceKm(state.homeLocation.lat, state.homeLocation.lng, f.lat, f.lng);
      if (dist > HOME_RADIUS_KM) return false;
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
    marker._facilityData = f;  // ルート検索用にデータを保持
    marker.bindPopup(() => createPopupContent(f, totals), { maxWidth: 320 });
    marker.on("click", () => {
      clearRouteFromMap();
      state.selectedId = f.id;
      highlightCard(f.id);
    });
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
    <div class="popup-badges">
      ${f.temp_childcare === "あり"  ? '<span class="badge badge-temp-ok">🧒 一時保育あり</span>' : ""}
      ${f.temp_childcare === "なし"  ? '<span class="badge badge-temp-no">一時保育なし</span>'    : ""}
      ${(!f.temp_childcare)          ? '<span class="badge badge-temp-unknown">一時保育不明</span>': ""}
    </div>
    ${f.address ? `<div class="popup-address">📍 ${escHtml(f.address)}</div>` : ""}
    ${f.tel     ? `<div class="popup-tel">📞 ${escHtml(f.tel)}</div>` : ""}
    ${(() => {
      const di = getDistanceInfo(f);
      if (!di) return "";
      return `<div class="popup-distance">
        <span class="popup-dist-val">📐 直線距離 ${formatDistance(di.distance)}</span>
        <div class="popup-travel-times">
          <span>🚶 ≈${formatTravelTime(di.walk)}</span>
          <span>🚲 ≈${formatTravelTime(di.bicycle)}</span>
          <span>🚗 ≈${formatTravelTime(di.car)}</span>
        </div>
      </div>
      <div class="popup-route-section"></div>`;
    })()}
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
    <div class="popup-links">
      ${f.official_url
        ? `<a class="popup-link popup-link-hp" href="${escHtml(f.official_url)}" target="_blank" rel="noopener">🏠 公式HP ↗</a>`
        : `<a class="popup-link popup-link-hp popup-link-search" href="https://www.google.com/search?q=${encodeURIComponent(f.name + ' 横浜市 公式サイト')}" target="_blank" rel="noopener">🔍 公式HP検索 ↗</a>`}
      ${f.review_url && f.review_site === "minkou"
        ? `<a class="popup-link popup-link-review" href="${escHtml(f.review_url)}" target="_blank" rel="noopener">💬 みんなの口コミ ↗</a>`
        : f.review_url && f.review_site === "hoicil"
        ? `<a class="popup-link popup-link-review" href="${escHtml(f.review_url)}" target="_blank" rel="noopener">💬 ホイシルで見る ↗</a>`
        : ""}
      ${f.ward && WARD_OFFICIAL_URLS[f.ward]
        ? `<a class="popup-link popup-link-ward" href="${WARD_OFFICIAL_URLS[f.ward]}" target="_blank" rel="noopener">🏛️ ${escHtml(f.ward)}の保育所案内 ↗</a>`
        : ""}
    </div>
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
    .map(f => {
      const _totals = calcTotals(f, state.filterAges);
      const _distInfo = getDistanceInfo(f);
      return { ...f, _totals, _status: getStatus(_totals), _distInfo };
    })
    .sort((a, b) => {
      switch (state.sortKey) {
        case "ward": { const c = (a.ward||"").localeCompare(b.ward||"","ja"); return c||((a.name||"").localeCompare(b.name||"","ja")); }
        case "ok":   return b._totals.vacancy - a._totals.vacancy;
        case "wait": return b._totals.waiting - a._totals.waiting;
        case "dist": return (a._distInfo?.distance ?? 999) - (b._distInfo?.distance ?? 999);
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
    const tempBadge = f.temp_childcare === "あり"
      ? '<span class="badge badge-temp-ok">🧒 一時保育</span>' : "";
    const reviewLink = f.review_url && f.review_site === "minkou"
      ? `<a class="card-link card-link-review" href="${escHtml(f.review_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">💬 みんなの口コミ</a>`
      : f.review_url && f.review_site === "hoicil"
      ? `<a class="card-link card-link-review" href="${escHtml(f.review_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">💬 ホイシル</a>`
      : "";
    const hpLink = f.official_url
      ? `<a class="card-link card-link-hp" href="${escHtml(f.official_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">🏠 公式HP</a>`
      : "";
    // 距離・所要時間
    const di = f._distInfo;
    const distHtml = di ? `
      <div class="card-distance">
        <span class="card-dist-val">${formatDistance(di.distance)}</span>
        <span class="card-travel">🚶${formatTravelTime(di.walk)}</span>
        <span class="card-travel">🚲${formatTravelTime(di.bicycle)}</span>
        <span class="card-travel">🚗${formatTravelTime(di.car)}</span>
      </div>` : "";
    card.innerHTML = `
      <div class="card-header">
        <div class="card-status-dot" style="background:${dotColor}"></div>
        <div class="card-name">${escHtml(f.name)}${tempBadge}</div>
        <div class="card-ward">${escHtml(f.ward)}</div>
      </div>
      ${distHtml}
      <div class="card-numbers">
        <div class="card-num"><span class="card-num-label">入所中</span><span class="card-num-val val-enrolled">${enrolled}</span></div>
        <div class="card-num"><span class="card-num-label">空き</span><span class="card-num-val val-ok">${vacancy}</span></div>
        <div class="card-num"><span class="card-num-label">待ち</span><span class="card-num-val val-waiting">${waiting}</span></div>
      </div>
      ${(reviewLink || hpLink) ? `<div class="card-links">${hpLink}${reviewLink}</div>` : ""}`;
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
// 自宅設定
// ========================================
function initHome() {
  // localStorageから復元
  const saved = localStorage.getItem("hoikuen_home");
  if (saved) {
    try {
      state.homeLocation = JSON.parse(saved);
      state.filterHomeRadius = true;
    } catch (e) { /* ignore */ }
  }

  // 自宅設定ボタン
  const homeBtn = document.getElementById("home-set-btn");
  if (homeBtn) {
    homeBtn.addEventListener("click", () => openHomeModal());
    updateHomeBtnLabel();
  }

  // 5km圏内フィルターボタン
  const radiusBtn = document.getElementById("filter-radius-btn");
  if (radiusBtn) {
    radiusBtn.addEventListener("click", () => {
      if (!state.homeLocation) { openHomeModal(); return; }
      state.filterHomeRadius = !state.filterHomeRadius;
      radiusBtn.classList.toggle("active", state.filterHomeRadius);
      applyFilters();
    });
    radiusBtn.classList.toggle("active", state.filterHomeRadius);
    radiusBtn.style.display = state.homeLocation ? "" : "none";
  }

  // モーダル
  const modal = document.getElementById("home-modal");
  if (!modal) return;

  document.getElementById("home-modal-close").addEventListener("click", closeHomeModal);
  modal.addEventListener("click", e => { if (e.target === modal) closeHomeModal(); });

  document.getElementById("home-use-gps").addEventListener("click", useGPS);
  document.getElementById("home-use-map").addEventListener("click", startMapPick);
  document.getElementById("home-clear").addEventListener("click", clearHome);

  // 地図復元
  if (state.homeLocation) {
    renderHomeOnMap();
  }
}

function openHomeModal() {
  document.getElementById("home-modal").classList.add("open");
  const info = document.getElementById("home-current-info");
  if (state.homeLocation) {
    info.textContent = `現在の設定: ${state.homeLocation.address || `${state.homeLocation.lat.toFixed(4)}, ${state.homeLocation.lng.toFixed(4)}`}`;
  } else {
    info.textContent = "自宅が未設定です";
  }
}

function closeHomeModal() {
  document.getElementById("home-modal").classList.remove("open");
}

function useGPS() {
  closeHomeModal();
  if (!navigator.geolocation) { showError("このブラウザでは位置情報を使用できません"); return; }
  showLoading("現在地を取得中...");
  navigator.geolocation.getCurrentPosition(
    pos => {
      hideLoading();
      setHome(pos.coords.latitude, pos.coords.longitude);
    },
    err => {
      hideLoading();
      showError("位置情報の取得に失敗しました。設定から許可してください。");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

let mapPickMode = false;

function startMapPick() {
  closeHomeModal();
  mapPickMode = true;
  document.getElementById("map-pick-banner").classList.add("show");
  map.getContainer().style.cursor = "crosshair";
  map.once("click", onMapPick);

  // キャンセル
  document.getElementById("map-pick-cancel").addEventListener("click", cancelMapPick, { once: true });
}

function onMapPick(e) {
  mapPickMode = false;
  document.getElementById("map-pick-banner").classList.remove("show");
  map.getContainer().style.cursor = "";
  setHome(e.latlng.lat, e.latlng.lng);
}

function cancelMapPick() {
  mapPickMode = false;
  document.getElementById("map-pick-banner").classList.remove("show");
  map.getContainer().style.cursor = "";
  map.off("click", onMapPick);
}

async function setHome(lat, lng) {
  // 逆ジオコーディングで住所取得
  let address = "";
  try {
    const res = await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lng}`);
    if (res.ok) {
      const data = await res.json();
      if (data.results) {
        address = (data.results.lv01Nm || "") + (data.results.muniNm || "");
      }
    }
  } catch (e) { /* ignore */ }

  state.homeLocation = { lat, lng, address };
  state.filterHomeRadius = true;
  localStorage.setItem("hoikuen_home", JSON.stringify(state.homeLocation));

  updateHomeBtnLabel();
  renderHomeOnMap();

  // 5km圏内ボタン表示
  const radiusBtn = document.getElementById("filter-radius-btn");
  if (radiusBtn) {
    radiusBtn.style.display = "";
    radiusBtn.classList.add("active");
  }

  applyFilters();
  map.setView([lat, lng], 14, { animate: true });
}

function clearHome() {
  closeHomeModal();
  state.homeLocation = null;
  state.filterHomeRadius = false;
  localStorage.removeItem("hoikuen_home");

  if (homeMarker) { map.removeLayer(homeMarker); homeMarker = null; }
  if (homeCircle) { map.removeLayer(homeCircle); homeCircle = null; }

  updateHomeBtnLabel();
  const radiusBtn = document.getElementById("filter-radius-btn");
  if (radiusBtn) { radiusBtn.style.display = "none"; radiusBtn.classList.remove("active"); }

  applyFilters();
}

function updateHomeBtnLabel() {
  const btn = document.getElementById("home-set-btn");
  if (!btn) return;
  btn.textContent = state.homeLocation ? "🏠 自宅変更" : "🏠 自宅設定";
  btn.classList.toggle("active", !!state.homeLocation);
}

function renderHomeOnMap() {
  if (!state.homeLocation) return;
  const { lat, lng } = state.homeLocation;

  if (homeMarker) map.removeLayer(homeMarker);
  if (homeCircle) map.removeLayer(homeCircle);

  homeMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      html: '<div class="home-marker">🏠</div>',
      className: "",
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    }),
    zIndexOffset: 1000,
  }).addTo(map).bindPopup(`<b>🏠 自宅</b><br>${state.homeLocation.address || ""}`);

  homeCircle = L.circle([lat, lng], {
    radius: HOME_RADIUS_KM * 1000,
    color: "#FF8FA3",
    fillColor: "#FF8FA3",
    fillOpacity: 0.06,
    weight: 2,
    dashArray: "8 4",
  }).addTo(map);
}

// 2点間の距離（km）: Haversine
function calcDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// 距離から所要時間（分）を計算
function calcTravelTimes(distKm) {
  return {
    walk:    Math.round(distKm / TRAVEL_SPEEDS.walk * 60),
    bicycle: Math.round(distKm / TRAVEL_SPEEDS.bicycle * 60),
    car:     Math.round(distKm / TRAVEL_SPEEDS.car * 60),
  };
}

// 距離表示用フォーマット
function formatDistance(distKm) {
  if (distKm < 1) return `${Math.round(distKm * 1000)}m`;
  return `${distKm.toFixed(1)}km`;
}

function formatTravelTime(minutes) {
  if (minutes < 1) return "1分未満";
  if (minutes >= 60) return `${Math.floor(minutes/60)}時間${minutes%60 ? minutes%60+"分" : ""}`;
  return `${minutes}分`;
}

// 施設の距離情報を取得
function getDistanceInfo(f) {
  if (!state.homeLocation || !f.lat || !f.lng) return null;
  const dist = calcDistanceKm(state.homeLocation.lat, state.homeLocation.lng, f.lat, f.lng);
  const times = calcTravelTimes(dist);
  return { distance: dist, ...times };
}

// ========================================
// OSRM ルート検索
// ========================================
function getRouteCacheKey(homeLat, homeLng, facLat, facLng) {
  return `${homeLat.toFixed(5)},${homeLng.toFixed(5)}>${facLat.toFixed(5)},${facLng.toFixed(5)}`;
}

async function fetchOSRMRoute(profile, homeLng, homeLat, facLng, facLat) {
  const url = `${OSRM_BASE}/${profile}/${homeLng},${homeLat};${facLng},${facLat}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes?.length) return null;
    const route = data.routes[0];
    return {
      distance: route.distance / 1000,  // m → km
      duration: Math.round(route.duration / 60),  // sec → min
      geometry: route.geometry,
    };
  } catch (e) {
    console.warn(`OSRM (${profile}) fetch failed:`, e);
    return null;
  }
}

async function fetchAllRoutes(facility) {
  if (!state.homeLocation || !facility.lat || !facility.lng) return null;
  const { lat: hLat, lng: hLng } = state.homeLocation;
  const cacheKey = getRouteCacheKey(hLat, hLng, facility.lat, facility.lng);

  if (routeCache[cacheKey]) return routeCache[cacheKey];

  // 3プロファイルを並列リクエスト
  const [walkRes, bikeRes, carRes] = await Promise.all([
    fetchOSRMRoute(OSRM_PROFILES.walk, hLng, hLat, facility.lng, facility.lat),
    fetchOSRMRoute(OSRM_PROFILES.bicycle, hLng, hLat, facility.lng, facility.lat),
    fetchOSRMRoute(OSRM_PROFILES.car, hLng, hLat, facility.lng, facility.lat),
  ]);

  const result = { walk: walkRes, bicycle: bikeRes, car: carRes };
  routeCache[cacheKey] = result;
  return result;
}

function showRouteOnMap(geometry) {
  clearRouteFromMap();
  if (!geometry) return;
  activeRouteLayer = L.geoJSON(geometry, {
    style: { color: "#3a7bd5", weight: 4, opacity: 0.7, dashArray: "8 4" },
  }).addTo(map);
}

function clearRouteFromMap() {
  if (activeRouteLayer) {
    map.removeLayer(activeRouteLayer);
    activeRouteLayer = null;
  }
}

// ポップアップ内のルート情報を非同期更新
async function updatePopupWithRoute(facility, popupEl) {
  const routeSection = popupEl.querySelector(".popup-route-section");
  if (!routeSection) return;

  routeSection.innerHTML = `
    <div class="popup-route-loading">🔄 ルート検索中...</div>
  `;

  const routes = await fetchAllRoutes(facility);
  if (!routes) {
    routeSection.innerHTML = `<div class="popup-route-error">ルート取得に失敗しました</div>`;
    return;
  }

  // 直線距離（参考値）
  const straightDist = calcDistanceKm(state.homeLocation.lat, state.homeLocation.lng, facility.lat, facility.lng);

  // 各ルートの表示
  const makeRow = (emoji, label, route, fallbackSpeed) => {
    if (route) {
      return `<div class="popup-route-row">
        <span class="popup-route-mode">${emoji} ${label}</span>
        <span class="popup-route-time">${formatTravelTime(route.duration)}</span>
        <span class="popup-route-dist">(${formatDistance(route.distance)})</span>
      </div>`;
    }
    // フォールバック: 直線距離 × 1.3 で推定
    const estDist = straightDist * 1.3;
    const estTime = Math.round(estDist / fallbackSpeed * 60);
    return `<div class="popup-route-row popup-route-est">
      <span class="popup-route-mode">${emoji} ${label}</span>
      <span class="popup-route-time">≈${formatTravelTime(estTime)}</span>
      <span class="popup-route-dist">(≈${formatDistance(estDist)})</span>
    </div>`;
  };

  // 車のルートを地図に表示（最も情報量が多い）
  const displayRoute = routes.car || routes.bicycle || routes.walk;
  if (displayRoute?.geometry) {
    showRouteOnMap(displayRoute.geometry);
  }

  routeSection.innerHTML = `
    <div class="popup-route-header">🗺️ ルート検索結果</div>
    ${makeRow("🚶", "徒歩", routes.walk, TRAVEL_SPEEDS.walk)}
    ${makeRow("🚲", "自転車", routes.bicycle, TRAVEL_SPEEDS.bicycle)}
    ${makeRow("🚗", "車", routes.car, TRAVEL_SPEEDS.car)}
    <div class="popup-route-note">📐 直線距離: ${formatDistance(straightDist)}</div>
  `;
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
