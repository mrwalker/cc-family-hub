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
