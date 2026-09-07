// sync-leetcode-stats.mjs
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_BASE = (process.env.LEETCODE_API_BASE || "https://alfa-leetcode-api.onrender.com").replace(/\/$/, "");
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 500);
const MAX_RETRIES = 3;

// Optional: who/what triggered this run, and an optional scope (partial sync).
const SYNC_TYPE = process.env.SYNC_TYPE === "Automatic" ? "Automatic" : "Manual";
const SYNCED_BY = process.env.SYNCED_BY || null;       // staff.id (uuid), if triggered from your app
const DEPARTMENT = process.env.DEPARTMENT || null;      // optional filter
const YEAR = process.env.YEAR ? Number(process.env.YEAR) : null;
const SECTION = process.env.SECTION || null;

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

async function fetchJson(url) {
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
  const data = await fetchJson(`${API_BASE}/${encodeURIComponent(username)}/solved`);
  return {
    easy: Number(data.easySolved ?? data.easy ?? 0),
    medium: Number(data.mediumSolved ?? data.medium ?? 0),
    hard: Number(data.hardSolved ?? data.hard ?? 0),
  };
}

async function getSubmissionCalendar(username) {
  const data = await fetchJson(`${API_BASE}/${encodeURIComponent(username)}/calendar`);
  let calendar = data.submissionCalendar ?? data;
  if (typeof calendar === "string") {
    try {
      calendar = JSON.parse(calendar);
    } catch {
      calendar = {};
    }
  }
  return calendar;
}

async function startSyncLog(totalStudents) {
  const { data, error } = await supabase
    .from("sync_logs")
    .insert({
      synced_by: SYNCED_BY,
      sync_type: SYNC_TYPE,
      department: DEPARTMENT,
      year: YEAR,
      section: SECTION,
      total_students: totalStudents,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    console.error("Failed to create sync_logs row:", error.message);
    return null; // don't block the sync just because logging failed
  }
  return data.id;
}

async function finishSyncLog(logId, status) {
  if (!logId) return;
  const { error } = await supabase
    .from("sync_logs")
    .update({ completed_at: new Date().toISOString(), status })
    .eq("id", logId);
  if (error) console.error("Failed to finalize sync_logs row:", error.message);
}

async function main() {
  console.log(`Starting LeetCode sync via ${API_BASE} (${SYNC_TYPE})`);

  let query = supabase.from("students").select("reg_no, leetcode_username");
  if (DEPARTMENT) query = query.eq("department", DEPARTMENT);
  if (YEAR) query = query.eq("year", YEAR);
  if (SECTION) query = query.eq("section", SECTION);

  const { data: students, error: studentsErr } = await query;

  if (studentsErr) {
    console.error("Failed to fetch students:", studentsErr.message);
    process.exit(1);
  }

  console.log(`Found ${students.length} students.`);
  const logId = await startSyncLog(students.length);

  const failures = [];
  let updated = 0;
  let streakUpdatedCount = 0;

  for (const student of students) {
    const { reg_no, leetcode_username } = student;
    try {
      const { data: existing } = await supabase
        .from("student_summary")
        .select("current_streak, streak_updated_at")
        .eq("reg_no", reg_no)
        .maybeSingle();

      const alreadyUpdatedToday =
        existing?.streak_updated_at && istDateString(new Date(existing.streak_updated_at)) === istDateString();

      const [solved, calendar] = await Promise.all([
        getSolvedCounts(leetcode_username),
        alreadyUpdatedToday ? Promise.resolve(null) : getSubmissionCalendar(leetcode_username),
      ]);

      const payload = {
        reg_no,
        easy_count: solved.easy,
        medium_count: solved.medium,
        hard_count: solved.hard,
        updated_at: new Date().toISOString(),
      };

      let streakNote = "unchanged (already updated today)";
      if (!alreadyUpdatedToday) {
        const newStreak = computeStreakThroughYesterday(calendar);
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
      console.log(`OK  ${reg_no} (${leetcode_username}) -> E:${solved.easy} M:${solved.medium} H:${solved.hard} ${streakNote}`);
    } catch (err) {
      failures.push({ reg_no, leetcode_username, error: err.message });
      console.error(`FAIL ${reg_no} (${leetcode_username}): ${err.message}`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`\nDone. Updated ${updated}/${students.length}. Streak recomputed for ${streakUpdatedCount}.`);

  const finalStatus = failures.length ? "Failed" : "Success";
  await finishSyncLog(logId, finalStatus);

  if (failures.length) {
    console.log(`Failures (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f.reg_no} (${f.leetcode_username}): ${f.error}`);
    process.exitCode = 1;
  }
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});