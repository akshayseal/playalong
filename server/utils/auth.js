const jwt = require('jsonwebtoken');

function sign(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  });
}

function verify(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

module.exports = { sign, verify };
