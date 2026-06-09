//! Card-level spaced repetition on FSRS (rs-fsrs). Replaces the per-submodule
//! SM-2 scheduler in db.rs, which is kept frozen for rollback. One row in
//! `cards` per flashcard; every grade appends to `review_log` (the full history
//! the FSRS optimizer would need if we later train per-user parameters).

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use rs_fsrs::{Card as FsrsCard, Parameters, Rating, State, FSRS};
use rusqlite::Connection;
use serde::Serialize;

const DAY_SECS: i64 = 86_400;
/// A card failed this many times is a "leech": auto-suspended, offered for rewrite.
const LEECH_LAPSES: i64 = 8;
/// Cap on NEW cards entering the queue per local day (review-debt protection).
const NEW_PER_DAY: i64 = 20;
pub const DEFAULT_QUEUE_LIMIT: i64 = 100;

fn fsrs() -> FSRS {
    FSRS::new(Parameters {
        request_retention: 0.9,
        maximum_interval: 36_500,
        // No intra-day learning queue in the app: use the long-term scheduler.
        enable_short_term: false,
        enable_fuzz: true,
        ..Default::default()
    })
}

fn ts(secs: i64) -> DateTime<Utc> {
    DateTime::from_timestamp(secs, 0).unwrap_or_else(Utc::now)
}

fn rating_from(r: u8) -> Rating {
    match r {
        1 => Rating::Again,
        2 => Rating::Hard,
        4 => Rating::Easy,
        _ => Rating::Good,
    }
}

fn state_from(s: i64) -> State {
    match s {
        1 => State::Learning,
        2 => State::Review,
        3 => State::Relearning,
        _ => State::New,
    }
}

/// FNV-1a over front+back: ties FSRS state to card content so a regenerated
/// deck keeps the progress of unchanged cards.
pub fn content_hash(front: &str, back: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in front
        .trim()
        .as_bytes()
        .iter()
        .chain([0x1f_u8].iter())
        .chain(back.trim().as_bytes())
    {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRow {
    pub id: String,
    pub course_id: String,
    pub module_id: String,
    pub submodule_id: String,
    pub kind: String,
    pub front: String,
    pub back: String,
    pub concept: Option<String>,
    pub anchor: Option<String>,
    pub state: i64,
    pub due_at: i64,
    pub stability: f64,
    pub difficulty: f64,
    pub elapsed_days: i64,
    pub scheduled_days: i64,
    pub reps: i64,
    pub lapses: i64,
    pub last_review_at: Option<i64>,
    pub suspended: bool,
    pub leech: bool,
}

/// Predicted next interval (days) per rating, for grade-button labels.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntervalPreview {
    pub again: i64,
    pub hard: i64,
    pub good: i64,
    pub easy: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueCard {
    #[serde(flatten)]
    pub card: CardRow,
    pub course_title: String,
    pub submodule_title: String,
    pub preview: IntervalPreview,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GradeOutcome {
    pub card: CardRow,
    /// True when THIS grade tipped the card into leech (it was auto-suspended).
    pub became_leech: bool,
}

const CARD_COLS: &str = "id, course_id, module_id, submodule_id, kind, front, back, concept, anchor, \
     state, due_at, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, \
     last_review_at, suspended, leech";

fn row_to_card(r: &rusqlite::Row) -> rusqlite::Result<CardRow> {
    Ok(CardRow {
        id: r.get(0)?,
        course_id: r.get(1)?,
        module_id: r.get(2)?,
        submodule_id: r.get(3)?,
        kind: r.get(4)?,
        front: r.get(5)?,
        back: r.get(6)?,
        concept: r.get(7)?,
        anchor: r.get(8)?,
        state: r.get(9)?,
        due_at: r.get(10)?,
        stability: r.get(11)?,
        difficulty: r.get(12)?,
        elapsed_days: r.get(13)?,
        scheduled_days: r.get(14)?,
        reps: r.get(15)?,
        lapses: r.get(16)?,
        last_review_at: r.get(17)?,
        suspended: r.get::<_, i64>(18)? != 0,
        leech: r.get::<_, i64>(19)? != 0,
    })
}

fn get_card(conn: &Connection, card_id: &str) -> Result<CardRow, rusqlite::Error> {
    let sql = format!("SELECT {CARD_COLS} FROM cards WHERE id = ?1");
    conn.query_row(&sql, [card_id], row_to_card)
}

fn to_fsrs_card(row: &CardRow) -> FsrsCard {
    FsrsCard {
        due: ts(row.due_at),
        stability: row.stability,
        difficulty: row.difficulty,
        elapsed_days: row.elapsed_days,
        scheduled_days: row.scheduled_days,
        reps: row.reps as i32,
        lapses: row.lapses as i32,
        state: state_from(row.state),
        last_review: ts(row.last_review_at.unwrap_or(row.due_at)),
    }
}

fn preview_for(row: &CardRow, now: i64) -> IntervalPreview {
    let log = fsrs().repeat(to_fsrs_card(row), ts(now));
    let days = |r: Rating| log.get(&r).map(|i| i.card.scheduled_days).unwrap_or(0);
    IntervalPreview {
        again: days(Rating::Again),
        hard: days(Rating::Hard),
        good: days(Rating::Good),
        easy: days(Rating::Easy),
    }
}

/// Apply one grade: FSRS transition, persist, append review_log, leech check.
pub fn schedule_card(
    conn: &Connection,
    card_id: &str,
    rating: u8,
    source: &str,
    now: i64,
) -> Result<GradeOutcome, rusqlite::Error> {
    let row = get_card(conn, card_id)?;
    let info = fsrs().next(to_fsrs_card(&row), ts(now), rating_from(rating));
    let c = &info.card;
    let due_after = c.due.timestamp();
    let was_leech = row.leech;
    let lapses = c.lapses as i64;
    let becomes_leech = !was_leech && lapses >= LEECH_LAPSES;
    conn.execute(
        "UPDATE cards SET state = ?2, due_at = ?3, stability = ?4, difficulty = ?5, \
         elapsed_days = ?6, scheduled_days = ?7, reps = ?8, lapses = ?9, last_review_at = ?10, \
         leech = ?11, suspended = CASE WHEN ?11 THEN 1 ELSE suspended END \
         WHERE id = ?1",
        rusqlite::params![
            card_id,
            c.state as i64,
            due_after,
            c.stability,
            c.difficulty,
            c.elapsed_days,
            c.scheduled_days,
            c.reps as i64,
            lapses,
            now,
            (was_leech || becomes_leech) as i64,
        ],
    )?;
    conn.execute(
        "INSERT INTO review_log (card_id, course_id, reviewed_at, rating, state_before, \
         stability_before, difficulty_before, stability_after, difficulty_after, \
         elapsed_days, scheduled_days, due_after, source) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![
            card_id,
            row.course_id,
            now,
            rating as i64,
            row.state,
            row.stability,
            row.difficulty,
            c.stability,
            c.difficulty,
            c.elapsed_days,
            c.scheduled_days,
            due_after,
            source,
        ],
    )?;
    let card = get_card(conn, card_id)?;
    Ok(GradeOutcome {
        card,
        became_leech: becomes_leech,
    })
}

/// How many NEW cards may still enter the queue today (local day via tz offset).
fn new_budget(conn: &Connection, now: i64, tz_offset_secs: i64) -> Result<i64, rusqlite::Error> {
    let day_start = ((now + tz_offset_secs) / DAY_SECS) * DAY_SECS - tz_offset_secs;
    let introduced: i64 = conn.query_row(
        "SELECT COUNT(*) FROM review_log WHERE state_before = 0 AND reviewed_at >= ?1",
        [day_start],
        |r| r.get(0),
    )?;
    Ok((NEW_PER_DAY - introduced).max(0))
}

/// The review queue: due review cards (soonest first), then NEW cards — but new
/// cards only from submodules whose test was passed, capped by the daily budget.
pub fn get_due_cards(
    conn: &Connection,
    course_id: Option<&str>,
    now: i64,
    tz_offset_secs: i64,
    limit: i64,
) -> Result<Vec<DueCard>, rusqlite::Error> {
    let mut out: Vec<DueCard> = Vec::new();
    let base = format!(
        "SELECT {cols}, COALESCE(co.title, co.topic), m.title \
         FROM cards c JOIN courses co ON co.id = c.course_id \
         JOIN modules m ON m.id = c.submodule_id \
         WHERE c.suspended = 0 AND c.reps > 0 AND c.due_at <= ?1",
        cols = CARD_COLS
            .split(", ")
            .map(|col| format!("c.{col}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let map_row = |r: &rusqlite::Row| -> rusqlite::Result<(CardRow, String, String)> {
        Ok((row_to_card(r)?, r.get(20)?, r.get(21)?))
    };
    let mut rows: Vec<(CardRow, String, String)> = match course_id {
        Some(cid) => {
            let sql = format!("{base} AND c.course_id = ?2 ORDER BY c.due_at ASC LIMIT ?3");
            let mut stmt = conn.prepare(&sql)?;
            let it = stmt.query_map(rusqlite::params![now, cid, limit], map_row)?;
            it.collect::<Result<_, _>>()?
        }
        None => {
            let sql = format!("{base} ORDER BY c.due_at ASC LIMIT ?2");
            let mut stmt = conn.prepare(&sql)?;
            let it = stmt.query_map(rusqlite::params![now, limit], map_row)?;
            it.collect::<Result<_, _>>()?
        }
    };

    let remaining = limit - rows.len() as i64;
    let budget = new_budget(conn, now, tz_offset_secs)?.min(remaining.max(0));
    if budget > 0 {
        let new_base = format!(
            "SELECT {cols}, COALESCE(co.title, co.topic), m.title \
             FROM cards c JOIN courses co ON co.id = c.course_id \
             JOIN modules m ON m.id = c.submodule_id \
             JOIN progress p ON p.module_id = c.submodule_id \
             WHERE c.suspended = 0 AND c.reps = 0 AND p.test_passed_at IS NOT NULL",
            cols = CARD_COLS
                .split(", ")
                .map(|col| format!("c.{col}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let new_rows: Vec<(CardRow, String, String)> = match course_id {
            Some(cid) => {
                let sql = format!(
                    "{new_base} AND c.course_id = ?1 ORDER BY c.created_at ASC, c.position ASC LIMIT ?2"
                );
                let mut stmt = conn.prepare(&sql)?;
                let it = stmt.query_map(rusqlite::params![cid, budget], map_row)?;
                it.collect::<Result<_, _>>()?
            }
            None => {
                let sql =
                    format!("{new_base} ORDER BY c.created_at ASC, c.position ASC LIMIT ?1");
                let mut stmt = conn.prepare(&sql)?;
                let it = stmt.query_map(rusqlite::params![budget], map_row)?;
                it.collect::<Result<_, _>>()?
            }
        };
        rows.extend(new_rows);
    }

    for (card, course_title, submodule_title) in rows {
        let preview = preview_for(&card, now);
        out.push(DueCard {
            card,
            course_title,
            submodule_title,
            preview,
        });
    }
    Ok(out)
}

/// Due counts per course for the nav badge: review cards due now, plus new
/// cards available today (gated by passed tests and the daily budget).
pub fn due_card_counts(
    conn: &Connection,
    now: i64,
    tz_offset_secs: i64,
) -> Result<HashMap<String, i64>, rusqlite::Error> {
    let mut counts: HashMap<String, i64> = conn
        .prepare(
            "SELECT course_id, COUNT(*) FROM cards \
             WHERE suspended = 0 AND reps > 0 AND due_at <= ?1 GROUP BY course_id",
        )?
        .query_map([now], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<Result<_, _>>()?;
    let budget = new_budget(conn, now, tz_offset_secs)?;
    if budget > 0 {
        let new_counts: Vec<(String, i64)> = conn
            .prepare(
                "SELECT c.course_id, COUNT(*) FROM cards c \
                 JOIN progress p ON p.module_id = c.submodule_id \
                 WHERE c.suspended = 0 AND c.reps = 0 AND p.test_passed_at IS NOT NULL \
                 GROUP BY c.course_id",
            )?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
            .collect::<Result<_, _>>()?;
        for (cid, n) in new_counts {
            *counts.entry(cid).or_insert(0) += n.min(budget);
        }
    }
    Ok(counts)
}

/// All cards of one submodule (in-lesson recall widgets), deck order.
pub fn cards_for_submodule(
    conn: &Connection,
    submodule_id: &str,
) -> Result<Vec<CardRow>, rusqlite::Error> {
    let sql = format!(
        "SELECT {CARD_COLS} FROM cards WHERE submodule_id = ?1 ORDER BY position ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([submodule_id], row_to_card)?;
    rows.collect()
}

/// Card metadata needed by the leech-rewrite flow (article lookup, prompts).
pub fn card_meta(conn: &Connection, card_id: &str) -> Result<CardRow, rusqlite::Error> {
    get_card(conn, card_id)
}

/// Replace a (leech) card with 1-3 rewritten cards: the old card is suspended
/// (history kept), the new ones start fresh at the end of the deck.
pub fn replace_card(
    conn: &Connection,
    card_id: &str,
    new_cards: &[serde_json::Value],
    now: i64,
) -> Result<Vec<CardRow>, rusqlite::Error> {
    let old = get_card(conn, card_id)?;
    conn.execute("UPDATE cards SET suspended = 1 WHERE id = ?1", [card_id])?;
    let max_pos: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position), 0) FROM cards WHERE submodule_id = ?1",
        [&old.submodule_id],
        |r| r.get(0),
    )?;
    let mut out = Vec::new();
    for (i, v) in new_cards.iter().take(3).enumerate() {
        let Some((front, back, concept, _)) = card_fields(v) else {
            continue;
        };
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO cards (id, course_id, module_id, submodule_id, kind, position, \
             front, back, concept, anchor, content_hash, created_at, due_at) \
             VALUES (?1, ?2, ?3, ?4, 'flashcard', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params![
                id,
                old.course_id,
                old.module_id,
                old.submodule_id,
                max_pos + 1 + i as i64,
                front,
                back,
                concept,
                old.anchor,
                content_hash(&front, &back),
                now,
                now,
            ],
        )?;
        out.push(get_card(conn, &id)?);
    }
    Ok(out)
}

pub fn set_card_suspended(
    conn: &Connection,
    card_id: &str,
    suspended: bool,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE cards SET suspended = ?2 WHERE id = ?1",
        rusqlite::params![card_id, suspended as i64],
    )?;
    Ok(())
}

fn card_fields(v: &serde_json::Value) -> Option<(String, String, Option<String>, Option<String>)> {
    let front = v.get("front")?.as_str()?.trim().to_string();
    let back = v.get("back")?.as_str()?.trim().to_string();
    if front.is_empty() || back.is_empty() {
        return None;
    }
    let opt = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    Some((front, back, opt("concept"), opt("section")))
}

/// Reconcile the cards table with a (re)generated flashcards.json deck.
/// Content-hash matching preserves FSRS state across regeneration; removed
/// cards keep their history (suspended) once reviewed, otherwise are deleted.
pub fn sync_cards_for_submodule(
    conn: &Connection,
    course_id: &str,
    module_id: &str,
    submodule_id: &str,
    flashcards: &serde_json::Value,
    now: i64,
) -> Result<usize, rusqlite::Error> {
    let deck: Vec<(String, String, Option<String>, Option<String>)> = flashcards
        .as_array()
        .map(|a| a.iter().filter_map(card_fields).collect())
        .unwrap_or_default();

    let existing: HashMap<String, (String, i64)> = conn
        .prepare("SELECT content_hash, id, reps FROM cards WHERE submodule_id = ?1")?
        .query_map([submodule_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                (r.get::<_, String>(1)?, r.get::<_, i64>(2)?),
            ))
        })?
        .collect::<Result<_, _>>()?;

    let mut kept: Vec<String> = Vec::new();
    let mut created = 0usize;
    for (pos, (front, back, concept, anchor)) in deck.iter().enumerate() {
        let hash = content_hash(front, back);
        if let Some((id, _)) = existing.get(&hash) {
            kept.push(hash.clone());
            conn.execute(
                "UPDATE cards SET position = ?2, concept = ?3, anchor = ?4, suspended = 0 \
                 WHERE id = ?1",
                rusqlite::params![id, pos as i64, concept, anchor],
            )?;
        } else {
            conn.execute(
                "INSERT INTO cards (id, course_id, module_id, submodule_id, kind, position, \
                 front, back, concept, anchor, content_hash, created_at, due_at) \
                 VALUES (?1, ?2, ?3, ?4, 'flashcard', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    course_id,
                    module_id,
                    submodule_id,
                    pos as i64,
                    front,
                    back,
                    concept,
                    anchor,
                    hash,
                    now,
                    now,
                ],
            )?;
            kept.push(hash);
            created += 1;
        }
    }
    for (hash, (id, reps)) in existing {
        if kept.contains(&hash) {
            continue;
        }
        if reps > 0 {
            conn.execute("UPDATE cards SET suspended = 1 WHERE id = ?1", [&id])?;
        } else {
            conn.execute("DELETE FROM cards WHERE id = ?1", [&id])?;
        }
    }
    Ok(created)
}

/// Seed schedules for a submodule's untouched cards from the honest first-test
/// ratio (one graded review each; fuzz desynchronizes the due dates).
pub fn seed_from_test_ratio(
    conn: &Connection,
    submodule_id: &str,
    ratio: f64,
    now: i64,
) -> Result<(), rusqlite::Error> {
    let rating = if ratio >= 0.95 {
        4
    } else if ratio >= 0.8 {
        3
    } else if ratio >= 0.6 {
        2
    } else {
        1
    };
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM cards WHERE submodule_id = ?1 AND reps = 0 AND suspended = 0")?
        .query_map([submodule_id], |r| r.get::<_, String>(0))?
        .collect::<Result<_, _>>()?;
    for id in ids {
        schedule_card(conn, &id, rating, "test_seed", now)?;
    }
    Ok(())
}

/// One-time startup backfill: create cards from every ready submodule's
/// flashcards.json, seeding FSRS state from legacy SM-2 rows where present.
/// Idempotent (content-hash skip + app_meta flag).
pub fn backfill_cards<F>(conn: &Connection, read_flashcards: F, now: i64) -> Result<usize, rusqlite::Error>
where
    F: Fn(&str, &str, &str) -> serde_json::Value,
{
    let done: Option<String> = conn
        .query_row(
            "SELECT value FROM app_meta WHERE key = 'cards_backfill_v1'",
            [],
            |r| r.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    if done.is_some() {
        return Ok(0);
    }

    let subs: Vec<(String, String, String)> = conn
        .prepare(
            "SELECT course_id, parent_id, id FROM modules \
             WHERE parent_id IS NOT NULL AND generation_state = 'ready'",
        )?
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<_, _>>()?;

    let mut created = 0usize;
    for (course_id, module_id, submodule_id) in subs {
        let deck = read_flashcards(&course_id, &module_id, &submodule_id);
        if !deck.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            continue;
        }
        created += sync_cards_for_submodule(conn, &course_id, &module_id, &submodule_id, &deck, now)?;
        // Legacy SM-2 state -> FSRS seed (heuristic; FSRS self-corrects in a
        // few reviews): stability ≈ interval, difficulty from ease linearly.
        if let Some(rv) = crate::db::get_review(conn, &submodule_id)? {
            if rv.reps > 0 {
                conn.execute(
                    "UPDATE cards SET state = 2, due_at = ?2, stability = ?3, difficulty = ?4, \
                     reps = ?5, lapses = ?6, last_review_at = ?7, scheduled_days = ?8 \
                     WHERE submodule_id = ?1 AND reps = 0",
                    rusqlite::params![
                        submodule_id,
                        rv.due_at,
                        rv.interval_days.max(0.1),
                        (11.0 - 3.0 * rv.ease).clamp(1.0, 10.0),
                        rv.reps,
                        rv.lapses,
                        rv.last_reviewed_at,
                        rv.interval_days.round().max(1.0) as i64,
                    ],
                )?;
            }
        }
    }
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES ('cards_backfill_v1', ?1) \
         ON CONFLICT(key) DO UPDATE SET value = ?1",
        [now.to_string()],
    )?;
    Ok(created)
}
