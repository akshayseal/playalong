const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { sign } = require('../utils/auth');

const router = express.Router();

// ---- Players --------------------------------------------------------------
router.post('/player/register', async (req, res) => {
  const { email, password, name, organisation } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'email, password and name are required' });
  }
  try {
    const existing = await db.query('SELECT id FROM players WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO players (email, password_hash, name, organisation)
       VALUES ($1, $2, $3, $4) RETURNING id, email, name, organisation`,
      [email.toLowerCase(), hash, name, organisation || null]
    );
    const player = result.rows[0];
    const token = sign({ role: 'player', id: player.id });
    res.json({ token, player });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/player/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    const result = await db.query('SELECT * FROM players WHERE email = $1', [email.toLowerCase()]);
    const player = result.rows[0];
    if (!player || !(await bcrypt.compare(password, player.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = sign({ role: 'player', id: player.id });
    res.json({
      token,
      player: { id: player.id, email: player.email, name: player.name, organisation: player.organisation },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ---- Quizmasters ------------------------------------------------------------
router.post('/quizmaster/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'email, password and name are required' });
  }
  try {
    const existing = await db.query('SELECT id FROM quizmasters WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO quizmasters (email, password_hash, name) VALUES ($1, $2, $3)
       RETURNING id, email, name`,
      [email.toLowerCase(), hash, name]
    );
    const qm = result.rows[0];
    const token = sign({ role: 'quizmaster', id: qm.id });
    res.json({ token, quizmaster: qm });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/quizmaster/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    const result = await db.query('SELECT * FROM quizmasters WHERE email = $1', [email.toLowerCase()]);
    const qm = result.rows[0];
    if (!qm || !(await bcrypt.compare(password, qm.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = sign({ role: 'quizmaster', id: qm.id });
    res.json({ token, quizmaster: { id: qm.id, email: qm.email, name: qm.name } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

module.exports = router;
