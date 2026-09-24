#!/usr/bin/env node
/**
 * QuizPlay load test — simulates real players end to end against your
 * actual deployed app: each one registers an account, joins your session
 * by its join code, connects over Socket.IO, and answers questions as the
 * quizmaster pushes them. This is a truer test than a generic load tool,
 * because QuizPlay's join flow is a real login + a two-step (REST, then
 * socket) join, not a bare HTTP hit.
 *
 * Requires Node 18+ (for built-in fetch) and the socket.io-client package:
 *   npm install --no-save socket.io-client
 *
 * Usage:
 *   BASE_URL=https://<your-app>.up.railway.app \
 *   JOIN_CODE=ABC123 \
 *   NUM_PLAYERS=1000 \
 *   node loadtest/simulate-players.js
 *
 * How to actually run a test:
 *   1. As quizmaster, create a quiz with a few questions and a session —
 *      leave it in the lobby (don't click Start yet). Note its join code.
 *   2. Run this script with that join code. It registers NUM_PLAYERS fake
 *      accounts and connects them all, ramping up in batches so you don't
 *      slam the register endpoint all at once.
 *   3. Once it reports everyone connected, go to the real quizmaster
 *      dashboard and click Start, then Next question, same as a real event.
 *   4. Watch this script's stats alongside Railway's Metrics tab for the
 *      playalong service (CPU, memory) and the Postgres service.
 *
 * Cleanup: fake accounts are named loadtest-<n>@quizplay-test.invalid, so
 * you can find and remove them afterwards via the Postgres console:
 *   DELETE FROM players WHERE email LIKE 'loadtest-%@quizplay-test.invalid';
 */

const { io } = require('socket.io-client');

const BASE_URL = process.env.BASE_URL;
const JOIN_CODE = process.env.JOIN_CODE;
const NUM_PLAYERS = parseInt(process.env.NUM_PLAYERS || '1000', 10);
const RAMP_BATCH = parseInt(process.env.RAMP_BATCH || '25', 10);
const RAMP_DELAY_MS = parseInt(process.env.RAMP_DELAY_MS || '300', 10);

if (!BASE_URL || !JOIN_CODE) {
  console.error('Set BASE_URL and JOIN_CODE env vars — see the comment at the top of this file for usage.');
  process.exit(1);
}

const WS_URL = BASE_URL.replace(/^http/, 'ws');

const stats = {
  registered: 0, registerFailed: 0,
  joined: 0, joinFailed: 0,
  connected: 0, disconnected: 0,
  answered: 0, answerFailed: 0,
  latencies: [],
};

async function api(path, opts = {}) {
  const res = await fetch(BASE_URL + '/api' + path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function simulatePlayer(n) {
  const email = `loadtest-${n}@quizplay-test.invalid`;
  const password = 'loadtest-password-123';
  let token;

  try {
    const reg = await api('/auth/player/register', {
      method: 'POST',
      body: { email, password, name: `Load Test ${n}`, organisation: 'Load Test' },
    });
    token = reg.token;
    stats.registered++;
  } catch (e) {
    // Account may already exist from a previous run — log in instead.
    try {
      const login = await api('/auth/player/login', { method: 'POST', body: { email, password } });
      token = login.token;
      stats.registered++;
    } catch (e2) {
      stats.registerFailed++;
      return;
    }
  }

  let sessionId;
  try {
    const joined = await api('/player/sessions/join', { method: 'POST', token, body: { joinCode: JOIN_CODE } });
    sessionId = joined.session.id;
    stats.joined++;
  } catch (e) {
    stats.joinFailed++;
    return;
  }

  const socket = io(WS_URL, { auth: { token }, transports: ['websocket'] });

  socket.on('connect', () => { stats.connected++; });
  socket.on('disconnect', () => { stats.disconnected++; });

  socket.emit('join_session', { sessionId }, (ack) => {
    if (ack?.error) console.error(`player ${n} join_session error:`, ack.error);
  });

  socket.on('question', (q) => {
    // Stagger answers over a few seconds, like real players actually reading
    // the question, instead of every socket answering in the same instant.
    const delay = 1000 + Math.random() * 4000;
    const start = Date.now();
    setTimeout(() => {
      const letters = ['A', 'B', 'C', 'D'];
      socket.emit('submit_answer', {
        sessionId,
        questionId: q.id,
        selectedOption: letters[Math.floor(Math.random() * 4)],
      }, (ack) => {
        if (ack?.error) stats.answerFailed++;
        else { stats.answered++; stats.latencies.push(Date.now() - start); }
      });
    }, delay);
  });

  socket.on('quiz_finished', () => {
    setTimeout(() => socket.disconnect(), 2000);
  });
}

async function main() {
  console.log(`Ramping up ${NUM_PLAYERS} simulated players against ${BASE_URL} (join code ${JOIN_CODE})...`);
  for (let i = 0; i < NUM_PLAYERS; i += RAMP_BATCH) {
    const batch = [];
    for (let n = i; n < Math.min(i + RAMP_BATCH, NUM_PLAYERS); n++) batch.push(simulatePlayer(n));
    await Promise.all(batch);
    await new Promise((r) => setTimeout(r, RAMP_DELAY_MS));
    process.stdout.write(
      `\r  connected: ${stats.connected} | joined: ${stats.joined} | register failed: ${stats.registerFailed} | join failed: ${stats.joinFailed}   `
    );
  }
  console.log('\nAll players ramped up. Now go click Start, then Next question, on the real quizmaster dashboard.');

  setInterval(() => {
    const avg = stats.latencies.length
      ? Math.round(stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length)
      : 0;
    console.log(
      `connected: ${stats.connected} | disconnected: ${stats.disconnected} | answered: ${stats.answered} | answer failed: ${stats.answerFailed} | avg answer round-trip: ${avg}ms`
    );
  }, 5000);
}

main();
