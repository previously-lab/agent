import { compileSpaceRecipe } from "./space-recipe";
import { hashString, WORLD_SEED } from "./seed";
import type { Palette, SpaceRecipe } from "./space-types";

/** The one architectural identity used by the normal game path. */
export const TIME_ROOM_ID = "default-indoor-room-v1" as const;

export const TIME_ROOM_SEASONS = ["spring", "summer", "autumn", "winter"] as const;
export const TIME_ROOM_DAY_PARTS = ["dawn", "day", "dusk", "night"] as const;
export const TIME_ROOM_WEATHER = ["clear", "cloudy", "rain", "snow"] as const;

export type TimeRoomSeason = (typeof TIME_ROOM_SEASONS)[number];
export type TimeRoomDayPart = (typeof TIME_ROOM_DAY_PARTS)[number];
export type TimeRoomWeather = (typeof TIME_ROOM_WEATHER)[number];

export interface TimeRoomAtmosphere {
  /** Decorative calendar season, not a claim about a real location. */
  season: TimeRoomSeason;
  dayNight: TimeRoomDayPart;
  /** Stable decorative weather derived from the slice's calendar date. */
  weather: TimeRoomWeather;
  palette: Palette;
}

export interface TimeRoomEntry {
  sliceId: string;
  label: string;
  start?: string;
}

export interface TimeRoomNavigation {
  /** Entries are chronological, oldest to newest. */
  entries: readonly TimeRoomEntry[];
  activeIndex: number;
  active: TimeRoomEntry | null;
  previousIndex: number | null;
  nextIndex: number | null;
}

const BASE_RECIPE = compileSpaceRecipe(TIME_ROOM_ID, WORLD_SEED);
const BASE_PALETTE = BASE_RECIPE.palette;

const DAY_PALETTES: Readonly<Record<TimeRoomDayPart, Pick<
  Palette,
  "sky" | "fog" | "sunColor" | "sunIntensity" | "ambient"
>>> = {
  dawn: { sky: "#e8c9b6", fog: "#d9c3b5", sunColor: "#ffd2a6", sunIntensity: 0.58, ambient: 0.48 },
  day: { sky: "#c9dce2", fog: "#c4d2d2", sunColor: "#fff1d2", sunIntensity: 0.9, ambient: 0.58 },
  dusk: { sky: "#b99fa8", fog: "#b5a5a7", sunColor: "#efb18b", sunIntensity: 0.48, ambient: 0.42 },
  night: { sky: "#273444", fog: "#3c4854", sunColor: "#a9c0df", sunIntensity: 0.2, ambient: 0.3 },
};

const SEASON_ACCENTS: Readonly<Record<TimeRoomSeason, string>> = {
  spring: "#9aab8b",
  summer: "#6f9272",
  autumn: "#b18458",
  winter: "#8ca3ad",
};

const WEATHER_TINTS: Readonly<Record<TimeRoomWeather, { color: string; mix: number }>> = {
  clear: { color: "#ffffff", mix: 0 },
  cloudy: { color: "#aeb8c0", mix: 0.36 },
  rain: { color: "#718596", mix: 0.48 },
  snow: { color: "#dce7ee", mix: 0.58 },
};

function mixHex(a: string, b: string, amount: number): string {
  const channels = (hex: string) => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
  const ca = channels(a);
  const cb = channels(b);
  return `#${ca.map((value, index) => Math.round(value + (cb[index] - value) * amount).toString(16).padStart(2, "0")).join("")}`;
}

function utcDateForSlice(sliceId: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/.exec(sliceId);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute) return null;
  return date;
}

/** Canonical IANA timezone, with an explicit UTC fallback for bad input. */
export function normalizeTimeZone(timeZone: string | null | undefined): string {
  const candidate = timeZone?.trim() || "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    minutes: value("hour") * 60 + value("minute"),
  };
}

function seasonForMonth(month: number): TimeRoomSeason {
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "autumn";
  return "winter";
}

function dayPartForMinutes(minutes: number): TimeRoomDayPart {
  if (minutes >= 5 * 60 && minutes < 8 * 60) return "dawn";
  if (minutes >= 8 * 60 && minutes < 17 * 60) return "day";
  if (minutes >= 17 * 60 && minutes < 20 * 60) return "dusk";
  return "night";
}

function weatherForDate(year: number, month: number, day: number, season: TimeRoomSeason): TimeRoomWeather {
  const value = hashString(`${year}-${month}-${day}@decorative-room-weather`) % 100;
  if (season === "winter" && value < 24) return "snow";
  if (value < 46) return "clear";
  if (value < 74) return "cloudy";
  return "rain";
}

/**
 * A deterministic, decorative mood for a slice. It deliberately uses the
 * slice's calendar fields, never the current clock or a weather service.
 * Invalid fixture IDs receive a stable neutral day instead of throwing.
 */
export function timeRoomAtmosphere(
  sliceId: string,
  timeZone: string = "UTC",
): TimeRoomAtmosphere {
  const utcDate = utcDateForSlice(sliceId);
  const parsed = utcDate ? localDateParts(utcDate, normalizeTimeZone(timeZone)) : null;
  const season = parsed ? seasonForMonth(parsed.month) : "spring";
  const dayNight = parsed ? dayPartForMinutes(parsed.minutes) : "day";
  const weather = parsed
    ? weatherForDate(parsed.year, parsed.month, parsed.day, season)
    : "clear";
  const daylight = DAY_PALETTES[dayNight];
  const weatherDim = weather === "clear" ? 1 : weather === "cloudy" ? 0.82 : 0.68;
  const weatherTint = WEATHER_TINTS[weather];
  const seasonalSky = mixHex(daylight.sky, SEASON_ACCENTS[season], 0.12);
  const seasonalFog = mixHex(daylight.fog, SEASON_ACCENTS[season], 0.08);
  return {
    season,
    dayNight,
    weather,
    palette: {
      ...BASE_PALETTE,
      ...daylight,
      sky: mixHex(seasonalSky, weatherTint.color, weatherTint.mix),
      fog: mixHex(seasonalFog, weatherTint.color, weatherTint.mix * 0.8),
      sunColor: mixHex(daylight.sunColor, weatherTint.color, weatherTint.mix * 0.45),
      ground: "#a9a191",
      wall: "#d8d2c4",
      fabric: "#98a18e",
      wood: "#b39a78",
      sunIntensity: daylight.sunIntensity * weatherDim,
      ambient: Math.max(0.25, daylight.ambient * (0.9 + weatherDim * 0.1)),
      accent: SEASON_ACCENTS[season],
    },
  };
}

/**
 * Compile the normal path's persistent room. Only its palette responds to
 * the slice. Every seed, dimension, archetype and furniture input remains
 * attached to TIME_ROOM_ID, never to the memory slice.
 */
export function timeRoomRecipe(sliceId: string, timeZone: string = "UTC"): SpaceRecipe {
  return {
    ...BASE_RECIPE,
    sliceId: TIME_ROOM_ID,
    worldClass: "interior",
    archetype: "library",
    fixedModule: "study",
    palette: timeRoomAtmosphere(sliceId, timeZone).palette,
  };
}

/** Geometry-only comparison surface for tests and diagnostics. */
export function timeRoomGeometrySignature(recipe: SpaceRecipe): string {
  return JSON.stringify({
    sliceId: recipe.sliceId,
    worldClass: recipe.worldClass,
    archetype: recipe.archetype,
    size: recipe.size,
    width: recipe.width,
    layoutSeed: recipe.layoutSeed,
    lightSeed: recipe.lightSeed,
    fixedModule: recipe.fixedModule,
  });
}

export function timeRoomAtmosphereKey(atmosphere: TimeRoomAtmosphere): string {
  return `${atmosphere.season}/${atmosphere.dayNight}/${atmosphere.weather}`;
}

/** Resolve chronological navigation without mutating the source entry list. */
export function timeRoomNavigation(
  entries: readonly TimeRoomEntry[],
  requestedSliceId?: string | null,
  currentSliceId?: string | null,
): TimeRoomNavigation {
  const chronological = [...entries].reverse();
  const requestedIndex = requestedSliceId
    ? chronological.findIndex((entry) => entry.sliceId === requestedSliceId)
    : -1;
  const currentIndex = currentSliceId
    ? chronological.findIndex((entry) => entry.sliceId === currentSliceId)
    : -1;
  const activeIndex = requestedIndex >= 0
    ? requestedIndex
    : currentIndex >= 0
      ? currentIndex
      : Math.max(0, chronological.length - 1);
  return {
    entries: chronological,
    activeIndex,
    active: chronological[activeIndex] ?? null,
    previousIndex: activeIndex > 0 ? activeIndex - 1 : null,
    nextIndex: activeIndex >= 0 && activeIndex < chronological.length - 1 ? activeIndex + 1 : null,
  };
}

export interface CommittedTimeRoomFrame<T> {
  laneKey: string;
  frame: T;
}

/** Select the visible frame without allowing same-lane live props through a freeze. */
export function selectFrozenRoomFrame<T>(
  committed: CommittedTimeRoomFrame<T> | null,
  live: T,
  frozen: boolean,
  laneKey: string,
): T {
  return frozen && committed?.laneKey === laneKey ? committed.frame : live;
}
