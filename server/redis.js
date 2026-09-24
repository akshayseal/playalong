const Redis = require('ioredis');

const hasRedis = !!process.env.REDIS_URL;

let client = null;
let subClient = null;
if (hasRedis) {
  // No maxRetriesPerRequest cap here: these clients back the Socket.IO
  // adapter and the leaderboard, so we want ioredis's default behaviour of
  // retrying a dropped connection indefinitely with backoff, rather than
  // giving up after a few tries and throwing.
  client = new Redis(process.env.REDIS_URL);
  subClient = new Redis(process.env.REDIS_URL);
  // Both clients need an error handler, or an unreachable Redis crashes the
  // whole Node process instead of just logging — this matters most exactly
  // when it's least convenient, mid-event with 1000 players connected.
  client.on('error', (e) => console.error('Redis error (main client)', e.message));
  subClient.on('error', (e) => console.error('Redis error (sub client)', e.message));
} else {
  console.warn(
    '[redis] REDIS_URL not set — using in-memory leaderboard. ' +
    'This ONLY works with a single Node process. Set REDIS_URL before ' +
    'running more than one instance or you will get inconsistent leaderboards.'
  );
}

// ---- In-memory fallback (dev only) --------------------------------------
const memSortedSets = new Map(); // key -> Map(member -> score)

function memZAdd(key, score, member) {
  if (!memSortedSets.has(key)) memSortedSets.set(key, new Map());
  memSortedSets.get(key).set(member, score);
}

function memZRevRangeWithScores(key, count) {
  const set = memSortedSets.get(key);
  if (!set) return [];
  return [...set.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([member, score]) => ({ member, score }));
}

// ---- Public leaderboard API ----------------------------------------------
// Score encodes both accuracy and speed into one sortable number so a single
// ZADD/ZREVRANGE round-trip gives us a ranked leaderboard with no read-modify
// -write race, even under concurrent answers from ~1000 players.
//
// score = totalPoints * 1,000,000 - totalResponseTimeMs
// (more points always wins; among equal points, less total time wins,
// because it *subtracts* from the score.)
function encodeScore(totalPoints, totalResponseTimeMs) {
  return totalPoints * 1_000_000 - totalResponseTimeMs;
}

async function bumpLeaderboard(sessionId, playerId, addPoints, addTimeMs) {
  const key = `lb:${sessionId}`;
  const memberKey = `p:${playerId}`;

  if (hasRedis) {
    // Track raw totals in a hash so we can recompute the composite score,
    // then write the composite score into the sorted set.
    const pointsKey = `${key}:points`;
    const timeKey = `${key}:time`;
    const [totalPoints, totalTime] = await Promise.all([
      client.hincrby(pointsKey, memberKey, addPoints),
      client.hincrby(timeKey, memberKey, addTimeMs),
    ]);
    const score = encodeScore(totalPoints, totalTime);
    await client.zadd(key, score, memberKey);
    return { totalPoints, totalTime };
  }

  // in-memory fallback
  const pointsKey = `${key}:points`;
  const timeKey = `${key}:time`;
  if (!memSortedSets.has(pointsKey)) memSortedSets.set(pointsKey, new Map());
  if (!memSortedSets.has(timeKey)) memSortedSets.set(timeKey, new Map());
  const totalPoints = (memSortedSets.get(pointsKey).get(memberKey) || 0) + addPoints;
  const totalTime = (memSortedSets.get(timeKey).get(memberKey) || 0) + addTimeMs;
  memSortedSets.get(pointsKey).set(memberKey, totalPoints);
  memSortedSets.get(timeKey).set(memberKey, totalTime);
  memZAdd(key, encodeScore(totalPoints, totalTime), memberKey);
  return { totalPoints, totalTime };
}

async function getTopLeaderboard(sessionId, limit = 50) {
  const key = `lb:${sessionId}`;
  const pointsKey = `${key}:points`;
  const timeKey = `${key}:time`;

  if (hasRedis) {
    const raw = await client.zrevrange(key, 0, limit - 1, 'WITHSCORES');
    const rows = [];
    for (let i = 0; i < raw.length; i += 2) {
      const memberKey = raw[i];
      const playerId = parseInt(memberKey.slice(2), 10);
      rows.push({ playerId });
    }
    if (rows.length === 0) return [];
    const memberKeys = rows.map((r) => `p:${r.playerId}`);
    const [points, times] = await Promise.all([
      client.hmget(pointsKey, ...memberKeys),
      client.hmget(timeKey, ...memberKeys),
    ]);
    return rows.map((r, i) => ({
      playerId: r.playerId,
      totalPoints: parseInt(points[i] || '0', 10),
      totalTimeMs: parseInt(times[i] || '0', 10),
    }));
  }

  const top = memZRevRangeWithScores(key, limit);
  const pointsMap = memSortedSets.get(pointsKey) || new Map();
  const timeMap = memSortedSets.get(timeKey) || new Map();
  return top.map(({ member }) => ({
    playerId: parseInt(member.slice(2), 10),
    totalPoints: pointsMap.get(member) || 0,
    totalTimeMs: timeMap.get(member) || 0,
  }));
}

async function clearLeaderboard(sessionId) {
  const key = `lb:${sessionId}`;
  if (hasRedis) {
    await client.del(key, `${key}:points`, `${key}:time`);
  } else {
    memSortedSets.delete(key);
    memSortedSets.delete(`${key}:points`);
    memSortedSets.delete(`${key}:time`);
  }
}

module.exports = {
  hasRedis,
  client,
  subClient,
  bumpLeaderboard,
  getTopLeaderboard,
  clearLeaderboard,
};
