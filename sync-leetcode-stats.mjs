// sync-leetcode-stats.mjs
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// --- API base config ---
// Primary API base is tried first. If a request to it fails (after its own
// retries), we fall back to the alfa-leetcode-api render instance.
const API_BASE_PRIMARY = (process.env.LEETCODE_API_BASE || "https://alfa-leetcode-api.onrender.com").replace(/\/$/, "");
const API_BASE_FALLBACK = (process.env.LEETCODE_API_BASE_FALLBACK || "https://alfa-leetcode-api.onrender.com").replace(/\/$/, "");

const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 500);
const MAX_RETRIES = 3;

// Optional: who/what triggered this run, and an optional scope (partial sync).
const SYNC_TYPE = process.env.SYNC_TYPE === "Automatic" ? "Automatic" : "Manual";
const SYNCED_BY = process.env.SYNCED_BY || null;       // staff.id (uuid), if triggered from your app
const DEPARTMENT = process.env.DEPARTMENT || null;      // optional filter
const YEAR = process.env.YEAR ? Number(process.env.YEAR) : null;
const SECTION = process.env.SECTION || null;

// Register-number range filter (optional partial sync by reg_no range).
// e.g. REG_FROM=21CS001 REG_TO=21CS060
// If both are given and REG_FROM sorts after REG_TO, they're auto-swapped
// so the range direction never causes an empty result.
//
// REG_FROM/REG_TO are kept as TEXT for querying the `students` table (its
// reg_no column is text and range-filtered with gte/lte on the raw string).
// sync_logs.reg_from/reg_to are INTEGER, so a separate, explicitly-converted
// pair (REG_FROM_INT/REG_TO_INT) is computed below just for that insert.
const RAW_REG_FROM = process.env.REG_FROM || null;
const RAW_REG_TO = process.env.REG_TO || null;
let REG_FROM = RAW_REG_FROM;
let REG_TO = RAW_REG_TO;
if (REG_FROM && REG_TO) {
  let commonPrefixLen = 0;
  const maxLen = Math.min(REG_FROM.length, REG_TO.length);
  while (commonPrefixLen < maxLen && REG_FROM[commonPrefixLen] === REG_TO[commonPrefixLen]) {
    commonPrefixLen++;
  }
  const suffixLen = maxLen - commonPrefixLen;
  if (suffixLen > 5) {
    console.warn(
      `WARNING: REG_FROM="${REG_FROM}" and REG_TO="${REG_TO}" only share a ${commonPrefixLen}-character common prefix. ` +
        `This range will match a much wider set of reg_no values than a typical "same series, different last digits" range. ` +
        `Double-check these values before relying on the result.`
    );
  }
}
if (REG_FROM && REG_TO && REG_FROM > REG_TO) {
  [REG_FROM, REG_TO] = [REG_TO, REG_FROM];
}

// Converts a reg_no string into an integer for the sync_logs.reg_from/reg_to
// columns, by stripping any non-digit characters (e.g. department letters)
// and parsing what remains. Returns null for null/empty/non-numeric input.
//
// CAUTION: this is lossy. "21CS001" and "21CE001" both strip down to the
// same digits ("21001"), so two different register-number series can
// collide onto the same integer. A warning is logged whenever the input
// contains non-digit characters, since that's the case where information
// is being discarded.
function regNoToInt(regNo) {
  if (!regNo) return null;
  const digitsOnly = regNo.replace(/\D/g, "");
  if (!digitsOnly) {
    console.warn(`Could not convert reg_no "${regNo}" to an integer (no digits found) — storing null.`);
    return null;
  }
  if (digitsOnly.length !== regNo.length) {
    console.warn(
      `reg_no "${regNo}" contains non-digit characters that will be dropped for sync_logs storage -> ${digitsOnly}. ` +
        `Different reg_no series (e.g. different department codes) can collide onto the same integer this way.`
    );
  }
  const n = Number(digitsOnly);
  return Number.isFinite(n) ? n : null;
}

const REG_FROM_INT = regNoToInt(REG_FROM);
const REG_TO_INT = regNoToInt(REG_TO);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- "Day" boundary in IST (adjust if your users aren't IST) ---
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istDateString(d = new Date()) {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

async function fetchJsonFromBase(apiBase, path) {
  const url = `${apiBase}${path}`;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) await sleep(1000 * attempt);
    }
  }
  throw lastErr;
}

// Tries the primary API base; if it fails completely (after retries), falls
// back to the fallback API base. Returns { data, apiBaseUsed }.
async function fetchJsonWithFallback(path) {
  try {
    const data = await fetchJsonFromBase(API_BASE_PRIMARY, path);
    return { data, apiBaseUsed: API_BASE_PRIMARY };
  } catch (primaryErr) {
    if (API_BASE_FALLBACK === API_BASE_PRIMARY) {
      // No distinct fallback configured, nothing else to try.
      throw primaryErr;
    }
    console.warn(`Primary API failed for ${path} (${primaryErr.message}); trying fallback...`);
    const data = await fetchJsonFromBase(API_BASE_FALLBACK, path);
    return { data, apiBaseUsed: API_BASE_FALLBACK };
  }
}

function activeDaySet(submissionCalendar) {
  const days = new Set();
  if (!submissionCalendar) return days;
  for (const [epochSecondsStr, count] of Object.entries(submissionCalendar)) {
    if (Number(count) > 0) {
      const d = new Date(Number(epochSecondsStr) * 1000);
      days.add(d.toISOString().slice(0, 10));
    }
  }
  return days;
}

function computeStreakThroughYesterday(submissionCalendar) {
  const days = activeDaySet(submissionCalendar);
  const cursor = new Date();
  cursor.setUTCHours(0, 0, 0, 0);
  cursor.setUTCDate(cursor.getUTCDate() - 1);

  let streak = 0;
  for (let i = 0; i < 3650; i++) {
    const dayStr = cursor.toISOString().slice(0, 10);
    if (days.has(dayStr)) {
      streak++;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

async function getSolvedCounts(username) {
  const { data, apiBaseUsed } = await fetchJsonWithFallback(`/${encodeURIComponent(username)}/solved`);
  return {
    counts: {
      easy: Number(data.easySolved ?? data.easy ?? 0),
      medium: Number(data.mediumSolved ?? data.medium ?? 0),
      hard: Number(data.hardSolved ?? data.hard ?? 0),
    },
    apiBaseUsed,
  };
}

async function getSubmissionCalendar(username) {
  const { data, apiBaseUsed } = await fetchJsonWithFallback(`/${encodeURIComponent(username)}/calendar`);
  let calendar = data.submissionCalendar ?? data;
  if (typeof calendar === "string") {
    try {
      calendar = JSON.parse(calendar);
    } catch {
      calendar = {};
    }
  }
  return { calendar, apiBaseUsed };
}

// Inserts ONE brand-new sync_logs row per run, once the run has finished.
// Unlike the previous "insert a placeholder row at start, then update it"
// approach, this only ever does a single INSERT — called from the finally
// block in main() with the start time captured up front and everything
// else (status, completed_at) known by the time the run is done. That means
// every run — success or failure — always produces exactly one new row,
// and there's never a half-written "in progress" row left behind.
async function logSyncRun({ startedAt, totalStudents, status }) {
  const { data, error } = await supabase
    .from("sync_logs")
    .insert({
      synced_by: SYNCED_BY,
      sync_type: SYNC_TYPE,
      department: DEPARTMENT,
      year: YEAR,
      section: SECTION,
      reg_from: REG_FROM_INT,
      reg_to: REG_TO_INT,
      total_students: totalStudents,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      status,
    })
    .select("id")
    .single();

  if (error) {
    console.error("Failed to insert sync_logs row:", JSON.stringify(error, null, 2));
    return null;
  }
  console.log(`sync_logs row ${data.id} created -> status=${status}`);
  return data.id;
}

async function main() {
  const startedAt = new Date().toISOString();

  console.log(
    `Starting LeetCode sync (${SYNC_TYPE}). Primary API -> ${API_BASE_PRIMARY}` +
      (API_BASE_FALLBACK !== API_BASE_PRIMARY ? `, fallback -> ${API_BASE_FALLBACK}` : " (no distinct fallback configured)")
  );
  console.log(`Raw env received -> REG_FROM="${RAW_REG_FROM}" REG_TO="${RAW_REG_TO}"`);
  if (REG_FROM || REG_TO) {
    console.log(`Reg-no range filter (after order-check, used for students query): ${REG_FROM ?? "(start)"} -> ${REG_TO ?? "(end)"}`);
    console.log(`Reg-no range as stored in sync_logs (integer): ${REG_FROM_INT ?? "(null)"} -> ${REG_TO_INT ?? "(null)"}`);
  }

  let query = supabase.from("students").select("reg_no, leetcode_username");
  if (DEPARTMENT) query = query.eq("department", DEPARTMENT);
  if (YEAR) query = query.eq("year", YEAR);
  if (SECTION) query = query.eq("section", SECTION);
  if (REG_FROM) query = query.gte("reg_no", REG_FROM);
  if (REG_TO) query = query.lte("reg_no", REG_TO);
  query = query.order("reg_no", { ascending: true });

  const { data: students, error: studentsErr } = await query;

  if (studentsErr) {
    console.error("Failed to fetch students:", studentsErr.message);
    // Still record that a run was attempted, even though it never got
    // past fetching the student list.
    await logSyncRun({ startedAt, totalStudents: 0, status: "Failed" });
    process.exit(1);
  }

  console.log(`Found ${students.length} students.`);

  const failures = [];
  let updated = 0;
  let streakUpdatedCount = 0;
  let finalStatus = "Failed";

  try {
    for (let i = 0; i < students.length; i++) {
      const student = students[i];
      const { reg_no, leetcode_username } = student;

      try {
        const { data: existing } = await supabase
          .from("student_summary")
          .select("current_streak, streak_updated_at")
          .eq("reg_no", reg_no)
          .maybeSingle();

        const alreadyUpdatedToday =
          existing?.streak_updated_at && istDateString(new Date(existing.streak_updated_at)) === istDateString();

        const [solvedResult, calendarResult] = await Promise.all([
          getSolvedCounts(leetcode_username),
          alreadyUpdatedToday
            ? Promise.resolve({ calendar: null, apiBaseUsed: null })
            : getSubmissionCalendar(leetcode_username),
        ]);

        const solved = solvedResult.counts;
        const apiBaseUsed = solvedResult.apiBaseUsed;

        const payload = {
          reg_no,
          easy_count: solved.easy,
          medium_count: solved.medium,
          hard_count: solved.hard,
          updated_at: new Date().toISOString(),
        };

        let streakNote = "unchanged (already updated today)";
        if (!alreadyUpdatedToday) {
          const newStreak = computeStreakThroughYesterday(calendarResult.calendar);
          const previousStreak = existing?.current_streak ?? 0;
          payload.current_streak = newStreak;
          payload.yesterday_streak = previousStreak;
          payload.streak_updated_at = new Date().toISOString();
          streakNote = `streak:${newStreak}`;
          streakUpdatedCount++;
        }

        const { error: upsertErr } = await supabase
          .from("student_summary")
          .upsert(payload, { onConflict: "reg_no" });

        if (upsertErr) throw upsertErr;

        updated++;
        console.log(
          `OK  [${i + 1}/${students.length}] ${reg_no} (${leetcode_username}) via ${apiBaseUsed} -> E:${solved.easy} M:${solved.medium} H:${solved.hard} ${streakNote}`
        );
      } catch (err) {
        failures.push({ reg_no, leetcode_username, error: err.message });
        console.error(`FAIL [${i + 1}/${students.length}] ${reg_no} (${leetcode_username}): ${err.message}`);
      }

      await sleep(REQUEST_DELAY_MS);
    }

    console.log(`\nDone. Updated ${updated}/${students.length}. Streak recomputed for ${streakUpdatedCount}.`);

    finalStatus = failures.length ? "Failed" : "Success";

    if (failures.length) {
      console.log(`Failures (${failures.length}):`);
      for (const f of failures) console.log(`  - ${f.reg_no} (${f.leetcode_username}): ${f.error}`);
      process.exitCode = 1;
    }
  } finally {
    // Always inserts exactly one new sync_logs row for this run, whether
    // the loop completed cleanly, threw, or exited early.
    await logSyncRun({ startedAt, totalStudents: students.length, status: finalStatus });
  }
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
