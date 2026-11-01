"use strict";

// All data lives in localStorage on the phone. Use the backup export to keep a copy.
const STORAGE_KEY = "nogro.v1";
const REST_DEFAULT_S = 120;
const REPORT_HISTORY_SESSIONS = 12; // ~4-6 weeks at 2-3 sessions/week
const LONG_TERM_MONTHS = 6;
const MEASURES_IN_REPORT = 6;

// Sync config (incl. token) is kept apart so it never ends up in a backup export.
const SYNC_KEY = "nogro.sync";
const SYNC_DEBOUNCE_MS = 2000;
const SYNC_STALE_MS = 5 * 60 * 1000;

const defaultState = () => ({
  profile: { goals: "", level: "", constraints: "", schedule: "", equipment: "", heightCm: "", coach: "claude", sound: "on" },
  coachMemory: [], // long-term notes, rewritten by the coach on each plan import, editable by hand
  history: [], // finished sessions, oldest first
  measurements: [], // { id, date: "YYYY-MM-DD", weightKg, fatPct, muscleKg, bmrKcal, note }, oldest first
  exerciseLinks: {}, // lowercase exercise name -> free-exercise-db id
  food: { likes: "", dislikes: "", allergies: "", cooking: "", other: "" }, // meal-idea preferences
  meals: [], // meal ideas from the LLM: { id, name, type, portions, kcal, protein, prepMin, batch, ingredients, steps, tips, fav }
  shopping: [], // { text, done }
  deleted: [], // ids of deleted sessions, so a sync merge does not bring them back
  plan: null, // next session prescribed by the coach
  active: null, // session in progress (local only, not synced)
  updatedAt: 0, // epoch ms of the last change to synced data
});

let state = load();
let lastCore = JSON.stringify(core(state));
let sync = loadSync();
let view = state.active ? "workout" : "home";
let viewArg = null;
let rest = null; // { endAt: epoch ms, totalS: number }
let work = null; // running stopwatch: { ex, set, goAt: epoch ms, target: s }
let wakeLock = null;

// ---------- storage ----------

function normalize(s) {
  const d = defaultState();
  return { ...d, ...s, profile: { ...d.profile, ...s.profile }, food: { ...d.food, ...s.food } };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalize(JSON.parse(raw)) : defaultState();
  } catch {
    return defaultState();
  }
}

// The part of the state that is synced to GitHub.
function core(s) {
  return {
    profile: s.profile,
    coachMemory: s.coachMemory,
    history: s.history,
    measurements: s.measurements,
    exerciseLinks: s.exerciseLinks,
    food: s.food,
    meals: s.meals,
    shopping: s.shopping,
    deleted: s.deleted,
    plan: s.plan,
  };
}

function save() {
  const snap = JSON.stringify(core(state));
  if (snap !== lastCore) {
    lastCore = snap;
    state.updatedAt = Date.now();
    scheduleSync();
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

navigator.storage?.persist?.();

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function num(v) {
  if (v === "" || v === null || v === undefined) return "";
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : "";
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
}

function isoDay(iso) {
  return iso.slice(0, 10);
}

// Timed sets store the duration in seconds in "reps".
function fmtSet(s, timed = false) {
  const rpe = s.rpe !== "" && s.rpe !== undefined ? `@${s.rpe}` : "";
  const hasKg = s.kg !== "" && s.kg !== undefined;
  if (timed) return `${hasKg ? `${s.kg}kg ` : ""}${s.reps} s${rpe}`;
  return `${hasKg ? `${s.kg}kg` : "PDC"}×${s.reps}${rpe}`;
}

const fmtSets = (ex) => (ex.sets || []).map((s) => fmtSet(s, ex.timed)).join(", ");

// BMI = kg / m². Returns "" when height or weight is missing.
function bmi(weightKg, heightCm = state.profile.heightCm) {
  const h = num(heightCm) / 100;
  return h && typeof weightKg === "number" ? Math.round((weightKg / (h * h)) * 10) / 10 : "";
}

function fmtMeasure(m) {
  const parts = [
    m.weightKg !== "" && `${m.weightKg} kg`,
    m.fatPct !== "" && `${m.fatPct} % MG`,
    m.muscleKg !== "" && `${m.muscleKg} kg muscle squelettique`,
    bmi(m.weightKg) !== "" && `IMC ${bmi(m.weightKg)}`,
    m.bmrKcal !== "" && `métabolisme de base ${m.bmrKcal} kcal`,
    m.note && m.note,
  ].filter(Boolean);
  return `- ${m.date} : ${parts.join(", ")}`;
}

function sameName(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function knownExercises() {
  const names = new Map();
  for (const h of state.history) for (const e of h.exercises) names.set(e.name.toLowerCase(), e.name);
  if (state.plan) for (const e of state.plan.exercises) names.set(e.name.toLowerCase(), e.name);
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

function lastPerf(name) {
  for (let i = state.history.length - 1; i >= 0; i--) {
    const ex = state.history[i].exercises.find((e) => sameName(e.name, name));
    if (ex) return { date: state.history[i].startedAt, sets: ex.sets, timed: ex.timed };
  }
  return null;
}

function go(v, arg = null) {
  view = v;
  viewArg = arg;
  render();
  window.scrollTo(0, 0);
}

// ---------- workout logic ----------

function startWorkout(fromPlan) {
  const p = fromPlan ? state.plan : null;
  state.active = {
    id: Date.now().toString(36),
    name: p?.name || "Séance libre",
    startedAt: new Date().toISOString(),
    plan: p ? structuredClone(p) : null,
    exercises: p
      ? p.exercises.map((e) => ({
          name: e.name,
          restS: e.rest_s || REST_DEFAULT_S,
          note: e.notes || "",
          timed: Boolean(e.timed),
          sets: (e.sets || []).map((s) => ({ kg: s.kg ?? "", reps: s.reps ?? "", rpe: s.rpe ?? "", done: false })),
        }))
      : [],
  };
  save();
  go("workout");
}

function addExercise(name) {
  name = name.trim();
  if (!name) return;
  const prev = lastPerf(name);
  const seed = prev?.sets.at(-1);
  state.active.exercises.push({
    name,
    restS: REST_DEFAULT_S,
    note: "",
    sets: [{ kg: seed?.kg ?? "", reps: seed?.reps ?? "", rpe: "", done: false }],
  });
  save();
  render();
}

function finishWorkout(form) {
  const a = state.active;
  const exercises = a.exercises
    .map((e) => ({
      name: e.name,
      ...(e.timed ? { timed: true } : {}),
      sets: e.sets.filter((s) => s.done && s.reps !== "").map(({ kg, reps, rpe }) => ({ kg, reps, rpe })),
    }))
    .filter((e) => e.sets.length);
  const session = {
    id: a.id,
    name: a.name,
    startedAt: a.startedAt,
    durationMin: Math.round((Date.now() - new Date(a.startedAt)) / 60000),
    plan: a.plan,
    exercises,
    feedback: {
      energy: form.energy.value,
      sessionRpe: form.sessionRpe.value,
      pain: form.pain.value.trim(),
      notes: form.notes.value.trim(),
    },
  };
  state.history.push(session);
  if (a.plan) state.plan = null;
  state.active = null;
  save();
  work = null;
  stopRest();
  releaseWakeLock();
  go("report", session.id);
}

// ---------- rest timer ----------

// ---------- sound ----------
// Beeps are scheduled on the audio clock, so they stay on time even when timers are throttled.
// Output follows the phone's audio route (Bluetooth / wired headphones when connected).

let audioCtx = null;
let scheduledBeeps = [];

const soundOn = () => state.profile.sound !== "off";

function audio() {
  audioCtx ||= new AudioContext();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function beepAt(delayS, freqHz, durS) {
  const c = audio();
  const t = c.currentTime + Math.max(0, delayS);
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.frequency.value = freqHz;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.5, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + durS);
  osc.connect(gain).connect(c.destination);
  osc.start(t);
  osc.stop(t + durS + 0.05);
  scheduledBeeps.push(osc);
}

function cancelBeeps() {
  for (const o of scheduledBeeps) {
    try {
      o.stop();
    } catch {
      /* already stopped */
    }
  }
  scheduledBeeps = [];
}

// Short ticks at 3, 2, 1 s before the end, then a long high tone at the end.
function scheduleCountdown(endInS) {
  if (!soundOn()) return;
  for (const k of [3, 2, 1]) if (endInS - k > 0) beepAt(endInS - k, 660, 0.12);
  beepAt(endInS, 990, 0.6);
}

// ---------- rest timer & exercise stopwatch ----------
// One bar at a time: the stopwatch hides the rest timer while it runs.

const WORK_READY_S = 5; // countdown before a timed set, to get into position

function startRest(seconds) {
  rest = { endAt: Date.now() + seconds * 1000, totalS: seconds, buzzed: false };
  cancelBeeps();
  scheduleCountdown(seconds);
  tickBar();
}

function stopRest() {
  rest = null;
  cancelBeeps();
  tickBar();
}

function startWork(exIdx) {
  const e = state.active.exercises[exIdx];
  let setIdx = e.sets.findIndex((s) => !s.done);
  if (setIdx < 0) {
    const last = e.sets.at(-1);
    e.sets.push({ kg: last?.kg ?? "", reps: last?.reps ?? "", rpe: "", done: false });
    setIdx = e.sets.length - 1;
  }
  // A non-timed exercise has reps, not seconds: no target, and it becomes timed only once a set is saved.
  const target = e.timed ? num(e.sets[setIdx].reps) || 0 : 0;
  rest = null;
  work = { ex: exIdx, set: setIdx, goAt: Date.now() + WORK_READY_S * 1000, target, buzzed: false };
  cancelBeeps();
  scheduleCountdown(WORK_READY_S);
  if (target) scheduleCountdown(WORK_READY_S + target);
  tickBar();
}

function stopWork(save_ = true) {
  const w = work;
  work = null;
  cancelBeeps();
  if (!w) return tickBar();
  const elapsed = Math.round((Date.now() - w.goAt) / 1000);
  const e = state.active?.exercises[w.ex];
  if (save_ && e && elapsed > 0) {
    e.timed = true;
    Object.assign(e.sets[w.set], { reps: elapsed, done: true });
    save();
    render();
    return startRest(Number(e.restS) || REST_DEFAULT_S);
  }
  tickBar();
}

const fmtClock = (s) => `${s < 0 ? "+" : ""}${Math.floor(Math.abs(s) / 60)}:${String(Math.abs(s) % 60).padStart(2, "0")}`;

function tickBar() {
  const el = $("#rest");
  if (work) {
    const sinceGo = Math.floor((Date.now() - work.goAt) / 1000);
    const name = state.active?.exercises[work.ex]?.name ?? "";
    const reached = work.target && sinceGo >= work.target;
    if (reached && !work.buzzed) {
      work.buzzed = true;
      navigator.vibrate?.([300, 150, 300]);
    }
    el.hidden = false;
    el.className = sinceGo < 0 ? "ready" : reached ? "reached" : "work";
    el.innerHTML = `
      <span class="time">${sinceGo < 0 ? `Prêt ${-sinceGo}` : fmtClock(sinceGo)}
        <small>${esc(name)} · série ${work.set + 1}${work.target ? ` · cible ${work.target} s` : ""}</small></span>
      <button class="small" data-action="work-cancel">✕</button>
      <button class="small" data-action="work-stop">Stop</button>`;
    return;
  }
  if (!rest) {
    el.hidden = true;
    return;
  }
  const left = Math.round((rest.endAt - Date.now()) / 1000);
  if (left <= 0 && !rest.buzzed) {
    rest.buzzed = true;
    navigator.vibrate?.([300, 150, 300]);
  }
  el.hidden = false;
  el.className = left < 0 ? "over" : "";
  el.innerHTML = `
    <span class="time">${fmtClock(left)}<small>Repos</small></span>
    <button class="small" data-action="rest-add" data-s="-15">−15</button>
    <button class="small" data-action="rest-add" data-s="15">+15</button>
    <button class="small" data-action="rest-stop">OK</button>`;
}

setInterval(tickBar, 250);

async function holdWakeLock() {
  try {
    if (!wakeLock && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    wakeLock?.addEventListener("release", () => (wakeLock = null));
  } catch {
    /* not supported or denied: screen may sleep, nothing else breaks */
  }
}

function releaseWakeLock() {
  wakeLock?.release();
  wakeLock = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.active) holdWakeLock();
});

// ---------- GitHub sync ----------
// Stores core state as one JSON file in a private repo, through the Contents API.
// Merge rule: sessions are a union by id minus tombstones; profile and plan come from the newer side.

function loadSync() {
  try {
    return { path: "nogro-data.json", ...JSON.parse(localStorage.getItem(SYNC_KEY) || "{}") };
  } catch {
    return { path: "nogro-data.json" };
  }
}

function saveSync() {
  localStorage.setItem(SYNC_KEY, JSON.stringify(sync));
}

const syncEnabled = () => Boolean(sync.owner && sync.repo && sync.token);

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function gh(method, body, accept = "application/vnd.github+json") {
  const path = sync.path.split("/").map(encodeURIComponent).join("/");
  return fetch(`https://api.github.com/repos/${encodeURIComponent(sync.owner)}/${encodeURIComponent(sync.repo)}/contents/${path}`, {
    method,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${sync.token}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function ghError(res) {
  const msg = (await res.json().catch(() => ({}))).message || "";
  if (res.status === 401) return "Token invalide ou expiré (401).";
  if (res.status === 403) return `Accès refusé (403) : vérifie les droits Contents du token. ${msg}`;
  if (res.status === 404) return "Repo introuvable (404) : vérifie owner/repo et l'accès du token.";
  return `GitHub ${res.status} : ${msg}`;
}

async function fetchRemote() {
  const res = await gh("GET");
  if (res.status === 404) {
    // Missing file is normal on first sync; missing repo is reported by the PUT.
    return { sha: null, data: null };
  }
  if (!res.ok) throw new Error(await ghError(res));
  const meta = await res.json();
  let text;
  if (meta.encoding === "base64" && meta.content) {
    text = b64decode(meta.content);
  } else {
    // Files over 1 MB come back without content: read the raw media type instead.
    const raw = await gh("GET", null, "application/vnd.github.raw+json");
    if (!raw.ok) throw new Error(await ghError(raw));
    text = await raw.text();
  }
  return { sha: meta.sha, data: normalize(JSON.parse(text)) };
}

function mergeRemote(remote) {
  const deleted = [...new Set([...state.deleted, ...remote.deleted])];
  const union = (remoteList, localList, dateKey) => {
    const byId = new Map();
    for (const x of [...remoteList, ...localList]) if (!deleted.includes(x.id)) byId.set(x.id, x);
    return [...byId.values()].sort((a, b) => a[dateKey].localeCompare(b[dateKey]));
  };
  state.history = union(remote.history, state.history, "startedAt");
  state.measurements = union(remote.measurements, state.measurements, "date");
  state.deleted = deleted;
  const remoteNewer = remote.updatedAt > state.updatedAt;
  state.exerciseLinks = remoteNewer
    ? { ...state.exerciseLinks, ...remote.exerciseLinks }
    : { ...remote.exerciseLinks, ...state.exerciseLinks };
  if (remoteNewer) {
    state.profile = remote.profile;
    state.coachMemory = remote.coachMemory;
    state.plan = remote.plan;
    state.food = remote.food;
    state.meals = remote.meals;
    state.shopping = remote.shopping;
  }
  save();
  // Do not re-render under the user's fingers during a workout.
  if (view !== "workout" && view !== "finish") render();
}

let syncTimer = null;
let syncing = false;
let syncAgain = false;

function scheduleSync(delay = SYNC_DEBOUNCE_MS) {
  if (!syncEnabled()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, delay);
}

async function runSync(retry = true) {
  if (!syncEnabled()) return;
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  sync.status = "Synchro…";
  renderSyncStatus();
  try {
    const { sha, data } = await fetchRemote();
    if (data) mergeRemote(data);
    if (!data || JSON.stringify(core(data)) !== JSON.stringify(core(state))) {
      const res = await gh("PUT", {
        message: `chore(data): sync ${new Date().toISOString()}`,
        content: b64encode(JSON.stringify({ version: 1, updatedAt: state.updatedAt, ...core(state) }, null, 1)),
        ...(sha ? { sha } : {}),
      });
      if ((res.status === 409 || res.status === 422) && retry) {
        // Remote changed between GET and PUT: merge again once.
        syncing = false;
        return await runSync(false);
      }
      if (!res.ok) throw new Error(await ghError(res));
    }
    sync.lastOk = Date.now();
    sync.status = "";
  } catch (err) {
    sync.status = navigator.onLine ? `Erreur : ${err.message}` : "Hors ligne : synchro en attente.";
  } finally {
    syncing = false;
    saveSync();
    renderSyncStatus();
    if (syncAgain) {
      syncAgain = false;
      scheduleSync(500);
    }
  }
}

function syncStatusText() {
  if (!syncEnabled()) return "Synchro GitHub non configurée (données uniquement sur ce téléphone).";
  if (sync.status) return sync.status;
  if (sync.lastOk) return `Synchro OK · ${new Date(sync.lastOk).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}`;
  return "Synchro en attente.";
}

function renderSyncStatus() {
  const el = $("#sync-status");
  if (el) el.textContent = syncStatusText();
}

window.addEventListener("online", () => scheduleSync(0));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - (sync.lastOk || 0) > SYNC_STALE_MS) scheduleSync(0);
});

// ---------- coach report / plan import ----------

const COACHES = {
  claude: { label: "Claude", url: "https://claude.ai/new" },
  gemini: { label: "Gemini", url: "https://gemini.google.com/app" },
  chatgpt: { label: "ChatGPT", url: "https://chatgpt.com/" },
};

const coach = () => COACHES[state.profile.coach] || COACHES.claude;

// Coaching method sent with every report, so any LLM in a fresh chat programs the same way.
const COACH_GUIDE = `
## Méthode
- Tu n'as pas d'autre mémoire que ce message. "Mémoire long terme" est ta mémoire : renvoie-la EN ENTIER dans
  "memory", mise à jour (cycle et semaine en cours, blessures, ce qui marche ou pas, préférences, décisions).
  Garde les points encore valides, retire les obsolètes, 15 points maximum.
- Raisonne en cycles de 4 à 6 semaines : progression, puis une semaine de décharge (volume −40 %, RPE ≤ 7).
  Indique le cycle et la semaine dans "memory" et dans le "name" de la séance (ex. "C1 S3 · Full body A").
- Progression double : garde la charge tant que toutes les séries n'atteignent pas le haut de la fourchette de reps
  au RPE cible, puis monte (+2,5 kg aux barres et machines, +1 à 2 kg par haltère).
  Si le RPE réel dépasse la cible de 1,5 ou plus, ou si des reps manquent : garde ou baisse la charge.
- RPE cible : 7 à 8 sur les polyarticulaires, 8 à 9 sur l'isolation. Pas d'échec sur les polyarticulaires lourds.
- Volume par muscle et par semaine : 10 à 16 séries effectives. Répartis-le selon la fréquence du profil
  et les séances déjà faites cette semaine (voir dates de l'historique).
- Ordre : polyarticulaires lourds d'abord, isolation ensuite, gainage et cardio en fin de séance. Séance de 60 à 75 min.
- Douleur signalée : ne charge pas la zone, remplace l'exercice par une variante indolore, note-le dans "memory".
  Douleur articulaire aiguë ou qui persiste : recommande de consulter.
- Perte de gras : protège la force (garde les charges lourdes), ajoute 10 à 20 min de cardio en zone 2 en fin de séance.
  Commente la tendance du poids sur 2 à 3 semaines, pas sur une pesée isolée.
- Noms d'exercices : réutilise EXACTEMENT les noms de l'historique pour le même exercice. N'invente pas de nouveau
  nom pour un exercice déjà fait. Variante nouvelle = nom nouveau et explicite.
- Conventions : kg = charge par haltère pour les haltères, charge totale sinon. "kg" absent = poids de corps.
  Exercices chronométrés (gainage, cardio, isométrie) : "timed": true et "reps" = durée en SECONDES (12 min = 720).
  "rest_s" en secondes.
`;

const PLAN_FORMAT = `{
  "name": "Push A",
  "date": "YYYY-MM-DD",
  "notes": "Objectif de la séance en une phrase",
  "memory": ["Liste COMPLÈTE et à jour des points long terme, 15 max"],
  "exercises": [
    {
      "name": "Développé couché",
      "rest_s": 150,
      "notes": "Consigne technique ou de progression",
      "sets": [ { "kg": 60, "reps": 8, "rpe": 8 } ]
    },
    { "name": "Gainage planche", "timed": true, "rest_s": 45, "sets": [ { "reps": 45 } ] }
  ]
}`;

function sessionBlock(h) {
  const lines = [`### ${isoDay(h.startedAt)} — ${h.name} (${h.durationMin} min)`];
  for (const e of h.exercises) lines.push(`- ${e.name} : ${fmtSets(e)}`);
  const f = h.feedback || {};
  const fb = [
    f.energy && `énergie ${f.energy}/5`,
    f.sessionRpe && `RPE séance ${f.sessionRpe}/10`,
    f.pain && `douleur : ${f.pain}`,
    f.notes && `notes : ${f.notes}`,
  ].filter(Boolean);
  if (fb.length) lines.push(`- Ressenti : ${fb.join(" ; ")}`);
  return lines.join("\n");
}

// Epley estimate; only for sets heavy enough to be meaningful.
function e1rm(s) {
  if (typeof s.kg !== "number" || typeof s.reps !== "number" || s.reps < 1 || s.reps > 12) return 0;
  return s.kg * (1 + s.reps / 30);
}

// One line per exercise over the whole history: best estimated 1RM per month, last months only.
function longTermProgress(upTo) {
  const byEx = new Map();
  for (const h of state.history.slice(0, upTo + 1)) {
    const month = h.startedAt.slice(0, 7);
    for (const e of h.exercises) {
      const key = e.name.toLowerCase();
      const entry = byEx.get(key) || { name: e.name, sessions: 0, months: new Map() };
      entry.sessions++;
      const best = Math.max(0, ...e.sets.map(e1rm));
      if (best) entry.months.set(month, Math.max(entry.months.get(month) || 0, best));
      byEx.set(key, entry);
    }
  }
  return [...byEx.values()]
    .filter((x) => x.sessions >= 2)
    .sort((a, b) => b.sessions - a.sessions)
    .map((x) => {
      const months = [...x.months].slice(-LONG_TERM_MONTHS).map(([m, v]) => `${m} ${Math.round(v)}`);
      return `- ${x.name} (${x.sessions} séances)${months.length ? ` : ${months.join(" → ")}` : ""}`;
    });
}

function buildReport(session) {
  const p = state.profile;
  const idx = state.history.findIndex((h) => h.id === session.id);
  const past = state.history.slice(Math.max(0, idx - REPORT_HISTORY_SESSIONS), idx);

  const profile = [
    p.goals && `- Objectifs : ${p.goals}`,
    p.level && `- Niveau / expérience : ${p.level}`,
    p.schedule && `- Fréquence : ${p.schedule}`,
    p.equipment && `- Matériel : ${p.equipment}`,
    p.constraints && `- Contraintes / blessures : ${p.constraints}`,
    p.heightCm && `- Taille : ${p.heightCm} cm`,
  ].filter(Boolean);

  // First measurement as baseline, then the most recent ones.
  const ms = state.measurements;
  const shownMs = ms.length > MEASURES_IN_REPORT ? [ms[0], ...ms.slice(-(MEASURES_IN_REPORT - 1))] : ms;

  let planVsDone = "";
  if (session.plan) {
    const rows = session.plan.exercises.map((pe) => {
      const done = session.exercises.find((e) => sameName(e.name, pe.name));
      return `- ${pe.name} : prévu ${fmtSets(pe)} → fait ${done ? fmtSets(done) : "rien"}`;
    });
    const extra = session.exercises.filter((e) => !session.plan.exercises.some((pe) => sameName(pe.name, e.name)));
    for (const e of extra) rows.push(`- ${e.name} (hors plan) : ${fmtSets(e)}`);
    planVsDone = `\n## Prévu vs réalisé\n${rows.join("\n")}\n`;
  }

  const progress = longTermProgress(idx);

  return `Tu es mon coach de musculation. Analyse ma séance du jour et mon historique, puis planifie ma prochaine séance.
${COACH_GUIDE}
## Format de réponse
1. Une analyse courte (5 lignes maximum) : ce qui a progressé, ce qui coince, la décision pour la suite.
2. La prochaine séance dans UN SEUL bloc \`\`\`json, à ce format :
${PLAN_FORMAT}
Contraintes JSON : JSON strict (pas de commentaires, pas de virgule finale), nombres sans unité,
une entrée par série dans "sets", "rpe" = RPE cible. Pas d'autre bloc de code dans la réponse.

## Profil
${profile.length ? profile.join("\n") : "- (non renseigné)"}

## Mesures corporelles
${shownMs.length ? shownMs.map(fmtMeasure).join("\n") : "- (aucune)"}

## Mémoire long terme
${state.coachMemory.length ? state.coachMemory.map((m) => `- ${m}`).join("\n") : "- (vide : à créer)"}

## Progression long terme (meilleur 1RM estimé par mois, kg)
${progress.length ? progress.join("\n") : "- (pas assez de données)"}
${planVsDone}
## Séance du jour
${sessionBlock(session)}

## Historique récent
${past.length ? past.map(sessionBlock).join("\n\n") : "(aucune séance précédente)"}
`;
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`JSON invalide : ${err.message}`);
  }
}

// A full backup (has a history array) pasted instead of a plan.
const isBackup = (obj) => Array.isArray(obj.history);

function parsePlan(input) {
  let obj = typeof input === "string" ? extractJson(input) : input;
  // Accept a plan wrapped as { "plan": { ... } }, a frequent LLM variant.
  const memorySrc = obj.memory ?? obj.coachMemory;
  if (!Array.isArray(obj.exercises) && obj.plan?.exercises) obj = { ...obj.plan, memory: memorySrc };
  if (!Array.isArray(obj.exercises) || !obj.exercises.length) throw new Error("Le champ 'exercises' est absent ou vide.");
  for (const e of obj.exercises) {
    if (!e.name) throw new Error("Un exercice n'a pas de 'name'.");
    if (!Array.isArray(e.sets)) throw new Error(`L'exercice '${e.name}' n'a pas de 'sets'.`);
    e.sets = e.sets.map((s) => ({ kg: num(s.kg), reps: num(s.reps), rpe: num(s.rpe) }));
    e.rest_s = num(e.rest_s) || REST_DEFAULT_S;
    e.timed = Boolean(e.timed);
  }
  obj.name = obj.name || "Séance du coach";
  const memory = Array.isArray(obj.memory) ? obj.memory.map(String).map((m) => m.trim()).filter(Boolean) : null;
  delete obj.memory;
  return { plan: obj, memory };
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function download(filename, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- views ----------

function tile(label, value, unit, delta = "") {
  return `<div class="tile"><div class="label">${label}</div>
    <div class="value">${value === "" ? "—" : esc(value)}<span class="unit">${unit}</span></div>
    ${delta ? `<div class="delta">${delta}</div>` : ""}</div>`;
}

// Signed difference vs. the first measurement, e.g. "−1.2 depuis le 01/11".
function deltaSince(key, unit) {
  const ms = state.measurements.filter((m) => typeof m[key] === "number");
  if (ms.length < 2) return "";
  const d = Math.round((ms.at(-1)[key] - ms[0][key]) * 10) / 10;
  const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
  return `${sign}${Math.abs(d)}${unit} depuis le ${new Date(ms[0].date).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })}`;
}

function viewHome() {
  const plan = state.plan;
  const m = state.measurements.at(-1);
  const monthKey = new Date().toISOString().slice(0, 7);
  const monthCount = state.history.filter((h) => h.startedAt.startsWith(monthKey)).length;
  const hour = new Date().getHours();
  const hello = hour < 6 ? "Bonne nuit" : hour < 18 ? "Salut" : "Bonsoir";
  return `
    <div class="eyebrow">${new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}</div>
    <h1 class="lead">${hello} 👋</h1>
    <div class="tiles">
      ${tile("Poids", m?.weightKg ?? "", " kg", deltaSince("weightKg", " kg"))}
      ${tile("Masse grasse", m?.fatPct ?? "", " %", deltaSince("fatPct", " pt"))}
      ${tile("IMC", m ? bmi(m.weightKg) : "", "")}
      ${tile("Séances ce mois", monthCount, "")}
    </div>
    ${state.active ? `<button class="primary block" data-action="go" data-view="workout" style="margin:0 0 14px">Reprendre la séance en cours</button>` : ""}
    ${
      plan
        ? `<div class="card hero">
            <div class="eyebrow">Prochaine séance</div>
            <h2 style="font-size:22px;margin:4px 0">${esc(plan.name)}</h2>
            ${plan.notes ? `<p class="note">${esc(plan.notes)}</p>` : ""}
            ${plan.exercises
              .map((e) => `<div class="ex-line"><span>${esc(e.name)}</span><span class="sets-sum">${e.sets.length} × ${esc(e.sets[0]?.reps ?? "")}</span></div>`)
              .join("")}
            ${state.active ? "" : `<button class="primary block" data-action="start-plan">Démarrer la séance</button>`}
          </div>`
        : `<div class="card"><p class="muted">Aucune séance planifiée. Fais une séance libre, puis envoie le compte rendu au coach.</p></div>`
    }
    <div class="row">
      ${state.active ? "" : `<button data-action="start-free">Séance libre</button>`}
      <button class="ghost" data-action="go" data-view="import">Importer un plan</button>
    </div>
    <p id="sync-status" class="muted" style="margin-top:16px;text-align:center">${esc(syncStatusText())}</p>`;
}

// Single-series weight chart: 2px line, 8px dots, crosshair + tooltip on hover/touch.
function weightChart() {
  const pts = state.measurements.filter((m) => typeof m.weightKg === "number");
  if (pts.length < 2) return `<p class="muted">La courbe apparaît à partir de 2 pesées.</p>`;
  const W = 340, H = 170, L = 30, R = 8, T = 10, B = 22;
  const ts = pts.map((m) => new Date(m.date).getTime());
  const ws = pts.map((m) => m.weightKg);
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  const lo = Math.floor(Math.min(...ws) - 1), hi = Math.ceil(Math.max(...ws) + 1);
  const x = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (w) => T + (1 - (w - lo) / (hi - lo)) * (H - T - B);
  const step = Math.max(1, Math.ceil((hi - lo) / 4));
  const ticks = [];
  for (let v = lo; v <= hi; v += step) ticks.push(v);
  const fmtD = (t) => new Date(t).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
  const data = pts.map((m, i) => ({ x: x(ts[i]), y: y(m.weightKg), label: `${fmtD(ts[i])} · ${m.weightKg} kg` }));
  return `
    <div class="chart" data-points='${esc(JSON.stringify(data))}' data-w="${W}">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution du poids">
        ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("")}
        <text class="axis" x="${L}" y="${H - 6}">${fmtD(t0)}</text>
        <text class="axis" x="${W - R}" y="${H - 6}" text-anchor="end">${fmtD(t1)}</text>
        <polyline class="series" points="${data.map((p) => `${p.x},${p.y}`).join(" ")}"/>
        ${data.map((p) => `<circle class="dot" cx="${p.x}" cy="${p.y}" r="4"/>`).join("")}
        <line class="cross" y1="${T}" y2="${H - B}" visibility="hidden"/>
        <rect x="0" y="0" width="${W}" height="${H}" fill="transparent" data-hit/>
      </svg>
      <div class="tip" hidden></div>
    </div>`;
}

function chartHover(ev) {
  const chart = ev.target.closest(".chart");
  if (!chart) return;
  const svg = chart.querySelector("svg");
  const pts = JSON.parse(chart.dataset.points);
  const box = svg.getBoundingClientRect();
  const scale = box.width / Number(chart.dataset.w);
  const px = (ev.clientX - box.left) / scale;
  const p = pts.reduce((a, b) => (Math.abs(b.x - px) < Math.abs(a.x - px) ? b : a));
  const cross = chart.querySelector(".cross");
  cross.setAttribute("x1", p.x);
  cross.setAttribute("x2", p.x);
  cross.setAttribute("visibility", "visible");
  const tip = chart.querySelector(".tip");
  tip.hidden = false;
  tip.innerHTML = `<strong>${esc(p.label)}</strong>`;
  tip.style.left = `${Math.min(Math.max(p.x * scale, 70), box.width - 70)}px`;
  tip.style.top = `${p.y * scale}px`;
}

function viewBody() {
  const ms = [...state.measurements].reverse();
  const today = isoDay(new Date().toISOString());
  const last = state.measurements.at(-1);
  return `
    <div class="eyebrow">Suivi</div>
    <h1 class="lead">Corps</h1>
    <div class="card">
      <div class="spread"><h2>Poids</h2><span class="muted">${esc(deltaSince("weightKg", " kg"))}</span></div>
      ${weightChart()}
    </div>
    <form data-form="measure" class="card">
      <h2>Nouvelle mesure</h2>
      <div class="row">
        <div><label>Date</label><input name="date" type="date" value="${today}"></div>
        <div><label>Poids (kg)</label><input name="weightKg" inputmode="decimal" placeholder="${esc(last?.weightKg ?? "")}"></div>
      </div>
      <div class="row">
        <div><label>Masse grasse (%)</label><input name="fatPct" inputmode="decimal"></div>
        <div><label>Muscle squelettique (kg)</label><input name="muscleKg" inputmode="decimal"></div>
      </div>
      <div class="row">
        <div><label>Métabolisme (kcal)</label><input name="bmrKcal" inputmode="numeric"></div>
        <div><label>Note</label><input name="note" placeholder="à jeun, matin…"></div>
      </div>
      <button type="submit" class="primary block">Ajouter</button>
    </form>
    ${ms
      .map(
        (m) => `
      <div class="card">
        <div class="spread"><strong>${new Date(m.date).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}</strong>
          <button class="small danger" data-action="del-measure" data-id="${m.id}">✕</button></div>
        <p class="muted">${esc(fmtMeasure(m).replace(/^- [\d-]+ : /, ""))}</p>
      </div>`
      )
      .join("")}`;
}

// ---------- exercise database (free-exercise-db, public domain) ----------
// Pinned to a commit so cached files never go stale; the service worker caches them for offline use.

const EXDB_BASE = "https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5/";
let exdb = null;
let exdbError = "";

function loadExdb() {
  if (exdb || exdbError) return;
  fetch(`${EXDB_BASE}dist/exercises.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((data) => (exdb = data))
    .catch((err) => (exdbError = `Base d'exercices indisponible (${err.message}). Réessaie avec du réseau.`))
    .finally(() => view === "exercise" && render());
}

const deaccent = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

// French gym vocabulary -> English words used by the database. Longest phrases first.
const FR_EN = [
  ["souleve de terre", "deadlift"], ["developpe couche", "bench press"], ["developpe incline", "incline press"],
  ["developpe militaire", "shoulder press"], ["tirage vertical", "lat pulldown"], ["tirage horizontal", "seated cable row"],
  ["elevations laterales", "lateral raise"], ["elevation laterale", "lateral raise"], ["presse a cuisses", "leg press"],
  ["releve de jambes", "leg raise"], ["squat bulgare", "split squat"], ["gainage planche", "plank"],
  ["developpe", "press"], ["couche", "bench"], ["halteres", "dumbbell"], ["haltere", "dumbbell"], ["barre", "barbell"],
  ["tirage", "pulldown"], ["rowing", "row"], ["unilateral", "one arm"], ["militaire", "shoulder"], ["assis", "seated"],
  ["debout", "standing"], ["pompes", "pushups"], ["planche", "plank"], ["gainage", "plank"], ["tractions", "pullups"],
  ["fentes", "lunge"], ["mollets", "calf raise"], ["poulie", "cable"], ["ecarte", "fly"], ["roumain", "romanian"],
  ["velo", "bicycling"], ["rameur", "rowing stationary"], ["oiseau", "reverse fly"], ["epaules", "shoulder"],
];
const STOP = new Set(["de", "du", "des", "a", "au", "la", "le", "les", "avec", "en", "et", "test", "zone", "2"]);

function tokens(s) {
  let t = deaccent(s);
  for (const [fr, en] of FR_EN) t = t.replaceAll(fr, en);
  return t.split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));
}

// Token overlap; prefix match counts so "pushup" finds "pushups".
function matchScore(q, name) {
  const n = tokens(name);
  let hits = 0;
  for (const w of q) if (n.some((x) => x === w || (w.length >= 4 && (x.startsWith(w) || w.startsWith(x))))) hits++;
  return hits ? hits * 2 - (n.length - hits) * 0.3 : 0;
}

function exdbResults(query) {
  if (!exdb) return "";
  const q = tokens(query);
  const hits = exdb
    .map((x) => ({ x, s: matchScore(q, x.name) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 12);
  if (!hits.length) return `<p class="muted">Aucun résultat. Essaie en anglais (ex. "bench press").</p>`;
  return hits
    .map(
      ({ x }) => `
      <button class="list-item exdb-hit" data-action="link-ex" data-id="${esc(x.id)}">
        <img src="${EXDB_BASE}exercises/${esc(x.images[0])}" alt="" loading="lazy" crossorigin="anonymous">
        <span><strong>${esc(x.name)}</strong><br><span class="muted">${esc(x.equipment || "—")} · ${esc(x.primaryMuscles.join(", "))}</span></span>
      </button>`
    )
    .join("");
}

const MUSCLES_FR = {
  abdominals: "abdos", chest: "pectoraux", shoulders: "épaules", triceps: "triceps", biceps: "biceps",
  lats: "grand dorsal", "middle back": "milieu du dos", "lower back": "lombaires", quadriceps: "quadriceps",
  hamstrings: "ischios", glutes: "fessiers", calves: "mollets", forearms: "avant-bras", traps: "trapèzes",
  adductors: "adducteurs", abductors: "abducteurs", neck: "cou",
};
const muscles = (list) => list.map((m) => MUSCLES_FR[m] || m).join(", ");

function viewExercise(arg) {
  const header = `
    <button class="small" data-action="ex-back">← Retour</button>
    <div class="eyebrow" style="margin-top:14px">Fiche exercice</div>
    <h1 class="lead">${esc(arg.name)}</h1>`;
  if (exdbError) return `${header}<p class="note">${esc(exdbError)}</p>`;
  if (!exdb) {
    loadExdb();
    return `${header}<p class="muted">Chargement de la base d'exercices…</p>`;
  }
  const ex = exdb.find((x) => x.id === state.exerciseLinks[arg.name.trim().toLowerCase()]);
  if (!ex || arg.search) {
    return `${header}
      <p class="muted">${ex ? "Choisis une autre fiche." : "Pas encore de fiche liée. Choisis la bonne, l'app s'en souviendra."}</p>
      <input id="exdb-q" value="${esc(arg.name)}" placeholder="Rechercher (FR ou EN)" autocomplete="off">
      <div id="exdb-results" style="margin-top:12px">${exdbResults(arg.name)}</div>`;
  }
  const img = (i) => `${EXDB_BASE}exercises/${esc(ex.images[i])}`;
  return `${header}
    <div class="exdb-anim">
      <img src="${img(0)}" alt="Position de départ" crossorigin="anonymous">
      ${ex.images[1] ? `<img class="end" src="${img(1)}" alt="Position d'arrivée" crossorigin="anonymous">` : ""}
    </div>
    <div class="card">
      <p><strong>${esc(ex.name)}</strong></p>
      <p class="muted">${esc(ex.equipment || "—")} · niveau ${esc(ex.level)} · ${esc(ex.mechanic || ex.category)}</p>
      <p>Muscles : <strong>${esc(muscles(ex.primaryMuscles))}</strong>${ex.secondaryMuscles.length ? ` · ${esc(muscles(ex.secondaryMuscles))}` : ""}</p>
    </div>
    <div class="card">
      <h2>Exécution</h2>
      <ol class="steps">${ex.instructions.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
    </div>
    <button class="block" data-action="ex-search">Ce n'est pas le bon exercice</button>`;
}

const RPE_SCALE = [
  ["10", "0", "Échec : impossible d'en faire une de plus"],
  ["9", "1", "Très dur, une seule de plus au maximum"],
  ["8", "2", "Dur, mais il en restait deux"],
  ["7", "3", "La charge bouge encore vite"],
  ["6", "4", "Effort modéré"],
  ["≤ 5", "5 +", "Échauffement"],
];

function showRpeHelp() {
  let d = $("#rpe-dialog");
  if (!d) {
    d = document.createElement("dialog");
    d.id = "rpe-dialog";
    d.innerHTML = `
      <h2>RPE : difficulté ressentie</h2>
      <p class="muted">Combien de reps propres tu aurais encore pu faire à la fin de la série ?</p>
      <table class="rpe">
        <tr><th>RPE</th><th>Reps en réserve</th><th></th></tr>
        ${RPE_SCALE.map(([r, rir, txt]) => `<tr><td><strong>${r}</strong></td><td>${rir}</td><td>${txt}</td></tr>`).join("")}
      </table>
      <p class="muted">Demi-points possibles : 8,5 = « peut-être 2, sûrement 1 ». Note-le juste après la série.
        Les RPE du plan sont des cibles : remplace-les par ton ressenti réel.
        RPE séance = à quel point la séance entière t'a vidé (1 à 10).</p>
      <button class="primary block" data-action="rpe-close">OK</button>`;
    // Tap on the backdrop closes it.
    d.addEventListener("click", (ev) => ev.target === d && d.close());
    document.body.append(d);
  }
  d.showModal();
}

// ---------- meal ideas (no tracking: the LLM proposes simple meals that fit the goal) ----------

const MEALS_FORMAT = `{
  "meals": [
    {
      "name": "Poulet riz brocoli sauce soja-miel",
      "type": "repas",
      "portions": 4,
      "kcal_per_portion": 600,
      "protein_g": 50,
      "prep_min": 25,
      "batch": true,
      "ingredients": ["800 g de blanc de poulet", "300 g de riz (cru)"],
      "steps": ["Cuire le riz", "Saisir le poulet en dés"],
      "tips": "Se garde 4 jours au frigo. Variante : remplacer le soja par du curry."
    }
  ],
  "shopping": ["800 g de blanc de poulet", "1 kg de riz"]
}`;

function buildFoodPrompt(craving) {
  const f = state.food;
  const m = state.measurements.at(-1);
  const favs = state.meals.filter((x) => x.fav).map((x) => `- ${x.name}`);
  const prefs = [
    f.likes && `- J'aime : ${f.likes}`,
    f.dislikes && `- Je n'aime pas / je ne mange pas : ${f.dislikes}`,
    f.allergies && `- Allergies / intolérances : ${f.allergies}`,
    f.cooking && `- Cuisine (temps, matériel, batch cooking) : ${f.cooking}`,
    f.other && `- Autre : ${f.other}`,
  ].filter(Boolean);
  return `Tu es mon coach nutrition. Je ne compte pas les calories et je ne veux pas de suivi : donne-moi des idées
de repas simples, qui collent à mon objectif sportif et à mes goûts. Je suis difficile : respecte strictement
mes "je n'aime pas". Le basique répétitif (poulet-riz, etc.) me va très bien : vise efficace et facile, pas gastronomique.

Règles :
- Riche en protéines (≥ 35 g par repas principal, ≥ 20 g par petit-déjeuner ou collation), adapté à une perte de gras sans perte de muscle.
- Ingrédients de supermarché courant, peu d'étapes. Privilégie les plats qui se préparent en grande quantité et se gardent 3-4 jours.
- 7 idées : 2 petits-déjeuners, 3 repas principaux (au moins 2 en batch de 4 portions), 2 collations.
- Ne répète pas mes favoris, mais propose des idées dans le même esprit.
- "shopping" = liste de courses regroupée pour préparer toutes les idées, quantités comprises.
- Valeurs nutritionnelles = estimations par portion.

Réponds avec UN SEUL bloc \`\`\`json à ce format (JSON strict, sans commentaires) :
${MEALS_FORMAT}
"type" vaut "petit-déj", "repas" ou "collation".

## Objectif et profil
${state.profile.goals ? `- ${state.profile.goals}` : "- (non renseigné)"}
${m ? fmtMeasure(m) : ""}

## Mémoire du coach (repères nutrition inclus)
${state.coachMemory.length ? state.coachMemory.map((x) => `- ${x}`).join("\n") : "- (vide)"}

## Mes goûts
${prefs.length ? prefs.join("\n") : "- (non renseignés)"}

## Mes favoris
${favs.length ? favs.join("\n") : "- (aucun)"}
${craving.trim() ? `\n## Envie du moment\n${craving.trim()}\n` : ""}`;
}

function importMeals(obj) {
  if (!Array.isArray(obj.meals) || !obj.meals.length) throw new Error("Le champ 'meals' est absent ou vide.");
  const fresh = obj.meals.map((x, i) => ({
    id: `meal${Date.now().toString(36)}${i}`,
    name: String(x.name || "Sans nom"),
    type: String(x.type || "repas"),
    portions: num(x.portions),
    kcal: num(x.kcal_per_portion ?? x.kcal),
    protein: num(x.protein_g ?? x.protein),
    prepMin: num(x.prep_min),
    batch: Boolean(x.batch),
    ingredients: Array.isArray(x.ingredients) ? x.ingredients.map(String) : [],
    steps: Array.isArray(x.steps) ? x.steps.map(String) : [],
    tips: x.tips ? String(x.tips) : "",
    fav: false,
  }));
  // Favourites survive a new batch of ideas; the rest is replaced.
  state.meals = [...state.meals.filter((x) => x.fav), ...fresh];
  if (Array.isArray(obj.shopping)) state.shopping = obj.shopping.map((text) => ({ text: String(text), done: false }));
}

const MEAL_TYPES = [
  ["petit-déj", "Petits-déjeuners"],
  ["repas", "Repas"],
  ["collation", "Collations"],
];

function mealCard(m) {
  const facts = [
    m.protein !== "" && `${m.protein} g prot.`,
    m.kcal !== "" && `~${m.kcal} kcal`,
    m.prepMin !== "" && `${m.prepMin} min`,
    m.batch && m.portions && `batch ${m.portions} portions`,
  ].filter(Boolean);
  return `
    <details class="card meal">
      <summary>
        <div class="spread">
          <strong>${esc(m.name)}</strong>
          <button class="small star ${m.fav ? "on" : ""}" data-action="meal-fav" data-id="${m.id}" aria-label="Favori">${m.fav ? "★" : "☆"}</button>
        </div>
        <div class="muted">${esc(facts.join(" · "))}</div>
      </summary>
      <h2 style="margin-top:12px">Ingrédients${m.portions ? ` (${esc(m.portions)} portions)` : ""}</h2>
      <ul class="steps">${m.ingredients.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      <h2>Préparation</h2>
      <ol class="steps">${m.steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
      ${m.tips ? `<p class="note">${esc(m.tips)}</p>` : ""}
      ${m.fav ? "" : `<button class="small danger" data-action="meal-del" data-id="${m.id}">Retirer</button>`}
    </details>`;
}

function viewFood() {
  const groups = MEAL_TYPES.map(([type, label]) => {
    const list = state.meals.filter((m) => m.type === type || (type === "repas" && !MEAL_TYPES.some(([t]) => t === m.type)));
    return list.length ? `<div class="eyebrow" style="margin:18px 0 8px">${label}</div>${list.map(mealCard).join("")}` : "";
  }).join("");
  const shop = state.shopping;
  return `
    <div class="eyebrow">Idées repas, sans suivi</div>
    <h1 class="lead">Cuisine</h1>
    <button class="primary block" style="margin:0 0 6px" data-action="go" data-view="foodPrompt">Demander de nouvelles idées</button>
    ${groups || `<div class="card"><p class="muted">Aucune idée pour l'instant. Renseigne tes goûts et demande des idées au coach.</p></div>`}
    ${
      shop.length
        ? `<div class="card">
            <div class="spread"><h2>Liste de courses</h2><button class="small" data-action="shop-clear">Retirer les cochés</button></div>
            ${shop
              .map((x, i) => `<button class="shop ${x.done ? "done" : ""}" data-action="shop-toggle" data-i="${i}"><span class="box">${x.done ? "✓" : ""}</span>${esc(x.text)}</button>`)
              .join("")}
          </div>`
        : ""
    }`;
}

function viewFoodPrompt() {
  const f = state.food;
  const field = (name, label, placeholder) =>
    `<label>${label}</label><textarea name="${name}" style="min-height:64px" placeholder="${placeholder}">${esc(f[name])}</textarea>`;
  return `
    <button class="small" data-action="go" data-view="food">← Retour</button>
    <div class="eyebrow" style="margin-top:14px">Nouvelles idées</div>
    <h1 class="lead">Mes goûts</h1>
    <form data-form="food-prefs" class="card">
      ${field("likes", "J'aime", "Poulet, riz, pâtes, œufs, fromage blanc…")}
      ${field("dislikes", "Je n'aime pas / je ne mange pas", "Poisson, champignons, poivrons…")}
      ${field("allergies", "Allergies / intolérances", "Aucune")}
      ${field("cooking", "Cuisine", "20 min max en semaine, batch cooking le dimanche, airfryer…")}
      ${field("other", "Autre", "Budget, cantine le midi, pas de micro-ondes au boulot…")}
      <button type="submit" class="block">Enregistrer mes goûts</button>
    </form>
    <div class="card">
      <h2>1. Copier la demande</h2>
      <label>Envie du moment (optionnel)</label>
      <input name="craving" placeholder="Ex. un truc sucré pour le soir, du mexicain…">
      <button class="primary block" data-action="copy-food">Copier la demande</button>
      <a class="btn block" href="${coach().url}" target="_blank" rel="noopener">Ouvrir ${coach().label}</a>
    </div>
    <form data-form="food-import" class="card">
      <h2>2. Importer la réponse</h2>
      <textarea name="text" style="min-height:160px" placeholder="Colle ici toute la réponse"></textarea>
      <button type="submit" class="primary block">Importer les idées</button>
      <p id="food-error" class="note"></p>
    </form>
    <p class="muted">Les favoris ★ sont conservés quand tu importes de nouvelles idées.</p>`;
}

const NAV = [
  ["home", "Accueil", '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'],
  ["history", "Historique", '<path d="M4 5h16M4 12h16M4 19h10"/>'],
  ["body", "Corps", '<path d="M3 17l5-6 4 4 8-9"/><path d="M15 6h5v5"/>'],
  ["food", "Cuisine", '<path d="M7 3v8a2 2 0 0 0 2 2v8M5 3v5M9 3v5M17 3c-2 2-2 6 0 8v10"/>'],
  ["settings", "Profil", '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/>'],
];

function navBar() {
  const section = { session: "history", report: "history", workout: "home", finish: "home", import: "home", foodPrompt: "food" }[view] || view;
  return `<nav class="tabs">${NAV.map(
    ([v, label, icon]) => `<button class="${section === v ? "on" : ""}" data-action="go" data-view="${v}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>${label}</button>`
  ).join("")}</nav>`;
}

function viewWorkout() {
  const a = state.active;
  if (!a) return viewHome();
  holdWakeLock();
  const exHtml = a.exercises
    .map((e, i) => {
      const prev = lastPerf(e.name);
      return `
      <div class="card">
        <div class="spread">
          <h2>${esc(e.name)}</h2>
          <span class="row" style="flex:0">
            <button class="small" data-action="work-start" data-ex="${i}" aria-label="Chronomètre">⏱</button>
            <button class="small" data-action="ex-info" data-name="${esc(e.name)}" aria-label="Fiche exercice">ⓘ</button>
            <button class="small danger" data-action="del-ex" data-ex="${i}">✕</button>
          </span>
        </div>
        ${e.note ? `<p class="note">${esc(e.note)}</p>` : ""}
        ${prev ? `<p class="muted">Dernière fois (${fmtDate(prev.date)}) : ${fmtSets(prev)}</p>` : ""}
        <div class="sets">
          <div class="set head"><span>#</span><span>kg</span><span>${e.timed ? "sec" : "reps"}</span><button class="link-head" data-action="rpe-help">RPE ⓘ</button><span></span></div>
          ${e.sets
            .map(
              (s, j) => `
            <div class="set ${s.done ? "done" : ""}">
              <span class="num">${j + 1}</span>
              <input inputmode="decimal" data-field="kg" data-ex="${i}" data-set="${j}" value="${esc(s.kg)}">
              <input inputmode="numeric" data-field="reps" data-ex="${i}" data-set="${j}" value="${esc(s.reps)}">
              <input inputmode="decimal" data-field="rpe" data-ex="${i}" data-set="${j}" value="${esc(s.rpe)}">
              <button class="check" data-action="toggle-set" data-ex="${i}" data-set="${j}">✓</button>
            </div>`
            )
            .join("")}
        </div>
        <div class="row" style="margin-top:8px">
          <button class="small" data-action="add-set" data-ex="${i}">+ Série</button>
          <button class="small" data-action="del-set" data-ex="${i}">− Série</button>
          <label class="muted" style="margin:0;text-align:right">Repos (s)</label>
          <input inputmode="numeric" data-field="restS" data-ex="${i}" value="${esc(e.restS)}" style="padding:6px">
        </div>
      </div>`;
    })
    .join("");

  return `
    <input class="title-input" data-field="name" value="${esc(a.name)}">
    <button class="small ghost" data-action="rpe-help" style="margin:6px 0">Échelle RPE</button>
    <p class="muted">Débutée ${new Date(a.startedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</p>
    ${a.plan?.notes ? `<p class="note">${esc(a.plan.notes)}</p>` : ""}
    ${exHtml}
    <div class="card">
      <form data-form="add-ex" class="row">
        <input name="exName" list="exlist" placeholder="Ajouter un exercice" autocomplete="off">
        <button type="submit" style="flex:0">+</button>
      </form>
      <datalist id="exlist">${knownExercises().map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
    </div>
    <button class="primary block" data-action="go" data-view="finish">Terminer la séance</button>
    <div class="row" style="margin-top:8px">
      <button data-action="go" data-view="home">Accueil</button>
      <button class="danger" data-action="discard">Abandonner</button>
    </div>`;
}

function viewFinish() {
  const a = state.active;
  if (!a) return viewHome();
  const doneSets = a.exercises.reduce((n, e) => n + e.sets.filter((s) => s.done).length, 0);
  const opts = (max) => `<option value="">—</option>` + Array.from({ length: max }, (_, i) => `<option>${i + 1}</option>`).join("");
  return `
    <h1>Fin de séance</h1>
    <p class="muted">${doneSets} séries validées. Seules les séries cochées ✓ sont enregistrées.</p>
    <form data-form="finish" class="card">
      <div class="row">
        <div><label>Énergie (1–5)</label><select name="energy">${opts(5)}</select></div>
        <div><label>RPE séance (1–10) <button type="button" class="link-head" data-action="rpe-help">ⓘ</button></label><select name="sessionRpe">${opts(10)}</select></div>
      </div>
      <label>Douleur / gêne (où, quand, intensité)</label>
      <textarea name="pain" placeholder="Rien à signaler"></textarea>
      <label>Notes pour le coach</label>
      <textarea name="notes" placeholder="Sommeil, stress, technique, envies pour la prochaine…"></textarea>
      <button type="submit" class="primary block">Enregistrer & générer le compte rendu</button>
    </form>
    <button class="block" data-action="go" data-view="workout">Retour à la séance</button>`;
}

function viewReport(id) {
  const session = state.history.find((h) => h.id === id);
  if (!session) return viewHome();
  return `
    <h1>Compte rendu</h1>
    <p class="muted">1. Copie le texte. 2. Colle-le dans ${coach().label}. 3. Copie sa réponse et importe-la ici.</p>
    <button class="primary block" data-action="copy-report" data-id="${id}">Copier le compte rendu</button>
    <a class="btn block" href="${coach().url}" target="_blank" rel="noopener">Ouvrir ${coach().label}</a>
    <button class="block" data-action="go" data-view="import">Importer la réponse du coach</button>
    <textarea readonly style="min-height:320px;margin-top:12px;font-size:13px">${esc(buildReport(session))}</textarea>
    <button class="block" data-action="go" data-view="home">Accueil</button>`;
}

function viewImport() {
  return `
    <h1>Importer un plan</h1>
    <p class="muted">Colle toute la réponse de ${coach().label}. Le bloc JSON est extrait automatiquement.</p>
    <form data-form="import" class="card">
      <textarea name="text" style="min-height:240px" placeholder="Colle ici la réponse du coach"></textarea>
      <button type="button" class="block" data-action="paste">Coller depuis le presse-papier</button>
      <button type="submit" class="primary block">Importer</button>
      <p id="import-error" class="note"></p>
    </form>
    ${state.plan ? `<p class="muted">Attention : remplace le plan actuel « ${esc(state.plan.name)} ».</p>` : ""}
    <button class="block" data-action="go" data-view="home">Annuler</button>`;
}

function viewHistory() {
  const items = [...state.history].reverse();
  return `
    <div class="eyebrow">${state.history.length} séances</div>
    <h1 class="lead">Historique</h1>
    ${
      items.length
        ? items
            .map(
              (h) => `
      <button class="list-item" data-action="go" data-view="session" data-id="${h.id}">
        <div class="spread"><strong>${esc(h.name)}</strong><span class="muted">${fmtDate(h.startedAt)}</span></div>
        <div class="muted">${h.exercises.map((e) => esc(e.name)).join(" · ")}</div>
      </button>`
            )
            .join("")
        : `<p class="muted">Aucune séance.</p>`
    }`;
}

function viewSession(id) {
  const h = state.history.find((x) => x.id === id);
  if (!h) return viewHistory();
  const f = h.feedback || {};
  return `
    <h1>${esc(h.name)}</h1>
    <p class="muted">${fmtDate(h.startedAt)} · ${h.durationMin} min</p>
    ${h.exercises
      .map((e) => `<div class="card"><h2>${esc(e.name)}</h2>${e.sets.map((s, i) => `<p>${i + 1}. ${fmtSet(s, e.timed)}</p>`).join("")}</div>`)
      .join("")}
    <div class="card">
      <p>Énergie : ${esc(f.energy || "—")}/5 · RPE séance : ${esc(f.sessionRpe || "—")}/10</p>
      ${f.pain ? `<p>Douleur : ${esc(f.pain)}</p>` : ""}
      ${f.notes ? `<p>Notes : ${esc(f.notes)}</p>` : ""}
    </div>
    <button class="primary block" data-action="go" data-view="report" data-id="${h.id}">Compte rendu pour le coach</button>
    <button class="block danger" data-action="del-session" data-id="${h.id}">Supprimer la séance</button>
    <button class="block" data-action="go" data-view="history">Retour</button>`;
}

function viewSettings() {
  const p = state.profile;
  const field = (name, label, placeholder, area = false) =>
    `<label>${label}</label>` +
    (area
      ? `<textarea name="${name}" placeholder="${placeholder}">${esc(p[name])}</textarea>`
      : `<input name="${name}" placeholder="${placeholder}" value="${esc(p[name])}">`);
  return `
    <div class="eyebrow">Envoyé au coach dans chaque compte rendu</div>
    <h1 class="lead">Profil</h1>
    <form data-form="profile" class="card">
      ${field("goals", "Objectifs", "Ex. prise de force, hypertrophie haut du corps", true)}
      ${field("level", "Niveau / expérience", "Ex. 3 ans de muscu, DC 90 kg")}
      ${field("schedule", "Fréquence", "Ex. 4 séances / semaine, 1 h max")}
      ${field("equipment", "Matériel", "Ex. salle complète")}
      ${field("constraints", "Contraintes / blessures", "Ex. épaule gauche fragile", true)}
      ${field("heightCm", "Taille (cm)", "180")}
      <label>IA coach</label>
      <select name="coach">${Object.entries(COACHES)
        .map(([k, c]) => `<option value="${k}" ${k === (p.coach || "claude") ? "selected" : ""}>${c.label}</option>`)
        .join("")}</select>
      <label>Bips (fin de repos, chrono)</label>
      <select name="sound">
        <option value="on" ${p.sound !== "off" ? "selected" : ""}>Activés</option>
        <option value="off" ${p.sound === "off" ? "selected" : ""}>Désactivés</option>
      </select>
      <label>Mémoire long terme du coach (un point par ligne)</label>
      <textarea name="coachMemory" style="min-height:160px" placeholder="Mise à jour par le coach à chaque import de plan">${esc(state.coachMemory.join("\n"))}</textarea>
      <button type="submit" class="primary block">Enregistrer</button>
    </form>
    <form data-form="sync" class="card">
      <h2>Synchro GitHub</h2>
      <p class="muted">Copie les séances, le profil et le plan dans un repo <strong>privé</strong> après chaque changement.
        Token : GitHub → Settings → Developer settings → Fine-grained tokens. Accès au seul repo de données,
        permission <em>Contents : Read and write</em>.</p>
      <div class="row">
        <div><label>Owner</label><input name="owner" value="${esc(sync.owner)}" placeholder="ton-user" autocapitalize="off"></div>
        <div><label>Repo</label><input name="repo" value="${esc(sync.repo)}" placeholder="nogro-data" autocapitalize="off"></div>
      </div>
      <label>Fichier</label>
      <input name="path" value="${esc(sync.path)}" autocapitalize="off">
      <label>Token</label>
      <input name="token" type="password" value="${esc(sync.token)}" placeholder="github_pat_…" autocomplete="off">
      <button type="submit" class="primary block">Enregistrer & synchroniser</button>
      <p id="sync-status" class="muted">${esc(syncStatusText())}</p>
    </form>
    <div class="card">
      <h2>Sauvegarde manuelle</h2>
      <p class="muted">Export JSON sans le token. La séance en cours n'est jamais synchronisée.</p>
      <button class="block" data-action="export">Exporter (JSON)</button>
      <label class="btn block" style="color:var(--text);font-size:16px;margin-top:8px">Importer une sauvegarde
        <input type="file" accept="application/json,.json" data-action="import-backup" hidden>
      </label>
    </div>`;
}

function render() {
  const views = {
    home: viewHome,
    workout: viewWorkout,
    finish: viewFinish,
    report: () => viewReport(viewArg),
    import: viewImport,
    history: viewHistory,
    session: () => viewSession(viewArg),
    settings: viewSettings,
    body: viewBody,
    exercise: () => viewExercise(viewArg),
    food: viewFood,
    foodPrompt: viewFoodPrompt,
  };
  $("#app").innerHTML = (views[view] || viewHome)() + navBar();
}

document.addEventListener("pointermove", chartHover);
document.addEventListener("pointerdown", chartHover);

// ---------- events ----------

document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("[data-action]");
  if (!t || t.tagName === "INPUT") return;
  // Any tap unlocks audio (browsers block sound until a user gesture).
  if (soundOn()) audio();
  const ex = Number(t.dataset.ex);
  const set = Number(t.dataset.set);
  const a = state.active;

  switch (t.dataset.action) {
    case "go":
      return go(t.dataset.view, t.dataset.id ?? null);
    case "start-plan":
      return startWorkout(true);
    case "start-free":
      return startWorkout(false);
    case "toggle-set": {
      const s = a.exercises[ex].sets[set];
      s.done = !s.done;
      save();
      render();
      if (s.done) startRest(Number(a.exercises[ex].restS) || REST_DEFAULT_S);
      return;
    }
    case "add-set": {
      const sets = a.exercises[ex].sets;
      const last = sets.at(-1);
      sets.push({ kg: last?.kg ?? "", reps: last?.reps ?? "", rpe: "", done: false });
      save();
      return render();
    }
    case "del-set":
      if (a.exercises[ex].sets.length > 1) a.exercises[ex].sets.pop();
      save();
      return render();
    case "del-ex":
      if (!confirm(`Supprimer ${a.exercises[ex].name} ?`)) return;
      a.exercises.splice(ex, 1);
      save();
      return render();
    case "discard":
      if (!confirm("Abandonner la séance ? Rien ne sera enregistré.")) return;
      state.active = null;
      work = null;
      save();
      stopRest();
      releaseWakeLock();
      return go("home");
    case "rest-add": {
      rest.endAt += Number(t.dataset.s) * 1000;
      rest.buzzed = rest.endAt <= Date.now();
      cancelBeeps();
      const left = (rest.endAt - Date.now()) / 1000;
      if (left > 0) scheduleCountdown(left);
      return tickBar();
    }
    case "work-start":
      return startWork(ex);
    case "work-stop":
      return stopWork(true);
    case "work-cancel":
      return stopWork(false);
    case "rest-stop":
      return stopRest();
    case "copy-report": {
      const session = state.history.find((h) => h.id === t.dataset.id);
      const ok = await copy(buildReport(session));
      t.textContent = ok ? "Copié ✓" : "Échec : sélectionne le texte à la main";
      return;
    }
    case "paste":
      try {
        document.querySelector("[name=text]").value = await navigator.clipboard.readText();
      } catch {
        $("#import-error").textContent = "Accès au presse-papier refusé : colle à la main (appui long).";
      }
      return;
    case "meal-fav": {
      const m = state.meals.find((x) => x.id === t.dataset.id);
      m.fav = !m.fav;
      save();
      return render();
    }
    case "meal-del":
      state.meals = state.meals.filter((x) => x.id !== t.dataset.id);
      save();
      return render();
    case "shop-toggle":
      state.shopping[Number(t.dataset.i)].done = !state.shopping[Number(t.dataset.i)].done;
      save();
      return render();
    case "shop-clear":
      state.shopping = state.shopping.filter((x) => !x.done);
      save();
      return render();
    case "copy-food": {
      const ok = await copy(buildFoodPrompt(document.querySelector("[name=craving]")?.value || ""));
      t.textContent = ok ? "Copié ✓" : "Échec : sélectionne le texte à la main";
      return;
    }
    case "rpe-help":
      return showRpeHelp();
    case "rpe-close":
      return $("#rpe-dialog").close();
    case "ex-info":
      return go("exercise", { name: t.dataset.name, back: view, search: false, scroll: window.scrollY });
    case "ex-search":
      viewArg = { ...viewArg, search: true };
      return render();
    case "link-ex":
      state.exerciseLinks[viewArg.name.trim().toLowerCase()] = t.dataset.id;
      save();
      viewArg = { ...viewArg, search: false };
      return render();
    case "ex-back": {
      const y = viewArg.scroll || 0;
      go(viewArg.back || "home");
      return window.scrollTo(0, y);
    }
    case "del-measure":
      if (!confirm("Supprimer cette mesure ?")) return;
      state.measurements = state.measurements.filter((m) => m.id !== t.dataset.id);
      state.deleted.push(t.dataset.id);
      save();
      return render();
    case "del-session":
      if (!confirm("Supprimer définitivement cette séance ?")) return;
      state.history = state.history.filter((h) => h.id !== t.dataset.id);
      state.deleted.push(t.dataset.id);
      save();
      return go("history");
    case "export":
      return download(`nogro-backup-${isoDay(new Date().toISOString())}.json`, JSON.stringify(state, null, 2));
  }
});

document.addEventListener("input", (ev) => {
  const t = ev.target;
  if (t.id === "exdb-q") {
    $("#exdb-results").innerHTML = exdbResults(t.value);
    return;
  }
  const field = t.dataset.field;
  if (!field || !state.active) return;
  if (field === "name") state.active.name = t.value;
  else if (field === "restS") state.active.exercises[Number(t.dataset.ex)].restS = num(t.value);
  else state.active.exercises[Number(t.dataset.ex)].sets[Number(t.dataset.set)][field] = num(t.value);
  save();
});

document.addEventListener("change", (ev) => {
  const t = ev.target;
  if (t.dataset.action !== "import-backup" || !t.files[0]) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.history)) throw new Error("champ 'history' absent");
      if (!confirm(`Remplacer toutes les données par cette sauvegarde (${data.history.length} séances) ?`)) return;
      state = normalize(data);
      save();
      go("home");
    } catch (err) {
      alert(`Sauvegarde invalide : ${err.message}`);
    }
  };
  reader.readAsText(t.files[0]);
});

document.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = ev.target;
  switch (f.dataset.form) {
    case "add-ex":
      return addExercise(f.exName.value);
    case "finish":
      return finishWorkout(f);
    case "import":
      try {
        const obj = extractJson(f.text.value);
        if (isBackup(obj)) {
          const n = obj.history.length;
          if (!confirm(`C'est une sauvegarde complète (${n} séances, profil, mesures). Remplacer toutes les données ?`)) return;
          state = normalize(obj);
          save();
          return go("home");
        }
        const { plan, memory } = parsePlan(obj);
        state.plan = plan;
        if (memory) state.coachMemory = memory;
        save();
        go("home");
      } catch (err) {
        $("#import-error").textContent = err.message;
      }
      return;
    case "profile":
      state.profile = Object.fromEntries(Object.keys(defaultState().profile).map((k) => [k, f[k].value.trim()]));
      state.coachMemory = f.coachMemory.value.split("\n").map((m) => m.trim()).filter(Boolean);
      save();
      return go("home");
    case "food-prefs":
      state.food = Object.fromEntries(Object.keys(defaultState().food).map((k) => [k, f[k].value.trim()]));
      save();
      return go("foodPrompt");
    case "food-import":
      try {
        importMeals(extractJson(f.text.value));
        save();
        go("food");
      } catch (err) {
        $("#food-error").textContent = err.message;
      }
      return;
    case "measure": {
      const m = {
        id: `m${Date.now().toString(36)}`,
        date: f.date.value || isoDay(new Date().toISOString()),
        weightKg: num(f.weightKg.value),
        fatPct: num(f.fatPct.value),
        muscleKg: num(f.muscleKg.value),
        bmrKcal: num(f.bmrKcal.value),
        note: f.note.value.trim(),
      };
      if (m.weightKg === "" && m.fatPct === "" && m.muscleKg === "") return;
      state.measurements.push(m);
      state.measurements.sort((a, b) => a.date.localeCompare(b.date));
      save();
      return render();
    }
    case "sync":
      for (const k of ["owner", "repo", "path", "token"]) sync[k] = f[k].value.trim();
      sync.path ||= "nogro-data.json";
      sync.status = "";
      saveSync();
      return runSync();
  }
});

if ("serviceWorker" in navigator) {
  // Reload once when a new deploy takes control, so the phone never runs a stale version.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => hadController && location.reload());
  navigator.serviceWorker.register("sw.js").then((reg) => {
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && reg.update());
  });
}

render();
runSync();
