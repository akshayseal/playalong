const root = document.getElementById('root');
const logoutBtn = document.getElementById('logoutBtn');
const brandBtn = document.getElementById('brandBtn');

const state = {
  token: localStorage.getItem('qp_qm_token') || null,
  qm: JSON.parse(localStorage.getItem('qp_qm') || 'null'),
  view: state0(),
  quizzes: [],
  currentQuiz: null,
  questions: [],
  session: null,
  socket: null,
  participants: [],
  leaderboard: [],
  liveStatus: 'lobby',
  currentQuestionSeq: 0,
  liveQuestion: null,
  suggestedColors: null,
};
function state0() { return localStorage.getItem('qp_qm_token') ? 'quizList' : 'auth'; }

function setToken(token, qm) {
  state.token = token; state.qm = qm;
  localStorage.setItem('qp_qm_token', token);
  localStorage.setItem('qp_qm', JSON.stringify(qm));
}
function logout() {
  localStorage.removeItem('qp_qm_token'); localStorage.removeItem('qp_qm');
  if (state.socket) state.socket.disconnect();
  qpApplyTheme(null);
  Object.assign(state, { token: null, qm: null, view: 'auth', session: null, socket: null });
  render();
}
logoutBtn.onclick = logout;

// "Home" without logging out — go back to the quiz list. Confirms first if
// a live session is actually in progress, so a stray click doesn't drop you
// out of a control room mid-event.
function goHome() {
  if (state.view === 'sessionControl' && state.liveStatus !== 'finished' && state.liveStatus !== 'lobby') {
    if (!confirm('A quiz is live — leave the control room and go back to your quizzes?')) return;
  }
  if (state.socket) state.socket.disconnect();
  qpApplyTheme(null);
  Object.assign(state, { session: null, socket: null, liveQuestion: null, participants: [], leaderboard: [] });
  state.view = state.token ? 'quizList' : 'auth';
  root.dataset.loaded = '';
  render();
}
brandBtn.onclick = goHome;

async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const res = await fetch('/api' + path, {
    ...opts,
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(opts.headers || {}),
    },
    body: isForm ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function esc(s) { return qpEsc(s); }

function render() {
  logoutBtn.style.display = state.token ? 'inline-flex' : 'none';
  if (!state.token) return renderAuth();
  if (state.view === 'quizList') return renderQuizList();
  if (state.view === 'quizDetail') return renderQuizDetail();
  if (state.view === 'sessionControl') return renderSessionControl();
}

// ---------------- Auth ----------------
function renderAuth() {
  root.innerHTML = `
    <div class="qp-card" style="max-width:440px;margin:0 auto">
      <h2>Quizmaster login</h2>
      <div class="qp-tabs">
        <button id="tabLogin" class="active">Log in</button>
        <button id="tabRegister">Sign up</button>
      </div>
      <div id="regFields" style="display:none">
        <label>Your name</label><input id="name" type="text" placeholder="e.g. Akshay">
        <label>Quizmaster passkey</label><input id="passkey" type="password" placeholder="Ask your admin for this">
      </div>
      <label>Email</label><input id="email" type="email">
      <label>Password</label><input id="password" type="password">
      <div class="qp-error" id="err" style="display:none"></div>
      <button id="submitBtn" class="qp-btn block" style="margin-top:18px">Log in</button>
    </div>`;
  let mode = 'login';
  const tabLogin = document.getElementById('tabLogin'), tabRegister = document.getElementById('tabRegister');
  const regFields = document.getElementById('regFields'), submitBtn = document.getElementById('submitBtn');
  tabLogin.onclick = () => { mode = 'login'; tabLogin.classList.add('active'); tabRegister.classList.remove('active'); regFields.style.display = 'none'; submitBtn.textContent = 'Log in'; };
  tabRegister.onclick = () => { mode = 'register'; tabRegister.classList.add('active'); tabLogin.classList.remove('active'); regFields.style.display = 'block'; submitBtn.textContent = 'Sign up'; };
  submitBtn.onclick = async () => {
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const errEl = document.getElementById('err'); errEl.style.display = 'none';
    try {
      let data;
      if (mode === 'login') data = await api('/auth/quizmaster/login', { method: 'POST', body: { email, password } });
      else {
        const name = document.getElementById('name').value.trim();
        const passkey = document.getElementById('passkey').value;
        if (!name) throw new Error('Please enter your name');
        data = await api('/auth/quizmaster/register', { method: 'POST', body: { email, password, name, passkey } });
      }
      setToken(data.token, data.quizmaster);
      state.view = 'quizList';
      await loadQuizzes();
    } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
  };
}

// ---------------- Quiz list ----------------
async function loadQuizzes() {
  state.quizzes = await api('/quizmaster/quizzes');
  render();
}

function renderQuizList() {
  qpApplyTheme(null);
  if (!state.quizzes.length && !root.dataset.loaded) { loadQuizzes(); root.dataset.loaded = '1'; }
  root.innerHTML = `
    <div class="qp-card">
      <h2>Create a quiz</h2>
      <label>Title</label>
      <input id="newTitle" type="text" placeholder="e.g. Inter-School Science Quiz 2026">
      <label>Logo (optional — used to suggest a theme, white-labels this quiz)</label>
      <input type="file" id="newLogo" accept="image/*">
      <div class="qp-row" style="margin-top:10px; align-items:center">
        <div>
          <label style="margin-top:0">Primary color</label>
          <input type="color" id="newPrimary" value="#000000">
        </div>
        <div>
          <label style="margin-top:0">Accent color</label>
          <input type="color" id="newSecondary" value="#FF7D09">
        </div>
        <div style="display:flex;align-items:flex-end;padding-bottom:2px">
          <span class="qp-muted" id="colorHint"></span>
        </div>
      </div>
      <button id="createBtn" class="qp-btn block" style="margin-top:16px">Create</button>
    </div>
    <div class="qp-card">
      <h2>Your quizzes</h2>
      ${state.quizzes.length ? `
        <table class="qp-table">
          <tr><th>Title</th><th>Questions</th><th>Created</th><th></th></tr>
          ${state.quizzes.map((q) => `
            <tr>
              <td>${q.logo_url ? `<img src="${esc(q.logo_url)}" style="width:20px;height:20px;border-radius:5px;object-fit:cover;vertical-align:middle;margin-right:8px">` : ''}${esc(q.title)}</td>
              <td>${q.question_count}</td>
              <td>${new Date(q.created_at).toLocaleDateString()}</td>
              <td><button class="qp-btn ghost" data-id="${q.id}">Open</button></td>
            </tr>`).join('')}
        </table>` : `<div class="qp-empty">No quizzes yet — create your first one above.</div>`}
    </div>`;

  document.getElementById('newLogo').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const dom = qpDominantColor(img);
      if (dom) {
        document.getElementById('newPrimary').value = dom;
        document.getElementById('newSecondary').value = qpShade(dom, 0.4);
        document.getElementById('colorHint').textContent = 'Suggested from your logo — tweak if you like';
      }
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  };

  document.getElementById('createBtn').onclick = async () => {
    const title = document.getElementById('newTitle').value.trim();
    if (!title) return;
    const fd = new FormData();
    fd.append('title', title);
    fd.append('primary_color', document.getElementById('newPrimary').value);
    fd.append('secondary_color', document.getElementById('newSecondary').value);
    const logoFile = document.getElementById('newLogo').files[0];
    if (logoFile) fd.append('logo', logoFile);
    const quiz = await api('/quizmaster/quizzes', { method: 'POST', body: fd });
    state.quizzes.unshift(quiz);
    render();
  };
  root.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.onclick = async () => {
      state.currentQuiz = state.quizzes.find((q) => q.id == btn.dataset.id);
      state.questions = await api(`/quizmaster/quizzes/${btn.dataset.id}/questions`);
      state.view = 'quizDetail';
      render();
    };
  });
}

// ---------------- Quiz detail (questions + theme) ----------------
function renderQuizDetail() {
  const quiz = state.currentQuiz;
  qpApplyTheme(quiz);
  root.innerHTML = `
    <button id="backBtn" class="qp-btn ghost" style="margin-bottom:14px">← All quizzes</button>
    <div class="qp-card">
      <span class="qp-tag">${state.questions.length} question${state.questions.length === 1 ? '' : 's'}</span>
      <h2>${esc(quiz.title)}</h2>
      <button id="startSessionBtn" class="qp-btn accent" ${state.questions.length === 0 ? 'disabled' : ''}>Create session & go live</button>
    </div>

    <div class="qp-card">
      <h3>Theme / white-label</h3>
      <p class="qp-muted">Players see this quiz's own logo and colors instead of the default XM theme while they're in it.</p>
      ${quiz.logo_url ? `<img src="${esc(quiz.logo_url)}" style="width:48px;height:48px;border-radius:12px;object-fit:cover;margin-bottom:10px">` : ''}
      <label>Change logo (optional)</label><input type="file" id="themeLogo" accept="image/*">
      <div class="qp-row" style="margin-top:10px">
        <div><label style="margin-top:0">Primary color</label><input type="color" id="themePrimary" value="${quiz.primary_color || '#000000'}"></div>
        <div><label style="margin-top:0">Accent color</label><input type="color" id="themeSecondary" value="${quiz.secondary_color || '#FF7D09'}"></div>
      </div>
      <button id="saveThemeBtn" class="qp-btn" style="margin-top:14px">Save theme</button>
      <span class="qp-muted" id="themeMsg" style="margin-left:10px"></span>
    </div>

    <div class="qp-card">
      <h3>Bulk upload (CSV)</h3>
      <p class="qp-muted">Columns: question, option_a, option_b, option_c, option_d, correct_option (A/B/C/D), image_url (optional), time_limit_seconds (optional), points_base (optional)</p>
      <input type="file" id="csvFile" accept=".csv">
      <button id="csvBtn" class="qp-btn" style="margin-top:10px">Upload CSV</button>
      <div id="csvMsg" class="qp-muted" style="margin-top:8px"></div>
    </div>

    <div class="qp-card">
      <h3>Add a single question</h3>
      <label>Question text</label><textarea id="qText" rows="2"></textarea>
      <label>Picture (optional)</label><input type="file" id="qImage" accept="image/*">
      <div class="qp-row"><div><label>Option A</label><input id="optA" type="text"></div><div><label>Option B</label><input id="optB" type="text"></div></div>
      <div class="qp-row"><div><label>Option C</label><input id="optC" type="text"></div><div><label>Option D</label><input id="optD" type="text"></div></div>
      <div class="qp-row">
        <div><label>Correct option</label><select id="correctOpt"><option>A</option><option>B</option><option>C</option><option>D</option></select></div>
        <div><label>Time limit (sec)</label><input id="timeLimit" type="number" value="20"></div>
        <div><label>Points</label><input id="pointsBase" type="number" value="1000"></div>
      </div>
      <button id="addQBtn" class="qp-btn block" style="margin-top:16px">Add question</button>
      <div id="addQErr" class="qp-error" style="display:none"></div>
    </div>

    <div class="qp-card">
      <h3>Question bank</h3>
      ${state.questions.length ? `
        <table class="qp-table">
          <tr><th>#</th><th>Question</th><th>Correct</th><th></th></tr>
          ${state.questions.map((q) => `
            <tr>
              <td>${q.seq}</td>
              <td>${esc(q.question_text)}${q.image_url ? ' 🖼️' : ''}</td>
              <td>${q.correct_option}</td>
              <td><button class="qp-btn ghost delQ" data-id="${q.id}">Delete</button></td>
            </tr>`).join('')}
        </table>` : `<div class="qp-empty">No questions yet.</div>`}
    </div>`;

  document.getElementById('backBtn').onclick = goHome;

  document.getElementById('themeLogo').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const dom = qpDominantColor(img);
      if (dom) {
        document.getElementById('themePrimary').value = dom;
        document.getElementById('themeSecondary').value = qpShade(dom, 0.4);
      }
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  };

  document.getElementById('saveThemeBtn').onclick = async () => {
    const fd = new FormData();
    fd.append('primary_color', document.getElementById('themePrimary').value);
    fd.append('secondary_color', document.getElementById('themeSecondary').value);
    const logoFile = document.getElementById('themeLogo').files[0];
    if (logoFile) fd.append('logo', logoFile);
    const msg = document.getElementById('themeMsg');
    try {
      const updated = await api(`/quizmaster/quizzes/${quiz.id}/theme`, { method: 'PUT', body: fd });
      state.currentQuiz = updated;
      const idx = state.quizzes.findIndex((q) => q.id === updated.id);
      if (idx >= 0) state.quizzes[idx] = updated;
      msg.textContent = 'Saved.';
      qpApplyTheme(updated);
    } catch (e) { msg.textContent = e.message; }
  };

  document.getElementById('csvBtn').onclick = async () => {
    const file = document.getElementById('csvFile').files[0];
    const msg = document.getElementById('csvMsg');
    if (!file) { msg.textContent = 'Choose a CSV file first.'; return; }
    const fd = new FormData(); fd.append('file', file);
    try {
      const data = await api(`/quizmaster/quizzes/${quiz.id}/questions/csv`, { method: 'POST', body: fd });
      msg.textContent = `Added ${data.inserted} question(s).` + (data.rowErrors?.length ? ` ${data.rowErrors.length} row(s) skipped: ${data.rowErrors.join('; ')}` : '');
      state.questions = await api(`/quizmaster/quizzes/${quiz.id}/questions`);
      render();
    } catch (e) { msg.textContent = e.message; }
  };

  document.getElementById('addQBtn').onclick = async () => {
    const errEl = document.getElementById('addQErr'); errEl.style.display = 'none';
    const fd = new FormData();
    fd.append('question_text', document.getElementById('qText').value.trim());
    fd.append('option_a', document.getElementById('optA').value.trim());
    fd.append('option_b', document.getElementById('optB').value.trim());
    fd.append('option_c', document.getElementById('optC').value.trim());
    fd.append('option_d', document.getElementById('optD').value.trim());
    fd.append('correct_option', document.getElementById('correctOpt').value);
    fd.append('time_limit_seconds', document.getElementById('timeLimit').value);
    fd.append('points_base', document.getElementById('pointsBase').value);
    const imgFile = document.getElementById('qImage').files[0];
    if (imgFile) fd.append('image', imgFile);
    try {
      await api(`/quizmaster/quizzes/${quiz.id}/questions`, { method: 'POST', body: fd });
      state.questions = await api(`/quizmaster/quizzes/${quiz.id}/questions`);
      render();
    } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
  };

  root.querySelectorAll('.delQ').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/quizmaster/questions/${btn.dataset.id}`, { method: 'DELETE' });
      state.questions = state.questions.filter((q) => q.id != btn.dataset.id);
      render();
    };
  });

  document.getElementById('startSessionBtn').onclick = async () => {
    const session = await api(`/quizmaster/quizzes/${quiz.id}/sessions`, { method: 'POST' });
    state.session = session;
    state.participants = [];
    state.leaderboard = [];
    state.liveStatus = 'lobby';
    state.currentQuestionSeq = 0;
    state.liveQuestion = null;
    state.view = 'sessionControl';
    render();
    connectQmSocket();
  };
}

// ---------------- Session control room ----------------
function connectQmSocket() {
  const socket = io({ auth: { token: state.token } });
  state.socket = socket;
  socket.emit('join_as_quizmaster', { sessionId: state.session.id }, (ack) => {
    if (ack?.error) alert(ack.error);
  });
  socket.on('participant_joined', (p) => {
    if (!state.participants.find((x) => x.id === p.id)) state.participants.push(p);
    refreshLiveBits();
  });
  socket.on('question', (q) => {
    state.liveQuestion = q;
    state.liveQuestion.correctOption = null;
    refreshLiveQuestion();
  });
  socket.on('answer_revealed', ({ questionId, correctOption }) => {
    if (state.liveQuestion && state.liveQuestion.id === questionId) {
      state.liveQuestion.correctOption = correctOption;
      refreshLiveQuestion();
    }
  });
  socket.on('leaderboard_update', (rows) => { state.leaderboard = rows; refreshLiveBits(); });
  socket.on('quiz_finished', (rows) => { state.leaderboard = rows; state.liveStatus = 'finished'; render(); });
}

function refreshLiveBits() {
  const p = document.getElementById('participantCount');
  if (p) p.textContent = state.participants.length;
  const lb = document.getElementById('lbLive');
  if (lb) {
    if (!lb.querySelector('#lbTable')) { lb.innerHTML = leaderboardTableHtml(); return; }
    qpFlipReorder(lb.querySelector('tbody'), () => { lb.innerHTML = leaderboardTableHtml(); });
  }
}

function refreshLiveQuestion() {
  const el = document.getElementById('liveQuestionPanel');
  if (el) el.outerHTML = liveQuestionHtml();
}

function liveQuestionHtml() {
  const q = state.liveQuestion;
  if (!q) return `<div id="liveQuestionPanel"></div>`;
  return `
    <div class="qp-live-question" id="liveQuestionPanel">
      <span class="qp-tag" style="background:rgba(255,255,255,.15);color:#fff">Question ${q.seq} · projectable</span>
      <h2>${esc(q.question_text)}</h2>
      ${q.image_url ? `<img src="${esc(q.image_url)}" alt="" style="max-width:100%;border-radius:12px;margin-bottom:16px">` : ''}
      <div class="qp-options">
        ${['A','B','C','D'].map((L) => `
          <div class="qp-opt ${q.correctOption === L ? 'correct' : ''}">
            <span class="letter">${L}</span>${esc(q['option_' + L.toLowerCase()])}
          </div>`).join('')}
      </div>
    </div>`;
}

function leaderboardTableHtml() {
  if (!state.leaderboard.length) return `<div class="qp-empty">No scores yet.</div>`;
  return `<table class="qp-table" id="lbTable"><tr><th>#</th><th>Name</th><th>Org</th><th>Points</th></tr>
    <tbody>
    ${state.leaderboard.slice(0, 30).map((r, i) => `<tr data-key="${r.playerId}"><td>${i+1}</td><td>${esc(r.name)}</td><td>${esc(r.organisation || '')}</td><td>${r.totalPoints}</td></tr>`).join('')}
    </tbody>
  </table>`;
}

function renderSessionControl() {
  qpApplyTheme(state.currentQuiz);
  const s = state.session;

  if (state.liveStatus === 'finished') {
    root.innerHTML = `
      <div class="qp-card" style="text-align:center">
        <div style="font-size:40px">🏁</div>
        <h2>Quiz complete!</h2>
        ${qpRenderPodium(state.leaderboard)}
      </div>
      <div class="qp-card">
        <h3>Final leaderboard</h3>
        ${leaderboardTableHtml()}
      </div>
      <button id="homeBtn" class="qp-btn block">Back to your quizzes</button>`;
    document.getElementById('homeBtn').onclick = goHome;
    return;
  }

  root.innerHTML = `
    <div class="qp-card" style="text-align:center">
      <span class="qp-tag">${esc(state.currentQuiz.title)}</span>
      <p class="qp-muted" style="margin:6px 0 0">Share this code with players</p>
      <div class="qp-code">${s.join_code}</div>
      <p class="qp-muted"><span id="participantCount">${state.participants.length}</span> player(s) joined</p>
    </div>
    <div class="qp-card">
      <div class="qp-row">
        <button id="startBtn" class="qp-btn accent">Start quiz</button>
        <button id="nextBtn" class="qp-btn">Next question</button>
        <button id="revealBtn" class="qp-btn ghost">Reveal answer</button>
        <button id="endBtn" class="qp-btn danger">End quiz</button>
      </div>
      <p class="qp-muted" style="margin-top:10px" id="statusLine">Status: ${state.liveStatus}</p>
    </div>
    ${liveQuestionHtml()}
    <div class="qp-card">
      <h3>Live leaderboard</h3>
      <div id="lbLive">${leaderboardTableHtml()}</div>
    </div>`;

  document.getElementById('startBtn').onclick = () => {
    state.socket.emit('start_session', { sessionId: s.id }, (ack) => {
      if (ack?.error) return alert(ack.error);
      state.liveStatus = 'live';
      document.getElementById('statusLine').textContent = 'Status: live — lobby open, click "Next question" to begin';
    });
  };
  document.getElementById('nextBtn').onclick = () => {
    state.socket.emit('next_question', { sessionId: s.id }, (ack) => {
      if (ack?.error) return alert(ack.error);
      if (ack.finished) { render(); return; }
      state.currentQuestionSeq = ack.question.seq;
      document.getElementById('statusLine').textContent = `Status: question ${ack.question.seq} live`;
    });
  };
  document.getElementById('revealBtn').onclick = () => {
    state.socket.emit('reveal_answer', { sessionId: s.id }, (ack) => {
      if (ack?.error) return alert(ack.error);
      document.getElementById('statusLine').textContent = 'Status: answer revealed — click "Next question" to continue';
    });
  };
  document.getElementById('endBtn').onclick = () => {
    if (!confirm('End the quiz now?')) return;
    state.socket.emit('end_session', { sessionId: s.id }, () => {});
  };
}

render();
