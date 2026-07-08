const DATA_PATH = "./data/";
const SGT = "Asia/Singapore";

const TABS = [
  ["predict", "Predict"],
  ["fixtures", "Fixtures"],
  ["table", "Table"],
  ["projections", "Projections"],
  ["ratings", "Ratings"],
  ["results", "Results"],
  ["sgpools", "SG Pools"],
  ["method", "Method"],
];

const MAX_GOALS = 8;

const SG_POOLS_BET_TYPES = [
  ["MR", "1X2"],
  ["CS", "Pick the Score"],
  ["HL", "Total Goals Over/Under"],
  ["BG", "Will Both Teams Score"],
  ["EG", "Total Goals"],
  ["OE", "Total Goals Odd/Even"],
  ["AH", "Asian Handicap / HT Asian Handicap"],
  ["MH", "Handicap 1X2"],
  ["H1", "Halftime 1X2"],
  ["HF", "Halftime-Fulltime"],
  ["WH", "1/2 Goal"],
  ["NGN", "Team to Score 1st Goal"],
  ["FS", "1st Goal Scorer"],
  ["LS", "Last Goal Scorer"],
];

const DEFAULT_CONFIG = {
  runs: 8000,
  seed: 20260821,
  kFactor: 32,
  homeAdvantage: 55,
  baseXg: 1.35,
  xgScale: 560,
  xgMin: 0.2,
  xgMax: 4.5,
  rho: -0.08,
  zeroInflation: 0.2,
  drawGuard: 14,
  styleWeight: 70,
};

const state = {
  tab: validTab(location.hash.replace("#", "")),
  data: null,
  home: "",
  away: "",
  month: "",
  copied: false,
  config: readConfig(),
  cache: new Map(),
};

const app = document.querySelector("#app");

init();

async function init() {
  const [schedule, results, model, singaporePools] = await Promise.all([
    loadJSON("schedule.json"),
    loadJSON("results.json"),
    loadJSON("team-model.json"),
    safeLoadJSON("sgpools-markets.json", defaultSingaporePoolsFeed()),
  ]);

  const teams = model.teams.map((team) => ({ ...team }));

  state.data = {
    schedule,
    results,
    singaporePools,
    teams,
    season: model.season,
    priorsNote: model.priorsNote,
    teamByName: Object.fromEntries(teams.map((team) => [team.name, team])),
    styles: buildStyleProfiles(teams, results),
  };

  const next = nextFixture(schedule, results);
  state.home = next?.home || teams[0].name;
  state.away = next?.away || teams[1].name;
  state.month = next ? monthKeyOf(next.date) : monthKeyOf(schedule[0]?.date || new Date().toISOString());

  window.addEventListener("hashchange", () => {
    state.tab = validTab(location.hash.replace("#", ""));
    render();
  });

  render();
}

async function loadJSON(file) {
  const response = await fetch(`${DATA_PATH}${file}`, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not load ${file}`);
  return response.json();
}

async function safeLoadJSON(file, fallback) {
  try {
    return await loadJSON(file);
  } catch (error) {
    return fallback;
  }
}

function defaultSingaporePoolsFeed() {
  return {
    generatedAt: null,
    sourceUrl: "https://online.singaporepools.com/en/sports",
    status: "not_connected",
    note: "No Singapore Pools snapshot has been generated yet. The daily updater checks public Singapore Pools pages for English Premier League listings.",
    betTypes: SG_POOLS_BET_TYPES.map(([code, name]) => ({ code, name })),
    events: [],
  };
}

function validTab(tab) {
  return TABS.some(([id]) => id === tab) ? tab : "predict";
}

function readConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem("epl27-config") || "{}") };
  } catch (error) {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  localStorage.setItem("epl27-config", JSON.stringify(state.config));
  state.cache.clear();
}

/* ---------------- Elo + Poisson engine ---------------- */

function buildStyleProfiles(teams, results) {
  const profiles = {};
  for (const team of teams) {
    const matches = results
      .filter((match) => match.home === team.name || match.away === team.name)
      .slice(-14)
      .reverse();
    if (matches.length < 3) {
      profiles[team.name] = { attack: 0, defense: 0, formPower: 0 };
      continue;
    }
    let weight = 0;
    let gf = 0;
    let ga = 0;
    let pts = 0;
    matches.forEach((match, index) => {
      const w = Math.exp(-index / 7);
      const isHome = match.home === team.name;
      const forGoals = isHome ? match.homeGoals : match.awayGoals;
      const againstGoals = isHome ? match.awayGoals : match.homeGoals;
      weight += w;
      gf += forGoals * w;
      ga += againstGoals * w;
      pts += (forGoals > againstGoals ? 3 : forGoals === againstGoals ? 1 : 0) * w;
    });
    const gfPer = gf / weight;
    const gaPer = ga / weight;
    const ppg = pts / weight;
    const attack = clamp((gfPer - 1.4) * 0.16 + (ppg - 1.4) * 0.03, -0.16, 0.16);
    const defense = clamp((1.4 - gaPer) * 0.16 + (ppg - 1.4) * 0.02, -0.16, 0.16);
    profiles[team.name] = { attack, defense, formPower: ppg };
  }
  return profiles;
}

function ratingsAfterResults(results, config = state.config) {
  const ratings = new Map(state.data.teams.map((team) => [team.name, team.prior]));
  const sorted = [...results].sort((a, b) => `${a.date}-${a.id}`.localeCompare(`${b.date}-${b.id}`));
  for (const match of sorted) updateElo(ratings, match, config);
  return ratings;
}

function updateElo(ratings, match, config) {
  const home = state.data.teamByName[match.home];
  const away = state.data.teamByName[match.away];
  if (!home || !away) return;
  const h = ratings.get(home.name) ?? home.prior;
  const a = ratings.get(away.name) ?? away.prior;
  const expected = logisticExpected(h + config.homeAdvantage, a);
  const actual = match.homeGoals > match.awayGoals ? 1 : match.homeGoals === match.awayGoals ? 0.5 : 0;
  const margin = Math.abs(match.homeGoals - match.awayGoals);
  const mov = margin <= 1 ? 1 : margin === 2 ? 1.5 : (11 + margin) / 8;
  const delta = config.kFactor * mov * (actual - expected);
  ratings.set(home.name, h + delta);
  ratings.set(away.name, a - delta);
}

function ratingOf(team, ratings) {
  return ratings.get(team.name) ?? team.prior;
}

function logisticExpected(homeRating, awayRating) {
  return 1 / (1 + Math.pow(10, (awayRating - homeRating) / 400));
}

function matchPrediction(homeName, awayName, ratings, options = {}) {
  const config = options.config || state.config;
  const home = state.data.teamByName[homeName];
  const away = state.data.teamByName[awayName];
  const homeRating = ratingOf(home, ratings) + (options.neutral ? 0 : config.homeAdvantage);
  const awayRating = ratingOf(away, ratings);
  const style = state.data.styles;
  const homeStyle = style[homeName] || { attack: 0, defense: 0 };
  const awayStyle = style[awayName] || { attack: 0, defense: 0 };
  const styleWeight = config.styleWeight / 100;
  const homeStyleMultiplier = Math.exp((homeStyle.attack - awayStyle.defense) * styleWeight);
  const awayStyleMultiplier = Math.exp((awayStyle.attack - homeStyle.defense) * styleWeight);
  const lambdaHome = clamp(
    config.baseXg * Math.exp((homeRating - awayRating) / config.xgScale) * homeStyleMultiplier,
    config.xgMin,
    config.xgMax,
  );
  const lambdaAway = clamp(
    config.baseXg * Math.exp((awayRating - homeRating) / config.xgScale) * awayStyleMultiplier,
    config.xgMin,
    config.xgMax,
  );
  const matrix = scoreMatrix(lambdaHome, lambdaAway, config);
  const raw = summarizeMatrix(matrix);
  const closeness = Math.exp(-Math.abs(homeRating - awayRating) / 185);
  const drawExtra = (config.drawGuard / 100) * closeness * (1 - raw.pDraw) * 0.28;
  const nonDraw = raw.pHome + raw.pAway || 1;
  const pDraw = clamp(raw.pDraw + drawExtra, 0.02, 0.62);
  const pHome = raw.pHome - drawExtra * (raw.pHome / nonDraw);
  const pAway = raw.pAway - drawExtra * (raw.pAway / nonDraw);
  const total = pHome + pDraw + pAway;
  return {
    homeName,
    awayName,
    lambdaHome,
    lambdaAway,
    matrix,
    pHome: pHome / total,
    pDraw: pDraw / total,
    pAway: pAway / total,
    over25: raw.over25,
    btts: raw.btts,
    topScorelines: raw.topScorelines,
    ratingDiff: homeRating - awayRating,
  };
}

function scoreMatrix(lambdaHome, lambdaAway, config) {
  const homeDist = Array.from({ length: MAX_GOALS + 1 }, (_, goals) => poissonProbability(lambdaHome, goals));
  const awayDist = Array.from({ length: MAX_GOALS + 1 }, (_, goals) => poissonProbability(lambdaAway, goals));
  const matrix = [];
  let total = 0;
  for (let h = 0; h <= MAX_GOALS; h += 1) {
    matrix[h] = [];
    for (let a = 0; a <= MAX_GOALS; a += 1) {
      const dc = dixonColes(h, a, lambdaHome, lambdaAway, config.rho);
      const zero = h === 0 && a === 0 ? 1 + config.zeroInflation : 1;
      const value = Math.max(0, homeDist[h] * awayDist[a] * dc * zero);
      matrix[h][a] = value;
      total += value;
    }
  }
  for (let h = 0; h <= MAX_GOALS; h += 1) {
    for (let a = 0; a <= MAX_GOALS; a += 1) matrix[h][a] /= total;
  }
  return matrix;
}

function poissonProbability(lambda, goals) {
  let factorial = 1;
  for (let i = 2; i <= goals; i += 1) factorial *= i;
  return (Math.pow(lambda, goals) * Math.exp(-lambda)) / factorial;
}

function dixonColes(h, a, lh, la, rho) {
  if (h === 0 && a === 0) return 1 - lh * la * rho;
  if (h === 0 && a === 1) return 1 + lh * rho;
  if (h === 1 && a === 0) return 1 + la * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

function summarizeMatrix(matrix) {
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  let over25 = 0;
  let btts = 0;
  const scores = [];
  for (let h = 0; h < matrix.length; h += 1) {
    for (let a = 0; a < matrix[h].length; a += 1) {
      const p = matrix[h][a];
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;
      if (h + a >= 3) over25 += p;
      if (h > 0 && a > 0) btts += p;
      scores.push({ h, a, p });
    }
  }
  scores.sort((x, y) => y.p - x.p);
  return { pHome, pDraw, pAway, over25, btts, topScorelines: scores.slice(0, 8) };
}

/* ---------------- Standings ---------------- */

function computeStandings(results = state.data.results) {
  const rows = new Map(state.data.teams.map((team) => [team.name, emptyRow(team)]));
  for (const match of results) {
    const home = rows.get(match.home);
    const away = rows.get(match.away);
    if (!home || !away) continue;
    applyResultToRows(home, away, match.homeGoals, match.awayGoals);
  }
  return rows;
}

function emptyRow(team) {
  return { team, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, pts: 0 };
}

function applyResultToRows(home, away, hg, ag) {
  home.played += 1;
  away.played += 1;
  home.gf += hg;
  home.ga += ag;
  away.gf += ag;
  away.ga += hg;
  home.gd = home.gf - home.ga;
  away.gd = away.gf - away.ga;
  if (hg > ag) {
    home.won += 1;
    away.lost += 1;
    home.pts += 3;
  } else if (hg < ag) {
    away.won += 1;
    home.lost += 1;
    away.pts += 3;
  } else {
    home.drawn += 1;
    away.drawn += 1;
    home.pts += 1;
    away.pts += 1;
  }
}

function sortedTable(rows) {
  return [...rows.values()].sort(
    (a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.team.name.localeCompare(b.team.name),
  );
}

function zoneFor(position) {
  if (position === 1) return { cls: "zone-title", label: "Champions" };
  if (position <= 4) return { cls: "zone-ucl", label: "Champions League" };
  if (position === 5) return { cls: "zone-uel", label: "Europa League" };
  if (position >= 18) return { cls: "zone-rel", label: "Relegation" };
  return { cls: "", label: "" };
}

/* ---------------- Season simulation ---------------- */

function getSimulation() {
  const key = JSON.stringify({
    results: state.data.results.map((r) => `${r.id}:${r.homeGoals}-${r.awayGoals}`).join("|"),
    config: state.config,
  });
  if (!state.cache.has(key)) {
    const ratings = ratingsAfterResults(state.data.results);
    state.cache.set(key, simulateSeason(ratings, state.config.runs, state.config.seed, state.config));
  }
  return state.cache.get(key);
}

function simulateSeason(ratings, runs, seed, config) {
  const teams = state.data.teams;
  const index = new Map(teams.map((team, i) => [team.name, i]));
  const n = teams.length;

  const basePts = new Int32Array(n);
  const baseGd = new Int32Array(n);
  const baseGf = new Int32Array(n);
  const playedIds = new Set(state.data.results.map((result) => result.id));
  for (const match of state.data.results) {
    const h = index.get(match.home);
    const a = index.get(match.away);
    if (h == null || a == null) continue;
    baseGf[h] += match.homeGoals;
    baseGf[a] += match.awayGoals;
    baseGd[h] += match.homeGoals - match.awayGoals;
    baseGd[a] += match.awayGoals - match.homeGoals;
    if (match.homeGoals > match.awayGoals) basePts[h] += 3;
    else if (match.homeGoals < match.awayGoals) basePts[a] += 3;
    else {
      basePts[h] += 1;
      basePts[a] += 1;
    }
  }

  const remaining = state.data.schedule
    .filter((match) => !playedIds.has(match.id) && index.has(match.home) && index.has(match.away))
    .map((match) => {
      const prediction = matchPrediction(match.home, match.away, ratings, { config });
      const size = (MAX_GOALS + 1) * (MAX_GOALS + 1);
      const cumulative = new Float64Array(size);
      let total = 0;
      let cell = 0;
      for (let h = 0; h <= MAX_GOALS; h += 1) {
        for (let a = 0; a <= MAX_GOALS; a += 1) {
          total += prediction.matrix[h][a];
          cumulative[cell] = total;
          cell += 1;
        }
      }
      return { home: index.get(match.home), away: index.get(match.away), cumulative };
    });

  const random = mulberry32(seed);
  const titles = new Float64Array(n);
  const top4 = new Float64Array(n);
  const top5 = new Float64Array(n);
  const relegated = new Float64Array(n);
  const ptsSum = new Float64Array(n);
  const posDist = Array.from({ length: n }, () => new Float64Array(n));

  const pts = new Int32Array(n);
  const gd = new Int32Array(n);
  const gf = new Int32Array(n);
  const order = new Array(n);

  for (let run = 0; run < runs; run += 1) {
    pts.set(basePts);
    gd.set(baseGd);
    gf.set(baseGf);

    for (const fixture of remaining) {
      const pick = random();
      const cumulative = fixture.cumulative;
      let cell = 0;
      while (cell < cumulative.length - 1 && cumulative[cell] < pick) cell += 1;
      const hg = Math.floor(cell / (MAX_GOALS + 1));
      const ag = cell % (MAX_GOALS + 1);
      gf[fixture.home] += hg;
      gf[fixture.away] += ag;
      gd[fixture.home] += hg - ag;
      gd[fixture.away] += ag - hg;
      if (hg > ag) pts[fixture.home] += 3;
      else if (hg < ag) pts[fixture.away] += 3;
      else {
        pts[fixture.home] += 1;
        pts[fixture.away] += 1;
      }
    }

    for (let i = 0; i < n; i += 1) order[i] = i;
    order.sort((x, y) => pts[y] - pts[x] || gd[y] - gd[x] || gf[y] - gf[x] || random() - 0.5);

    for (let position = 0; position < n; position += 1) {
      const teamIndex = order[position];
      posDist[teamIndex][position] += 1;
      ptsSum[teamIndex] += pts[teamIndex];
      if (position === 0) titles[teamIndex] += 1;
      if (position < 4) top4[teamIndex] += 1;
      if (position < 5) top5[teamIndex] += 1;
      if (position >= n - 3) relegated[teamIndex] += 1;
    }
  }

  const teamStatsByName = new Map();
  teams.forEach((team, i) => {
    const positions = [...posDist[i]].map((count) => count / runs);
    let modePos = 0;
    positions.forEach((p, position) => {
      if (p > positions[modePos]) modePos = position;
    });
    teamStatsByName.set(team.name, {
      title: titles[i] / runs,
      top4: top4[i] / runs,
      top5: top5[i] / runs,
      relegated: relegated[i] / runs,
      avgPts: ptsSum[i] / runs,
      modePos: modePos + 1,
      positions,
    });
  });

  const championProb = teams
    .map((team) => ({ team, p: teamStatsByName.get(team.name).title }))
    .sort((a, b) => b.p - a.p);

  return { runs, teamStatsByName, championProb, remainingCount: remaining.length };
}

function deterministicProjection(ratings) {
  const playedIds = new Set(state.data.results.map((result) => result.id));
  const rows = computeStandings();
  for (const fixture of state.data.schedule.filter((match) => !playedIds.has(match.id))) {
    const home = rows.get(fixture.home);
    const away = rows.get(fixture.away);
    if (!home || !away) continue;
    const prediction = matchPrediction(fixture.home, fixture.away, ratings);
    const score = bestScoreline(prediction);
    applyResultToRows(home, away, score.hg, score.ag);
  }
  return sortedTable(rows);
}

function bestScoreline(prediction) {
  const outcome =
    prediction.pDraw > prediction.pHome && prediction.pDraw > prediction.pAway
      ? "draw"
      : prediction.pHome >= prediction.pAway
        ? "home"
        : "away";
  let best = null;
  for (let h = 0; h < prediction.matrix.length; h += 1) {
    for (let a = 0; a < prediction.matrix[h].length; a += 1) {
      if (outcome === "home" && h <= a) continue;
      if (outcome === "away" && a <= h) continue;
      if (outcome === "draw" && h !== a) continue;
      if (!best || prediction.matrix[h][a] > best.p) best = { hg: h, ag: a, p: prediction.matrix[h][a] };
    }
  }
  return best || { hg: 1, ag: 1, p: 0 };
}

/* ---------------- Fixtures / grading helpers ---------------- */

function nextFixture(schedule, results) {
  const played = new Set(results.map((result) => result.id));
  const now = Date.now();
  return (
    schedule.find((match) => !played.has(match.id) && Date.parse(match.date) >= now - 3 * 60 * 60 * 1000) ||
    schedule.find((match) => !played.has(match.id)) ||
    null
  );
}

function resultMap() {
  return new Map(state.data.results.map((result) => [result.id, result]));
}

function recentForm(teamName, count) {
  return state.data.results
    .filter((match) => match.home === teamName || match.away === teamName)
    .slice(-count)
    .map((match) => {
      const isHome = match.home === teamName;
      const gfor = isHome ? match.homeGoals : match.awayGoals;
      const gagainst = isHome ? match.awayGoals : match.homeGoals;
      return {
        result: gfor > gagainst ? "W" : gfor === gagainst ? "D" : "L",
        gf: gfor,
        ga: gagainst,
        opp: isHome ? match.away : match.home,
      };
    });
}

function gradePredictions(results) {
  const ratings = new Map(state.data.teams.map((team) => [team.name, team.prior]));
  const sorted = [...results].sort((a, b) => `${a.date}-${a.id}`.localeCompare(`${b.date}-${b.id}`));
  return sorted.map((match) => {
    const prediction = matchPrediction(match.home, match.away, ratings);
    const actual = match.homeGoals > match.awayGoals ? "home" : match.homeGoals < match.awayGoals ? "away" : "draw";
    const probs = { home: prediction.pHome, draw: prediction.pDraw, away: prediction.pAway };
    const picked = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
    const graded = { match, prediction, actual, picked, correct: actual === picked, pActual: probs[actual] };
    updateElo(ratings, match, state.config);
    return graded;
  });
}

function accuracyScores(graded) {
  if (!graded.length) return { n: 0, hitRate: 0, brier: 0, logLoss: 0, trend: [] };
  let hits = 0;
  let brier = 0;
  const cumulative = [];
  let running = 0;
  graded.forEach((row, indexPos) => {
    const p = { home: row.prediction.pHome, draw: row.prediction.pDraw, away: row.prediction.pAway };
    brier += (p.home - (row.actual === "home" ? 1 : 0)) ** 2;
    brier += (p.draw - (row.actual === "draw" ? 1 : 0)) ** 2;
    brier += (p.away - (row.actual === "away" ? 1 : 0)) ** 2;
    if (row.correct) hits += 1;
    running += -Math.log(Math.max(1e-12, row.pActual));
    cumulative.push(running / (indexPos + 1));
  });
  return {
    n: graded.length,
    hitRate: hits / graded.length,
    brier: brier / graded.length,
    logLoss: running / graded.length,
    trend: cumulative,
  };
}

/* ---------------- Singapore time formatting ---------------- */

function sgtKickoff(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const text = new Intl.DateTimeFormat("en-SG", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: SGT,
  }).format(date);
  return `${text} SGT`;
}

function sgtTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return new Intl.DateTimeFormat("en-SG", { hour: "numeric", minute: "2-digit", timeZone: SGT }).format(date);
}

function sgtDayKey(iso) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SGT, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}

function sgtDayLabel(iso) {
  return new Intl.DateTimeFormat("en-SG", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: SGT,
  }).format(new Date(iso));
}

function monthKeyOf(iso) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SGT, year: "numeric", month: "2-digit" }).format(new Date(iso));
}

function monthLabel(iso) {
  return new Intl.DateTimeFormat("en-SG", { timeZone: SGT, month: "short", year: "2-digit" }).format(new Date(iso));
}

function formatSnapshotTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${new Intl.DateTimeFormat("en-SG", { dateStyle: "medium", timeStyle: "short", timeZone: SGT }).format(date)} SGT`;
}

/* ---------------- Rendering ---------------- */

function render() {
  if (!state.data) {
    app.innerHTML = `<div class="shell"><div class="empty">Loading predictor data...</div></div>`;
    return;
  }
  const ratings = ratingsAfterResults(state.data.results);
  const sim = getSimulation();
  const active = state.tab;
  app.innerHTML = `
    <div class="shell">
      ${renderHeader(sim)}
      ${renderNav(active)}
      <main>${renderTab(active, ratings, sim)}</main>
      ${renderFooter()}
    </div>
  `;
  bindEvents();
}

function renderHeader(sim) {
  const leader = sim.championProb[0];
  return `
    <header class="topbar">
      <div>
        <div class="eyebrow">English Premier League 2026-27</div>
        <h1><span class="accent-green">Predictor</span> Lab</h1>
        <p class="lede">
          Elo ratings become expected goals, expected goals become scorelines, and ${fmtInt(state.config.runs)}
          Monte Carlo season runs turn those match odds into title, top-four, and relegation probabilities.
          All kickoff times are in Singapore time.
        </p>
      </div>
      <div class="header-actions">
        <span class="pill">${crest(leader.team)}<strong>${leader.team.short}</strong> ${pct(leader.p, 1)} title</span>
        <span class="pill"><strong>${state.data.results.length}</strong>/380 played</span>
        <button class="icon-button" data-action="theme" aria-label="Toggle theme" title="Toggle theme">${document.documentElement.classList.contains("light") ? "◐" : "☼"}</button>
      </div>
    </header>
  `;
}

function renderNav(active) {
  return `
    <nav class="nav" aria-label="Predictor sections">
      ${TABS.map(([id, label]) => `<button class="nav-button ${active === id ? "active" : ""}" data-tab="${id}">${label}</button>`).join("")}
    </nav>
  `;
}

function renderTab(tab, ratings, sim) {
  if (tab === "predict") return renderPredict(ratings, sim);
  if (tab === "fixtures") return renderFixtures(ratings);
  if (tab === "table") return renderTable(ratings, sim);
  if (tab === "projections") return renderProjections(sim);
  if (tab === "ratings") return renderRatings(ratings);
  if (tab === "results") return renderResults();
  if (tab === "sgpools") return renderSingaporePools(ratings);
  return renderMethod(ratings, sim);
}

/* ---------------- Predict tab ---------------- */

function renderPredict(ratings, sim) {
  const home = state.data.teamByName[state.home] || state.data.teams[0];
  const away = state.data.teamByName[state.away] || state.data.teams[1];
  const prediction = matchPrediction(home.name, away.name, ratings);
  const next = nextFixture(state.data.schedule, state.data.results);
  return `
    <div class="grid two">
      <section class="panel pad">
        ${next ? renderNextMatch(next, ratings) : ""}
        <div class="section-head" style="margin-top:16px">
          <div>
            <div class="label">Matchup</div>
            <h2>${crest(home)} ${home.short} vs ${crest(away)} ${away.short}</h2>
          </div>
        </div>
        <div class="select-row">
          ${teamSelect("home", home.name)}
          <span class="versus">vs</span>
          ${teamSelect("away", away.name)}
        </div>
        <div class="grid two" style="margin-top:14px">
          ${renderTeamCard(home, ratings, sim)}
          ${renderTeamCard(away, ratings, sim)}
        </div>
      </section>
      <section class="panel pad">
        <div class="match-hero">
          <div class="team-side">
            <div class="team-name"><span class="flag">${crest(home)}</span><span class="truncate">${home.short}</span></div>
            <span class="muted">xG ${prediction.lambdaHome.toFixed(2)}</span>
          </div>
          <span class="versus">${prediction.pDraw > prediction.pHome && prediction.pDraw > prediction.pAway ? "X" : prediction.pHome > prediction.pAway ? "1" : "2"}</span>
          <div class="team-side right">
            <div class="team-name"><span class="truncate">${away.short}</span><span class="flag">${crest(away)}</span></div>
            <span class="muted">xG ${prediction.lambdaAway.toFixed(2)}</span>
          </div>
        </div>
        <div class="odds-row" style="margin-top:12px">
          <div class="prob-card"><span class="label">${home.code} (home)</span><strong class="accent-green">${pct(prediction.pHome, 1)}</strong></div>
          <div class="prob-card"><span class="label">Draw</span><strong class="accent-amber">${pct(prediction.pDraw, 1)}</strong></div>
          <div class="prob-card"><span class="label">${away.code} (away)</span><strong class="accent-cyan">${pct(prediction.pAway, 1)}</strong></div>
        </div>
        <div class="bar" style="margin-top:12px">
          <span class="bar-home" style="width:${prediction.pHome * 100}%"></span>
          <span class="bar-draw" style="width:${prediction.pDraw * 100}%"></span>
          <span class="bar-away" style="width:${prediction.pAway * 100}%"></span>
        </div>
        <div class="grid four" style="margin-top:12px">
          ${metric("Over 2.5", pct(prediction.over25, 0), "Poisson total goals", "accent-cyan")}
          ${metric("BTTS", pct(prediction.btts, 0), "both teams score", "accent-green")}
          ${metric("Elo gap", signed(Math.round(prediction.ratingDiff)), "incl. home advantage", "accent-violet")}
          ${metric("Home edge", `${state.config.homeAdvantage}`, "Elo points at home", "accent-amber")}
        </div>
        <p class="muted" style="margin-top:12px;line-height:1.5">${matchRead(home, away, prediction)}</p>
      </section>
    </div>
    <div class="grid two" style="margin-top:14px">
      <section class="panel pad">
        <div class="section-head">
          <div>
            <div class="label">Scoreline matrix</div>
            <h2>Exact-score probabilities</h2>
          </div>
        </div>
        ${renderScoreMatrix(prediction, home.code, away.code)}
      </section>
      <section class="panel pad">
        <div class="section-head">
          <div>
            <div class="label">Most likely scorelines</div>
            <h2>Modal paths</h2>
          </div>
        </div>
        ${renderTopScorelines(prediction, home, away)}
        ${renderSeasonMeetings(home, away)}
      </section>
    </div>
    ${renderControls()}
  `;
}

function renderNextMatch(match, ratings) {
  const prediction = matchPrediction(match.home, match.away, ratings);
  const home = state.data.teamByName[match.home];
  const away = state.data.teamByName[match.away];
  const fav =
    prediction.pDraw > prediction.pHome && prediction.pDraw > prediction.pAway
      ? null
      : prediction.pHome > prediction.pAway
        ? home
        : away;
  const favProb = Math.max(prediction.pHome, prediction.pDraw, prediction.pAway);
  return `
    <div class="panel flat pad" style="background:var(--panel-2)">
      <div class="section-head">
        <div>
          <div class="label">Next match</div>
          <h2>${sgtKickoff(match.date)}</h2>
        </div>
        <span class="tag">Premier League</span>
      </div>
      <div class="match-row">
        <span class="team-inline">${crest(home)}<span>${home.short}</span></span>
        <span class="center-score">v</span>
        <span class="team-inline">${crest(away)}<span>${away.short}</span></span>
        <span class="tag">${fav ? `${fav.code} ${pct(favProb, 0)}` : `Draw ${pct(favProb, 0)}`}</span>
      </div>
      <p class="muted" style="margin-top:8px">Venue: ${escapeHtml(match.venue || "TBC")}</p>
    </div>
  `;
}

function teamSelect(kind, selected) {
  return `
    <select data-select="${kind}" aria-label="${kind === "home" ? "Home team" : "Away team"}">
      ${state.data.teams.map((team) => `<option value="${escapeAttr(team.name)}" ${team.name === selected ? "selected" : ""}>${team.name} (${team.code})</option>`).join("")}
    </select>
  `;
}

function renderTeamCard(team, ratings, sim) {
  const rank =
    [...state.data.teams].sort((a, b) => ratingOf(b, ratings) - ratingOf(a, ratings)).findIndex((row) => row.name === team.name) + 1;
  const stats = sim.teamStatsByName.get(team.name);
  const form = recentForm(team.name, 5);
  return `
    <div class="team-card panel flat pad">
      <div class="section-head" style="margin-bottom:0">
        <div>
          <h3>${crest(team)} ${team.short}</h3>
          <span class="muted">${team.code} · Elo rank #${rank}</span>
        </div>
        <strong class="accent-green">${Math.round(ratingOf(team, ratings))}</strong>
      </div>
      <div class="team-meta">
        <span class="tag">Title ${pct(stats?.title || 0, 1)}</span>
        <span class="tag">Top 4 ${pct(stats?.top4 || 0, 0)}</span>
        <span class="tag">Releg. ${pct(stats?.relegated || 0, 0)}</span>
      </div>
      <div>
        <div class="mini-label">Recent form</div>
        <div class="form-dots" style="margin-top:6px">
          ${form.map((item) => `<span class="form-dot ${item.result}" title="${item.result} ${item.gf}-${item.ga} vs ${escapeAttr(item.opp)}">${item.result}</span>`).join("") || `<span class="muted">No matches played yet</span>`}
        </div>
      </div>
    </div>
  `;
}

function renderScoreMatrix(prediction, homeCode, awayCode) {
  const max = Math.max(...prediction.matrix.flat());
  const cols = Array.from({ length: 7 }, (_, i) => i);
  return `
    <div class="matrix-wrap">
      <table class="score-matrix">
        <thead>
          <tr><th>${homeCode}/${awayCode}</th>${cols.map((col) => `<th>${col}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${cols.map((h) => `
            <tr>
              <th>${h}</th>
              ${cols.map((a) => `<td class="heat" style="--heat:${Math.max(4, (prediction.matrix[h][a] / max) * 92)}">${pct(prediction.matrix[h][a], 0)}</td>`).join("")}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <p class="muted" style="margin-top:10px">Rows are ${homeCode} goals, columns are ${awayCode} goals. Probabilities beyond six goals are modelled but hidden from this compact grid.</p>
  `;
}

function renderTopScorelines(prediction, home, away) {
  return `
    <div class="list">
      ${prediction.topScorelines.map((score, indexPos) => `
        <div class="match-row">
          <span class="faint">#${indexPos + 1}</span>
          <span class="team-inline">${crest(home)}<span>${home.code}</span></span>
          <span class="center-score">${score.h}-${score.a}</span>
          <span class="team-inline">${crest(away)}<span>${away.code}</span></span>
          <strong>${pct(score.p, 1)}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function renderSeasonMeetings(home, away) {
  const results = resultMap();
  const meetings = state.data.schedule.filter(
    (match) =>
      (match.home === home.name && match.away === away.name) || (match.home === away.name && match.away === home.name),
  );
  if (!meetings.length) return "";
  return `
    <div class="mini-label" style="margin-top:14px">This season's meetings</div>
    <div class="list" style="margin-top:8px">
      ${meetings.map((match) => {
        const result = results.get(match.id);
        const h = state.data.teamByName[match.home];
        const a = state.data.teamByName[match.away];
        return `
          <div class="match-row">
            <span class="faint">${sgtKickoff(match.date)}</span>
            <span class="team-inline">${crest(h)}<span>${h.code}</span></span>
            <span class="center-score">${result ? `${result.homeGoals}-${result.awayGoals}` : "v"}</span>
            <span class="team-inline">${crest(a)}<span>${a.code}</span></span>
            <span class="tag">${result ? "FT" : "Upcoming"}</span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function matchRead(home, away, prediction) {
  const favourite = prediction.pHome >= prediction.pAway ? home : away;
  const edge = Math.abs(prediction.pHome - prediction.pAway);
  const closeness = edge < 0.08 ? "This projects as a tight match" : edge < 0.22 ? `${favourite.short} are moderate favourites` : `${favourite.short} are strong favourites`;
  const goals = prediction.lambdaHome + prediction.lambdaAway;
  const tempo = goals > 3 ? "a high-scoring profile" : goals > 2.3 ? "a balanced goal expectation" : "a low-scoring profile";
  return `${closeness} with ${tempo}: combined xG ${goals.toFixed(2)}, draw ${pct(prediction.pDraw, 0)}, and the most likely scoreline ${prediction.topScorelines[0].h}-${prediction.topScorelines[0].a}.`;
}

/* ---------------- Fixtures tab ---------------- */

function renderFixtures(ratings) {
  const months = [...new Set(state.data.schedule.map((match) => monthKeyOf(match.date)))].sort();
  if (!months.includes(state.month)) state.month = months[0];
  const results = resultMap();
  const monthMatches = state.data.schedule.filter((match) => monthKeyOf(match.date) === state.month);
  const grouped = groupBy(monthMatches, (match) => sgtDayKey(match.date));
  return `
    <section class="panel pad">
      <div class="section-head">
        <div>
          <div class="label">Fixtures</div>
          <h2>All 380 matches, Singapore time</h2>
        </div>
        <p>Played matches show the final score. Upcoming matches show the model favourite and can be opened in Predict.</p>
      </div>
      <div class="team-meta" style="margin-bottom:14px">
        ${months.map((key) => {
          const sample = state.data.schedule.find((match) => monthKeyOf(match.date) === key);
          return `<button class="nav-button ${key === state.month ? "active" : ""}" data-month="${key}">${monthLabel(sample.date)}</button>`;
        }).join("")}
      </div>
      ${Object.entries(grouped).map(([day, matches]) => `
        <div class="timeline-day">
          <div class="timeline-title">
            <h3>${sgtDayLabel(matches[0].date)}</h3>
            <span class="tag">${matches.length} match${matches.length === 1 ? "" : "es"}</span>
          </div>
          <div class="list">
            ${matches.map((match) => renderFixtureRow(match, results.get(match.id), ratings)).join("")}
          </div>
        </div>
      `).join("")}
    </section>
  `;
}

function renderFixtureRow(match, result, ratings) {
  const home = state.data.teamByName[match.home];
  const away = state.data.teamByName[match.away];
  if (!home || !away) return "";
  const canPick = !result;
  let status = "FT";
  if (!result) {
    const prediction = matchPrediction(match.home, match.away, ratings);
    if (prediction.pDraw > prediction.pHome && prediction.pDraw > prediction.pAway) {
      status = `Draw ${pct(prediction.pDraw, 0)}`;
    } else {
      const fav = prediction.pHome > prediction.pAway ? home : away;
      status = `${fav.code} ${pct(Math.max(prediction.pHome, prediction.pAway), 0)}`;
    }
  }
  return `
    <button class="match-button" ${canPick ? `data-pick="${escapeAttr(match.home)}|${escapeAttr(match.away)}"` : "disabled"}>
      <span class="stage-chip">${sgtTime(match.date)}</span>
      <span class="team-inline">${crest(home)}<span>${home.short}</span></span>
      <span class="center-score">${result ? `${result.homeGoals}-${result.awayGoals}` : "v"}</span>
      <span class="team-inline">${crest(away)}<span>${away.short}</span></span>
      <span class="tag">${status}</span>
      <span class="faint" style="grid-column:1 / -1">${sgtKickoff(match.date)} · ${escapeHtml(match.venue || "Venue TBC")}</span>
    </button>
  `;
}

/* ---------------- Table tab ---------------- */

function renderTable(ratings, sim) {
  const live = sortedTable(computeStandings());
  const projected = deterministicProjection(ratings);
  return `
    <div class="grid two">
      <section class="panel pad">
        <div class="section-head">
          <div>
            <div class="label">Live table</div>
            <h2>Actual results only</h2>
          </div>
        </div>
        ${renderLeagueTable(live, { showForm: true })}
        ${renderZoneLegend()}
      </section>
      <section class="panel pad">
        <div class="section-head">
          <div>
            <div class="label">Projected final table</div>
            <h2>Single most likely path</h2>
          </div>
          <p>Current results plus the modal scoreline for every remaining fixture. See Projections for full Monte Carlo probabilities.</p>
        </div>
        ${renderLeagueTable(projected, { simStats: sim.teamStatsByName })}
      </section>
    </div>
  `;
}

function renderLeagueTable(rows, options = {}) {
  return `
    <div class="matrix-wrap">
      <table class="standings-table">
        <thead>
          <tr>
            <th>#</th><th>Team</th><th class="num">P</th><th class="num">W</th><th class="num">D</th><th class="num">L</th>
            <th class="num">GD</th><th class="num">Pts</th>${options.showForm ? "<th>Form</th>" : ""}${options.simStats ? `<th class="num">Title</th>` : ""}
          </tr>
        </thead>
        <tbody>
          ${rows.map((row, indexPos) => {
            const position = indexPos + 1;
            const zone = zoneFor(position);
            const form = options.showForm ? recentForm(row.team.name, 5) : null;
            const stats = options.simStats ? options.simStats.get(row.team.name) : null;
            return `
              <tr class="${zone.cls}">
                <td>${position}</td>
                <td><span class="team-inline">${crest(row.team)}<span>${row.team.short}</span></span></td>
                <td class="num">${row.played}</td>
                <td class="num">${row.won}</td>
                <td class="num">${row.drawn}</td>
                <td class="num">${row.lost}</td>
                <td class="num">${signed(row.gd)}</td>
                <td class="num"><strong>${row.pts}</strong></td>
                ${form ? `<td><span class="form-dots">${form.map((item) => `<span class="form-dot ${item.result}">${item.result}</span>`).join("") || `<span class="faint">--</span>`}</span></td>` : ""}
                ${stats ? `<td class="num">${pct(stats.title, 1)}</td>` : ""}
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderZoneLegend() {
  return `
    <div class="team-meta" style="margin-top:12px">
      <span class="tag zone-title">1 Champions</span>
      <span class="tag zone-ucl">2-4 Champions League</span>
      <span class="tag zone-uel">5 Europa League</span>
      <span class="tag zone-rel">18-20 Relegation</span>
    </div>
  `;
}

/* ---------------- Projections tab ---------------- */

function renderProjections(sim) {
  const byTitle = [...sim.teamStatsByName.entries()].sort((a, b) => b[1].title - a[1].title);
  const byTop4 = [...sim.teamStatsByName.entries()].sort((a, b) => b[1].top4 - a[1].top4);
  const byReleg = [...sim.teamStatsByName.entries()].sort((a, b) => b[1].relegated - a[1].relegated);
  const byPts = [...sim.teamStatsByName.entries()].sort((a, b) => b[1].avgPts - a[1].avgPts);
  const leader = byTitle[0];
  const relegFav = byReleg[0];
  return `
    <section class="panel pad">
      <div class="section-head">
        <div>
          <div class="label">Season simulation</div>
          <h2>${fmtInt(sim.runs)} Monte Carlo seasons</h2>
        </div>
        <p>Every run replays the remaining ${fmtInt(sim.remainingCount)} fixtures from Poisson scoreline distributions, then ranks the final table on points, goal difference, and goals scored.</p>
      </div>
      <div class="grid four">
        ${metric("Title favourite", `${teamShort(leader[0])}`, pct(leader[1].title, 1), "accent-green")}
        ${metric("Most at risk", `${teamShort(relegFav[0])}`, `${pct(relegFav[1].relegated, 1)} relegation`, "accent-rose")}
        ${metric("Simulated seasons", fmtInt(sim.runs), "per model refresh", "accent-cyan")}
        ${metric("Fixtures left", fmtInt(sim.remainingCount), "of 380 total", "accent-amber")}
      </div>
    </section>
    <div class="grid two" style="margin-top:14px">
      ${probabilityPanel("Title race", "P(champions)", byTitle.slice(0, 8), (stats) => stats.title, "var(--green)")}
      ${probabilityPanel("Top four", "P(Champions League)", byTop4.slice(0, 8), (stats) => stats.top4, "var(--cyan)")}
    </div>
    <div class="grid two" style="margin-top:14px">
      ${probabilityPanel("Relegation battle", "P(bottom three)", byReleg.slice(0, 8), (stats) => stats.relegated, "var(--rose, #e5484d)")}
      <section class="panel pad">
        <div class="section-head">
          <div><div class="label">Expected points</div><h2>Full-season forecast</h2></div>
        </div>
        <div class="matrix-wrap">
          <table>
            <thead><tr><th>Team</th><th class="num">xPts</th><th class="num">Mode pos</th><th class="num">Title</th><th class="num">Top 4</th><th class="num">Releg.</th></tr></thead>
            <tbody>
              ${byPts.map(([name, stats]) => `
                <tr>
                  <td><span class="team-inline">${crest(state.data.teamByName[name])}<span>${teamShort(name)}</span></span></td>
                  <td class="num"><strong>${stats.avgPts.toFixed(1)}</strong></td>
                  <td class="num">${stats.modePos}</td>
                  <td class="num">${pct(stats.title, 1)}</td>
                  <td class="num">${pct(stats.top4, 1)}</td>
                  <td class="num">${pct(stats.relegated, 1)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `;
}

function probabilityPanel(label, heading, entries, pick, color) {
  const max = Math.max(0.01, ...entries.map(([, stats]) => pick(stats)));
  return `
    <section class="panel pad">
      <div class="section-head">
        <div><div class="label">${label}</div><h2>${heading}</h2></div>
      </div>
      <div class="list">
        ${entries.map(([name, stats]) => `
          <div class="match-row">
            <span class="team-inline">${crest(state.data.teamByName[name])}<span>${teamShort(name)}</span></span>
            <span class="bar" style="grid-column:2 / 5"><span style="display:block;height:100%;border-radius:inherit;width:${(pick(stats) / max) * 100}%;background:${color}"></span></span>
            <strong>${pct(pick(stats), 1)}</strong>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

/* ---------------- Ratings tab ---------------- */

function renderRatings(ratings) {
  const rows = [...state.data.teams].sort((a, b) => ratingOf(b, ratings) - ratingOf(a, ratings));
  const maxDelta = Math.max(1, ...rows.map((team) => Math.abs(ratingOf(team, ratings) - team.prior)));
  return `
    <section class="panel pad">
      <div class="section-head">
        <div>
          <div class="label">Elo ratings</div>
          <h2>Live strength estimates</h2>
        </div>
        <p>Ratings start from preseason priors and update after every result with margin-of-victory scaling. Home advantage is worth ${state.config.homeAdvantage} Elo points in match predictions.</p>
      </div>
      <div class="matrix-wrap">
        <table>
          <thead><tr><th>#</th><th>Team</th><th class="num">Elo</th><th class="num">Prior</th><th class="num">Change</th><th>Movement</th><th class="num">Form ppg</th></tr></thead>
          <tbody>
            ${rows.map((team, indexPos) => {
              const rating = ratingOf(team, ratings);
              const delta = rating - team.prior;
              const form = state.data.styles[team.name]?.formPower || 0;
              return `
                <tr>
                  <td>${indexPos + 1}</td>
                  <td><span class="team-inline">${crest(team)}<span>${team.short}</span></span></td>
                  <td class="num"><strong>${Math.round(rating)}</strong></td>
                  <td class="num">${team.prior}</td>
                  <td class="num ${delta >= 0 ? "accent-green" : "accent-rose"}">${signed(Math.round(delta))}</td>
                  <td>${movementBar(delta, maxDelta)}</td>
                  <td class="num">${form ? form.toFixed(2) : "--"}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function movementBar(delta, maxDelta) {
  const width = Math.min(100, (Math.abs(delta) / maxDelta) * 100);
  const color = delta >= 0 ? "var(--green)" : "var(--rose, #e5484d)";
  return `<span class="bar"><span style="display:block;height:100%;border-radius:inherit;width:${width}%;background:${color}"></span></span>`;
}

/* ---------------- Results tab ---------------- */

function renderResults() {
  const graded = gradePredictions(state.data.results);
  if (!graded.length) {
    const first = state.data.schedule[0];
    return `
      <section class="panel pad">
        <div class="empty">
          <strong>No matches played yet.</strong>
          <p style="margin-top:8px">The 2026-27 season kicks off ${first ? sgtKickoff(first.date) : "soon"}. Results and the prediction scorecard will appear here automatically.</p>
        </div>
      </section>
    `;
  }
  const scores = accuracyScores(graded);
  const grouped = groupBy([...graded].reverse(), (row) => sgtDayKey(row.match.date));
  return `
    <section class="panel pad">
      <div class="section-head">
        <div><div class="label">Prediction scorecard</div><h2>How the model is doing</h2></div>
        <p>Each finished match is graded against the probabilities the model would have quoted at kickoff, using only earlier results.</p>
      </div>
      <div class="grid four">
        ${metric("Matches graded", scores.n, "completed fixtures", "accent-cyan")}
        ${metric("Hit rate", pct(scores.hitRate, 1), "picked outcome was right", "accent-green")}
        ${metric("Brier score", scores.brier.toFixed(3), "lower is better", "accent-amber")}
        ${metric("Log loss", scores.logLoss.toFixed(3), "lower is better", "accent-violet")}
      </div>
      ${scores.trend.length > 1 ? renderSparkline(scores.trend) : ""}
    </section>
    <section class="panel pad" style="margin-top:14px">
      <div class="section-head">
        <div><div class="label">Results</div><h2>Most recent first, Singapore time</h2></div>
      </div>
      ${Object.entries(grouped).map(([day, rows]) => `
        <div class="timeline-day">
          <div class="timeline-title">
            <h3>${sgtDayLabel(rows[0].match.date)}</h3>
            <span class="tag">${rows.length} match${rows.length === 1 ? "" : "es"}</span>
          </div>
          <div class="list">
            ${rows.map((row) => renderResultCard(row)).join("")}
          </div>
        </div>
      `).join("")}
    </section>
  `;
}

function renderResultCard(row) {
  const home = state.data.teamByName[row.match.home];
  const away = state.data.teamByName[row.match.away];
  const pickedLabel = row.picked === "home" ? home.code : row.picked === "away" ? away.code : "Draw";
  return `
    <div class="match-row">
      <span class="faint">${sgtTime(row.match.date)}</span>
      <span class="team-inline">${crest(home)}<span>${home.short}</span></span>
      <span class="center-score">${row.match.homeGoals}-${row.match.awayGoals}</span>
      <span class="team-inline">${crest(away)}<span>${away.short}</span></span>
      <span class="tag ${row.correct ? "zone-title" : ""}">${row.correct ? "✓" : "✗"} ${pickedLabel} ${pct(row.pActual, 0)}</span>
    </div>
  `;
}

function renderSparkline(points) {
  const w = 760;
  const h = 110;
  const min = Math.min(...points, 1.0);
  const max = Math.max(...points, 1.2);
  const span = max - min || 1;
  const x = (indexPos) => (indexPos / (points.length - 1)) * w;
  const y = (value) => h - 12 - ((value - min) / span) * (h - 24);
  const path = points.map((value, indexPos) => `${indexPos ? "L" : "M"}${x(indexPos).toFixed(1)} ${y(value).toFixed(1)}`).join(" ");
  return `
    <svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Rolling log-loss trend">
      <path d="${path}" fill="none" stroke="var(--cyan)" stroke-width="3" vector-effect="non-scaling-stroke"></path>
      <circle cx="${x(points.length - 1)}" cy="${y(points.at(-1))}" r="4" fill="var(--cyan)"></circle>
    </svg>
  `;
}

/* ---------------- Singapore Pools tab ---------------- */

function renderSingaporePools(ratings) {
  const feed = state.data.singaporePools || defaultSingaporePoolsFeed();
  const events = singaporePoolsEplEvents(feed);
  const upcoming = singaporePoolsWatchlist(ratings, events);
  const sourceState = events.length
    ? `${events.length} public event listing${events.length === 1 ? "" : "s"}`
    : feed.generatedAt
      ? "Checked, no public listings"
      : "No snapshot yet";
  return `
    <section class="panel pad">
      <div class="section-head">
        <div>
          <div class="label">Singapore Pools</div>
          <h2>English Premier League market watch</h2>
        </div>
        <p>Informational comparison only. This page does not place bets, size stakes, or tell you to gamble. Singapore Pools account betting is only for people above 21, and under-18 betting is not allowed.</p>
      </div>
      <div class="grid four">
        ${metric("Source", "SG Pools", sourceState, "accent-green")}
        ${metric("Snapshot", feed.generatedAt ? formatSnapshotTime(feed.generatedAt) : "Not connected", "daily at 8:05 am SGT", "accent-cyan")}
        ${metric("Markets known", SG_POOLS_BET_TYPES.length, "football bet-type catalogue", "accent-amber")}
        ${metric("Mode", "Availability", "public listings + model fair odds", "accent-violet")}
      </div>
      <p class="muted" style="margin-top:12px;line-height:1.5">
        The daily updater writes public Singapore Pools EPL listing hints into <code>data/sgpools-markets.json</code>. Live prices are intentionally not fetched; this page shows availability context beside the predictor's own fair odds.
      </p>
      <div class="team-meta" style="margin-top:12px">
        <a class="pill" href="https://online.singaporepools.com/en/sports/competition/36/football/england/english-premier" target="_blank" rel="noreferrer noopener">Open SG Pools EPL page</a>
        <a class="pill" href="https://online.singaporepools.com/en/sports/football-bet-types" target="_blank" rel="noreferrer noopener">Football bet types</a>
      </div>
    </section>
    <div class="grid two" style="margin-top:14px">
      <section class="panel pad">
        <div class="section-head">
          <div>
            <div class="label">Available at snapshot</div>
            <h2>${events.length ? "EPL listings found" : "Waiting for public listings"}</h2>
          </div>
        </div>
        ${events.length ? renderSingaporePoolsEvents(events, ratings) : renderSingaporePoolsEmpty(feed)}
      </section>
      <section class="panel pad">
        <div class="section-head">
          <div>
            <div class="label">Market catalogue</div>
            <h2>Singapore football bet types</h2>
          </div>
        </div>
        <div class="team-meta">
          ${SG_POOLS_BET_TYPES.map(([code, name]) => `<span class="tag">${code} · ${name}</span>`).join("")}
        </div>
        <p class="muted" style="margin-top:12px;line-height:1.5">The model can directly estimate 1X2, Over/Under 2.5, Both Teams Score, and Pick the Score. Bet-type names are shown for availability context only.</p>
      </section>
    </div>
    <section class="panel pad" style="margin-top:14px">
      <div class="section-head">
        <div>
          <div class="label">Upcoming fixture watchlist</div>
          <h2>Model fair prices for comparable markets</h2>
        </div>
        <p>Fair odds are 1 divided by model probability. They are generated by this predictor only and are not Singapore Pools prices or recommendations.</p>
      </div>
      <div class="list">
        ${upcoming.map((item) => renderSingaporePoolsWatchCard(item)).join("") || `<div class="empty">Season complete - no upcoming fixtures.</div>`}
      </div>
    </section>
  `;
}

function singaporePoolsEplEvents(feed) {
  const events = Array.isArray(feed.events) ? feed.events : [];
  return events.filter((event) => {
    const text = `${event.competition || ""} ${event.league || ""}`.toLowerCase();
    return (
      text.includes("premier") ||
      text.includes("epl") ||
      Boolean(findFixtureByTeams(event.home, event.away))
    );
  });
}

function singaporePoolsWatchlist(ratings, sgEvents) {
  const played = new Set(state.data.results.map((result) => result.id));
  return state.data.schedule
    .filter((match) => !played.has(match.id))
    .slice(0, 10)
    .map((match) => {
      const prediction = matchPrediction(match.home, match.away, ratings);
      const event = sgEvents.find((candidate) => matchByTeams(candidate.home, candidate.away, match.home, match.away));
      return { match, prediction, event, comparisons: modelComparableMarkets(prediction, match) };
    });
}

function renderSingaporePoolsEvents(events, ratings) {
  return `
    <div class="list">
      ${events.map((event) => {
        const match = findFixtureByTeams(event.home, event.away);
        const prediction = match ? matchPrediction(match.home, match.away, ratings) : null;
        return `
          <div class="panel flat pad">
            <div class="section-head">
              <div>
                <h3>${escapeHtml(event.home || "TBD")} vs ${escapeHtml(event.away || "TBD")}</h3>
                <span class="muted">${event.kickoff ? escapeHtml(formatSnapshotTime(event.kickoff)) : match ? sgtKickoff(match.date) : "Kickoff TBC"} · ${escapeHtml(event.competition || "Football")}</span>
              </div>
              <span class="tag">${escapeHtml(event.status || "available")}</span>
            </div>
            ${prediction ? renderMarketComparisonTable(modelComparableMarkets(prediction, match)) : `<p class="muted" style="margin-top:10px">Could not match this listing to the fixture list, so model fair odds are not shown.</p>`}
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderSingaporePoolsEmpty(feed) {
  const checkedAt = feed.generatedAt ? formatSnapshotTime(feed.generatedAt) : null;
  return `
    <div class="empty" style="text-align:left">
      <strong>${checkedAt ? "No public Singapore Pools EPL listings were found at the last check." : "The Singapore Pools updater has not run yet."}</strong>
      <p style="margin-top:8px">${checkedAt ? `Last checked: ${escapeHtml(checkedAt)}.` : "Run the updater to create the first snapshot."}</p>
      <p style="margin-top:8px">${escapeHtml(feed.note || "Singapore Pools usually lists Premier League matches a few days before kickoff.")}</p>
    </div>
  `;
}

function renderSingaporePoolsWatchCard(item) {
  const home = state.data.teamByName[item.match.home];
  const away = state.data.teamByName[item.match.away];
  return `
    <div class="panel flat pad">
      <div class="section-head">
        <div>
          <h3>${crest(home)} ${home.short} vs ${crest(away)} ${away.short}</h3>
          <span class="muted">${sgtKickoff(item.match.date)} · ${escapeHtml(item.match.venue || "Venue TBC")}</span>
        </div>
        <span class="tag">${item.event ? "Public SG listing" : "No public SG listing"}</span>
      </div>
      ${renderMarketComparisonTable(item.comparisons)}
    </div>
  `;
}

function renderMarketComparisonTable(comparisons) {
  return `
    <div class="matrix-wrap" style="margin-top:10px">
      <table>
        <thead>
          <tr><th>Market</th><th>Selection</th><th class="num">Model</th><th class="num">Fair odds</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${comparisons.map((row) => `
            <tr>
              <td>${row.market}</td>
              <td>${row.selection}</td>
              <td class="num">${row.probability != null ? pct(row.probability, 1) : "--"}</td>
              <td class="num">${row.fairOdds ? row.fairOdds.toFixed(2) : "--"}</td>
              <td>Model only</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function modelComparableMarkets(prediction, match) {
  const home = state.data.teamByName[match.home];
  const away = state.data.teamByName[match.away];
  const rows = [
    marketRow("1X2", home.short, prediction.pHome),
    marketRow("1X2", "Draw", prediction.pDraw),
    marketRow("1X2", away.short, prediction.pAway),
    marketRow("Over/Under 2.5", "Over 2.5", prediction.over25),
    marketRow("Over/Under 2.5", "Under 2.5", 1 - prediction.over25),
    marketRow("Both Teams Score", "Yes", prediction.btts),
    marketRow("Both Teams Score", "No", 1 - prediction.btts),
  ];
  prediction.topScorelines.slice(0, 3).forEach((score) => {
    rows.push(marketRow("Pick the Score", `${score.h}-${score.a}`, score.p));
  });
  return rows;
}

function marketRow(market, selection, probability) {
  return {
    market,
    selection,
    probability,
    fairOdds: probability > 0 ? 1 / probability : null,
  };
}

function matchByTeams(aHome, aAway, bHome, bAway) {
  if (!aHome || !aAway || !bHome || !bAway) return false;
  const left = [normalizeTeamName(aHome), normalizeTeamName(aAway)].sort().join("|");
  const right = [normalizeTeamName(bHome), normalizeTeamName(bAway)].sort().join("|");
  return left === right;
}

function findFixtureByTeams(home, away) {
  if (!home || !away) return null;
  return state.data.schedule.find((match) => matchByTeams(home, away, match.home, match.away)) || null;
}

function normalizeTeamName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\bafc\b|\bfc\b/g, "")
    .replace(/manchester/g, "man")
    .replace(/\butd\b/g, "united")
    .replace(/tottenham hotspur|spurs/g, "tottenham")
    .replace(/brighton (and|&) hove albion/g, "brighton")
    .replace(/nottingham|nott m|nottm/g, "nott")
    .replace(/wolverhampton wanderers/g, "wolves")
    .replace(/west ham united/g, "west ham")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/* ---------------- Method tab ---------------- */

function renderMethod(ratings, sim) {
  const top = sim.championProb[0];
  return `
    <section class="panel pad">
      <div class="section-head">
        <div><div class="label">Method</div><h2>Elo + Poisson + Monte Carlo</h2></div>
        <p>This is the working model behind every tab. Change the controls and the match odds, table projections, and season probabilities recompute together.</p>
      </div>
      <div class="grid four">
        ${metric("Title favourite", `${teamShort(top.team.name)}`, pct(top.p, 1), "accent-green")}
        ${metric("Runs", fmtInt(sim.runs), "Monte Carlo seasons", "accent-cyan")}
        ${metric("Home advantage", state.config.homeAdvantage, "Elo points at home", "accent-amber")}
        ${metric("K-factor", state.config.kFactor, "Elo update speed", "accent-violet")}
      </div>
      <p class="muted" style="margin-top:12px;line-height:1.5">${escapeHtml(state.data.priorsNote || "")}</p>
    </section>
    ${renderControls()}
    <div class="grid two" style="margin-top:14px">
      <section class="panel pad">
        <div class="section-head"><div><div class="label">Formula stack</div><h2>How a match is priced</h2></div></div>
        <table>
          <tbody>
            <tr><th>Elo update</th><td>New Elo = old Elo + K x margin factor x (actual - expected)</td></tr>
            <tr><th>Strength</th><td>Effective Elo adds home advantage and a recent-form attack/defense style multiplier.</td></tr>
            <tr><th>Goals</th><td>xG = base xG x exp(Elo gap / scale) x style multiplier, clamped to a sane range.</td></tr>
            <tr><th>Scoreline</th><td>Poisson goal distributions adjusted for low-score dependence (Dixon-Coles) and 0-0 inflation.</td></tr>
            <tr><th>Draws</th><td>A closeness curve nudges draw probability upward when teams are similarly rated.</td></tr>
            <tr><th>Season</th><td>Actual results stand; every remaining fixture is sampled thousands of times to estimate title, top-four, and relegation odds.</td></tr>
            <tr><th>Data</th><td>Fixtures and results refresh hourly from ESPN's public scoreboard via GitHub Actions; Singapore Pools listings refresh daily. Nothing depends on any personal machine being online.</td></tr>
          </tbody>
        </table>
      </section>
      <section class="panel pad">
        <div class="section-head"><div><div class="label">Model inputs</div><h2>Top live ratings</h2></div></div>
        <table>
          <thead><tr><th>Team</th><th class="num">Elo</th><th class="num">Title</th></tr></thead>
          <tbody>
            ${[...state.data.teams].sort((a, b) => ratingOf(b, ratings) - ratingOf(a, ratings)).slice(0, 10).map((team) => {
              const stats = sim.teamStatsByName.get(team.name);
              return `<tr><td><span class="team-inline">${crest(team)}<span>${team.short}</span></span></td><td class="num">${Math.round(ratingOf(team, ratings))}</td><td class="num">${pct(stats.title, 1)}</td></tr>`;
            }).join("")}
          </tbody>
        </table>
      </section>
    </div>
  `;
}

function renderControls() {
  const c = state.config;
  return `
    <section class="panel pad" style="margin-top:14px">
      <div class="section-head">
        <div><div class="label">Model controls</div><h2>Simulation settings</h2></div>
        <button class="primary-button" data-action="reset-config">Reset</button>
      </div>
      <div class="control-grid">
        ${control("runs", "Runs", c.runs, 1000, 20000, 500, fmtInt(c.runs))}
        ${control("kFactor", "K-factor", c.kFactor, 10, 60, 2, c.kFactor)}
        ${control("homeAdvantage", "Home advantage", c.homeAdvantage, 0, 120, 5, c.homeAdvantage)}
        ${control("styleWeight", "Style weight", c.styleWeight, 0, 150, 5, `${c.styleWeight}%`)}
        ${control("drawGuard", "Draw guard", c.drawGuard, 0, 30, 1, `${c.drawGuard}%`)}
        ${control("baseXg", "Base xG", c.baseXg, 1.0, 1.8, 0.05, c.baseXg.toFixed(2))}
        ${control("xgScale", "Elo to xG scale", c.xgScale, 360, 760, 20, c.xgScale)}
        ${control("zeroInflation", "0-0 inflation", c.zeroInflation, 0, 0.8, 0.05, c.zeroInflation.toFixed(2))}
        ${control("rho", "Low-score rho", c.rho, -0.2, 0.1, 0.01, c.rho.toFixed(2))}
      </div>
    </section>
  `;
}

function control(key, label, value, min, max, step, output) {
  return `
    <div class="control">
      <label><span>${label}</span><output>${output}</output></label>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-control="${key}">
    </div>
  `;
}

function metric(label, value, sub, accent = "accent-green") {
  return `
    <div class="metric">
      <div class="label">${label}</div>
      <div class="value ${accent}">${value}</div>
      <div class="sub">${sub}</div>
    </div>
  `;
}

function renderFooter() {
  return `
    <footer class="footer">
      All dates and kickoff times are shown in Singapore time (SGT, UTC+8).
      Fixtures and results refresh hourly from ESPN's public scoreboard via GitHub Actions; Singapore Pools public listings refresh daily.
      Model probabilities are estimates for entertainment, not betting advice. If gambling is a problem, call the National Council on Problem Gambling helpline: 1800-6-668-668.
    </footer>
  `;
}

/* ---------------- Events ---------------- */

function bindEvents() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      location.hash = button.dataset.tab;
    });
  });

  document.querySelectorAll("[data-month]").forEach((button) => {
    button.addEventListener("click", () => {
      state.month = button.dataset.month;
      render();
    });
  });

  document.querySelectorAll("[data-select]").forEach((select) => {
    select.addEventListener("change", () => {
      if (select.dataset.select === "home") state.home = select.value;
      if (select.dataset.select === "away") state.away = select.value;
      render();
    });
  });

  document.querySelectorAll("[data-control]").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.control;
      state.config[key] = Number(input.value);
      saveConfig();
      render();
    });
  });

  document.querySelectorAll("[data-pick]").forEach((button) => {
    button.addEventListener("click", () => {
      const [home, away] = button.dataset.pick.split("|");
      state.home = home;
      state.away = away;
      location.hash = "predict";
      render();
    });
  });

  document.querySelectorAll("[data-action='theme']").forEach((button) => {
    button.addEventListener("click", () => {
      document.documentElement.classList.toggle("light");
      localStorage.setItem("epl27-theme", document.documentElement.classList.contains("light") ? "light" : "dark");
      render();
    });
  });

  document.querySelectorAll("[data-action='reset-config']").forEach((button) => {
    button.addEventListener("click", () => {
      state.config = { ...DEFAULT_CONFIG };
      saveConfig();
      render();
    });
  });
}

/* ---------------- Utilities ---------------- */

function crest(team) {
  if (!team) return "";
  return `<img class="crest" src="https://a.espncdn.com/i/teamlogos/soccer/500/${team.espnId}.png" alt="" loading="lazy" onerror="this.style.display='none'">`;
}

function teamShort(name) {
  return state.data.teamByName[name]?.short || name;
}

function groupBy(items, keyOf) {
  const output = {};
  for (const item of items) {
    const key = keyOf(item);
    (output[key] = output[key] || []).push(item);
  }
  return output;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pct(value, digits = 0) {
  return `${(value * 100).toFixed(digits)}%`;
}

function fmtInt(value) {
  return Number(value).toLocaleString("en-SG");
}

function signed(value) {
  return value > 0 ? `+${value}` : `${value}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
