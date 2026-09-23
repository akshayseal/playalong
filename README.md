# QuizPlay

A real-time play-along quiz platform, in the spirit of the NISM quiz game you
linked: players log in, join a session with a code, answer timed multiple-choice
questions (text or picture-based), and see an instant leaderboard ranked by
accuracy and speed. A quizmaster dashboard uploads questions (one at a time or
in bulk via CSV), watches players join, and drives the live session.

Built to comfortably handle **~1000 concurrent players** in one session — see
"Scaling to 1000+ players" below for exactly what that requires.

## Stack

- **Backend:** Node.js + Express + Socket.IO
- **Database:** PostgreSQL — the durable record of every player, quiz, question and answer
- **Redis:** live leaderboard (sorted-set based) + Socket.IO's Redis adapter, so you can run more than one Node process
- **Frontend:** plain HTML/CSS/JS (no build step) — one app for players, one for quizmasters, sharing your Xpress Minds/Whizzland purple-and-amber look

## Project layout

```
server/
  index.js            Express + Socket.IO bootstrap
  db.js               Postgres pool
  redis.js            Redis client + leaderboard helpers (in-memory fallback for solo dev)
  schema.sql           Table definitions
  migrate.js          Applies schema.sql
  routes/
    auth.js            Player + quizmaster register/login
    quizmaster.js       Quizzes, questions (single + CSV), sessions, participants, leaderboard
    player.js           Join-by-code
  sockets/
    quizSocket.js       The live game loop: start, next question, submit answer, reveal, end
  utils/
    csvQuestions.js     CSV parsing/validation
    scoring.js          Accuracy + speed scoring
    auth.js             JWT sign/verify
public/
  player/               Player web app
  quizmaster/           Quizmaster dashboard
docker-compose.yml      Postgres + Redis for local dev
sample-questions.csv    Example CSV in the expected format
loadtest/socket-load.yml  Artillery script to load-test toward 1000 connections
```

## Running it locally

```bash
# 1. Install dependencies
npm install

# 2. Start Postgres + Redis
docker compose up -d

# 3. Configure environment
cp .env.example .env
# edit .env: docker-compose defaults for DATABASE_URL/REDIS_URL already match,
# but add your Cloudinary credentials (see "Persistent image storage" below)
# if you want picture questions to work locally too

# 4. Create the schema
npm run migrate

# 5. Start the server
npm run dev        # or: npm start
```

Then open:
- `http://localhost:4000/quizmaster/` to log in as a quizmaster, create a quiz, add questions, and start a session
- `http://localhost:4000/player/` (in another browser/tab/device) to join with the code shown on the dashboard

## Persistent image storage (Cloudinary)

Question images uploaded through the dashboard's single-question form go
straight to Cloudinary, not to local disk. This matters because Railway (and
most PaaS hosts) wipe the filesystem on every redeploy — local disk storage
would silently lose every picture-round image the next time you ship a code
change, which is a bad thing to discover the morning of an event.

1. Create a free account at [cloudinary.com](https://cloudinary.com/users/register/free) (the free tier's storage and bandwidth comfortably covers a quiz image bank).
2. Your **Cloud name**, **API key**, and **API secret** are right on the dashboard after signup.
3. Put those three values in `.env` (locally) or your host's environment variables (in production) as `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.

Without these set, text-only quizzes work fine, but uploading a question
image will fail with a clear error rather than silently misbehaving.

## Uploading questions

**Single question**, with an optional picture, via the "Add a single question"
form on the quiz page (drag in an image for a picture round — it's uploaded to
Cloudinary and the image URL is stored automatically).

**Bulk via CSV** — see `sample-questions.csv`. Columns:

| column | required | notes |
|---|---|---|
| `question` | yes | question text |
| `option_a` .. `option_d` | yes | the four choices |
| `correct_option` | yes | `A`, `B`, `C`, or `D` |
| `image_url` | no | a hosted image URL for picture questions — leave blank for text-only |
| `time_limit_seconds` | no | defaults to 20 |
| `points_base` | no | defaults to 1000 |

The CSV path takes a URL, not a file upload — for bulk picture questions,
upload the images to Cloudinary yourself first (drag-and-drop at
[cloudinary.com/console/media_library](https://cloudinary.com/console/media_library))
and paste each one's URL into `image_url`, or add pictures one at a time
through the single-question form instead.


## Scoring

Each correct answer scores between 50% and 100% of the question's
`points_base`, sliding linearly with how much of the time limit was used —
answer instantly for full marks, answer right at the buzzer for half marks.
Wrong or missed answers score 0. The leaderboard ranks by total points first,
total time second (so ties go to whoever was faster overall) — the same shape
of ranking as the NISM app. Tune the curve in `server/utils/scoring.js` if you
want a steeper/gentler time bonus.

## How the live loop works

1. Quizmaster creates a **quiz** (a reusable set of questions) and, when ready
   to run it, a **session** (a fresh join code + live state — you can run the
   same quiz multiple times with different sessions).
2. Players log in once and **join a session by code** (`POST /api/player/sessions/join`),
   which is recorded in Postgres — this is what makes a refresh/reconnect safe;
   a player's seat isn't lost if their phone drops signal.
3. Everyone connects a Socket.IO socket and joins that session's room.
4. Quizmaster clicks **Start**, then **Next question** to push each question
   to every connected player at once.
5. Players answer; each answer is written to Postgres (one row per player per
   question, so no double-scoring) and bumped into a Redis sorted set that
   backs the leaderboard.
6. Every 2 seconds while a question is live, the server broadcasts the current
   top-50 leaderboard to everyone in the room — batched, not per-answer, so
   1000 simultaneous answers don't turn into 1000 leaderboard broadcasts.
7. Quizmaster reveals the answer, then moves on; when questions run out the
   session ends and the final leaderboard is broadcast.

## Scaling to 1000+ concurrent players

This is designed to run as a single Node instance up to a few hundred
concurrent sockets on modest hardware, and to scale horizontally past that.
What to actually do as you approach 1000:

1. **Turn on Redis** (`REDIS_URL` in `.env`). Two things depend on it:
   - The live leaderboard is a Redis sorted set, not an in-memory object, so
     it stays correct across multiple Node processes.
   - Socket.IO's Redis adapter (`@socket.io/redis-adapter`, already wired in
     `server/index.js`) lets `io.to(room).emit(...)` reach sockets connected
     to *any* instance, not just the one that received the event.
2. **Run more than one Node instance** behind a load balancer, once Redis is
   on. On Railway/Render/Fly this is usually a "scale to N instances" toggle.
   You don't need sticky sessions for correctness (the Redis adapter handles
   cross-instance broadcast), but sticky sessions reduce reconnect overhead.
3. **Size the Postgres pool deliberately.** `PG_POOL_MAX` × number of instances
   must stay under your Postgres server's `max_connections`. For ~1000
   concurrent players answering a handful of questions each, 15-20 connections
   per instance is plenty — the write pattern is small, short inserts, not
   long-running queries.
4. **Question images are already CDN-backed.** They're served from
   Cloudinary, not from your Node process, so this one's handled — the
   thing to actually watch under load is Postgres and Redis, not image
   bandwidth.
5. **Load-test before the real event.** `loadtest/socket-load.yml` is an
   Artillery script that ramps toward ~1000 concurrent Socket.IO connections
   joining a session and submitting answers — run it against a staging session
   a day or two ahead of a live event, not for the first time on game day.
6. **Watch your quizmaster's own connection.** The quizmaster's "next
   question" click is a single event that fans out to everyone — make sure
   *their* wifi is solid; if you want extra safety, add a short retry/backoff
   on the dashboard's socket connection (not included here, since one flaky
   admin connection is a much smaller failure mode than 1000 player
   connections).

None of this needs Kubernetes or anything exotic — 2-3 small instances plus a
single small Redis and Postgres (Railway's standard tiers, which you're
already using for Whizzland, are enough) comfortably covers 1000 concurrent
players for a live quiz event.

## Deploying

Same shape as your existing Railway setup: push this repo, add a Postgres
plugin and a Redis plugin, set the environment variables from `.env.example`
(pointing `DATABASE_URL`/`REDIS_URL` at Railway's managed instances, plus your
`JWT_SECRET` and the three `CLOUDINARY_*` values), run `npm run migrate` once
via a Railway shell or a one-off deploy, then `npm start`. Scale replicas from
Railway's settings once you've load-tested past what one instance handles
comfortably.

## Extending it

- **Teams instead of individuals:** add a `team_id` on `participants` and
  aggregate the leaderboard by team — the Redis sorted-set approach extends
  cleanly to team totals.
- **Question banks / reuse across events:** quizzes already are independent
  of sessions, so cloning a quiz for a new event is a straightforward
  `INSERT ... SELECT`.
- **Export results:** the `responses` table has everything needed for a
  post-event report (per-question accuracy, average response time, etc.) —
  useful for the same kind of scorecard/report-card generation you built for
  Whizzland.
