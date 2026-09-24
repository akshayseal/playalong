const { verify } = require('../utils/auth');
const db = require('../db');
const { computeScore } = require('../utils/scoring');
const { bumpLeaderboard, getTopLeaderboard, clearLeaderboard } = require('../redis');

// In-memory registry of active questions, PER PROCESS. Under horizontal
// scaling this is fine because only one instance ever runs `start`/`next`
// for a given session at a time (the quizmaster's socket), and everything
// that must be seen by *all* instances (leaderboard, room broadcasts) goes
// through Redis / the Socket.IO Redis adapter instead of this map.
const activeQuestions = new Map(); // sessionId -> { question, startedAt }
const leaderboardTimers = new Map(); // sessionId -> interval handle

function playerRoom(sessionId) { return `session:${sessionId}`; }
function masterRoom(sessionId) { return `session:${sessionId}:qm`; }

function publicQuestion(q) {
  return {
    id: q.id,
    seq: q.seq,
    question_text: q.question_text,
    image_url: q.image_url,
    option_a: q.option_a,
    option_b: q.option_b,
    option_c: q.option_c,
    option_d: q.option_d,
    time_limit_seconds: q.time_limit_seconds,
  };
}

async function ownsSession(quizmasterId, sessionId) {
  const r = await db.query(
    `SELECT s.id FROM sessions s JOIN quizzes z ON z.id = s.quiz_id
     WHERE s.id = $1 AND z.quizmaster_id = $2`,
    [sessionId, quizmasterId]
  );
  return r.rows.length > 0;
}

async function isParticipant(playerId, sessionId) {
  const r = await db.query('SELECT id FROM participants WHERE session_id = $1 AND player_id = $2', [sessionId, playerId]);
  return r.rows.length > 0;
}

async function withNames(rows) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.playerId);
  const names = await db.query('SELECT id, name, organisation FROM players WHERE id = ANY($1)', [ids]);
  const map = Object.fromEntries(names.rows.map((n) => [n.id, n]));
  return rows.map((r) => ({ ...r, name: map[r.playerId]?.name, organisation: map[r.playerId]?.organisation }));
}

function startLeaderboardTicker(io, sessionId) {
  stopLeaderboardTicker(sessionId);
  const timer = setInterval(async () => {
    const rows = await getTopLeaderboard(sessionId, 50);
    const withN = await withNames(rows);
    io.to(playerRoom(sessionId)).to(masterRoom(sessionId)).emit('leaderboard_update', withN);
  }, 2000); // batch broadcasts — don't push a leaderboard update per answer at 1000 concurrent players
  leaderboardTimers.set(sessionId, timer);
}

function stopLeaderboardTicker(sessionId) {
  const t = leaderboardTimers.get(sessionId);
  if (t) clearInterval(t);
  leaderboardTimers.delete(sessionId);
}

function registerQuizSocket(io) {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('auth required'));
      socket.user = verify(token); // { role, id }
      next();
    } catch (e) {
      next(new Error('invalid token'));
    }
  });

  io.on('connection', (socket) => {
    // ---- Player joins the live room for a session ----
    socket.on('join_session', async ({ sessionId }, ack) => {
      try {
        if (socket.user.role !== 'player') return ack?.({ error: 'players only' });
        if (!(await isParticipant(socket.user.id, sessionId))) {
          return ack?.({ error: 'Join this quiz with its code first (POST /api/player/sessions/join)' });
        }
        socket.data.sessionId = sessionId;
        socket.join(playerRoom(sessionId));

        const player = await db.query('SELECT id, name, organisation FROM players WHERE id = $1', [socket.user.id]);
        io.to(masterRoom(sessionId)).emit('participant_joined', player.rows[0]);

        const active = activeQuestions.get(String(sessionId));
        ack?.({
          ok: true,
          activeQuestion: active ? publicQuestion(active.question) : null,
        });
      } catch (e) {
        console.error(e);
        ack?.({ error: 'Failed to join session' });
      }
    });

    // ---- Quizmaster joins the control room for a session ----
    socket.on('join_as_quizmaster', async ({ sessionId }, ack) => {
      try {
        if (socket.user.role !== 'quizmaster') return ack?.({ error: 'quizmasters only' });
        if (!(await ownsSession(socket.user.id, sessionId))) return ack?.({ error: 'Not your session' });
        socket.data.sessionId = sessionId;
        socket.data.isQuizmaster = true;
        socket.join(masterRoom(sessionId));
        ack?.({ ok: true });
      } catch (e) {
        console.error(e);
        ack?.({ error: 'Failed to join as quizmaster' });
      }
    });

    // ---- Quizmaster: start the session (opens the lobby -> live) ----
    socket.on('start_session', async ({ sessionId }, ack) => {
      if (!socket.data.isQuizmaster || !(await ownsSession(socket.user.id, sessionId))) {
        return ack?.({ error: 'Not authorized' });
      }
      await db.query(`UPDATE sessions SET status = 'live' WHERE id = $1`, [sessionId]);
      io.to(playerRoom(sessionId)).to(masterRoom(sessionId)).emit('session_started');
      ack?.({ ok: true });
    });

    // ---- Quizmaster: push the next question ----
    socket.on('next_question', async ({ sessionId }, ack) => {
      if (!socket.data.isQuizmaster || !(await ownsSession(socket.user.id, sessionId))) {
        return ack?.({ error: 'Not authorized' });
      }
      const sessionResult = await db.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
      const session = sessionResult.rows[0];
      const nextSeq = session.current_question_seq + 1;

      const qResult = await db.query('SELECT * FROM questions WHERE quiz_id = $1 AND seq = $2', [session.quiz_id, nextSeq]);
      const question = qResult.rows[0];
      if (!question) {
        await db.query(`UPDATE sessions SET status = 'finished', ended_at = now() WHERE id = $1`, [sessionId]);
        stopLeaderboardTicker(String(sessionId));
        const finalRows = await withNames(await getTopLeaderboard(sessionId, 1000));
        io.to(playerRoom(sessionId)).to(masterRoom(sessionId)).emit('quiz_finished', finalRows);
        return ack?.({ ok: true, finished: true });
      }

      await db.query(
        `UPDATE sessions SET status = 'question_active', current_question_seq = $1, question_started_at = now() WHERE id = $2`,
        [nextSeq, sessionId]
      );
      activeQuestions.set(String(sessionId), { question, startedAt: Date.now() });
      startLeaderboardTicker(io, sessionId);

      io.to(playerRoom(sessionId)).to(masterRoom(sessionId)).emit('question', publicQuestion(question));
      ack?.({ ok: true, question: publicQuestion(question) });
    });

    // ---- Player: submit an answer ----
    socket.on('submit_answer', async ({ sessionId, questionId, selectedOption }, ack) => {
      try {
        if (socket.user.role !== 'player') return ack?.({ error: 'players only' });
        const active = activeQuestions.get(String(sessionId));
        if (!active || active.question.id !== questionId) {
          return ack?.({ error: 'This question is no longer active' });
        }
        const responseTimeMs = Date.now() - active.startedAt;
        const isCorrect = String(selectedOption).toUpperCase() === active.question.correct_option;
        const points = computeScore({
          isCorrect,
          responseTimeMs,
          timeLimitSeconds: active.question.time_limit_seconds,
          pointsBase: active.question.points_base,
        });

        // Durable record (idempotent — a player can only answer once per question)
        const inserted = await db.query(
          `INSERT INTO responses (session_id, player_id, question_id, selected_option, is_correct, response_time_ms, points_awarded)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (session_id, player_id, question_id) DO NOTHING
           RETURNING id`,
          [sessionId, socket.user.id, questionId, String(selectedOption).toUpperCase(), isCorrect, responseTimeMs, points]
        );
        if (inserted.rows.length === 0) {
          return ack?.({ error: 'You already answered this question' });
        }

        // Fast path for the live leaderboard — Redis, not Postgres
        await bumpLeaderboard(sessionId, socket.user.id, points, responseTimeMs);

        ack?.({ ok: true, isCorrect, points });
      } catch (e) {
        console.error(e);
        ack?.({ error: 'Failed to submit answer' });
      }
    });

    // ---- Quizmaster: close/reveal the current question ----
    socket.on('reveal_answer', async ({ sessionId }, ack) => {
      if (!socket.data.isQuizmaster || !(await ownsSession(socket.user.id, sessionId))) {
        return ack?.({ error: 'Not authorized' });
      }
      const active = activeQuestions.get(String(sessionId));
      if (!active) return ack?.({ error: 'No active question' });

      await db.query(`UPDATE sessions SET status = 'question_closed' WHERE id = $1`, [sessionId]);
      io.to(playerRoom(sessionId)).to(masterRoom(sessionId)).emit('answer_revealed', {
        questionId: active.question.id,
        correctOption: active.question.correct_option,
      });
      ack?.({ ok: true });
    });

    // ---- Quizmaster: end the session early ----
    socket.on('end_session', async ({ sessionId }, ack) => {
      if (!socket.data.isQuizmaster || !(await ownsSession(socket.user.id, sessionId))) {
        return ack?.({ error: 'Not authorized' });
      }
      await db.query(`UPDATE sessions SET status = 'finished', ended_at = now() WHERE id = $1`, [sessionId]);
      stopLeaderboardTicker(String(sessionId));
      const finalRows = await withNames(await getTopLeaderboard(sessionId, 1000));
      io.to(playerRoom(sessionId)).to(masterRoom(sessionId)).emit('quiz_finished', finalRows);
      ack?.({ ok: true });
    });

    socket.on('disconnect', () => {
      // Rooms are cleaned up automatically by Socket.IO; nothing to do here.
      // (Participant presence lives in Postgres via the `participants` table,
      // not socket state, so a refresh/reconnect never loses a player's spot.)
    });
  });
}

module.exports = { registerQuizSocket };
