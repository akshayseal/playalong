const { verify } = require('../utils/auth');

function requireRole(role) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    try {
      const payload = verify(token);
      if (payload.role !== role) {
        return res.status(403).json({ error: `${role} access required` });
      }
      req.auth = payload;
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

module.exports = { requireQuizmaster: requireRole('quizmaster'), requirePlayer: requireRole('player') };
