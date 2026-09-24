const express = require('express');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireQuizmaster } = require('../middleware/auth');
const { parseQuestionsCsv } = require('../utils/csvQuestions');
const { getTopLeaderboard, clearLeaderboard } = require('../redis');
const { CloudinaryStorage } = require('../cloudinaryStorage');

const router = express.Router();
router.use(requireQuizmaster);

// Question images go straight to Cloudinary (persistent, CDN-backed), not to
// local disk — Railway's filesystem is wiped on every redeploy, so disk
// storage would quietly lose every picture-round image the next time you ship
// a change. req.file.path below ends up being the public https URL.
const storage = new CloudinaryStorage({ folder: 'quizplay/questions' });
const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_IMAGE_SIZE_MB || '5', 10)) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('Only image uploads are allowed'));
    cb(null, true);
  },
});
const csvUpload = multer({ storage: multer.memoryStorage() });

// Quiz logos, kept in their own Cloudinary folder from question images so
// the two are easy to tell apart in the Cloudinary media library.
const logoStorage = new CloudinaryStorage({ folder: 'quizplay/logos' });
const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: (parseInt(process.env.MAX_IMAGE_SIZE_MB || '5', 10)) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('Only image uploads are allowed'));
    cb(null, true);
  },
});

function joinCode() {
  // 6-char, human-friendly (no 0/O/1/I confusion)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

// ---- Quizzes ----------------------------------------------------------------
// Every quiz can carry its own white-label theme — an optional logo plus a
// primary/secondary color pair, usually suggested client-side from the
// logo's own dominant color. Leaving these blank falls back to the app's
// default XM theme (see public/theme.js / public/shared.css).
router.post('/quizzes', uploadLogo.single('logo'), async (req, res) => {
  const { title, primary_color, secondary_color } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const logoUrl = req.file ? req.file.path : null;
  const result = await db.query(
    `INSERT INTO quizzes (quizmaster_id, title, logo_url, primary_color, secondary_color)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.auth.id, title, logoUrl, primary_color || null, secondary_color || null]
  );
  res.json(result.rows[0]);
});

router.put('/quizzes/:quizId/theme', uploadLogo.single('logo'), async (req, res) => {
  const { quizId } = req.params;
  if (!(await assertOwnsQuiz(req.auth.id, quizId))) return res.status(404).json({ error: 'Quiz not found' });

  const { primary_color, secondary_color } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (req.file) { fields.push(`logo_url = $${i++}`); values.push(req.file.path); }
  if (primary_color !== undefined) { fields.push(`primary_color = $${i++}`); values.push(primary_color || null); }
  if (secondary_color !== undefined) { fields.push(`secondary_color = $${i++}`); values.push(secondary_color || null); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

  values.push(quizId);
  const result = await db.query(`UPDATE quizzes SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, values);
  res.json(result.rows[0]);
});

router.get('/quizzes', async (req, res) => {
  const result = await db.query(
    `SELECT q.*, (SELECT count(*) FROM questions qq WHERE qq.quiz_id = q.id) AS question_count
     FROM quizzes q WHERE quizmaster_id = $1 ORDER BY created_at DESC`,
    [req.auth.id]
  );
  res.json(result.rows);
});

async function assertOwnsQuiz(quizmasterId, quizId) {
  const r = await db.query('SELECT id FROM quizzes WHERE id = $1 AND quizmaster_id = $2', [quizId, quizmasterId]);
  return r.rows.length > 0;
}

// ---- Questions: single upload (text + optional image) -----------------------
router.post('/quizzes/:quizId/questions', upload.single('image'), async (req, res) => {
  const { quizId } = req.params;
  if (!(await assertOwnsQuiz(req.auth.id, quizId))) return res.status(404).json({ error: 'Quiz not found' });

  const { question_text, option_a, option_b, option_c, option_d, correct_option, time_limit_seconds, points_base } = req.body;
  if (!question_text || !option_a || !option_b || !option_c || !option_d || !correct_option) {
    return res.status(400).json({ error: 'question_text, option_a..d and correct_option are required' });
  }
  if (!['A', 'B', 'C', 'D'].includes(correct_option.toUpperCase())) {
    return res.status(400).json({ error: 'correct_option must be A, B, C or D' });
  }

  const seqResult = await db.query('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM questions WHERE quiz_id = $1', [quizId]);
  const seq = seqResult.rows[0].next_seq;
  const imageUrl = req.file ? req.file.path : null;

  const result = await db.query(
    `INSERT INTO questions
      (quiz_id, seq, question_text, image_url, option_a, option_b, option_c, option_d, correct_option, time_limit_seconds, points_base)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [quizId, seq, question_text, imageUrl, option_a, option_b, option_c, option_d,
     correct_option.toUpperCase(), time_limit_seconds || 20, points_base || 1000]
  );
  res.json(result.rows[0]);
});

// ---- Questions: bulk CSV upload ---------------------------------------------
router.post('/quizzes/:quizId/questions/csv', csvUpload.single('file'), async (req, res) => {
  const { quizId } = req.params;
  if (!(await assertOwnsQuiz(req.auth.id, quizId))) return res.status(404).json({ error: 'Quiz not found' });
  if (!req.file) return res.status(400).json({ error: 'CSV file is required (field name: file)' });

  const { questions, errors } = parseQuestionsCsv(req.file.buffer);
  if (errors.length && questions.length === 0) {
    return res.status(400).json({ error: 'No valid rows found', details: errors });
  }

  const seqResult = await db.query('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM questions WHERE quiz_id = $1', [quizId]);
  let nextSeq = seqResult.rows[0].max_seq + 1;

  const client = await db.getClient();
  const inserted = [];
  try {
    await client.query('BEGIN');
    for (const q of questions) {
      const r = await client.query(
        `INSERT INTO questions
          (quiz_id, seq, question_text, image_url, option_a, option_b, option_c, option_d, correct_option, time_limit_seconds, points_base)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [quizId, nextSeq++, q.question_text, q.image_url, q.option_a, q.option_b, q.option_c, q.option_d,
         q.correct_option, q.time_limit_seconds, q.points_base]
      );
      inserted.push(r.rows[0]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    return res.status(500).json({ error: 'Failed to save questions' });
  } finally {
    client.release();
  }

  res.json({ inserted: inserted.length, questions: inserted, rowErrors: errors });
});

router.get('/quizzes/:quizId/questions', async (req, res) => {
  const { quizId } = req.params;
  if (!(await assertOwnsQuiz(req.auth.id, quizId))) return res.status(404).json({ error: 'Quiz not found' });
  const result = await db.query('SELECT * FROM questions WHERE quiz_id = $1 ORDER BY seq', [quizId]);
  res.json(result.rows);
});

router.delete('/questions/:questionId', async (req, res) => {
  // ownership check via join
  const r = await db.query(
    `DELETE FROM questions q USING quizzes z
     WHERE q.id = $1 AND q.quiz_id = z.id AND z.quizmaster_id = $2 RETURNING q.id`,
    [req.params.questionId, req.auth.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Question not found' });
  res.json({ deleted: true });
});

// ---- Sessions (a live "run" of a quiz, with a join code) ---------------------
router.post('/quizzes/:quizId/sessions', async (req, res) => {
  const { quizId } = req.params;
  if (!(await assertOwnsQuiz(req.auth.id, quizId))) return res.status(404).json({ error: 'Quiz not found' });

  let code = joinCode();
  // retry on the (rare) collision
  for (let i = 0; i < 5; i++) {
    const clash = await db.query('SELECT id FROM sessions WHERE join_code = $1', [code]);
    if (!clash.rows.length) break;
    code = joinCode();
  }

  const result = await db.query(
    'INSERT INTO sessions (quiz_id, join_code) VALUES ($1, $2) RETURNING *',
    [quizId, code]
  );
  res.json(result.rows[0]);
});

router.get('/sessions/:sessionId', async (req, res) => {
  const r = await db.query(
    `SELECT s.* FROM sessions s JOIN quizzes z ON z.id = s.quiz_id
     WHERE s.id = $1 AND z.quizmaster_id = $2`,
    [req.params.sessionId, req.auth.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Session not found' });
  res.json(r.rows[0]);
});

router.get('/sessions/:sessionId/participants', async (req, res) => {
  const owns = await db.query(
    `SELECT s.id FROM sessions s JOIN quizzes z ON z.id = s.quiz_id
     WHERE s.id = $1 AND z.quizmaster_id = $2`,
    [req.params.sessionId, req.auth.id]
  );
  if (!owns.rows.length) return res.status(404).json({ error: 'Session not found' });

  const result = await db.query(
    `SELECT p.id, pl.name, pl.organisation, p.joined_at
     FROM participants p JOIN players pl ON pl.id = p.player_id
     WHERE p.session_id = $1 ORDER BY p.joined_at`,
    [req.params.sessionId]
  );
  res.json(result.rows);
});

router.get('/sessions/:sessionId/leaderboard', async (req, res) => {
  const owns = await db.query(
    `SELECT s.id FROM sessions s JOIN quizzes z ON z.id = s.quiz_id
     WHERE s.id = $1 AND z.quizmaster_id = $2`,
    [req.params.sessionId, req.auth.id]
  );
  if (!owns.rows.length) return res.status(404).json({ error: 'Session not found' });

  const rows = await getTopLeaderboard(req.params.sessionId, 100);
  if (rows.length === 0) return res.json([]);
  const ids = rows.map((r) => r.playerId);
  const names = await db.query(`SELECT id, name, organisation FROM players WHERE id = ANY($1)`, [ids]);
  const nameMap = Object.fromEntries(names.rows.map((n) => [n.id, n]));
  res.json(rows.map((r) => ({ ...r, name: nameMap[r.playerId]?.name, organisation: nameMap[r.playerId]?.organisation })));
});

module.exports = router;
