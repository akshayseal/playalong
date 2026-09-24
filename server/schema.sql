-- QuizPlay schema
-- Run with: psql "$DATABASE_URL" -f server/schema.sql   (or `npm run migrate`)

CREATE TABLE IF NOT EXISTS quizmasters (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS players (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  organisation  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS quizzes (
  id             SERIAL PRIMARY KEY,
  quizmaster_id  INTEGER NOT NULL REFERENCES quizmasters(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  logo_url       TEXT,
  primary_color  TEXT,
  secondary_color TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Safe to re-run against a database that already has the quizzes table from
-- before white-labelling was added — these are no-ops if the columns exist.
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS primary_color TEXT;
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS secondary_color TEXT;

CREATE TABLE IF NOT EXISTS questions (
  id                  SERIAL PRIMARY KEY,
  quiz_id             INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  seq                 INTEGER NOT NULL,
  question_text       TEXT NOT NULL,
  image_url           TEXT,
  option_a            TEXT NOT NULL,
  option_b            TEXT NOT NULL,
  option_c            TEXT NOT NULL,
  option_d            TEXT NOT NULL,
  correct_option      CHAR(1) NOT NULL CHECK (correct_option IN ('A','B','C','D')),
  time_limit_seconds  INTEGER NOT NULL DEFAULT 20,
  points_base         INTEGER NOT NULL DEFAULT 1000,
  UNIQUE (quiz_id, seq)
);

CREATE TABLE IF NOT EXISTS sessions (
  id                     SERIAL PRIMARY KEY,
  quiz_id                INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  join_code              TEXT UNIQUE NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'lobby'
                         CHECK (status IN ('lobby','live','question_active','question_closed','finished')),
  current_question_seq  INTEGER NOT NULL DEFAULT 0,
  question_started_at   TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at               TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS participants (
  id           SERIAL PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, player_id)
);

CREATE TABLE IF NOT EXISTS responses (
  id                 SERIAL PRIMARY KEY,
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id          INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  question_id        INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  selected_option    CHAR(1) CHECK (selected_option IN ('A','B','C','D')),
  is_correct         BOOLEAN NOT NULL,
  response_time_ms   INTEGER NOT NULL,
  points_awarded     INTEGER NOT NULL,
  answered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, player_id, question_id)
);

-- Hot-path indexes
CREATE INDEX IF NOT EXISTS idx_questions_quiz     ON questions (quiz_id, seq);
CREATE INDEX IF NOT EXISTS idx_participants_sess  ON participants (session_id);
CREATE INDEX IF NOT EXISTS idx_responses_sess     ON responses (session_id);
CREATE INDEX IF NOT EXISTS idx_responses_player   ON responses (session_id, player_id);
CREATE INDEX IF NOT EXISTS idx_sessions_joincode  ON sessions (join_code);
