require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');

const authRoutes = require('./routes/auth');
const quizmasterRoutes = require('./routes/quizmaster');
const playerRoutes = require('./routes/player');
const { registerQuizSocket } = require('./sockets/quizSocket');
const { hasRedis, client: redisClient, subClient } = require('./redis');

const app = express();
const server = http.createServer(app);

const corsOrigins = (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim());

app.use(helmet({ contentSecurityPolicy: false })); // CSP tuned per-deployment; keep off by default for the bundled demo UI
app.use(cors({ origin: corsOrigins }));
app.use(express.json());
app.use('/', express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/quizmaster', quizmasterRoutes);
app.use('/api/player', playerRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, redis: hasRedis }));

if (!process.env.QUIZMASTER_PASSKEY) {
  console.warn('[auth] QUIZMASTER_PASSKEY not set — anyone can register as a quizmaster. Set this before a real event.');
}

const io = new Server(server, {
  cors: { origin: corsOrigins },
  // Larger buffers matter less than the adapter here — for 1000 concurrent
  // sockets on one instance this is fine; add more instances + the Redis
  // adapter below once you outgrow a single box.
});

if (hasRedis) {
  io.adapter(createAdapter(redisClient, subClient));
  console.log('[socket.io] Redis adapter active — safe to run multiple instances');
} else {
  console.warn('[socket.io] No Redis adapter — running single-instance only');
}

registerQuizSocket(io);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`QuizPlay listening on :${PORT}`);
});
