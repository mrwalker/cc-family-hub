/**
 * The household database's schema (D1, bound as HUB_DB), and the code that keeps
 * it current.
 *
 * The Worker applies its own migrations: the first time it uses the database in
 * an isolate, it runs any that are newer than what `schema_migrations` records,
 * each in one transaction. A family creates the database once and never runs a
 * migration by hand.
 *
 * To change the schema, append a migration. Never edit one that has shipped.
 */

export const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS pets (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         species TEXT,
         birthday TEXT,
         notes TEXT,
         archived INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         updated_by TEXT
       )`,
      // A task is anything due on a date. It may repeat, and task_log keeps its history.
      //   repeat_from 'done': the next date counts from the day it was done (a filter)
      //   repeat_from 'due':  the next date counts from the day it was due (a monthly pill)
      `CREATE TABLE IF NOT EXISTS tasks (
         id TEXT PRIMARY KEY,
         area TEXT NOT NULL,
         kind TEXT NOT NULL,
         title TEXT NOT NULL,
         pet_id TEXT REFERENCES pets(id),
         assignee TEXT,
         due_date TEXT,
         due_time TEXT,
         repeat_every INTEGER,
         repeat_unit TEXT,
         repeat_from TEXT NOT NULL DEFAULT 'done',
         lead_days INTEGER,
         provider TEXT,
         phone TEXT,
         url TEXT,
         notes TEXT,
         archived INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL,
         created_by TEXT,
         updated_at INTEGER NOT NULL,
         updated_by TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS tasks_due ON tasks (archived, due_date)`,
      // One row each time a task is done. due_before is the due date the task
      // had, so undoing the row puts it back.
      `CREATE TABLE IF NOT EXISTS task_log (
         id TEXT PRIMARY KEY,
         task_id TEXT NOT NULL REFERENCES tasks(id),
         done_on TEXT NOT NULL,
         done_by TEXT,
         note TEXT,
         due_before TEXT,
         created_at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS task_log_task ON task_log (task_id, created_at)`,
    ],
  },
  {
    // v2.3: places (a family can have more than one house), tasks done for
    // several pets together, booking an appointment, and stays with an end date.
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS places (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         address TEXT,
         notes TEXT,
         archived INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         updated_by TEXT
       )`,
      `ALTER TABLE tasks ADD COLUMN place_id TEXT REFERENCES places(id)`,
      // Tasks added together for several pets share a group, so they can be done,
      // booked and edited together, and each pet keeps its own dates and history.
      `ALTER TABLE tasks ADD COLUMN group_id TEXT`,
      // A booked appointment: its date and time (which may differ from when it's
      // due), and for a stay such as boarding, its last day.
      `ALTER TABLE tasks ADD COLUMN booked INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE tasks ADD COLUMN appt_date TEXT`,
      `ALTER TABLE tasks ADD COLUMN appt_time TEXT`,
      `ALTER TABLE tasks ADD COLUMN end_date TEXT`,
      `CREATE INDEX IF NOT EXISTS tasks_group ON tasks (group_id)`,
      // One action can mark several tasks done (a group); undo takes it all back.
      // before_json is what the task was, so undo restores every field done changed.
      `ALTER TABLE task_log ADD COLUMN action_id TEXT`,
      `ALTER TABLE task_log ADD COLUMN before_json TEXT`,
      `CREATE INDEX IF NOT EXISTS task_log_action ON task_log (action_id)`,
    ],
  },
  {
    // v2.4: appointments on a Google Calendar (household-calendar.js). For each event
    // the hub made: what it last wrote, so it can tell an edit made in Google Calendar.
    version: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS calendar_events (
         key TEXT PRIMARY KEY,
         calendar_id TEXT NOT NULL,
         event_id TEXT,
         fingerprint TEXT,
         start TEXT,
         "end" TEXT,
         updated_at INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS household_meta (k TEXT PRIMARY KEY, v TEXT)`,
    ],
  },
  {
    // v2.5: photos of the pets, for the pet-portraits cards. Each is a JPEG, PNG or
    // WebP the page has already shrunk, kept as base64 (at most 1 MB of image).
    version: 4,
    statements: [
      `CREATE TABLE IF NOT EXISTS pet_photos (
         id TEXT PRIMARY KEY,
         pet_id TEXT NOT NULL REFERENCES pets(id),
         mime TEXT NOT NULL,
         data TEXT NOT NULL,
         width INTEGER,
         height INTEGER,
         bytes INTEGER NOT NULL,
         created_at INTEGER NOT NULL,
         created_by TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS pet_photos_pet ON pet_photos (pet_id, created_at)`,
    ],
  },
  {
    // v2.6: chores. Jobs rotate weekly among the kids (the rotation is in household_meta
    // under chore_rotation); each chore belongs to jobs or to named people, and comes round
    // on its schedule. A tick is a chore_log row; a missed chore writes nothing.
    version: 5,
    statements: [
      `CREATE TABLE IF NOT EXISTS chore_jobs (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         emoji TEXT,
         position INTEGER NOT NULL DEFAULT 0,
         archived INTEGER NOT NULL DEFAULT 0,
         updated_at INTEGER NOT NULL,
         updated_by TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS chores (
         id TEXT PRIMARY KEY,
         title TEXT NOT NULL,
         job_ids TEXT,
         people TEXT,
         cadence TEXT NOT NULL,
         days TEXT,
         every_weeks INTEGER NOT NULL DEFAULT 1,
         anchor_week TEXT,
         time TEXT,
         time_kind TEXT,
         season_from TEXT,
         season_to TEXT,
         asked_for TEXT,
         notes TEXT,
         position INTEGER NOT NULL DEFAULT 0,
         archived INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL,
         created_by TEXT,
         updated_at INTEGER NOT NULL,
         updated_by TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS chore_log (
         id TEXT PRIMARY KEY,
         chore_id TEXT NOT NULL REFERENCES chores(id),
         period TEXT NOT NULL,
         done_for TEXT,
         done_by TEXT,
         action_id TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS chore_log_period ON chore_log (period)`,
      `CREATE INDEX IF NOT EXISTS chore_log_action ON chore_log (action_id)`,
      `CREATE TABLE IF NOT EXISTS chore_swaps (
         week TEXT NOT NULL,
         job_id TEXT NOT NULL,
         member TEXT NOT NULL,
         PRIMARY KEY (week, job_id)
       )`,
    ],
  },
  {
    // v2.7: escape rooms, kept by the hub instead of escape-rooms.yaml. image_url is a
    // picture found on the room's page (link-image.js), served through the hub.
    version: 6,
    statements: [
      `CREATE TABLE IF NOT EXISTS escape_rooms (
         id TEXT PRIMARY KEY,
         venue TEXT,
         room TEXT NOT NULL,
         city TEXT,
         date TEXT,
         approx_date INTEGER NOT NULL DEFAULT 0,
         url TEXT,
         image_url TEXT,
         image_checked_at INTEGER,
         who TEXT,
         solved INTEGER NOT NULL DEFAULT 0,
         escape_time TEXT,
         fail_note TEXT,
         difficulty INTEGER,
         rating INTEGER,
         notes TEXT,
         archived INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL,
         created_by TEXT,
         updated_at INTEGER NOT NULL,
         updated_by TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS escape_rooms_date ON escape_rooms (archived, date)`,
    ],
  },
  {
    // v2.8: movies and shows worth seeing, most picked monthly by the family's assistant,
    // and who wants to see (or has seen) each.
    version: 7,
    statements: [
      `CREATE TABLE IF NOT EXISTS movies (
         id TEXT PRIMARY KEY,
         title TEXT NOT NULL,
         kind TEXT NOT NULL DEFAULT 'movie',
         release_date TEXT,
         where_to TEXT,
         format TEXT,
         blurb TEXT,
         for_whom TEXT,
         url TEXT,
         image_url TEXT,
         image_checked_at INTEGER,
         source TEXT NOT NULL DEFAULT 'family',
         batch TEXT,
         archived INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         updated_by TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS movies_release ON movies (archived, release_date)`,
      `CREATE TABLE IF NOT EXISTS movie_marks (
         movie_id TEXT NOT NULL REFERENCES movies(id),
         member TEXT NOT NULL,
         mark TEXT NOT NULL,
         at INTEGER NOT NULL,
         by TEXT,
         PRIMARY KEY (movie_id, member)
       )`,
    ],
  },
  {
    // v2.9: trips, kept by the hub instead of trips.yaml. details holds the lists a trip
    // shows (highlights, things to do, restaurants, tips) as JSON. map_for is the
    // destination the map was found for, so a changed destination is looked up again.
    version: 8,
    statements: [
      `CREATE TABLE IF NOT EXISTS trips (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         destination TEXT,
         emoji TEXT,
         start_date TEXT NOT NULL,
         end_date TEXT NOT NULL,
         kind TEXT NOT NULL DEFAULT 'family',
         who TEXT,
         album TEXT,
         description TEXT,
         map_bbox TEXT,
         map_for TEXT,
         details TEXT,
         archived INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL,
         created_by TEXT,
         updated_at INTEGER NOT NULL,
         updated_by TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS trips_start ON trips (archived, start_date)`,
    ],
  },
  {
    // v2.9.2: an escape room played on a trip names the trip.
    version: 9,
    statements: [
      `ALTER TABLE escape_rooms ADD COLUMN trip_id TEXT`,
    ],
  },
  {
    // v2.11: photos of the places (the houses), for the house-portraits cards. Kept
    // as pet_photos keeps the pets'.
    version: 10,
    statements: [
      `CREATE TABLE IF NOT EXISTS place_photos (
         id TEXT PRIMARY KEY,
         place_id TEXT NOT NULL REFERENCES places(id),
         mime TEXT NOT NULL,
         data TEXT NOT NULL,
         width INTEGER,
         height INTEGER,
         bytes INTEGER NOT NULL,
         created_at INTEGER NOT NULL,
         created_by TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS place_photos_place ON place_photos (place_id, created_at)`,
    ],
  },
  {
    // v2.12: what the family's assistant changed through /api/agent (agent.js): who
    // asked, in which channel, and what undoes it. agent_proposals holds changes that
    // wait for an adult's yes.
    version: 11,
    statements: [
      `CREATE TABLE IF NOT EXISTS agent_log (
         id TEXT PRIMARY KEY,
         created_at INTEGER NOT NULL,
         scope TEXT NOT NULL,
         channel TEXT,
         op TEXT NOT NULL,
         target TEXT,
         summary TEXT NOT NULL,
         args_json TEXT,
         undo_json TEXT,
         actor TEXT,
         actor_role TEXT,
         actor_label TEXT,
         source TEXT,
         proposal_id TEXT,
         approved_by TEXT,
         undone_at INTEGER,
         undone_by TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS agent_log_created ON agent_log (created_at)`,
      `CREATE TABLE IF NOT EXISTS agent_proposals (
         id TEXT PRIMARY KEY,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL,
         scope TEXT NOT NULL,
         channel TEXT,
         op TEXT NOT NULL,
         args_json TEXT,
         summary TEXT NOT NULL,
         tier TEXT NOT NULL,
         requested_by TEXT,
         requested_label TEXT,
         source TEXT,
         status TEXT NOT NULL DEFAULT 'pending',
         decided_at INTEGER,
         decided_by TEXT,
         decided_via TEXT,
         log_id TEXT,
         error TEXT,
         announced_at INTEGER
       )`,
      `CREATE INDEX IF NOT EXISTS agent_proposals_status ON agent_proposals (status, created_at)`,
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

const ready = new WeakMap();   // database → the promise of its schema being current

/** Resolves once `db` has every migration. Cheap after the first call in an isolate. */
export function ensureSchema(db) {
  let p = ready.get(db);
  if (!p) {
    p = migrate(db).catch(err => { ready.delete(db); throw err; });
    ready.set(db, p);
  }
  return p;
}

async function currentVersion(db) {
  try {
    const row = await db.prepare("SELECT MAX(version) AS v FROM schema_migrations").first();
    return row?.v ?? 0;
  } catch {
    // A new database has no schema_migrations table yet.
    await db.prepare("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)").run();
    return 0;
  }
}

async function migrate(db) {
  let have = await currentVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= have) continue;
    try {
      await db.batch([
        ...m.statements.map(s => db.prepare(s)),
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").bind(m.version, Date.now()),
      ]);
    } catch (err) {
      // Two isolates can start the same migration at once. The loser's batch
      // rolls back; if the winner's is recorded, there's nothing left to do.
      have = await currentVersion(db);
      if (have < m.version) throw new Error(`Household database migration ${m.version} failed: ${err.message}`);
    }
  }
}
