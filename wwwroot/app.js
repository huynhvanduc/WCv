'use strict';
// UI theo canvas thiết kế "Workflow Runner": màn Thiết lập, màn Chạy, luồng Sửa lại commit cũ.
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (sha) => sha ? sha.slice(0, 7) : '';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { } },
};

const ICON = {
  grip: (c = '#8A8E97') => `<svg width="10" height="16" viewBox="0 0 10 16" fill="${c}" aria-hidden="true"><circle cx="2.5" cy="3" r="1.5"/><circle cx="7.5" cy="3" r="1.5"/><circle cx="2.5" cy="8" r="1.5"/><circle cx="7.5" cy="8" r="1.5"/><circle cx="2.5" cy="13" r="1.5"/><circle cx="7.5" cy="13" r="1.5"/></svg>`,
  up: '<svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="#3F434B" stroke-width="1.6" aria-hidden="true"><path d="M1 5l4-4 4 4"/></svg>',
  down: '<svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="#3F434B" stroke-width="1.6" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg>',
  trash: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#B3261E" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.8v4.4M9.2 6.8v4.4"/></svg>',
};

// ===== Trạng thái phía trình duyệt =====
const ui = {
  tab: 'run',
  snap: null, lastKey: '', logFrom: 0,
  wfId: store.get('wf'),      // workflow đang chọn (Thiết lập, và màn Chạy khi chưa bắt đầu)
  defs: {},                   // id → định nghĩa workflow (khi chưa có lần chạy)
  mode: 'single', endId: null,
  drafts: {},                 // commit message đang sửa, key = step|folder
  amendView: null,            // { phase: 'confirm', p } | { phase: 'done', ... }: phần chỉ có ở trình duyệt
  amendMsg: null,
};

// ===== Gọi API =====
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return data;
}

async function act(method, url, body) {
  try { const r = await api(method, url, body); await poll(); return r ?? true; }
  catch (e) { toast(e.message); return null; }
}

function toast(msg, ok = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = ok ? 'ok' : ''; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.hidden = true, ok ? 2500 : 8000);
}
$('#toast').onclick = () => $('#toast').hidden = true;

// Bấm hai lần để xác nhận, không dùng confirm() chặn trang
function confirmOnce(btn, msg) {
  if (btn.dataset.armed) { delete btn.dataset.armed; return true; }
  btn.dataset.armed = '1';
  toast(msg);
  setTimeout(() => delete btn.dataset.armed, 4000);
  return false;
}

// ===== Tab =====
function showTab(name) {
  ui.tab = name;
  store.set('tab', name);
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.page').forEach(p => p.hidden = p.id !== name);
  renderTop();
  if (name === 'setup') loadSetup(ui.wfId);
  else { ensureDef(ui.wfId).then(renderRun); scrollLog(true); }
}
document.querySelectorAll('.tab').forEach(b => b.onclick = () => showTab(b.dataset.tab));

function selectWorkflow(id) {
  ui.wfId = id;
  if (id) store.set('wf', id);
}

async function ensureDef(id) {
  if (!id || ui.defs[id]) return;
  try { ui.defs[id] = await api('GET', `/api/workflow?id=${encodeURIComponent(id)}`); } catch { }
}

// ===== Thanh trên =====
function renderTop() {
  const s = ui.snap;
  if (!s) return;
  const running = ui.tab === 'run';
  $('#top-repo').hidden = running;
  $('#top-repo').textContent = s.repoRoot;
  $('#top-busy').hidden = !s.busy;
  $('#top-reset').hidden = !running || !s.workflowId;
  $('#top-reset').disabled = s.busy || !!s.amend;

  const el = $('#top-wf');
  if (!running) { el.innerHTML = ''; return; }
  if (s.workflowId) { el.textContent = s.workflow?.name ?? s.workflowId; return; }
  if (s.workflows.length > 1) {
    el.innerHTML = `<select id="run-wf" aria-label="Chọn workflow">${s.workflows.map(w =>
      `<option value="${esc(w.id)}" ${w.id === ui.wfId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>`;
    $('#run-wf').onchange = async (e) => { selectWorkflow(e.target.value); await ensureDef(ui.wfId); renderRun(); };
  } else el.textContent = s.workflows[0]?.name ?? '';
}
$('#top-reset').onclick = (e) => {
  if (!confirmOnce(e.target, 'Bấm lần nữa để làm lại từ đầu (commit đã tạo vẫn giữ nguyên)')) return;
  selectWorkflow(ui.snap.workflowId);
  ui.amendView = null;
  act('POST', '/api/run/reset');
};

// ===== Hỏi trạng thái mỗi giây =====
async function poll() {
  let s;
  try { s = await api('GET', `/api/run?logFrom=${ui.logFrom}`); }
  catch { $('#top-busy').hidden = false; $('#top-busy').textContent = 'Mất kết nối tới tool'; return; }
  $('#top-busy').textContent = 'Đang chạy…';
  if (s.logFrom !== ui.logFrom) $('#log').innerHTML = '';    // log bị cắt bớt hoặc làm lại
  appendLog(s.log);
  ui.logFrom = s.logTotal;

  const prev = ui.snap;
  ui.snap = s;
  if (ui.tab === 'run' && ui.amendView?.phase === 'confirm') refreshPreview();   // điều kiện có thể đổi từ ngoài tool
  if (!ui.wfId || !s.workflows.some(w => w.id === ui.wfId)) selectWorkflow(s.workflowId || s.workflows[0]?.id || null);

  const key = JSON.stringify({ ...s, log: null, logFrom: null, logTotal: null });
  if (key === ui.lastKey) return;
  ui.lastKey = key;
  renderTop();
  if (ui.tab === 'run') {
    if (!s.workflowId) await ensureDef(ui.wfId);
    renderRun();
  } else if (!prev || prev.inProgress !== s.inProgress || !!prev.amend !== !!s.amend || JSON.stringify(prev.workflows) !== JSON.stringify(s.workflows)) {
    renderSetupLeft(); renderStepList(); renderEditor();
  }
}

// ===== Nhật ký =====
function logClass(t) {
  if (/LỖI|TIMEOUT|\] Fail|→ lỗi|Conflict|không chạy được/i.test(t)) return 'c-fail';
  if (/\] Pass|commit [0-9a-f]{7}|tự commit|Đã sửa xong|chạy xong/.test(t)) return 'c-ok';
  if (/restore|Tạm dừng|Sửa tay|Đang sửa|rebase dở|Dừng ở/.test(t)) return 'c-warn';
  if (/^\$ |Sang step|^---|^===|Tiếp tục/.test(t)) return 'c-blue';
  if (/^exit 0$|NoChange/.test(t)) return 'c-dim';
  return '';
}
function appendLog(lines) {
  if (!lines.length) return;
  const el = $('#log');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  el.insertAdjacentHTML('beforeend', lines.map(l => {
    const m = /^(\d\d:\d\d:\d\d) (.*)$/.exec(l);
    const [ts, text] = m ? [m[1], m[2]] : ['', l];
    return `<div class="${logClass(text)}"><span class="ts">${ts}</span> ${esc(text)}</div>`;
  }).join(''));
  while (el.children.length > 500) el.firstChild.remove();
  if (atBottom) scrollLog(true);
}
function scrollLog(force) { const el = $('#log'); if (force) el.scrollTop = el.scrollHeight; }

// ======================================================================
// Màn Chạy
// ======================================================================
const STATUS = {
  Pending: ['Chờ chạy', 't-neutral'], WaitingManual: ['Chờ dev sửa', 't-warn'], Review: ['Chờ review', 't-blue'],
  Skipped: ['Bỏ qua', 't-neutral'],
};
function stepLabel(run) {
  const st = run?.status ?? 'Pending';
  if (st !== 'Done') return STATUS[st];
  if (run.auto) return ['Tự commit', 't-pass'];
  if (run.folders.some(f => f.restored)) return ['Hoàn tất · có restore', 't-warn'];
  return ['Hoàn tất', 't-pass'];
}
const typeLabel = (st) => st.kind === 'manual' ? 'Sửa tay' : `Gọi app · ${st.shell === 'powershell' ? 'PowerShell' : 'CMD'}`;
const chip = ([text, tone]) => `<span class="chip ${tone}">${esc(text)}</span>`;

function runWorkflow() {
  const s = ui.snap;
  if (s.workflowId) return s.workflow;
  return ui.defs[ui.wfId]?.workflow ?? null;
}
function runOf(stepId) { return ui.snap.workflowId ? ui.snap.steps[stepId] : undefined; }
function curIndex(wf) {
  const s = ui.snap;
  if (!s.workflowId) return 0;
  if (!s.currentStepId) return wf.steps.length;       // đã chạy xong
  return wf.steps.findIndex(x => x.id === s.currentStepId);
}
function commits(wf) {
  const out = [];
  wf.steps.forEach((st, i) => (runOf(st.id)?.folders ?? []).forEach(f => { if (f.commitSha) out.push({ i, st, f }); }));
  return out;
}

function renderRun() {
  const s = ui.snap;
  if (!s || ui.tab !== 'run') return;
  const wf = runWorkflow();
  const focus = document.activeElement?.id, caret = document.activeElement?.selectionStart;

  if (!wf) {
    $('#side-steps').innerHTML = ''; $('#side-folders').hidden = true;
    $('#run-main').innerHTML = s.workflowError
      ? `<div class="error-box">${esc(s.workflowError)}</div>`
      : `<div class="empty-box">Chưa có workflow nào. Sang tab <b>Thiết lập</b> để tạo workflow đầu tiên.</div>`;
    renderHist(null);
    return;
  }
  const cur = curIndex(wf);
  renderSide(wf, cur);
  $('#run-main').innerHTML = renderMain(wf, cur);
  renderHist(wf, cur);

  if (focus && document.getElementById(focus)) {
    const el = document.getElementById(focus);
    el.focus();
    if (caret != null && el.setSelectionRange) el.setSelectionRange(caret, caret);
  }
}

function renderSide(wf, cur) {
  const s = ui.snap, finished = cur >= wf.steps.length;
  $('#side-steps').innerHTML = wf.steps.map((st, i) => {
    const run = runOf(st.id);
    const active = i === cur && !finished;
    const doneLike = run?.status === 'Done' || run?.status === 'Skipped';
    return `<div class="side-step ${active ? 'on' : ''}">
      <span class="dot ${doneLike ? 'dot-done' : active ? 'dot-active' : 'dot-idle'}">${i + 1}</span>
      <div class="stack-8" style="gap:4px;min-width:0;flex-grow:1">
        <div style="font-size:14px;font-weight:600">${esc(st.name)}</div>
        <div class="side-type">${esc(typeLabel(st))}</div>
        <div>${chip(stepLabel(run))}</div>
      </div></div>`;
  }).join('');
  $('#side-folders').hidden = !wf.folders.length;
  $('#side-folders').innerHTML = `Folder chạy theo thứ tự: <span class="mono">${wf.folders.map(esc).join(' → ')}</span>`;
}

function renderMain(wf, cur) {
  const s = ui.snap;
  if (s.amend || ui.amendView) return renderAmend(wf, cur);
  if (s.workflowError) return `<div class="error-box">${esc(s.workflowError)}</div>`;
  const n = wf.steps.length;

  if (cur >= n) {
    const cs = commits(wf);
    const auto = wf.steps.filter(x => runOf(x.id)?.auto).length;
    const restored = wf.steps.reduce((a, x) => a + (runOf(x.id)?.folders.filter(f => f.restored).length ?? 0), 0);
    return `<div class="done-panel"><div class="t">Workflow hoàn tất</div>
      <div class="d">Tất cả step đã chạy xong. ${cs.length} commit đã tạo (${auto} step tự commit ở chế độ liên tiếp), ${restored} folder đã restore.</div>
      <div><button class="btn btn-outline-green" data-act="restart" ${s.busy ? 'disabled' : ''}>Chạy lại từ đầu</button></div></div>`;
  }

  const st = wf.steps[cur];
  const run = runOf(st.id) ?? { status: 'Pending', folders: [] };
  const busy = s.busy, paused = s.paused;
  const cmdLine = st.kind === 'manual' ? 'Dev tự sửa · công cụ quét git status sau đó' : '> ' + [st.app, ...(st.args ?? [])].join(' ');

  // Chế độ chạy
  if (!ui.endId || wf.steps.findIndex(x => x.id === ui.endId) <= cur) ui.endId = wf.steps[cur + 1]?.id ?? null;
  const batch = ui.mode === 'batch' && cur < n - 1;
  const endIdx = wf.steps.findIndex(x => x.id === ui.endId);
  const canRun = run.status === 'Pending' && !busy && !paused;
  const running = busy && run.status === 'Pending' && s.workflowId;
  let html = `
    <div class="step-head">
      <div class="grow stack-8" style="gap:6px;min-width:0">
        <div class="meta">STEP ${cur + 1} / ${n} · ${esc(typeLabel(st))}</div>
        <h2>${esc(st.name)}</h2>
        <div class="cmd">${esc(cmdLine)}</div>
      </div>
      ${chip(stepLabel(run))}
    </div>
    <div class="mode-bar">
      <div class="seg">
        <button data-act="mode-single" class="${batch ? '' : 'on'}">Từng step</button>
        <button data-act="mode-batch" class="${batch ? 'on' : ''}" ${cur >= n - 1 ? 'disabled' : ''}>Liên tiếp</button>
      </div>
      ${batch ? `<div class="row-center" style="gap:6px"><span style="color:var(--ink-2)">đến step</span>${wf.steps.slice(cur + 1).map((x, k) =>
        `<button class="end-btn ${x.id === ui.endId ? 'on' : ''}" data-act="end" data-id="${esc(x.id)}">${cur + k + 2}</button>`).join('')}</div>` : ''}
      <div class="grow hint">${batch ? 'Pass 100% → tự commit, chạy tiếp. Fail hoặc gặp step Sửa tay → dừng.' : 'Chạy 1 step rồi dừng chờ review.'}</div>
      <button class="btn btn-primary btn-lg" data-act="run" ${canRun ? '' : 'disabled'}>${running ? 'Đang chạy…' : batch ? `Chạy liên tiếp ${cur + 1} → ${endIdx + 1}` : `Chạy step ${cur + 1}`}</button>
    </div>`;
  if (s.error) html += `<div class="error-box">${esc(s.error)}</div>`;
  if (paused) html += `<div class="paused"><span class="grow"><b>Workflow đang tạm dừng.</b> Working tree giữ nguyên, lần sau mở lại sẽ tiếp tục đúng step này.</span>
      <button class="btn btn-sm btn-dark-outline" data-act="resume" style="font-weight:600">Tiếp tục</button></div>`;

  if (run.status === 'Pending' && !running) {
    html += `<div class="idle-box"><div class="t">Sẵn sàng chạy step ${cur + 1}</div><div class="d">${st.kind === 'manual'
      ? 'Step sửa tay: công cụ hiện hướng dẫn, dev sửa xong bấm xác nhận để quét thay đổi.'
      : `Lệnh sẽ chạy lần lượt trên ${(st.folders ?? wf.folders).length} folder. Folder fail không chặn folder sau.`}</div></div>`;
  }
  if (running) {
    const total = (st.folders ?? wf.folders).length;
    html += `<div class="idle-box"><div class="t">Đang chạy step ${cur + 1}…</div><div class="d">Xong ${run.folders.length} / ${total} folder. Xem nhật ký bên phải.</div></div>`;
  }
  if (run.status === 'WaitingManual') {
    html += `<div class="manual-panel"><div class="k">STEP SỬA TAY · HƯỚNG DẪN</div><div class="g">${esc(st.guide)}</div>
      <div class="h">Sửa trong IDE, xong bấm nút bên dưới. Công cụ sẽ quét <b>git status</b> từng folder và soạn commit cho folder có thay đổi.</div>
      <div class="row-8"><button class="btn btn-primary btn-lg" data-act="manual-done" ${busy || paused ? 'disabled' : ''}>Đã sửa xong · quét thay đổi</button>
      <button class="btn btn-outline-warn" data-act="skip" ${busy || paused ? 'disabled' : ''}>Bỏ qua step này</button></div></div>`;
  }
  if (run.status === 'Review') html += renderReview(wf, st, run, cur);
  return html;
}

function renderReview(wf, st, run, cur) {
  const s = ui.snap, lock = s.busy || s.paused;
  const rows = run.folders.map((f, ri) => {
    const key = `${st.id}|${f.folder}`;
    let label, tone, cls = '';
    if (f.commitSha) [label, tone] = [`Đã commit · ${short(f.commitSha)}`, 't-pass'];
    else if (f.restored) [label, tone] = ['Đã restore', 't-warn'];
    else if (f.result === 'NoChange') [label, tone] = ['Không đổi', 't-neutral'];
    else if (f.result === 'Pass') [label, tone, cls] = ['PASS · chờ commit', 't-pass', 'pass'];
    else [label, tone, cls] = ['FAIL · commit bị khóa', 't-fail', 'fail'];
    const pending = !f.commitSha && !f.restored && !s.paused;
    let body = '';
    if (pending && f.result === 'Pass') body = `<div class="row-center" style="gap:10px">
      <input id="msg-${ri}" class="msg" data-draft="${esc(key)}" aria-label="Message commit ${esc(f.folder)}" value="${esc(ui.drafts[key] ?? f.commitMessage)}" ${lock ? 'disabled' : ''}>
      <button class="btn btn-green btn-sm" data-act="commit" data-folder="${esc(f.folder)}" data-key="${esc(key)}" ${lock ? 'disabled' : ''}>Commit</button></div>`;
    if (pending && f.result === 'Fail') body = `<div class="row-8" style="gap:12px;align-items:stretch">
      <div class="fail-cmds"><div>git restore --staged --worktree -- ${esc(f.folder)}/</div><div>git clean -fd -- ${esc(f.folder)}/</div></div>
      <div class="fail-actions">
        <button class="btn-red" data-act="restore" data-folder="${esc(f.folder)}" ${lock ? 'disabled' : ''}>Chạy restore</button>
        <button class="btn-dark-outline" data-act="rerun" data-folder="${esc(f.folder)}" ${lock ? 'disabled' : ''}>Chạy lại folder</button>
        <button class="locked-btn" disabled>Commit (khóa)</button>
      </div></div>`;
    return `<div class="frow ${pending ? cls : ''}"><div class="row-center" style="gap:12px">
      <span class="name">${esc(f.folder)}</span><span class="fsum" title="${esc(f.summary)}">${esc(f.summary)}</span>${chip([label, tone])}</div>${body}</div>`;
  }).join('');

  const pendPass = run.folders.filter(f => !f.handled && f.result === 'Pass').length;
  const pendFail = run.folders.filter(f => !f.handled && f.result === 'Fail').length;
  const nextOk = pendPass === 0 && pendFail === 0 && !lock;
  return `<div class="stack-8" style="gap:10px">${rows}</div>
    <div class="review-foot">
      <div class="grow" style="color:var(--ink-2)">${pendPass} folder chờ commit · ${pendFail} folder fail chưa xử lý</div>
      <button class="btn btn-outline-green" data-act="commit-all" ${pendPass === 0 || lock ? 'disabled' : ''}>Commit tất cả folder pass</button>
      <button class="btn" data-act="pause" ${s.paused || s.busy ? 'disabled' : ''}>Dừng workflow</button>
      <button class="btn btn-primary" data-act="next" ${nextOk ? '' : 'disabled'}>Sang step kế</button>
    </div>
    ${nextOk || s.paused ? '' : '<div class="next-hint">Sang step kế bị khóa: còn folder chưa commit hoặc chưa restore — tránh để restore ở step sau xóa công của step này.</div>'}`;
}

// ----- Sửa lại commit cũ -----
function commitInfo(wf, sha) {
  for (let i = 0; i < wf.steps.length; i++)
    for (const f of runOf(wf.steps[i].id)?.folders ?? [])
      if (f.commitSha === sha) return { i, st: wf.steps[i], f };
  return null;
}
function stepRange(wf, ids) {
  const nums = ids.map(id => wf.steps.findIndex(x => x.id === id) + 1).filter(x => x > 0).sort((a, b) => a - b);
  if (!nums.length) return '—';
  return nums[0] === nums[nums.length - 1] ? String(nums[0]) : `${nums[0]}–${nums[nums.length - 1]}`;
}
async function refreshPreview() {
  const v = ui.amendView;
  try {
    const p = await api('GET', `/api/amend/preview?sha=${v.p.sha}`);
    if (ui.amendView !== v || JSON.stringify(p) === JSON.stringify(v.p)) return;
    v.p = p; renderRun();
  } catch { }
}

function renderAmend(wf, cur) {
  const s = ui.snap, n = wf.steps.length;
  const backStep = Math.min(cur + 1, n);
  const v = ui.amendView;

  if (v?.phase === 'done') {
    return `<div class="done-panel"><div class="t" style="font-size:20px">Đã sửa xong commit của step ${v.stepNum}</div>
      <div class="d">Commit mới <b class="mono">${short(v.newSha)}</b> thay cho <span class="mono">${short(v.oldSha)}</span>. ${v.later} commit phía sau đã được áp lại: nội dung giữ nguyên, hash đổi mới.</div>
      <div><button class="btn btn-outline-green" data-act="amend-close">Quay lại step ${backStep}</button></div></div>`;
  }

  if (v?.phase === 'confirm' && !s.amend) {
    const p = v.p, info = commitInfo(wf, p.sha), stepNum = info ? info.i + 1 : '?';
    const blocked = !p.clean || p.pushed;
    const check = (ok, title, detail) => `<div class="check"><span class="ic ${ok ? 'ok' : 'no'}">${ok ? '✓' : '✕'}</span>
      <div class="stack-8" style="gap:2px"><span style="font-weight:600">${title}</span><span class="small muted">${detail}</span></div></div>`;
    return `${amendHead(stepNum, p.folder, `Quay về commit ${short(p.sha)}`, ['Chờ xác nhận', 't-blue'])}
      ${commitCard(p.sha, p.message, `Step ${stepNum} · ${esc(info?.st.name ?? '')} · ${p.later} commit phía sau`)}
      <div class="grid-2">
        <div class="card info-card"><div class="t">Công cụ sẽ làm gì</div>
          <div class="info-line"><span class="n">1</span><span>Tạm gác ${p.later} commit phía sau (step ${stepRange(wf, p.laterSteps)}).</span></div>
          <div class="info-line"><span class="n">2</span><span>Đưa ${p.files.length} file của commit này về thành thay đổi chưa commit.</span></div>
          <div class="info-line"><span class="n">3</span><span>Dev sửa trong IDE → commit lại, <b>chỉ cho step ${stepNum}</b>.</span></div>
          <div class="info-line"><span class="n">4</span><span>Áp lại ${p.later} commit phía sau lên trên, rồi quay về step ${backStep}.</span></div>
        </div>
        <div class="card info-card"><div class="t">Điều kiện</div>
          ${check(p.clean, 'Working tree sạch', p.clean ? 'Không còn thay đổi treo trong repo.' : 'git status còn thay đổi chưa commit hoặc restore, xử lý trước.')}
          ${check(!p.pushed, 'Commit chưa push lên remote', p.pushed ? 'Commit đã có trên remote: sửa lại sẽ phải force push nên công cụ chặn.' : 'Nếu đã push, sửa lại sẽ phải force push nên công cụ chặn.')}
        </div>
      </div>
      <div class="term">
        <div class="c">git status --porcelain            # phải rỗng</div>
        <div class="c">git branch -r --contains ${short(p.sha)}   # phải rỗng = chưa push</div>
        <div>git rebase -i ${short(p.sha)}~1           # công cụ đổi "pick ${short(p.sha)}" → "edit"</div>
        <div>git reset --soft HEAD~1           # file của commit → thay đổi (staged)</div>
      </div>
      <div class="row-center" style="gap:10px">
        <button class="btn btn-primary btn-lg" data-act="amend-start" ${blocked || s.busy ? 'disabled' : ''}>Quay về commit này</button>
        <button class="btn" data-act="amend-close">Hủy</button>
      </div>`;
  }

  // Đang sửa (theo trạng thái trên server)
  const a = s.amend;
  const info = a.sha ? commitInfo(wf, a.sha) : null, stepNum = info ? info.i + 1 : '?';
  const later = a.oldShas.length ? a.oldShas.length - 1 : 0;
  if (a.conflict || !a.sha) {
    const files = s.conflicts ?? [];
    return `${amendHead(stepNum, a.folder || '—', a.sha ? `Conflict khi áp lại commit sau` : 'Repo đang dở một git rebase', ['Đang conflict', 't-fail'])}
      <div class="warn-banner">${a.sha
        ? `Rebase dừng ở commit bị conflict: step sau cũng sửa đúng dòng vừa sửa ở step ${stepNum}. Gỡ conflict trong IDE rồi bấm <b>Tiếp tục</b>, hoặc <b>Hủy toàn bộ</b> để về như trước khi bấm “Sửa lại”.`
        : 'Tool được mở lại khi repo đang dở một git rebase. Gỡ conflict (nếu có) rồi bấm <b>Tiếp tục</b>, hoặc <b>Hủy toàn bộ</b>.'}</div>
      <div class="stack-8" style="gap:6px"><div class="small" style="font-weight:600;color:var(--ink-2)">File đang conflict</div>
        ${files.length ? files.map(f => `<div class="file-row conflict"><span class="s">U</span><span>${esc(f)}</span></div>`).join('')
          : '<div class="small muted">Không còn file conflict — bấm Tiếp tục.</div>'}</div>
      <div class="term"><div>git add -u</div><div>git rebase --continue             # conflict → dừng; Hủy → git rebase --abort</div></div>
      <div class="row-center" style="gap:10px">
        <button class="btn btn-primary btn-lg" data-act="amend-finish" ${s.busy ? 'disabled' : ''}>Tiếp tục</button>
        <button class="btn btn-outline-red" data-act="amend-abort" ${s.busy ? 'disabled' : ''}>Hủy toàn bộ</button>
      </div>`;
  }

  const files = s.amendFiles ?? [];
  const msg = ui.amendMsg ?? a.message;
  return `${amendHead(stepNum, a.folder, `Quay về commit ${short(a.sha)}`, ['Đang sửa · rebase dừng', 't-warn'])}
    ${commitCard(a.sha, a.message, `Step ${stepNum} · ${esc(info?.st.name ?? '')} · ${later} commit phía sau`)}
    <div class="warn-banner">Đã quay về trước commit <b class="mono">${short(a.sha)}</b>. ${later} commit phía sau đang tạm gác. File của commit đã thành <b>thay đổi (staged)</b>: sửa trong IDE rồi commit lại. Nút chạy workflow bị khóa cho đến khi xong.</div>
    <div class="stack-8" style="gap:6px"><div class="small" style="font-weight:600;color:var(--ink-2)">Thay đổi hiện có</div>
      ${files.length ? files.map(l => { const [st, ...p] = l.split(/\s+/); return `<div class="file-row"><span class="s">${esc(st)}</span><span>${esc(p.join(' '))}</span></div>`; }).join('')
        : '<div class="small muted">Chưa có thay đổi nào đang staged.</div>'}</div>
    <label class="field">Message commit (giữ nguyên mẫu, sửa được)
      <input id="amend-msg" class="input mono" value="${esc(msg)}"></label>
    <div class="term"><div>git add -- ${esc(a.folder)}/</div><div>git commit -m "${esc(msg)}"</div><div>git rebase --continue             # áp lại ${later} commit phía sau</div></div>
    <div class="row-center" style="gap:10px">
      <button class="btn btn-green btn-lg" data-act="amend-finish" ${s.busy ? 'disabled' : ''}>Commit lại · chỉ step ${stepNum}</button>
      <button class="btn btn-outline-red" data-act="amend-abort" ${s.busy ? 'disabled' : ''}>Hủy · trả nguyên trạng</button>
      <span class="small muted">Hủy = <span class="mono">git rebase --abort</span>, mọi thứ về như trước khi bấm.</span>
    </div>`;
}
const amendHead = (stepNum, folder, title, c) => `<div class="step-head"><div class="grow stack-8" style="gap:6px">
  <div class="meta">SỬA LẠI COMMIT CŨ · STEP ${stepNum} · ${esc(folder)}</div><h2>${esc(title)}</h2></div>${chip(c)}</div>`;
const commitCard = (sha, msg, sub) => `<div class="card commit-card"><span class="sha">${short(sha)}</span>
  <div class="stack-8" style="gap:3px;min-width:0;flex-grow:1"><div class="mono" style="font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(msg)}</div>
  <div class="small muted">${sub}</div></div></div>`;

// ----- Lịch sử commit -----
function renderHist(wf, cur) {
  const s = ui.snap;
  if (!wf) { $('#hist').innerHTML = ''; $('#hist-count').textContent = ''; $('#hist-lock').hidden = true; return; }
  const cs = commits(wf).reverse();
  const amendOn = !!s.amend || ui.amendView?.phase === 'confirm';
  const target = s.amend?.sha ?? ui.amendView?.p?.sha;
  $('#hist-count').textContent = `${cs.length} commit · mới nhất trên cùng`;
  $('#hist').innerHTML = cs.length ? cs.map(({ i, f }) => `<div class="hist-item ${f.commitSha === target ? 'target' : ''}">
      <div class="row-center" style="gap:6px"><span class="sha">${short(f.commitSha)}</span><span class="s">S${i + 1}</span>
      ${f.amended ? '<span class="amended">đã sửa</span>' : ''}<span class="grow"></span>
      <button class="edit" data-act="amend" data-sha="${f.commitSha}" aria-label="Sửa lại commit ${short(f.commitSha)}" ${amendOn || s.busy ? 'disabled' : ''}>Sửa lại</button></div>
      <div class="msg" title="${esc(f.commitMessage)}">${esc(f.commitMessage)}</div></div>`).join('')
    : '<div class="hist-empty">Chưa có commit nào. Chạy vài step để có commit ở đây.</div>';

  const curRun = cur < wf.steps.length ? runOf(wf.steps[cur].id) : null;
  const dirty = !!curRun && (curRun.status === 'WaitingManual' || (curRun.status === 'Review' && curRun.folders.some(f => !f.handled)));
  const lock = $('#hist-lock');
  lock.hidden = !(amendOn || (dirty && cs.length));
  lock.textContent = amendOn ? 'Đang sửa một commit cũ, xong hoặc hủy trước khi sửa commit khác.'
    : 'Step hiện tại còn thay đổi chưa commit/restore. Sửa commit cũ vẫn mở được, nhưng chỉ bắt đầu khi working tree sạch.';
}

// ----- Thao tác trên màn Chạy -----
document.addEventListener('input', e => {
  if (e.target.dataset.draft) ui.drafts[e.target.dataset.draft] = e.target.value;
  if (e.target.id === 'amend-msg') ui.amendMsg = e.target.value;
});

$('#run').addEventListener('click', async e => {
  const b = e.target.closest('button[data-act]');
  if (!b || b.disabled) return;
  const s = ui.snap, wf = runWorkflow();
  const cur = wf ? curIndex(wf) : 0;
  const stepId = encodeURIComponent(wf?.steps[cur]?.id ?? '');
  const folder = (b.dataset.folder ?? '').split('/').map(encodeURIComponent).join('/');
  switch (b.dataset.act) {
    case 'mode-single': ui.mode = 'single'; renderRun(); break;
    case 'mode-batch': ui.mode = 'batch'; renderRun(); break;
    case 'end': ui.endId = b.dataset.id; renderRun(); break;
    case 'run': {
      if (!s.workflowId && !await act('POST', '/api/run/start', { workflow: ui.wfId })) break;
      if (ui.mode === 'batch' && ui.endId) await act('POST', `/api/run/until/${encodeURIComponent(ui.endId)}`);
      else await act('POST', `/api/run/steps/${stepId}/run`);
      ui.mode = 'single';
      break;
    }
    case 'restart': selectWorkflow(s.workflowId); await act('POST', '/api/run/reset'); break;
    case 'manual-done': await act('POST', `/api/run/steps/${stepId}/manual-done`); break;
    case 'skip': await act('POST', `/api/run/steps/${stepId}/skip`); break;
    case 'commit': {
      const key = b.dataset.key;
      const msg = ui.drafts[key] ?? document.querySelector(`[data-draft="${CSS.escape(key)}"]`)?.value;
      if (await act('POST', `/api/run/steps/${stepId}/folders/${folder}/commit`, { message: msg })) delete ui.drafts[key];
      break;
    }
    case 'commit-all': {
      const messages = {};
      document.querySelectorAll('#run-main [data-draft]').forEach(i => messages[i.dataset.draft.split('|').slice(1).join('|')] = i.value);
      if (await act('POST', `/api/run/steps/${stepId}/commit-all`, { messages }))
        Object.keys(ui.drafts).filter(k => k.startsWith(wf.steps[cur].id + '|')).forEach(k => delete ui.drafts[k]);
      break;
    }
    case 'restore':
      if (confirmOnce(b, 'Bấm lần nữa để xóa mọi thay đổi chưa commit của folder này'))
        await act('POST', `/api/run/steps/${stepId}/folders/${folder}/restore`);
      break;
    case 'rerun': await act('POST', `/api/run/steps/${stepId}/folders/${folder}/rerun`); break;
    case 'next': await act('POST', '/api/run/next'); break;
    case 'pause': await act('POST', '/api/run/pause'); break;
    case 'resume': await act('POST', '/api/run/resume'); break;
    case 'amend':
      try { ui.amendView = { phase: 'confirm', p: await api('GET', `/api/amend/preview?sha=${b.dataset.sha}`) }; renderRun(); }
      catch (err) { toast(err.message); }
      break;
    case 'amend-close': ui.amendView = null; renderRun(); break;
    case 'amend-start':
      if (await act('POST', '/api/amend/start', { sha: ui.amendView.p.sha })) { ui.amendView = null; ui.amendMsg = null; renderRun(); }
      break;
    case 'amend-finish': {
      const a = s.amend, info = a?.sha ? commitInfo(wf, a.sha) : null;
      const r = await act('POST', '/api/amend/finish', { message: a?.conflict ? null : ($('#amend-msg')?.value ?? null) });
      if (r && !r.conflict) {
        ui.amendMsg = null;
        ui.amendView = r.newSha ? { phase: 'done', newSha: r.newSha, oldSha: a.sha, later: r.later, stepNum: info ? info.i + 1 : '?' } : null;
        renderRun();
      }
      break;
    }
    case 'amend-abort':
      if (confirmOnce(b, 'Bấm lần nữa để hủy: git rebase --abort, mọi thứ về như trước khi bấm “Sửa lại”')) {
        if (await act('POST', '/api/amend/abort')) { ui.amendMsg = null; renderRun(); }
      }
      break;
  }
});

// ======================================================================
// Màn Thiết lập
// ======================================================================
const DEFAULT_PATTERN = '[{folder}]: {message}';
const setup = {
  id: null, wf: null, loadErrors: [],
  items: [],             // [{ id, saved: StepDef|null, draft: StepDef|null }]
  sel: null, confirmDel: null,
  notice: '', noticeErr: false, errors: [],
  dragStep: null, dragFolder: null,
};
const readonly = () => !!ui.snap?.inProgress || !!ui.snap?.amend;
const viewOf = (it) => it.draft ?? it.saved;
const selItem = () => setup.items.find(x => x.id === setup.sel);

async function loadSetup(id) {
  renderSetupLeft();
  if (!id) { setup.id = null; setup.wf = null; setup.items = []; renderStepList(); renderEditor(); return; }
  try {
    const r = await api('GET', `/api/workflow?id=${encodeURIComponent(id)}`);
    const keepSel = setup.id === id ? setup.sel : null;
    Object.assign(setup, { id, wf: r.workflow, loadErrors: r.errors, confirmDel: null, errors: [], notice: '' });
    setup.items = r.workflow.steps.map(s => ({ id: s.id, saved: s, draft: null }));
    setup.sel = setup.items.some(x => x.id === keepSel) ? keepSel : setup.items[0]?.id ?? null;
    ui.defs[id] = r;
  } catch (e) { toast(e.message); }
  renderSetupLeft(); renderStepList(); renderEditor();
}

// Ghi cả workflow: bước đã lưu theo thứ tự hiện tại; bước đang sửa chỉ ghi khi bấm Lưu step
async function persist(override) {
  const steps = setup.items.map(it => override?.id === it.id ? override.step : it.saved).filter(Boolean);
  const wf = { ...setup.wf, steps };
  try {
    await api('PUT', `/api/workflow?id=${encodeURIComponent(setup.id)}`, wf);
    setup.wf = wf; setup.errors = []; setup.loadErrors = [];
    ui.defs[setup.id] = { id: setup.id, workflow: wf, errors: [] };
    ui.lastKey = '';
    return true;
  } catch (e) {
    setup.errors = e.message.split('\n').map(x => x.replace(/^- /, '')).filter(x => x && !x.endsWith(':'));
    setup.notice = 'Chưa lưu được'; setup.noticeErr = true;
    renderEditor();
    return false;
  }
}

function slug(text) {
  const base = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';
  return base;
}
function uniqueId(base, taken) {
  let id = base, k = 2;
  while (taken.includes(id)) id = `${base}-${k++}`;
  return id;
}

// ----- Cột trái: workflow + folder -----
function renderSetupLeft() {
  const s = ui.snap;
  if (!s) return;
  const ro = readonly();
  $('#wf-list').innerHTML = s.workflows.map(w =>
    `<button class="wf-item ${w.id === setup.id ? 'on' : ''}" data-wf="${esc(w.id)}">${esc(w.name)}</button>`).join('')
    || '<div class="hint">Chưa có workflow nào.</div>';
  $('#wf-new').disabled = ro;
  $('#folder-add').disabled = ro || !setup.wf;
  const folders = setup.wf?.folders ?? [];
  $('#folder-list').innerHTML = folders.map((f, i) => `<div class="folder-row" draggable="${!ro}" data-fi="${i}">
      ${ICON.grip('#A9ACB3')}<span class="num">${i + 1}</span><span class="name" title="${esc(f)}">${esc(f)}</span>
      <button class="x" data-rmfolder="${i}" aria-label="Bỏ folder ${esc(f)}" ${ro ? 'disabled' : ''}>×</button></div>`).join('')
    || (setup.wf ? '<div class="hint">Chưa có folder nào. Bấm + để thêm.</div>' : '');
}

$('#wf-list').addEventListener('click', e => {
  const b = e.target.closest('[data-wf]');
  if (!b) return;
  if (setup.items.some(x => x.draft) && !confirmOnce(b, 'Có step chưa lưu. Bấm lần nữa để bỏ thay đổi và chuyển workflow')) return;
  selectWorkflow(b.dataset.wf);
  loadSetup(b.dataset.wf);
});
$('#wf-new').onclick = () => { $('#wf-new-form').hidden = false; $('#wf-new').hidden = true; $('#wf-new-name').value = ''; $('#wf-new-name').focus(); };
$('#wf-new-cancel').onclick = () => { $('#wf-new-form').hidden = true; $('#wf-new').hidden = false; };
$('#wf-new-name').onkeydown = (e) => { if (e.key === 'Enter') $('#wf-new-ok').click(); if (e.key === 'Escape') $('#wf-new-cancel').click(); };
$('#wf-new-ok').onclick = async () => {
  const name = $('#wf-new-name').value.trim();
  if (!name) return;
  const id = uniqueId(slug(name), ui.snap.workflows.map(w => w.id));
  const wf = { name, folders: [], defaults: { timeoutSeconds: 300, commitPattern: DEFAULT_PATTERN, psHost: 'pwsh' }, steps: [] };
  try {
    await api('PUT', `/api/workflow?id=${encodeURIComponent(id)}`, wf);
    $('#wf-new-cancel').click();
    selectWorkflow(id);
    await poll();
    await loadSetup(id);
    toast('Đã tạo workflow', true);
  } catch (e) { toast(e.message); }
};

$('#folder-add').onclick = () => { $('#folder-new-form').hidden = false; $('#folder-new-name').value = ''; $('#folder-new-name').focus(); };
$('#folder-new-cancel').onclick = () => { $('#folder-new-form').hidden = true; };
$('#folder-new-name').onkeydown = (e) => { if (e.key === 'Enter') $('#folder-new-ok').click(); if (e.key === 'Escape') $('#folder-new-cancel').click(); };
$('#folder-new-ok').onclick = async () => {
  const name = $('#folder-new-name').value.trim().replace(/[\\/]+$/, '');
  if (!name) return;
  const before = setup.wf.folders;
  setup.wf = { ...setup.wf, folders: [...before, name] };
  if (await persist()) { $('#folder-new-form').hidden = true; setup.notice = `Đã thêm folder ${name}`; setup.noticeErr = false; }
  else setup.wf = { ...setup.wf, folders: before };
  renderSetupLeft(); renderStepList(); renderEditor();
};
$('#folder-list').addEventListener('click', async e => {
  const b = e.target.closest('[data-rmfolder]');
  if (!b || !confirmOnce(b, 'Bấm lần nữa để bỏ folder khỏi workflow (không xóa thư mục trên đĩa)')) return;
  const i = +b.dataset.rmfolder, name = setup.wf.folders[i];
  const before = { wf: setup.wf, items: setup.items };
  setup.wf = { ...setup.wf, folders: setup.wf.folders.filter((_, k) => k !== i) };
  // Step nào chỉ định riêng folder này thì bỏ luôn khỏi danh sách của step đó
  const strip = (st) => st && st.folders ? { ...st, folders: st.folders.filter(f => f !== name).length ? st.folders.filter(f => f !== name) : null } : st;
  setup.items = setup.items.map(it => ({ ...it, saved: strip(it.saved), draft: strip(it.draft) }));
  if (!await persist()) Object.assign(setup, before);
  renderSetupLeft(); renderStepList(); renderEditor();
});
dragList('#folder-list', '.folder-row', 'fi', async (from, to) => {
  const f = [...setup.wf.folders];
  f.splice(to, 0, f.splice(from, 1)[0]);
  const before = setup.wf;
  setup.wf = { ...setup.wf, folders: f };
  if (!await persist()) setup.wf = before;
  renderSetupLeft(); renderEditor();
});

// Kéo thả dùng chung cho danh sách folder và step
function dragList(container, itemSel, attr, onMove) {
  const root = $(container);
  let from = null;
  const clear = () => root.querySelectorAll(itemSel).forEach(x => x.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging'));
  root.addEventListener('dragstart', e => {
    const it = e.target.closest(itemSel);
    if (!it || readonly()) { e.preventDefault(); return; }
    from = +it.dataset[attr];
    it.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(from)); } catch { }   // Firefox cần setData thì mới cho kéo
  });
  root.addEventListener('dragover', e => {
    const it = e.target.closest(itemSel);
    if (from == null || !it) return;
    e.preventDefault();
    const to = +it.dataset[attr];
    root.querySelectorAll(itemSel).forEach(x => x.classList.remove('drag-over-top', 'drag-over-bottom'));
    if (to !== from) it.classList.add(to < from ? 'drag-over-top' : 'drag-over-bottom');
  });
  root.addEventListener('drop', e => {
    const it = e.target.closest(itemSel);
    e.preventDefault();
    const f = from; from = null; clear();
    if (f == null || !it) return;
    const to = +it.dataset[attr];
    if (to !== f) onMove(f, to);
  });
  root.addEventListener('dragend', () => { from = null; clear(); });
}

// ----- Cột giữa: danh sách step -----
function stepSub(st) {
  const count = (st.folders ?? setup.wf.folders).length;
  return `${count} folder · ${st.kind === 'manual' ? 'dev tự sửa' : [st.app || 'chưa chọn app', ...(st.args ?? [])].join(' ')}`;
}
function badgeOf(st) {
  if (st.kind === 'manual') return '<span class="badge b-manual">Sửa tay</span>';
  return st.shell === 'powershell' ? '<span class="badge b-ps">PowerShell</span>' : '<span class="badge b-cmd">CMD</span>';
}

function renderStepList() {
  const ro = readonly(), n = setup.items.length;
  $('#step-count').textContent = setup.wf ? `${n} step` : '';
  $('#step-add').disabled = ro || !setup.wf;
  $('#step-list').innerHTML = setup.items.map((it, i) => {
    const st = viewOf(it);
    if (setup.confirmDel === it.id) return `<div class="confirm-del">
      <div>Xóa step <b>${i + 1} · ${esc(st.name)}</b>? Thao tác này không hoàn tác được.</div>
      <div class="row-8"><button class="btn btn-red btn-sm" data-sact="do-delete" data-id="${esc(it.id)}">Xóa step</button>
      <button class="btn btn-sm" data-sact="cancel-delete">Giữ lại</button></div></div>`;
    return `<div class="step-card ${it.id === setup.sel ? 'on' : ''}" draggable="${!ro}" data-si="${i}">
      <span class="handle" title="Kéo để đổi thứ tự">${ICON.grip()}</span>
      <button class="step-pick" data-sact="pick" data-id="${esc(it.id)}">
        <span class="dot dot-dark">${i + 1}</span>
        <span class="step-text"><span class="row-center" style="gap:6px;min-width:0"><span class="step-name">${esc(st.name || '(chưa đặt tên)')}</span>
          ${it.draft ? '<span class="tag-unsaved">Chưa lưu</span>' : ''}</span>
          <span class="step-sub">${esc(stepSub(st))}</span></span>
        ${badgeOf(st)}
      </button>
      <div class="updown">
        <button data-sact="up" data-i="${i}" aria-label="Chuyển step lên" ${ro || i === 0 ? 'disabled' : ''}>${ICON.up}</button>
        <button data-sact="down" data-i="${i}" aria-label="Chuyển step xuống" ${ro || i === n - 1 ? 'disabled' : ''}>${ICON.down}</button>
      </div>
      <button class="del-btn" data-sact="ask-delete" data-id="${esc(it.id)}" aria-label="Xóa step" title="${n === 1 ? 'Workflow cần ít nhất 1 step' : 'Xóa step'}" ${ro || n === 1 ? 'disabled' : ''}>${ICON.trash}</button>
    </div>`;
  }).join('');
}

async function moveStep(from, to) {
  if (to < 0 || to >= setup.items.length || from === to) return;
  const before = setup.items;
  const items = [...before];
  const it = items.splice(from, 1)[0];
  items.splice(to, 0, it);
  setup.items = items;
  if (await persist()) { setup.notice = `Đã chuyển “${viewOf(it).name}” sang vị trí ${to + 1}`; setup.noticeErr = false; }
  else setup.items = before;
  renderStepList(); renderEditor();
}
dragList('#step-list', '.step-card', 'si', moveStep);

$('#step-list').addEventListener('click', async e => {
  const b = e.target.closest('[data-sact]');
  if (!b || b.disabled) return;
  switch (b.dataset.sact) {
    case 'pick': setup.sel = b.dataset.id; setup.confirmDel = null; setup.errors = []; setup.notice = ''; break;
    case 'up': await moveStep(+b.dataset.i, +b.dataset.i - 1); return;
    case 'down': await moveStep(+b.dataset.i, +b.dataset.i + 1); return;
    case 'ask-delete': setup.confirmDel = b.dataset.id; break;
    case 'cancel-delete': setup.confirmDel = null; break;
    case 'do-delete': {
      const i = setup.items.findIndex(x => x.id === b.dataset.id), it = setup.items[i];
      const before = setup.items;
      setup.items = setup.items.filter(x => x.id !== it.id);
      setup.confirmDel = null;
      if (it.saved && !await persist()) { setup.items = before; break; }
      if (setup.sel === it.id) setup.sel = setup.items[Math.min(i, setup.items.length - 1)]?.id ?? null;
      setup.notice = `Đã xóa step “${viewOf(it).name}”`; setup.noticeErr = false;
      break;
    }
  }
  renderStepList(); renderEditor();
});

$('#step-add').onclick = () => {
  const id = uniqueId(`step-${setup.items.length + 1}`, setup.items.map(x => x.id));
  setup.items.push({ id, saved: null, draft: { id, name: 'Step mới', kind: 'app', shell: 'cmd', app: '', args: [], message: '', folders: null } });
  setup.sel = id; setup.confirmDel = null; setup.errors = [];
  setup.notice = `Đã thêm step ${setup.items.length}`; setup.noticeErr = false;
  renderStepList(); renderEditor();
};

// ----- Cột phải: sửa step -----
const SAFE = /^[A-Za-z0-9_\-.:\\\/{}=,+@]+$/;
const quoteCmd = (s) => SAFE.test(s) ? s : '"' + s.replace(/"/g, '""') + '"';
const quotePs = (s) => SAFE.test(s) ? s : "'" + s.replace(/'/g, "''") + "'";

function renderEditor() {
  const el = $('#editor');
  if (!setup.wf) {
    el.innerHTML = `<div class="empty-box">${ui.snap?.workflows.length ? 'Chọn một workflow bên trái.' : 'Chưa có workflow nào. Bấm <b>+ Workflow mới</b> để tạo.'}</div>`;
    return;
  }
  const ro = readonly();
  const it = selItem();
  const errors = [...setup.loadErrors, ...setup.errors];
  const top = `${ro ? `<div class="readonly-banner">${ui.snap.amend ? 'Đang sửa lại commit cũ' : 'Đang có lần chạy dở'}: màn Thiết lập <b>chỉ xem</b>, để sửa YAML không làm bẩn working tree giữa chừng. Xong hoặc bỏ lần chạy thì sửa được.</div>` : ''}
    ${errors.length ? `<ul class="errors">${errors.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`;
  if (!it) {
    el.innerHTML = top + `<div class="empty-box">Workflow chưa có step nào. Bấm <b>+ Thêm step</b> để thêm.</div>`;
    return;
  }
  const st = viewOf(it), idx = setup.items.indexOf(it) + 1;
  const dis = ro ? 'disabled' : '';
  const manual = st.kind === 'manual', ps = st.shell === 'powershell';
  const host = st.psHost ?? setup.wf.defaults.psHost;
  const folders = setup.wf.folders;
  const on = (f) => !st.folders || st.folders.includes(f);
  const pattern = st.commitPattern ?? setup.wf.defaults.commitPattern ?? DEFAULT_PATTERN;

  el.innerHTML = top + `
    <div class="editor-head">
      <h2>Step ${idx} · chỉnh sửa</h2>
      <span id="ed-dirty">${it.draft ? '<span class="chip t-warn">Chưa lưu</span>' : ''}</span>
      <span class="notice ${setup.noticeErr ? 'err' : ''}">${esc(setup.notice)}</span>
      <button class="btn" data-eact="cancel" ${!it.draft || ro ? 'disabled' : ''}>Hủy thay đổi</button>
      <button class="btn btn-primary" data-eact="save" ${!it.draft || ro ? 'disabled' : ''}>Lưu step</button>
    </div>

    <div class="row-center" style="gap:16px;align-items:flex-end">
      <label class="field grow">Tên step<input class="input" data-f="name" value="${esc(st.name)}" ${dis}></label>
      <div class="stack-8" style="gap:6px"><div class="small" style="font-weight:600;color:var(--ink-2)">Loại step</div>
        <div class="seg"><button data-eact="kind" data-v="app" class="${manual ? '' : 'on'}" ${dis}>Gọi app</button><button data-eact="kind" data-v="manual" class="${manual ? 'on' : ''}" ${dis}>Sửa tay</button></div></div>
    </div>

    ${manual ? `
    <label class="field">Hướng dẫn hiển thị cho dev<textarea class="input" rows="4" data-f="guide" ${dis}>${esc(st.guide ?? '')}</textarea></label>
    <div class="manual-info">Khi chạy: hiện hướng dẫn → dev sửa → bấm “Đã sửa xong” → công cụ quét <b>git status</b> từng folder. Folder có thay đổi được soạn commit.</div>` : `
    <div class="app-box">
      <div class="row-center" style="gap:12px;flex-wrap:wrap">
        <div class="lbl">Chạy bằng</div>
        <div class="seg"><button data-eact="shell" data-v="cmd" class="${ps ? '' : 'on'}" ${dis}>CMD</button><button data-eact="shell" data-v="powershell" class="${ps ? 'on' : ''}" ${dis}>PowerShell</button></div>
        ${ps ? `<div class="seg small"><button data-eact="host" data-v="pwsh" class="${host === 'pwsh' ? 'on' : ''}" ${dis}>pwsh 7</button><button data-eact="host" data-v="powershell.exe" class="${host === 'powershell.exe' ? 'on' : ''}" ${dis}>powershell.exe 5.1</button></div>` : ''}
      </div>
      <div class="row-8" style="gap:16px">
        <label class="field grow">Ứng dụng / script cần gọi<input class="input mono" data-f="app" value="${esc(st.app ?? '')}" placeholder="VD: tools\\dotnet-upgrade.exe, dotnet, {root}\\scripts\\Build.ps1" ${dis}></label>
        <label class="field" style="width:130px">Timeout (giây)<input class="input mono" data-f="timeoutSeconds" type="number" min="1" value="${st.timeoutSeconds ?? ''}" placeholder="${setup.wf.defaults.timeoutSeconds}" ${dis}></label>
      </div>
      <div class="stack-8">
        <div class="row-baseline" style="gap:8px"><div class="grow small" style="font-weight:600;color:var(--ink-2)">Tham số (arg) · truyền đúng thứ tự từ trên xuống</div><div id="ed-argcount" class="xsmall muted">${(st.args ?? []).length} arg</div></div>
        ${(st.args ?? []).map((a, i) => `<div class="arg-row"><span class="n">${i + 1}</span>
          <input data-arg="${i}" value="${esc(a)}" aria-label="Arg ${i + 1}" placeholder="VD: --target hoặc {folder}" ${dis}>
          <button class="rm" data-eact="rm-arg" data-i="${i}" aria-label="Bỏ arg ${i + 1}" title="Bỏ arg này" ${dis}>−</button></div>`).join('')}
        ${(st.args ?? []).length ? '' : '<div class="small muted" style="padding-left:30px">Chưa có arg: app sẽ được gọi không kèm tham số.</div>'}
        <div style="padding-left:30px"><button class="btn-dashed" style="padding:8px 14px" data-eact="add-arg" ${dis}>+ Thêm arg</button></div>
      </div>
      <div class="stack-8" style="gap:6px">
        <div class="row-center small" style="gap:20px;flex-wrap:wrap;color:var(--ink-2)">
          <span style="font-weight:600">Công cụ sẽ gọi (ví dụ với folder đầu tiên)</span>
          <span>Pass khi: ${ps ? 'exit code = 0 (lỗi cmdlet cũng tính fail)' : 'exit code = 0'}</span>
          <span>Biến: <span class="mono">{folder} · {root}</span></span>
        </div>
        <div id="ed-runner" class="term"></div>
      </div>
    </div>`}

    <div class="stack-8">
      <div class="small" style="font-weight:600;color:var(--ink-2)">Folder áp dụng cho step này</div>
      <div class="row-8" style="gap:10px;flex-wrap:wrap">${folders.length ? folders.map(f =>
        `<label class="fcheck"><input type="checkbox" data-folder="${esc(f)}" ${on(f) ? 'checked' : ''} ${dis}>${esc(f)}</label>`).join('')
        : '<span class="small muted">Workflow chưa có folder: thêm ở cột bên trái.</span>'}</div>
    </div>

    <div class="stack-8">
      <div class="row-8" style="gap:16px">
        <label class="field" style="width:300px;flex-shrink:0">Mẫu commit (pattern)<input class="input mono" data-f="commitPattern" value="${esc(pattern)}" placeholder="${esc(DEFAULT_PATTERN)}" ${dis}></label>
        <label class="field grow" style="min-width:0">Message của step · điền vào {message}<input class="input" data-f="message" value="${esc(st.message)}" ${dis}></label>
      </div>
      <div class="row-center small muted" style="flex-wrap:wrap">
        <span>Chèn biến:</span>
        ${['{folder}', '{message}', '{step}'].map(t => `<button class="token" data-eact="token" data-v="${t}" title="Chèn ${t} vào cuối mẫu" ${dis}>${t}</button>`).join('')}
        <button class="token-dashed" data-eact="reset-pattern" ${dis}>Về mặc định</button>
        <span>{folder} = tên thư mục · {message} = message bên phải · {step} = tên step</span>
      </div>
      <div id="ed-patwarn" class="warn-text"></div>
    </div>

    <div class="grid-2" style="gap:14px">
      <div class="stack-8"><div class="small" style="font-weight:600;color:var(--green)">Xem trước · commit soạn sẵn khi PASS</div>
        <div id="ed-preview" class="term" style="min-height:88px"></div></div>
      <div class="stack-8"><div class="small" style="font-weight:600;color:var(--red)">Xem trước · khi FAIL (lệnh restore)</div>
        <div class="term" style="min-height:88px"><div>git restore --staged --worktree -- {folder}/</div><div>git clean -fd -- {folder}/</div><div class="c"># commit bị khóa cho folder này</div></div></div>
    </div>`;
  refreshLive();
}

// Phần tự cập nhật khi gõ, không vẽ lại cả form để giữ con trỏ
function refreshLive() {
  const it = selItem();
  if (!it || !setup.wf) return;
  const st = viewOf(it);
  const folders = (st.folders ?? setup.wf.folders);
  const first = folders[0] ?? '{folder}';
  const root = ui.snap?.repoRoot ?? '';
  const pattern = st.commitPattern ?? setup.wf.defaults.commitPattern ?? DEFAULT_PATTERN;
  const commit = (f) => pattern.split('{folder}').join(f).split('{message}').join(st.message || '…').split('{step}').join(st.name || '');

  const prev = $('#ed-preview');
  if (prev) prev.innerHTML = folders.length ? folders.slice(0, 4).map(f => `<div>${esc(commit(f))}</div>`).join('') : '<div class="c"># chưa chọn folder nào</div>';
  const warn = $('#ed-patwarn');
  if (warn) warn.textContent = pattern.includes('{folder}') ? '' : 'Mẫu chưa có {folder}: commit của các folder sẽ không phân biệt được với nhau.';
  const runner = $('#ed-runner');
  if (runner) {
    const expand = (s) => s.split('{folder}').join(`${root}\\${first}`).split('{root}').join(root);
    const tokens = [st.app || '<chưa chọn app>', ...(st.args ?? []).filter(a => a.trim() !== '')].map(expand);
    const host = st.psHost ?? setup.wf.defaults.psHost;
    const call = st.shell === 'powershell'
      ? `${host} -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; & ${tokens.map(quotePs).join(' ')}; exit $LASTEXITCODE"`
      : `cmd.exe /d /s /c "${tokens.map(quoteCmd).join(' ')}"`;
    runner.innerHTML = `<div>&gt; cd ${esc(root)}\\${esc(first)}</div><div>&gt; ${esc(call)}</div>`;
  }
  const count = $('#ed-argcount');
  if (count) count.textContent = `${(st.args ?? []).length} arg`;
  const dirty = $('#ed-dirty');
  if (dirty) dirty.innerHTML = it.draft ? '<span class="chip t-warn">Chưa lưu</span>' : '';
  document.querySelectorAll('[data-eact="save"], [data-eact="cancel"]').forEach(b => b.disabled = !it.draft || readonly());
}

function edit(fields, full) {
  const it = selItem();
  it.draft = { ...viewOf(it), ...fields };
  setup.notice = ''; setup.noticeErr = false;
  renderStepList();
  if (full) renderEditor(); else refreshLive();
}

$('#editor').addEventListener('input', e => {
  const t = e.target, it = selItem();
  if (!it) return;
  if (t.dataset.f) {
    let v = t.value;
    if (t.dataset.f === 'timeoutSeconds') v = v === '' ? null : +v;
    edit({ [t.dataset.f]: v });
  } else if (t.dataset.arg != null) {
    const args = [...(viewOf(it).args ?? [])];
    args[+t.dataset.arg] = t.value;
    edit({ args });
  } else if (t.dataset.folder != null) {
    const picked = [...document.querySelectorAll('#editor [data-folder]:checked')].map(x => x.dataset.folder);
    edit({ folders: picked.length === setup.wf.folders.length ? null : picked });
  }
});

$('#editor').addEventListener('click', async e => {
  const b = e.target.closest('[data-eact]');
  if (!b || b.disabled) return;
  const it = selItem(), st = viewOf(it);
  switch (b.dataset.eact) {
    case 'kind': edit({ kind: b.dataset.v }, true); break;
    case 'shell': edit({ shell: b.dataset.v }, true); break;
    case 'host': edit({ psHost: b.dataset.v }, true); break;
    case 'add-arg': edit({ args: [...(st.args ?? []), ''] }, true); document.querySelector(`#editor [data-arg="${(st.args ?? []).length}"]`)?.focus(); break;
    case 'rm-arg': edit({ args: (st.args ?? []).filter((_, i) => i !== +b.dataset.i) }, true); break;
    case 'token': edit({ commitPattern: (st.commitPattern ?? setup.wf.defaults.commitPattern ?? DEFAULT_PATTERN) + b.dataset.v }, true); break;
    case 'reset-pattern': edit({ commitPattern: null }, true); break;
    case 'cancel':
      if (!it.saved) { setup.items = setup.items.filter(x => x !== it); setup.sel = setup.items.at(-1)?.id ?? null; }
      else it.draft = null;
      setup.errors = []; setup.notice = 'Đã bỏ thay đổi chưa lưu'; setup.noticeErr = false;
      renderStepList(); renderEditor();
      break;
    case 'save': {
      const clean = normalize(it.draft);
      if (await persist({ id: it.id, step: clean })) {
        it.saved = clean; it.draft = null;
        setup.notice = `Đã lưu step ${setup.items.indexOf(it) + 1}`; setup.noticeErr = false;
        renderStepList(); renderEditor();
      }
      break;
    }
  }
});

// Bỏ trường không dùng tới để YAML gọn
function normalize(st) {
  const s = { ...st };
  if (s.kind === 'manual') { s.shell = s.app = s.args = s.psHost = null; }
  else { s.guide = null; s.args = (s.args ?? []).filter(a => a.trim() !== ''); if (!s.args.length) s.args = null; }
  if (s.shell !== 'powershell') s.psHost = null;
  if (s.commitPattern === '' || s.commitPattern === setup.wf.defaults.commitPattern) s.commitPattern = null;
  if (!s.timeoutSeconds) s.timeoutSeconds = null;
  return s;
}

// ===== Khởi động =====
(async () => {
  await poll();
  const saved = store.get('tab');
  showTab(saved === 'setup' || saved === 'run' ? saved : (ui.snap?.workflows.length ? 'run' : 'setup'));
  setInterval(poll, 1000);
})();
