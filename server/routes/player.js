const express = require('express');
const db = require('../db');
const { requirePlayer } = require('../middleware/auth');

const router = express.Router();
router.use(requirePlayer);

router.post('/sessions/join', async (req, res) => {
  const { joinCode } = req.body;
  if (!joinCode) return res.status(400).json({ error: 'joinCode is required' });

  const result = await db.query(
    `SELECT s.*, z.title AS quiz_title FROM sessions s
     JOIN quizzes z ON z.id = s.quiz_id
     WHERE s.join_code = $1`,
    [joinCode.toUpperCase()]
  );
  const session = result.rows[0];
  if (!session) return res.status(404).json({ error: 'No quiz found with that code' });
  if (session.status === 'finished') return res.status(410).json({ error: 'This quiz has already finished' });

  await db.query(
    `INSERT INTO participants (session_id, player_id) VALUES ($1, $2)
     ON CONFLICT (session_id, player_id) DO NOTHING`,
    [session.id, req.auth.id]
  );

  res.json({ session });
});

module.exports = router;
