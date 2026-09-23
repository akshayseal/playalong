const root = document.getElementById('root');
const logoutBtn = document.getElementById('logoutBtn');

const state = {
  token: localStorage.getItem('qp_player_token') || null,
  player: JSON.parse(localStorage.getItem('qp_player') || 'null'),
  session: null,
  socket: null,
  view: 'auth', // auth | join | lobby | question | answered | revealed | finished
  question: null,
  questionStartedAt: null,
  selected: null,
  lastResult: null,
  leaderboard: [],
  timerHandle: null,
};

function setToken(token, player) {
  state.token = token;
  state.player = player;
  localStorage.setItem('qp_player_token', token);
  localStorage.setItem('qp_player', JSON.stringify(player));
}

function logout() {
  localStorage.removeItem('qp_player_token');
  localStorage.removeItem('qp_player');
  if (state.socket) state.socket.disconnect();
  Object.assign(state, { token: null, player: null, session: null, socket: null, view: 'auth' });
  render();
}
logoutBtn.onclick = logout;

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function connectSocket() {
  const socket = io({ auth: { token: state.token } });
  state.socket = socket;

  socket.on('participant_joined', () => {}); // players don't need this

  socket.on('session_started', () => {
    state.view = 'lobby'; render();
  });

  socket.on('question', (q) => {
    state.question = q;
    state.questionStartedAt = Date.now();
    state.selected = null;
    state.lastResult = null;
    state.view = 'question';
    render();
    startTimer();
  });

  socket.on('answer_revealed', ({ questionId, correctOption }) => {
    if (state.question && state.question.id === questionId) {
      state.question.correctOption = correctOption;
      state.view = 'revealed';
      render();
    }
  });

  socket.on('leaderboard_update', (rows) => {
    state.leaderboard = rows;
    if (state.view === 'question' || state.view === 'answered' || state.view === 'revealed') renderLeaderboardPanel();
  });

  socket.on('quiz_finished', (rows) => {
    state.leaderboard = rows;
    state.view = 'finished';
    render();
  });

  socket.emit('join_session', { sessionId: state.session.id }, (ack) => {
    if (ack?.error) { alert(ack.error); return; }
    if (ack.activeQuestion) {
      state.question = ack.activeQuestion;
      state.questionStartedAt = Date.now();
      state.view = 'question';
      render();
      startTimer();
    }
  });
}

function startTimer() {
  clearInterval(state.timerHandle);
  const bar = () => document.getElementById('timerBar');
  const totalMs = state.question.time_limit_seconds * 1000;
  state.timerHandle = setInterval(() => {
    const elapsed = Date.now() - state.questionStartedAt;
    const pct = Math.max(0, 100 - (elapsed / totalMs) * 100);
    const el = bar();
    if (el) el.style.width = pct + '%';
    if (elapsed >= totalMs) clearInterval(state.timerHandle);
  }, 100);
}

function submitAnswer(letter) {
  if (state.selected) return;
  state.selected = letter;
  state.view = 'answered';
  render();
  state.socket.emit('submit_answer', {
    sessionId: state.session.id,
    questionId: state.question.id,
    selectedOption: letter,
  }, (ack) => {
    state.lastResult = ack;
    if (state.view === 'answered') render();
  });
}

function esc(s) { return (s ?? '').toString().replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function leaderboardHtml(rows, myId) {
  if (!rows.length) return `<p class="qp-muted">Scores will appear here once the first question is answered.</p>`;
  return `<ul class="qp-leaderboard">${rows.slice(0, 10).map((r, i) => `
    <li>
      <div class="rank ${i === 0 ? 'top1' : ''}">${i + 1}</div>
      <div class="name">${esc(r.name)}${r.playerId === myId ? ' (you)' : ''}</div>
      <div class="pts">${r.totalPoints} pts</div>
    </li>`).join('')}</ul>`;
}

function renderLeaderboardPanel() {
  const el = document.getElementById('lbPanel');
  if (el) el.innerHTML = leaderboardHtml(state.leaderboard, state.player.id);
}

function render() {
  logoutBtn.style.display = state.token ? 'inline-flex' : 'none';

  if (!state.token) return renderAuth();
  if (state.view === 'auth' || state.view === 'join') return renderJoin();
  if (state.view === 'lobby') return renderLobby();
  if (state.view === 'question') return renderQuestion();
  if (state.view === 'answered') return renderAnswered();
  if (state.view === 'revealed') return renderRevealed();
  if (state.view === 'finished') return renderFinished();
}

function renderAuth() {
  root.innerHTML = `
    <div class="qp-card">
      <h2>Welcome</h2>
      <div class="qp-tabs">
        <button id="tabLogin" class="active">Log in</button>
        <button id="tabRegister">Sign up</button>
      </div>
      <div id="regFields" style="display:none">
        <label>Name</label><input id="name" type="text" placeholder="Your full name">
        <label>College / Organisation</label><input id="org" type="text" placeholder="e.g. St. Xavier's College">
      </div>
      <label>Email</label><input id="email" type="email" placeholder="you@example.com">
      <label>Password</label><input id="password" type="password" placeholder="••••••••">
      <div class="qp-error" id="err" style="display:none"></div>
      <button id="submitBtn" class="qp-btn block" style="margin-top:18px">Log in</button>
    </div>`;

  let mode = 'login';
  const tabLogin = document.getElementById('tabLogin');
  const tabRegister = document.getElementById('tabRegister');
  const regFields = document.getElementById('regFields');
  const submitBtn = document.getElementById('submitBtn');
  tabLogin.onclick = () => { mode = 'login'; tabLogin.classList.add('active'); tabRegister.classList.remove('active'); regFields.style.display = 'none'; submitBtn.textContent = 'Log in'; };
  tabRegister.onclick = () => { mode = 'register'; tabRegister.classList.add('active'); tabLogin.classList.remove('active'); regFields.style.display = 'block'; submitBtn.textContent = 'Sign up'; };

  submitBtn.onclick = async () => {
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const errEl = document.getElementById('err');
    errEl.style.display = 'none';
    try {
      let data;
      if (mode === 'login') {
        data = await api('/auth/player/login', { method: 'POST', body: { email, password } });
      } else {
        const name = document.getElementById('name').value.trim();
        const organisation = document.getElementById('org').value.trim();
        if (!name) throw new Error('Please enter your name');
        data = await api('/auth/player/register', { method: 'POST', body: { email, password, name, organisation } });
      }
      setToken(data.token, data.player);
      state.view = 'join';
      render();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = 'block';
    }
  };
}

function renderJoin() {
  root.innerHTML = `
    <div class="qp-card">
      <h2>Hi ${esc(state.player.name)} 👋</h2>
      <p class="qp-muted">Enter the code your quizmaster shared to join the game.</p>
      <label>Join code</label>
      <input id="code" type="text" placeholder="ABC123" style="text-transform:uppercase; letter-spacing:4px; font-size:22px; text-align:center">
      <div class="qp-error" id="err" style="display:none"></div>
      <button id="joinBtn" class="qp-btn block" style="margin-top:18px">Join quiz</button>
    </div>`;

  document.getElementById('joinBtn').onclick = async () => {
    const joinCode = document.getElementById('code').value.trim();
    const errEl = document.getElementById('err');
    errEl.style.display = 'none';
    try {
      const data = await api('/player/sessions/join', { method: 'POST', body: { joinCode } });
      state.session = data.session;
      state.view = data.session.status === 'lobby' ? 'lobby' : 'question';
      render();
      connectSocket();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = 'block';
    }
  };
}

function renderLobby() {
  root.innerHTML = `
    <div class="qp-card" style="text-align:center">
      <span class="qp-tag">${esc(state.session.quiz_title)}</span>
      <h2>You're in!</h2>
      <p class="qp-muted">Sit tight — the quizmaster will start the quiz shortly.</p>
      <div style="font-size:40px; margin-top:10px">⏳</div>
    </div>`;
}

function renderQuestion() {
  const q = state.question;
  root.innerHTML = `
    <div class="qp-card">
      <span class="qp-tag">Question ${q.seq}</span>
      <div class="qp-timer"><div id="timerBar" style="width:100%"></div></div>
      <h2>${esc(q.question_text)}</h2>
      ${q.image_url ? `<img src="${esc(q.image_url)}" alt="" style="width:100%;border-radius:12px;margin:10px 0">` : ''}
      <div class="qp-options" style="margin-top:16px">
        ${['A','B','C','D'].map((L) => `
          <button class="qp-opt" data-letter="${L}">
            <span class="letter">${L}</span>${esc(q['option_' + L.toLowerCase()])}
          </button>`).join('')}
      </div>
    </div>`;
  startTimer();
  document.querySelectorAll('.qp-opt').forEach((btn) => {
    btn.onclick = () => submitAnswer(btn.dataset.letter);
  });
}

function renderAnswered() {
  const q = state.question;
  root.innerHTML = `
    <div class="qp-card">
      <span class="qp-tag">Question ${q.seq}</span>
      <div class="qp-timer"><div id="timerBar"></div></div>
      <h2>${esc(q.question_text)}</h2>
      <div class="qp-options" style="margin-top:16px">
        ${['A','B','C','D'].map((L) => `
          <button class="qp-opt ${state.selected === L ? 'selected' : ''}" disabled>
            <span class="letter">${L}</span>${esc(q['option_' + L.toLowerCase()])}
          </button>`).join('')}
      </div>
      <p class="qp-muted" style="margin-top:14px">Answer locked in — waiting for the rest of the room…</p>
    </div>`;
}

function renderRevealed() {
  const q = state.question;
  const mine = state.selected;
  const correct = q.correctOption;
  root.innerHTML = `
    <div class="qp-card">
      <span class="qp-tag">Question ${q.seq}</span>
      <h2>${esc(q.question_text)}</h2>
      <div class="qp-options" style="margin-top:16px">
        ${['A','B','C','D'].map((L) => {
          let cls = '';
          if (L === correct) cls = 'correct';
          else if (L === mine) cls = 'wrong';
          return `<button class="qp-opt ${cls}" disabled><span class="letter">${L}</span>${esc(q['option_' + L.toLowerCase()])}</button>`;
        }).join('')}
      </div>
      <p style="margin-top:14px;font-weight:800;color:${mine === correct ? 'var(--qp-correct)' : 'var(--qp-wrong)'}">
        ${mine === correct ? `Correct! +${state.lastResult?.points ?? 0} pts` : 'Not this time'}
      </p>
      <h3 style="margin-top:22px">Leaderboard</h3>
      <div id="lbPanel">${leaderboardHtml(state.leaderboard, state.player.id)}</div>
      <p class="qp-muted" style="margin-top:10px">Waiting for the next question…</p>
    </div>`;
}

function renderFinished() {
  root.innerHTML = `
    <div class="qp-card" style="text-align:center">
      <div style="font-size:40px">🏁</div>
      <h2>Quiz complete!</h2>
    </div>
    <div class="qp-card">
      <h3>Final leaderboard</h3>
      ${leaderboardHtml(state.leaderboard, state.player.id)}
    </div>`;
}

// Boot
if (state.token) {
  state.view = 'join';
}
render();
