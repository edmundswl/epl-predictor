#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEDULE_FILE = resolve(ROOT, "data/schedule.json");
const RESULTS_FILE = resolve(ROOT, "data/results.json");
const TEAM_MODEL_FILE = resolve(ROOT, "data/team-model.json");
const ESPN_SCOREBOARD =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard";

// 2026-27 English Premier League season window (UTC dates, inclusive).
const SEASON_START = "2026-08-01";
const SEASON_END = "2027-06-10";
// The scoreboard endpoint caps range responses, so harvest in short windows.
const WINDOW_DAYS = 14;

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const teamModel = JSON.parse(await readFile(TEAM_MODEL_FILE, "utf8"));
  const knownTeams = new Set(teamModel.teams.map((team) => team.name));
  const previousSchedule = await loadJsonOr(SCHEDULE_FILE, []);
  const previousResults = await loadJsonOr(RESULTS_FILE, []);

  const events = await fetchSeasonEvents();
  const schedule = [];
  const results = new Map(previousResults.map((result) => [result.id, result]));
  const unknownTeams = new Set();

  for (const event of events) {
    if (!knownTeams.has(event.home)) unknownTeams.add(event.home);
    if (!knownTeams.has(event.away)) unknownTeams.add(event.away);
    schedule.push({
      id: event.id,
      date: event.date,
      home: event.home,
      away: event.away,
      venue: event.venue,
    });
    if (event.completed) {
      results.set(event.id, {
        id: event.id,
        date: event.date,
        home: event.home,
        away: event.away,
        homeGoals: event.homeGoals,
        awayGoals: event.awayGoals,
      });
    }
  }

  if (unknownTeams.size) {
    console.warn(`Teams missing from team-model.json: ${[...unknownTeams].join(", ")}`);
  }

  schedule.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const scheduleIds = new Set(schedule.map((match) => match.id));
  const mergedResults = [...results.values()]
    .filter((result) => scheduleIds.has(result.id) || previousResults.some((prev) => prev.id === result.id))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  // Refuse to shrink the schedule dramatically (e.g. ESPN outage mid-run):
  // keep the previous snapshot rather than wiping fixtures the site relies on.
  if (schedule.length < Math.min(previousSchedule.length, 380) * 0.9) {
    console.warn(
      `Harvest returned ${schedule.length} fixtures (previously ${previousSchedule.length}); keeping previous schedule.`
    );
  } else {
    await writeJson(SCHEDULE_FILE, schedule);
  }
  await writeJson(RESULTS_FILE, mergedResults);

  console.log(
    `Season harvest: ${schedule.length} fixtures, ${mergedResults.length} completed results ` +
      `(${mergedResults.length - previousResults.length >= 0 ? "+" : ""}${mergedResults.length - previousResults.length} vs previous run).`
  );
}

async function fetchSeasonEvents() {
  const events = new Map();
  for (const range of dateWindows(SEASON_START, SEASON_END, WINDOW_DAYS)) {
    const response = await fetch(`${ESPN_SCOREBOARD}?dates=${range}`, {
      headers: {
        accept: "application/json",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      },
    });
    if (!response.ok) {
      console.warn(`ESPN scoreboard ${range} returned ${response.status}`);
      continue;
    }
    const payload = await response.json();
    for (const raw of payload.events || []) {
      const parsed = parseEspnEvent(raw);
      if (parsed) events.set(parsed.id, parsed);
    }
  }
  return [...events.values()];
}

function parseEspnEvent(event) {
  const competition = event.competitions?.[0];
  const status = competition?.status?.type || event.status?.type;
  const competitors = competition?.competitors || [];
  const home = competitors.find((competitor) => competitor.homeAway === "home");
  const away = competitors.find((competitor) => competitor.homeAway === "away");
  if (!home || !away) return null;

  const homeName = home.team?.displayName || home.team?.name;
  const awayName = away.team?.displayName || away.team?.name;
  if (!homeName || !awayName) return null;

  const completed = Boolean(status?.completed);
  const homeGoals = Number(home.score);
  const awayGoals = Number(away.score);
  if (completed && (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals))) return null;

  return {
    id: String(event.id),
    date: competition?.date || event.date,
    home: homeName,
    away: awayName,
    venue: competition?.venue?.fullName || "",
    completed,
    homeGoals,
    awayGoals,
  };
}

function* dateWindows(startYmd, endYmd, days) {
  const end = parseDate(endYmd);
  let cursor = parseDate(startYmd);
  while (cursor <= end) {
    const windowEnd = new Date(cursor);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + days - 1);
    const capped = windowEnd > end ? end : windowEnd;
    yield `${toYmd(cursor)}-${toYmd(capped)}`;
    cursor = new Date(capped);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

async function loadJsonOr(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function toYmd(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}
