#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_FILE = resolve(ROOT, "data/sgpools-markets.json");
const TEAM_MODEL_FILE = resolve(ROOT, "data/team-model.json");
const BASE_URL = "https://online.singaporepools.com";
const SPORTS_URL = `${BASE_URL}/en/sports`;
const EPL_URL = `${BASE_URL}/en/sports/competition/36/football/england/english-premier`;
const ENGLAND_URL = `${BASE_URL}/en/sports/region/4/football/england`;
const OPENING_ODDS_URL = `${BASE_URL}/en/sports/opening-odds`;

const SG_POOLS_BET_TYPES = [
  ["WH", "1/2 Goal"],
  ["FS", "1st Goal Scorer"],
  ["MR", "1X2"],
  ["AH", "Asian Handicap / HT Asian Handicap"],
  ["H1", "Halftime 1X2"],
  ["TG2", "Halftime Total Goals"],
  ["HF", "Halftime-Fulltime"],
  ["MH", "Handicap 1X2"],
  ["LS", "Last Goal Scorer"],
  ["CS", "Pick the Score"],
  ["NGN", "Team to Score 1st Goal"],
  ["EG", "Total Goals"],
  ["OE", "Total Goals Odd/Even"],
  ["HL", "Total Goals Over/Under"],
  ["BG", "Will Both Teams Score"],
];

const SOURCE_PAGES = [
  { label: "epl", url: EPL_URL },
  { label: "england", url: ENGLAND_URL },
  { label: "sports", url: SPORTS_URL },
  { label: "opening-odds", url: OPENING_ODDS_URL },
];

const headers = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-SG,en;q=0.9",
  referer: EPL_URL,
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
};

main().catch(async (error) => {
  const fallback = await loadPreviousFeed();
  const feed = {
    ...baseFeed(),
    status: "error",
    note: `Singapore Pools update failed: ${error.message}`,
    previousGeneratedAt: fallback?.generatedAt || null,
    events: [],
    errors: [{ message: error.message }],
  };
  await writeFeed(feed);
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const previousFeed = await loadPreviousFeed();
  const teamNames = await loadTeamNames();
  const checkedPages = [];
  const events = [];
  let betTypes = SG_POOLS_BET_TYPES.map(([code, name]) => ({ code, name }));

  for (const source of SOURCE_PAGES) {
    const page = await fetchText(source.url);
    checkedPages.push(pageSummary(source.label, page));
    if (!page.ok) continue;

    const pageBetTypes = extractBetTypes(page.text);
    if (pageBetTypes.length) betTypes = pageBetTypes;

    const ddProps = extractJsonAttributes(page.text, "data-prop-ddprop");
    for (const prop of ddProps) {
      const event = eventFromDdProp(prop.value, source.label, source.url);
      if (event) events.push(event);
    }
  }

  const allPagesFailed = checkedPages.length > 0 && checkedPages.every((page) => !page.ok);
  const normalizedEvents = dedupeEvents(events)
    .filter((event) => isEplEvent(event, teamNames))
    .map((event) => ({
      competition: event.competition || "English Premier",
      home: event.home,
      away: event.away,
      kickoff: event.kickoff || null,
      status: "public-listing",
      source: event.source,
      sourceUrl: event.sourceUrl,
      eventId: event.eventId || null,
      markets: [],
    }));

  const feed = {
    ...baseFeed(),
    mode: "availability_only",
    status: allPagesFailed
      ? "checked_network_error"
      : normalizedEvents.length
        ? "availability_snapshot"
        : "checked_no_public_events",
    note: allPagesFailed
      ? "Singapore Pools public pages could not be reached during this check, so the previous listing snapshot was preserved."
      : normalizedEvents.length
        ? "Singapore Pools public pages exposed English Premier League event listings. Live prices are intentionally not fetched."
        : "Singapore Pools public pages were checked, but no English Premier League event listings were exposed.",
    betTypes,
    checkedPages,
    previousGeneratedAt: allPagesFailed ? previousFeed?.generatedAt || null : undefined,
    events: allPagesFailed && previousFeed?.events ? previousFeed.events : normalizedEvents,
  };

  await writeFeed(feed);
  console.log(`Updated ${OUTPUT_FILE}: ${feed.status}, ${normalizedEvents.length} public event listing(s).`);
}

function baseFeed() {
  return {
    generatedAt: new Date().toISOString(),
    sourceUrl: SPORTS_URL,
    competitionUrl: EPL_URL,
    mode: "availability_only",
    status: "not_connected",
    note: "",
    betTypes: SG_POOLS_BET_TYPES.map(([code, name]) => ({ code, name })),
    events: [],
  };
}

async function loadTeamNames() {
  try {
    const model = JSON.parse(await readFile(TEAM_MODEL_FILE, "utf8"));
    return new Set(model.teams.flatMap((team) => [normalize(team.name), normalize(team.short)]));
  } catch {
    return new Set();
  }
}

async function fetchText(url) {
  try {
    const response = await fetch(url, { headers, redirect: "follow" });
    return {
      url,
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      text: await response.text(),
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: 0,
      contentType: "",
      text: "",
      error: error.message,
    };
  }
}

function pageSummary(label, response) {
  const text = response.text || "";
  return {
    label,
    url: response.url,
    ok: response.ok,
    status: response.status,
    contentType: response.contentType,
    bytes: text.length,
    error: response.error || null,
    sample: response.ok ? undefined : text.replace(/\s+/g, " ").trim().slice(0, 160),
  };
}

function extractBetTypes(html) {
  const attrs = extractJsonAttributes(html, "data-prop-football-bet-types");
  const first = attrs.find((attr) => Array.isArray(attr.value));
  if (!first) return [];
  return first.value
    .map((item) => ({
      code: String(item.key || item.code || "").trim(),
      name: String(item.value || item.name || "").trim(),
    }))
    .filter((item) => item.code && item.name);
}

function extractJsonAttributes(html, attributeName) {
  const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escapedName}=('([^']*)'|"([^"]*)")`, "g");
  const values = [];
  let match;
  while ((match = regex.exec(html))) {
    const raw = match[2] ?? match[3] ?? "";
    const value = safeJsonParse(decodeHtmlAttribute(raw));
    if (value) values.push({ raw, value });
  }
  return values;
}

function eventFromDdProp(prop, source, sourceUrl) {
  if (!prop || typeof prop !== "object") return null;
  if (!prop.eventName) return null;
  const teams = splitMatchName(prop.eventName);
  if (!teams) return null;
  return {
    competition: prop.typeName || prop.competition || "",
    home: teams.home,
    away: teams.away,
    kickoff: null,
    source,
    sourceUrl,
    eventId: prop.eventId || null,
    markets: [],
  };
}

function splitMatchName(name) {
  const text = String(name || "").replace(/\s+/g, " ").trim();
  const parts = text.split(/\s+v(?:s|\.?)\s+/i);
  if (parts.length !== 2) return null;
  return { home: cleanTeam(parts[0]), away: cleanTeam(parts[1]) };
}

function cleanTeam(value) {
  return String(value || "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isEplEvent(event, teamNames) {
  const text = `${event.competition || ""} ${event.sourceUrl || ""} ${event.source || ""}`.toLowerCase();
  if (text.includes("english premier") || text.includes("premier league") || text.includes("/english-premier")) {
    return true;
  }
  return teamNames.has(normalize(event.home)) && teamNames.has(normalize(event.away));
}

function dedupeEvents(events) {
  const output = new Map();
  for (const event of events) {
    if (!event.home || !event.away) continue;
    const key = event.eventId || `${normalize(event.home)}|${normalize(event.away)}`;
    const existing = output.get(key);
    if (!existing) {
      output.set(key, event);
      continue;
    }
    if (!existing.eventId && event.eventId) {
      output.set(key, { ...existing, ...event });
    }
  }
  return [...output.values()];
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function decodeHtmlAttribute(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function loadPreviousFeed() {
  try {
    return JSON.parse(await readFile(OUTPUT_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function writeFeed(feed) {
  await writeFile(OUTPUT_FILE, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
}
