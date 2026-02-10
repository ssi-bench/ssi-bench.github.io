(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

function initSectionBackgroundSplits() {
  const root = document.documentElement;
  const viewer = document.getElementById("dataset") || document.getElementById("viewer");
  const leaderboard = document.getElementById("leaderboard");
  if (!viewer || !leaderboard) return;

  let rafId = null;
  const update = () => {
    rafId = null;
    const viewerTop = viewer.getBoundingClientRect().top + window.scrollY;
    const leaderboardTop = leaderboard.getBoundingClientRect().top + window.scrollY;
    root.style.setProperty("--bgSplitViewer", `${Math.max(0, Math.round(viewerTop))}px`);
    root.style.setProperty("--bgSplitLeaderboard", `${Math.max(0, Math.round(leaderboardTop))}px`);
  };
  const schedule = () => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(update);
  };

  schedule();
  window.addEventListener("resize", schedule, { passive: true });
  document.addEventListener("load", schedule, true);

  if ("ResizeObserver" in window) {
    const target = document.querySelector("main") || document.body;
    const ro = new ResizeObserver(schedule);
    ro.observe(target);
  }

  if (document.fonts?.ready) {
    document.fonts.ready.then(schedule).catch(() => {});
  }
}

const params = new URLSearchParams(window.location.search);
const RAW_ARGS = String(params.get("args") || "");
const ARGS = new Set(
  RAW_ARGS.split(/[,\s]+/g)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);
const SHOW_COUNTER = ARGS.has("counter") || ARGS.has("show_counter") || ARGS.has("showcounter");

function trimTrailingSlashes(value) {
  return String(value || "").replace(/\/+$/g, "");
}

function resolveDatasetBase() {
  const explicit = params.get("datasetBase");
  if (explicit) return trimTrailingSlashes(explicit);

  const ownerParam = params.get("owner");
  const repoParam = params.get("repo");
  const refParam = params.get("ref");
  if (!ownerParam && !repoParam && !refParam) return "";

  const owner = ownerParam || "ssi-bench";
  const repo = repoParam || "ssi-bench.github.io";
  const ref = refParam || "main";
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}`;
}

const DATASET_BASE = resolveDatasetBase();
const TAXONOMY_URL_NEW = DATASET_BASE ? `${DATASET_BASE}/benchmark/taxonomy.json` : "benchmark/taxonomy.json";
const TAXONOMY_URL_OLD = DATASET_BASE ? `${DATASET_BASE}/data/taxonomy.json` : "data/taxonomy.json";
const TAXONOMY_URL = params.get("taxonomy") || TAXONOMY_URL_NEW;
const INDEX_URL = params.get("index") || (DATASET_BASE ? `${DATASET_BASE}/data/index.json` : "data/index.json");
const PROMPTS_URL = params.get("prompts") || (DATASET_BASE ? `${DATASET_BASE}/data/prompts.json` : "data/prompts.json");
const LEADERBOARD_PAIRWISE_URL =
  params.get("leaderboardPairwise") ||
  (DATASET_BASE ? `${DATASET_BASE}/data/pairwise_acc.json` : "data/pairwise_acc.json");
const LEADERBOARD_TASK_URL =
  params.get("leaderboardTask") || (DATASET_BASE ? `${DATASET_BASE}/data/task_acc.json` : "data/task_acc.json");

function resolveDatasetUrl(pathOrUrl) {
  const raw = String(pathOrUrl || "");
  if (!raw) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!DATASET_BASE) return raw;
  const cleaned = raw.replace(/^(\.\/)+/g, "").replace(/^(\.\.\/)+/g, "").replace(/^\/+/g, "");
  return `${DATASET_BASE}/${cleaned}`;
}

function withCacheBust(url, token) {
  const cleaned = String(token || "").trim();
  if (!cleaned) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${encodeURIComponent(cleaned)}`;
}

function resolveDatasetUrlWithCacheBust(pathOrUrl, token) {
  const url = resolveDatasetUrl(pathOrUrl);
  if (!url) return url;
  return withCacheBust(url, token);
}

function setLightboxOpen(open) {
  const box = $("lightbox");
  if (!box) return;
  box.classList.toggle("isOpen", Boolean(open));
  box.setAttribute("aria-hidden", open ? "false" : "true");
  document.body.style.overflow = open ? "hidden" : "";
}

function openLightbox(src, alt = "") {
  const boxImg = $("lightboxImg");
  if (!boxImg) return;
  boxImg.src = src;
  boxImg.alt = alt || "preview";
  setLightboxOpen(true);
}

function closeLightbox() {
  const boxImg = $("lightboxImg");
  if (boxImg) {
    boxImg.removeAttribute("src");
    boxImg.alt = "preview";
  }
  setLightboxOpen(false);
}

function normalizeSpaces(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function parseRankingText(value) {
  const raw = normalizeSpaces(value);
  if (!raw) return [];
  return raw
    .split(/[,\s]+/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number.parseInt(x, 10))
    .filter((n) => Number.isFinite(n));
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function loadJson(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

async function loadText(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.text();
}

function escapeText(value) {
  const el = document.createElement("span");
  el.textContent = String(value ?? "");
  return el.innerHTML;
}

function formatAcc(value) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : null;
  if (n === null) return "—";
  return n.toFixed(2);
}

function abbreviateTaskName(taskName) {
  const raw = String(taskName || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\s+/g, " ");

  const known = new Map([
    ["Ground Height", "Grd. Ht."],
    ["Ground Angle", "Grd. Ang."],
    ["Relative Distance", "Rel. Dist."],
    ["Hop Distance", "Hop Dist."],
    ["Cycle Length", "Cyc. Len."],
    ["Dimension", "Dim."],
    ["Multi-View", "M-View"],
  ]);
  if (known.has(normalized)) return known.get(normalized);

  const wordMap = new Map([
    ["Ground", "Grd."],
    ["Height", "Ht."],
    ["Angle", "Ang."],
    ["Relative", "Rel."],
    ["Distance", "Dist."],
    ["Dimension", "Dim."],
    ["Cycle", "Cyc."],
    ["Length", "Len."],
    ["Multi-View", "M-View"],
    ["Multi", "Multi"],
    ["View", "View"],
  ]);

  const parts = normalized.split(" ");
  const abbr = parts
    .map((p) => wordMap.get(p) || (p.length <= 4 ? p : `${p.slice(0, 3)}.`))
    .join(" ");
  return abbr;
}

function classifyGroup(groupName) {
  const g = String(groupName || "").toLowerCase();
  if (g.includes("proprietary") || g.includes("closed")) return "proprietary";
  if (g.includes("open") || g.includes("open-source") || g.includes("open weight") || g.includes("open-weight"))
    return "open";
  if (g.includes("baseline") || g.includes("human")) return "baseline";
  return "other";
}

function computeHighlights(models, metricKeys) {
  const byType = new Map();
  for (const m of models) {
    const t = classifyGroup(m.group);
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(m);
  }

  const result = { proprietary: {}, open: {} };
  for (const type of ["proprietary", "open"]) {
    const subset = byType.get(type) || [];
    for (const key of metricKeys) {
      const values = subset
        .map((m) => {
          const v = key === "average" ? m.average : m.scores?.[key];
          return typeof v === "number" && Number.isFinite(v) ? v : null;
        })
        .filter((v) => v !== null);

      const uniqDesc = Array.from(new Set(values)).sort((a, b) => b - a);
      const best = uniqDesc.length ? uniqDesc[0] : null;
      const second = uniqDesc.length > 1 ? uniqDesc[1] : null;
      result[type][key] = { best, second };
    }
  }
  return result;
}

function renderLeaderboard({ columns, models, sortKey, sortDir }) {
  const wrap = $("leaderboardTableWrap");
  if (!wrap) return;

  const table = document.createElement("table");
  table.className = "leaderboardTable";

  const colgroup = document.createElement("colgroup");
  const colModel = document.createElement("col");
  colModel.className = "leaderboardCol leaderboardCol--model";
  colgroup.appendChild(colModel);
  for (let i = 0; i < columns.length; i++) {
    const col = document.createElement("col");
    col.className = "leaderboardCol leaderboardCol--metric";
    colgroup.appendChild(col);
  }
  const colAvg = document.createElement("col");
  colAvg.className = "leaderboardCol leaderboardCol--avg";
  colgroup.appendChild(colAvg);
  table.appendChild(colgroup);

  const metricKeys = [...columns.map((c) => c.key), "average"];
  const highlights = computeHighlights(models, metricKeys);

  function isBest(model, key, type) {
    const v = key === "average" ? model.average : model.scores?.[key];
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
    return highlights?.[type]?.[key]?.best === v;
  }

  function isSecond(model, key, type) {
    const v = key === "average" ? model.average : model.scores?.[key];
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
    return highlights?.[type]?.[key]?.second === v;
  }

  const geometric = columns.filter((c) => String(c.groupSlug || c.groupName || "").toLowerCase().includes("geometric"));
  const topological = columns.filter((c) =>
    String(c.groupSlug || c.groupName || "").toLowerCase().includes("topological")
  );
  const topoFirstKey = topological.length ? topological[0].key : "";

  const thead = document.createElement("thead");
  const r1 = document.createElement("tr");
  const r2 = document.createElement("tr");

  function makeSortTh(label, key, { numeric = true } = {}) {
    const th = document.createElement("th");
    th.className = "leaderboardTh";
    th.scope = "col";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "leaderboardSort";
    btn.dataset.sortKey = key;
    btn.dataset.numeric = numeric ? "1" : "0";

    const active = sortKey === key;
    const arrow = active ? `<span class=\"leaderboardSort__arrow\">${sortDir === "asc" ? "▲" : "▼"}</span>` : "";
    btn.innerHTML = `<span>${escapeText(label)}</span>${arrow}`;
    if (active) btn.classList.add("isActive");

    th.appendChild(btn);
    return th;
  }

  const modelTh = makeSortTh("Model", "model", { numeric: false });
  modelTh.rowSpan = 2;
  modelTh.classList.add("leaderboardTh--model");
  r1.appendChild(modelTh);

  const gTh = document.createElement("th");
  gTh.className = "leaderboardGroup";
  gTh.colSpan = geometric.length;
  gTh.textContent = "Geometric";
  r1.appendChild(gTh);

  const tTh = document.createElement("th");
  tTh.className = "leaderboardGroup leaderboardGroup--topo";
  tTh.colSpan = topological.length;
  tTh.textContent = "Topological";
  r1.appendChild(tTh);

  const avgTh = makeSortTh("Avg", "average", { numeric: true });
  avgTh.rowSpan = 2;
  avgTh.classList.add("leaderboardTh--avg");
  r1.appendChild(avgTh);

  for (const c of [...geometric, ...topological]) {
    const th = makeSortTh(abbreviateTaskName(c.taskName), c.key, { numeric: true });
    th.classList.add("leaderboardTh--metric");
    th.title = String(c.taskName || "");
    if (topoFirstKey && c.key === topoFirstKey) th.classList.add("isSepLeft");
    r2.appendChild(th);
  }

  thead.appendChild(r1);
  thead.appendChild(r2);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const m of models) {
    const groupType = classifyGroup(m.group);
    const tr = document.createElement("tr");
    tr.className = `leaderboardRow leaderboardRow--${groupType}`;

    const modelTd = document.createElement("td");
    modelTd.className = "leaderboardTd leaderboardTd--model";
    modelTd.textContent = m.model || "";
    const groupHighlightType = groupType === "proprietary" || groupType === "open" ? groupType : null;
    if (groupHighlightType && isBest(m, "average", groupHighlightType)) tr.classList.add("isGroupBest");
    if (groupHighlightType && isSecond(m, "average", groupHighlightType)) tr.classList.add("isGroupSecond");
    tr.appendChild(modelTd);

    for (const c of [...geometric, ...topological]) {
      const td = document.createElement("td");
      td.className = "leaderboardTd leaderboardTd--num";
      const v = m.scores?.[c.key];
      td.textContent = formatAcc(v);
      if (topoFirstKey && c.key === topoFirstKey) td.classList.add("isSepLeft");

      if (groupHighlightType && isBest(m, c.key, groupHighlightType)) td.classList.add("isBest");
      if (groupHighlightType && isSecond(m, c.key, groupHighlightType)) td.classList.add("isSecond");

      tr.appendChild(td);
    }

    const avgTd = document.createElement("td");
    avgTd.className = "leaderboardTd leaderboardTd--avg";
    avgTd.textContent = formatAcc(m.average);
    if (groupHighlightType && isBest(m, "average", groupHighlightType)) avgTd.classList.add("isBest");
    if (groupHighlightType && isSecond(m, "average", groupHighlightType)) avgTd.classList.add("isSecond");
    tr.appendChild(avgTd);

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  wrap.innerHTML = "";
  wrap.appendChild(table);
}

function initLeaderboard() {
  const section = $("leaderboard");
  const wrap = $("leaderboardTableWrap");
  const meta = $("leaderboardMeta");
  if (!section || !wrap || !meta) return;

  const tabs = Array.from(section.querySelectorAll("button.leaderboardTab[data-board]"));
  if (!tabs.length) return;

  const cache = new Map();
  let activeBoard = "task";
  let sortKey = "";
  let sortDir = "desc";

  function getUrl(board) {
    return board === "task" ? LEADERBOARD_TASK_URL : LEADERBOARD_PAIRWISE_URL;
  }

  function getMetric(board) {
    return board === "task" ? "Task Accuracy" : "Pairwise Accuracy";
  }

  function getCellValue(model, key) {
    if (key === "model") return String(model.model || "");
    if (key === "average") return typeof model.average === "number" ? model.average : null;
    const v = model.scores ? model.scores[key] : null;
    return typeof v === "number" ? v : null;
  }

  function sortModels(models) {
    if (!sortKey) return [...models];
    const dir = sortDir === "asc" ? 1 : -1;
    const numeric = sortKey !== "model";
    return [...models].sort((a, b) => {
      const av = getCellValue(a, sortKey);
      const bv = getCellValue(b, sortKey);
      if (numeric) {
        const an = typeof av === "number" && Number.isFinite(av) ? av : null;
        const bn = typeof bv === "number" && Number.isFinite(bv) ? bv : null;
        if (an === null && bn === null) return 0;
        if (an === null) return 1;
        if (bn === null) return -1;
        if (an === bn) return 0;
        return an > bn ? dir : -dir;
      }
      const as = String(av || "").toLowerCase();
      const bs = String(bv || "").toLowerCase();
      if (as === bs) return 0;
      return as > bs ? dir : -dir;
    });
  }

  async function loadBoard(board) {
    if (cache.has(board)) return cache.get(board);
    const data = await loadJson(getUrl(board));
    cache.set(board, data);
    return data;
  }

  function setTabs(board) {
    activeBoard = board;
    for (const t of tabs) {
      const active = t.dataset.board === board;
      t.classList.toggle("isActive", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    }
  }

  function updateFromTableClick(e) {
    const btn = e.target?.closest?.("button[data-sort-key]");
    if (!btn) return;
    const key = btn.dataset.sortKey;
    if (!key) return;

    if (sortKey === key) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDir = key === "model" ? "asc" : "desc";
    }
    renderActive();
  }

  async function renderActive() {
    wrap.removeEventListener("click", updateFromTableClick);
    wrap.addEventListener("click", updateFromTableClick);

    try {
      const leaderboard = await loadBoard(activeBoard);
      const columns = Array.isArray(leaderboard?.columns) ? leaderboard.columns : [];
      let models = Array.isArray(leaderboard?.models) ? leaderboard.models : [];
      models = models.filter((m) => typeof m?.average === "number" && Number.isFinite(m.average) && m.average > 0);
      models = sortModels(models);

      meta.textContent = `${getMetric(activeBoard)} · ${models.length} models`;
      renderLeaderboard({ columns, models, sortKey, sortDir });
    } catch (err) {
      wrap.innerHTML = `<div class="meta">Failed to load leaderboard: ${escapeText(err?.message || err)}</div>`;
    }
  }

  for (const t of tabs) {
    t.addEventListener("click", () => {
      const board = t.dataset.board;
      if (!board) return;
      setTabs(board);
      renderActive();
    });
  }

  setTabs(activeBoard);
  renderActive();
}

function parseLegacyInfoTxt(text) {
  const lines = String(text || "")
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const color = lines[0] || "";
  const answerLine = lines[1] || "";
  let answer = [];
  if (answerLine.startsWith("[")) {
    try {
      answer = JSON.parse(answerLine);
    } catch {
      answer = parseRankingText(answerLine);
    }
  } else {
    answer = parseRankingText(answerLine);
  }
  const author = lines[2] || "";
  return { color, answer, author };
}

function setResult(kind, message, meta = "") {
  const result = $("result");
  if (!result) return;
  result.classList.remove("result--ok", "result--bad");
  if (kind === "ok") result.classList.add("result--ok");
  if (kind === "bad") result.classList.add("result--bad");
  result.innerHTML = "";
  const left = document.createElement("div");
  left.textContent = message;
  if (kind === "ok") left.className = "result__ok";
  if (kind === "bad") left.className = "result__bad";
  const right = document.createElement("div");
  right.className = "meta";
  right.textContent = meta;
  result.appendChild(left);
  result.appendChild(right);
}

function setChips(sequence) {
  const wrap = $("clickSequence");
  wrap.innerHTML = "";
  if (!sequence.length) {
    const empty = document.createElement("span");
    empty.className = "meta";
    empty.textContent = "Click the top-left Pick button on candidates to build a ranking (no typing required).";
    wrap.appendChild(empty);
    return;
  }
  for (const n of sequence) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = String(n);
    wrap.appendChild(chip);
  }
}

function humanPathFromDir(dir) {
  return String(dir || "").replace(/^(\.\.\/)+/, "");
}

let taxonomy = null;
let datasetIndex = null;
let datasetGeneratedAt = "";
let availableTasksByCategory = new Map();

let filteredItems = [];
let currentIndex = 0;
let clickSequence = [];
let currentInfo = null;
let promptTemplates = {};
let promptRenderNonce = 0;

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPromptMarkdown(text) {
  const escaped = escapeHtml(text);
  const withBold = escaped.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  return withBold.replaceAll("\n", "<br>");
}

function setCounterText(text) {
  const counter = $("counter");
  if (!counter) return;
  if (!SHOW_COUNTER) {
    counter.textContent = "";
    counter.hidden = true;
    return;
  }
  counter.hidden = false;
  counter.textContent = text;
}

function extractHighlightColor(info) {
  if (!info) return "";
  if (typeof info.color === "string" && info.color.trim()) return info.color.trim();
  const render = info && typeof info.render === "object" ? info.render : null;
  if (render) {
    if (typeof render.fillColor === "string" && render.fillColor.trim()) return render.fillColor.trim();
    if (typeof render.fontColor === "string" && render.fontColor.trim()) return render.fontColor.trim();
  }
  return "";
}

function fillPromptTemplate(template, info, item) {
  const labels = Array.isArray(item?.options) && item.options.length
    ? item.options.map((o) => o.label).join(", ")
    : "1, 2, 3, 4";
  const optionCount = Array.isArray(item?.options) ? String(item.options.length) : "";
  const color = extractHighlightColor(info) || "highlighted";

  return String(template || "")
    .replaceAll("{color}", color)
    .replaceAll("{option_labels}", labels)
    .replaceAll("{option_count}", optionCount);
}

function setPromptText(text) {
  const el = $("promptText");
  if (!el) return;
  const raw = String(text || "");
  el.dataset.raw = raw;
  el.innerHTML = renderPromptMarkdown(raw);
}

async function renderPromptForCurrent() {
  const nonce = ++promptRenderNonce;
  const taskSlug = getSelectedTaskSlug();
  const item = filteredItems[currentIndex] || null;

  let templateKey = taskSlug;
  if (item && item.isMultiView && item.baseTaskSlug) {
    templateKey = `mv_${item.baseTaskSlug}`;
  }

  const template = promptTemplates && templateKey ? promptTemplates[templateKey] : "";
  if (!template) {
    setPromptText("Prompt not available for this task.");
    return;
  }

  setPromptText(fillPromptTemplate(template, null, item));

  try {
    const info = await ensureInfoLoaded();
    if (nonce !== promptRenderNonce) return;
    setPromptText(fillPromptTemplate(template, info, item));
  } catch {
    // Keep template-only version.
  }
}

function getSelectedCategorySlug() {
  return $("categorySelect").value;
}

function getSelectedTaskSlug() {
  return $("taskSelect").value;
}

function rebuildTaskSelect() {
  const categorySlug = getSelectedCategorySlug();
  const taskSelect = $("taskSelect");
  taskSelect.innerHTML = "";

  const tasks = availableTasksByCategory.get(categorySlug) || [];
  for (const t of tasks) {
    const opt = document.createElement("option");
    opt.value = t.slug;
    opt.textContent = t.name;
    taskSelect.appendChild(opt);
  }
}

function applyFilters() {
  const categorySlug = getSelectedCategorySlug();
  const taskSlug = getSelectedTaskSlug();

  filteredItems = datasetIndex.items.filter((it) => {
    if (it.categorySlug !== categorySlug) return false;
    if (it.taskSlug !== taskSlug) return false;
    return true;
  });

  currentIndex = 0;
  clickSequence = [];
  currentInfo = null;
  setChips(clickSequence);

  if (filteredItems.length === 0) {
    $("originalImg").removeAttribute("src");
    $("optionsGrid").innerHTML = "";
    setCounterText("0 / 0");
    setResult("bad", "No samples found for this selection.", "");
    return;
  }

  renderCurrent();
}

async function renderCurrent() {
  const item = filteredItems[currentIndex];
  if (!item) return;

  setCounterText(`${currentIndex + 1} / ${filteredItems.length}`);
  $("answerInput").value = "";
  clickSequence = [];
  currentInfo = null;
  setChips(clickSequence);
  const result = $("result");
  if (result) {
    result.innerHTML = "";
    result.classList.remove("result--ok", "result--bad");
  }

  const renderBust = window.location.protocol === "http:" ? String(Date.now()) : datasetGeneratedAt;

  const originals =
    item && item.isMultiView && Array.isArray(item.originals) && item.originals.length
      ? item.originals
      : [item.original].filter(Boolean);
  const originalUrl1 = originals[0] ? resolveDatasetUrlWithCacheBust(originals[0], renderBust) : "";
  const originalUrl2 =
    item && item.isMultiView && originals[1] ? resolveDatasetUrlWithCacheBust(originals[1], renderBust) : "";

  $("originalImg").src = originalUrl1;
  $("originalImg").onclick = () => originalUrl1 && openLightbox(originalUrl1, "original view 1");

  const originalImg2 = $("originalImg2");
  if (originalUrl2) {
    originalImg2.hidden = false;
    originalImg2.src = originalUrl2;
    originalImg2.onclick = () => openLightbox(originalUrl2, "original view 2");
  } else {
    originalImg2.hidden = true;
    originalImg2.removeAttribute("src");
    originalImg2.onclick = null;
  }

  const referenceBox = $("referenceBox");
  const referenceImg = $("referenceImg");
  if (referenceBox && referenceImg && item && item.isMultiView && item.reference && item.reference.src) {
    const refUrl = resolveDatasetUrlWithCacheBust(item.reference.src, renderBust);
    referenceBox.hidden = false;
    referenceImg.src = refUrl;
    referenceImg.onclick = () => openLightbox(refUrl, "member 0");
  } else if (referenceBox) {
    referenceBox.hidden = true;
    if (referenceImg) {
      referenceImg.removeAttribute("src");
      referenceImg.onclick = null;
    }
  }
  const optionsGrid = $("optionsGrid");
  optionsGrid.innerHTML = "";

  for (const opt of item.options) {
    const wrapper = document.createElement("div");
    wrapper.className = "option";

    const imgWrap = document.createElement("div");
    imgWrap.className = "imgWrap imgWrap--option";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "imgWrap__pick";
    btn.setAttribute("aria-label", `Pick option ${opt.label}`);
    btn.addEventListener("click", () => {
      if (clickSequence.length >= item.options.length) return;
      if (clickSequence.includes(opt.label)) return;
      clickSequence = [...clickSequence, opt.label];
      setChips(clickSequence);
      $("answerInput").value = clickSequence.join(" ");
    });

    const btnText = document.createElement("span");
    btnText.className = "imgWrap__pickText";
    btnText.textContent = `Pick ${opt.label}`;
    btn.appendChild(btnText);

    const badge = document.createElement("span");
    badge.className = "imgWrap__badge";
    badge.textContent = `#${opt.label}`;

    const img = document.createElement("img");
    const optUrl = resolveDatasetUrlWithCacheBust(opt.src, renderBust);
    img.src = optUrl;
    img.alt = `option ${opt.label}`;
    img.addEventListener("click", () => openLightbox(optUrl, img.alt));
    imgWrap.appendChild(btn);
    imgWrap.appendChild(badge);
    imgWrap.appendChild(img);

    wrapper.appendChild(imgWrap);
    optionsGrid.appendChild(wrapper);
  }

  renderPromptForCurrent();
}

async function ensureInfoLoaded() {
  if (currentInfo) return currentInfo;
  const item = filteredItems[currentIndex];
  if (!item) return null;

  if (item.answer) {
    currentInfo = await loadJson(resolveDatasetUrlWithCacheBust(item.answer, datasetGeneratedAt));
    return currentInfo;
  }

  if (Array.isArray(item.gtAnswer) && item.gtAnswer.length) {
    currentInfo = { answer: item.gtAnswer };
    return currentInfo;
  }

  if (item.info && String(item.info).toLowerCase().endsWith(".json")) {
    currentInfo = await loadJson(resolveDatasetUrlWithCacheBust(item.info, datasetGeneratedAt));
    return currentInfo;
  }

  if (item.info) {
    const txt = await loadText(resolveDatasetUrlWithCacheBust(item.info, datasetGeneratedAt));
    currentInfo = parseLegacyInfoTxt(txt);
    return currentInfo;
  }

  currentInfo = null;
  return currentInfo;
}

async function checkAnswer({ reveal = false } = {}) {
  const item = filteredItems[currentIndex];
  if (!item) return;

  let info = null;
  try {
    info = await ensureInfoLoaded();
  } catch (err) {
    console.error(err);
    setResult("bad", "Failed to load ground-truth.", String(err?.message || err));
    return;
  }
  if (!info) return;

  const user = parseRankingText($("answerInput").value);
  const gt = Array.isArray(info.answer)
    ? info.answer.map((n) => Number.parseInt(n, 10)).filter((n) => Number.isFinite(n))
    : [];

  if (!gt.length) {
    setResult("bad", "Missing ground-truth answer.", "");
    return;
  }

  if (!user.length) {
    if (reveal) {
      setResult("ok", "Revealed.", `GT: ${gt.join(" ")}`);
      return;
    }
    setResult("bad", "Empty answer.", "");
    return;
  }
  if (user.length !== gt.length) {
    setResult(
      "bad",
      `Expected ${gt.length} numbers, got ${user.length}.`,
      reveal ? `GT: ${gt.join(" ")}` : ""
    );
    return;
  }

  const ok = arraysEqual(user, gt);
  if (ok) {
    setResult("ok", "Correct.", reveal ? `GT: ${gt.join(" ")}` : "");
  } else {
    setResult("bad", "Incorrect.", reveal ? `GT: ${gt.join(" ")}` : "");
  }
}

function goto(delta) {
  if (filteredItems.length === 0) return;
  currentIndex = (currentIndex + delta + filteredItems.length) % filteredItems.length;
  renderCurrent();
}

function randomPick() {
  if (filteredItems.length === 0) return;
  currentIndex = Math.floor(Math.random() * filteredItems.length);
  renderCurrent();
}

async function init() {
  initSectionBackgroundSplits();
  try {
    taxonomy = await loadJson(TAXONOMY_URL);
  } catch (err) {
    if (!params.get("taxonomy")) {
      taxonomy = await loadJson(TAXONOMY_URL_OLD);
    } else {
      throw err;
    }
  }
  datasetIndex = await loadJson(INDEX_URL);
  datasetGeneratedAt = String(datasetIndex?.generatedAt || "");
  try {
    promptTemplates = await loadJson(PROMPTS_URL);
  } catch {
    promptTemplates = {};
  }

  const items = Array.isArray(datasetIndex?.items) ? datasetIndex.items : [];
  const categoryOrder = new Map();
  const taskOrderByCategory = new Map();
  for (const it of items) {
    if (!it?.categorySlug || !it?.taskSlug) continue;
    if (!categoryOrder.has(it.categorySlug)) {
      categoryOrder.set(it.categorySlug, categoryOrder.size);
    }
    if (!taskOrderByCategory.has(it.categorySlug)) {
      taskOrderByCategory.set(it.categorySlug, new Map());
    }
    const taskOrder = taskOrderByCategory.get(it.categorySlug);
    if (!taskOrder.has(it.taskSlug)) {
      taskOrder.set(it.taskSlug, taskOrder.size);
    }
  }
  const presentCategorySlugs = new Set(items.map((it) => it.categorySlug).filter(Boolean));
  const presentTasksByCategory = new Map();
  for (const it of items) {
    if (!it?.categorySlug || !it?.taskSlug) continue;
    if (!presentTasksByCategory.has(it.categorySlug)) presentTasksByCategory.set(it.categorySlug, new Set());
    presentTasksByCategory.get(it.categorySlug).add(it.taskSlug);
  }

  const taskNameBySlug = new Map();
  if (Array.isArray(taxonomy?.tasks)) {
    for (const t of taxonomy.tasks) {
      if (!t?.slug) continue;
      if (t.name) taskNameBySlug.set(t.slug, t.name);
    }
  }

  function titleFromSlug(slug) {
    return String(slug || "")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (m) => m.toUpperCase());
  }

  const categorySelect = $("categorySelect");
  categorySelect.innerHTML = "";

  const categories = Array.isArray(taxonomy?.categories)
    ? taxonomy.categories
        .filter((cat) => presentCategorySlugs.has(cat.slug))
        .sort((a, b) => (categoryOrder.get(a.slug) ?? 1e9) - (categoryOrder.get(b.slug) ?? 1e9))
    : [];
  const fallbackCategories =
    categories.length > 0
      ? categories
      : Array.from(presentCategorySlugs)
          .sort((a, b) => (categoryOrder.get(a) ?? 1e9) - (categoryOrder.get(b) ?? 1e9) || a.localeCompare(b))
          .map((slug) => ({ slug, name: titleFromSlug(slug) }));

  for (const cat of fallbackCategories) {
    const opt = document.createElement("option");
    opt.value = cat.slug;
    opt.textContent = cat.name;
    categorySelect.appendChild(opt);
  }

  availableTasksByCategory = new Map();
  for (const cat of fallbackCategories) {
    const present = presentTasksByCategory.get(cat.slug) || new Set();
    let tasks = [];
    if (Array.isArray(taxonomy?.tasks) && taxonomy.tasks.length > 0) {
      const order = taskOrderByCategory.get(cat.slug) || new Map();
      tasks = taxonomy.tasks
        .filter((t) => t?.categorySlug === cat.slug && present.has(t.slug))
        .sort((a, b) => (order.get(a.slug) ?? 1e9) - (order.get(b.slug) ?? 1e9))
        .map((t) => ({ slug: t.slug, name: t.name || titleFromSlug(t.slug) }));
    }
    if (tasks.length === 0) {
      const order = taskOrderByCategory.get(cat.slug) || new Map();
      tasks = Array.from(present)
        .sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || a.localeCompare(b))
        .map((slug) => ({ slug, name: taskNameBySlug.get(slug) || titleFromSlug(slug) }));
    }
    availableTasksByCategory.set(cat.slug, tasks);
  }

  categorySelect.addEventListener("change", () => {
    rebuildTaskSelect();
    applyFilters();
  });

  $("taskSelect").addEventListener("change", applyFilters);

  const copyBtn = $("copyPromptBtn");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const text = $("promptText")?.dataset?.raw || $("promptText")?.textContent || "";
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try {
          document.execCommand("copy");
        } finally {
          document.body.removeChild(ta);
        }
      }
    });
  }

  $("prevBtn").addEventListener("click", () => goto(-1));
  $("nextBtn").addEventListener("click", () => goto(1));
  $("randomBtn").addEventListener("click", randomPick);

  $("clearBtn").addEventListener("click", () => {
    clickSequence = [];
    setChips(clickSequence);
    $("answerInput").value = "";
    setResult("", "Cleared.", "");
  });

  $("checkBtn").addEventListener("click", () => checkAnswer({ reveal: false }));
  $("revealBtn").addEventListener("click", () => checkAnswer({ reveal: true }));

  const lightbox = $("lightbox");
  if (lightbox) {
    lightbox.addEventListener("click", (e) => {
      if (e.target === lightbox) closeLightbox();
    });
  }
  const lightboxClose = $("lightboxClose");
  if (lightboxClose) lightboxClose.addEventListener("click", closeLightbox);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
  });

  rebuildTaskSelect();
  applyFilters();
  initLeaderboard();
}

init().catch((err) => {
  console.error(err);
  setResult("bad", "Failed to initialize viewer.", String(err?.message || err));
});

})();
