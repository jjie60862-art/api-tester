/* ============================================================
   API 试电笔  ·  前端逻辑 (vanilla, 无框架)
   ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = { configs: [], active_id: null, theme: 'light', test_prompt: '只回复 OK', test_count: 1, stream: true };
let logs = [];
let results = [];                       // 稳定性结果
let testAbort = null, running = false;
let chat = { messages: [], controller: null, busy: false };
let modalLog = null;
let showHidden = false;

/* ---------------- 工具 ---------------- */
function uid() { return Math.random().toString(36).slice(2, 10); }
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(16px)'; el.style.transition = 'all .25s'; }, 2600);
  setTimeout(() => el.remove(), 3000);
}
function fmtMs(v) { return (v === null || v === undefined || v === '') ? 'N/A' : (v >= 1000 ? (v / 1000).toFixed(2) + ' s' : Math.round(v) + ' ms'); }
function fmtNum(v) { return (v === null || v === undefined || v === '') ? 'N/A' : v; }
function setDot(cls) { $('#healthDot').className = 'dot ' + cls; }

async function api(path, body, method = 'POST') {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(path, opt);
  const txt = await r.text();
  try { return JSON.parse(txt); } catch (e) { return { ok: false, error: '本地服务响应异常: ' + txt.slice(0, 200) }; }
}

/* ---------------- 状态 ---------------- */
let saveTimer = null;
function saveState(now) {
  clearTimeout(saveTimer);
  const doSave = () => api('/api/state', S).catch(() => { });
  if (now) doSave(); else saveTimer = setTimeout(doSave, 400);
}
function activeCfg() { return S.configs.find(c => c.id === S.active_id) || null; }

/* ---------------- 主题 ---------------- */
function applyTheme() {
  document.documentElement.setAttribute('data-theme', S.theme === 'dark' ? 'dark' : 'light');
  $('#btnTheme').textContent = S.theme === 'dark' ? '☀️ 浅色' : '🌙 深色';
}
$('#btnTheme').onclick = () => { S.theme = S.theme === 'dark' ? 'light' : 'dark'; applyTheme(); saveState(true); };

/* ---------------- 配置列表 ---------------- */
function renderCfgList() {
  const box = $('#cfgList');
  if (!S.configs.length) {
    box.innerHTML = '<div class="hint" style="padding:10px 6px">还没有配置，点右上角「＋ 新建」。</div>';
    return;
  }
  box.innerHTML = S.configs.map(c => `
    <div class="cfg ${c.id === S.active_id ? 'on' : ''}" data-id="${c.id}">
      <button class="cfg-del" data-del="${c.id}" title="删除这个配置">✕</button>
      <div class="cfg-name">${esc(c.name || '未命名')}</div>
      <div class="cfg-url">${esc(c.base_url || '—')}</div>
      <div class="cfg-model">${c.model ? '🧩 ' + esc(c.model) : '<span class="hint">未选择模型</span>'}</div>
    </div>`).join('');
  $$('.cfg', box).forEach(el => el.onclick = () => { selectCfg(el.dataset.id); });
  $$('.cfg-del', box).forEach(el => el.onclick = e => { e.stopPropagation(); deleteCfg(el.dataset.del); });
}

function selectCfg(id) {
  S.active_id = id;
  const c = activeCfg();
  renderCfgList();
  fillForm(c);
  $('#activePill').textContent = c ? (c.name || '未命名') + ' · ' + (c.model || '未选模型') : '未选择配置';
  saveState(true);
}

function fillForm(c) {
  $('#fName').value = c ? (c.name || '') : '';
  $('#fBase').value = c ? (c.base_url || '') : '';
  $('#fKey').value = c ? (c.api_key || '') : '';
  $('#fProxy').value = c ? (c.proxy || '') : '';
  $('#fModel').value = c ? (c.model || '') : '';
  $('#fStream').checked = c ? !!c.stream : true;
  $('#baseHint').textContent = c && c.base_url ? '规整后：' + normalizeBasePreview(c.base_url) : '';
  $('#modelCount').textContent = '';
  $('#modelHint').className = 'hint';
  $('#modelHint').textContent = '部分 API 的 /models 不可用，可直接手动输入模型 ID。';
  $('#cfgCard').style.opacity = c ? '1' : '.5';
  $$('#cfgCard input, #cfgCard textarea, #cfgCard button').forEach(el => { if (el.id !== 'btnNewConfig') el.disabled = !c; });
  syncModelClear(); renderModelPicker();
}

function normalizeBasePreview(url) {
  let u = (url || '').trim().replace(/^["']|["']$/g, '');
  if (!u) return '';
  if (!/:\/\//.test(u)) u = 'https://' + u;
  try {
    const p = new URL(u);
    let path = p.pathname.replace(/\/+$/, '');
    for (const suf of ['/chat/completions', '/completions', '/models', '/embeddings', '/responses']) {
      if (path.toLowerCase().endsWith(suf)) { path = path.slice(0, -suf.length); break; }
    }
    path = path.replace(/\/+$/, '');
    if (/\/v\d+[a-z]*$/.test(path)) return p.origin + path;
    return p.origin + (path || '') + '/v1';
  } catch (e) { return url; }
}

function bindCfgInputs() {
  const upd = (k, el, cast) => $(el).addEventListener('input', () => {
    const c = activeCfg(); if (!c) return;
    c[k] = cast ? cast($(el).value) : $(el).value;
    if (k === 'base_url') $('#baseHint').textContent = c.base_url ? '规整后：' + normalizeBasePreview(c.base_url) : '';
    if (k === 'name' || k === 'base_url' || k === 'model') renderCfgList();
    if (k === 'name' || k === 'model') $('#activePill').textContent = (c.name || '未命名') + ' · ' + (c.model || '未选模型');
    saveState();
  });
  upd('name', '#fName'); upd('base_url', '#fBase'); upd('api_key', '#fKey');
  upd('proxy', '#fProxy'); upd('model', '#fModel');
  $('#fModel').addEventListener('input', () => { syncModelClear(); renderModelPicker(); });
  $('#btnClearModel').onclick = () => clearModel();
  $('#btnModelPicker').onclick = e => { e.stopPropagation(); togglePicker(); };
  $('#modelSearch').addEventListener('input', renderModelPicker);
  $('#modelSearch').addEventListener('keydown', e => { if (e.key === 'Escape') closePicker(); });
  $('#btnShowHidden').onclick = e => { e.stopPropagation(); showHidden = !showHidden; renderModelPicker(); };
  $('#btnAddModel').onclick = e => { e.stopPropagation(); addModelFromInput(); };
  document.addEventListener('click', e => {
    if ($('#modelPicker').classList.contains('hidden')) return;
    if ($('#modelPicker').contains(e.target) || e.target.id === 'btnModelPicker') return;
    closePicker();
  });
  $('#fStream').addEventListener('change', () => {
    const c = activeCfg(); if (!c) return;
    c.stream = $('#fStream').checked; S.stream = c.stream; saveState();
  });
}

/* ---------------- 模型列表（可逐条删除 / 恢复） ---------------- */
function syncModelClear() {
  const has = !!($('#fModel').value || '').trim();
  $('#btnClearModel').classList.toggle('hidden', !has);
}
function clearModel() {
  const c = activeCfg(); if (!c) return;
  c.model = ''; $('#fModel').value = '';
  syncModelClear(); renderCfgList();
  $('#activePill').textContent = (c.name || '未命名') + ' · 未选模型';
  saveState(true); renderModelPicker(); $('#fModel').focus();
}
function setModel(m) {
  const c = activeCfg(); if (!c) return;
  c.model = m; $('#fModel').value = m;
  syncModelClear(); renderCfgList();
  $('#activePill').textContent = (c.name || '未命名') + ' · ' + m;
  saveState(true);
}
function renderModelPicker() {
  const c = activeCfg(); const box = $('#modelPickerList');
  if (!c) { box.innerHTML = ''; return; }
  const all = c.models || [];
  const hidden = c.hidden_models || [];
  const q = ($('#modelSearch').value || '').trim().toLowerCase();
  let list = showHidden ? all.slice() : all.filter(m => !hidden.includes(m));
  if (q) list = list.filter(m => m.toLowerCase().includes(q));
  const cur = (c.model || '').trim();
  $('#modelCount').textContent = all.length
    ? (all.length + ' 个模型' + (hidden.length ? ' · 已删除 ' + hidden.length : '')) : '';
  $('#btnShowHidden').textContent = showHidden ? '隐藏已删除' : '显示已删除';
  $('#btnShowHidden').disabled = !hidden.length;
  if (!list.length) {
    box.innerHTML = '<div class="picker-empty">' + (all.length
      ? '没有匹配的模型' : '还没有模型列表。点「获取模型」拉取，或在输入框里手打模型 ID 后点「＋ 添加」一个个攒。') + '</div>';
    return;
  }
  box.innerHTML = list.map(m => {
    const isHidden = hidden.includes(m);
    return `<div class="pk-item ${m === cur ? 'on' : ''} ${isHidden ? 'hidden-model' : ''}" data-m="${esc(m)}">
      <span class="pk-name" title="${esc(m)}">${esc(m)}</span>
      <button class="pk-del" data-del="${esc(m)}" title="${isHidden ? '恢复到列表' : '从列表删除这个模型'}">${isHidden ? '↺' : '✕'}</button>
    </div>`;
  }).join('');
  $$('.pk-item', box).forEach(el => el.onclick = e => {
    if (e.target.classList.contains('pk-del')) return;
    setModel(el.dataset.m); renderModelPicker(); closePicker();
  });
  $$('.pk-del', box).forEach(el => el.onclick = e => {
    e.stopPropagation();
    const cc = activeCfg(); if (!cc) return;
    const m = el.dataset.del;
    cc.hidden_models = cc.hidden_models || [];
    if (cc.hidden_models.includes(m)) {
      cc.hidden_models = cc.hidden_models.filter(x => x !== m);
      toast('已恢复模型 ' + m, 'ok');
    } else {
      cc.hidden_models.push(m);
      if ((cc.model || '') === m) {
        cc.model = ''; $('#fModel').value = ''; syncModelClear(); renderCfgList();
        $('#activePill').textContent = (cc.name || '未命名') + ' · 未选模型';
      }
      toast('已从列表删除 ' + m + '（可点「显示已删除」找回）');
    }
    saveState(true); renderModelPicker();
  });
}
function addModelFromInput() {
  const c = activeCfg(); if (!c) return;
  const v = ($('#fModel').value || '').trim();
  if (!v) { toast('先在模型输入框里填一个模型 ID，再点「＋ 添加」', 'err'); $('#fModel').focus(); return; }
  c.models = c.models || [];
  if (c.models.includes(v)) { setModel(v); renderModelPicker(); toast('列表里已经有 ' + v, 'ok'); return; }
  c.models.push(v);
  c.models.sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
  c.hidden_models = (c.hidden_models || []).filter(x => x !== v);
  setModel(v); saveState(true); renderModelPicker();
  toast('已加入列表：' + v, 'ok');
}
function openPicker() { $('#cfgCard').classList.add('picker-open'); $('#modelPicker').classList.remove('hidden'); }
function closePicker() { $('#cfgCard').classList.remove('picker-open'); $('#modelPicker').classList.add('hidden'); }
function togglePicker() {
  if ($('#modelPicker').classList.contains('hidden')) { renderModelPicker(); openPicker(); $('#modelSearch').focus(); }
  else closePicker();
}

/* ---------------- 配置删除 ---------------- */
function deleteCfg(id) {
  const c = S.configs.find(x => x.id === id); if (!c) return;
  if (!confirm('删除配置「' + (c.name || '未命名') + '」？')) return;
  S.configs = S.configs.filter(x => x.id !== id);
  if (!S.configs.length) {
    S.configs.push({ id: uid(), name: '新配置', base_url: '', api_key: '', model: '', proxy: '', stream: true, timeout: 90 });
  }
  selectCfg(S.active_id === id ? S.configs[0].id : S.active_id);
  saveState(true);
  toast('已删除配置「' + (c.name || '未命名') + '」');
}

$('#btnNewConfig').onclick = () => {
  const c = { id: uid(), name: '新配置 ' + (S.configs.length + 1), base_url: '', api_key: '', model: '', proxy: '', stream: true, timeout: 90 };
  S.configs.push(c); selectCfg(c.id); $('#fName').focus();
};
$('#btnDelConfig').onclick = () => { const c = activeCfg(); if (c) deleteCfg(c.id); };
$('#btnEye').onclick = () => {
  const el = $('#fKey'); el.type = el.type === 'password' ? 'text' : 'password';
};

/* ---------------- 获取模型 ---------------- */
$('#btnModels').onclick = async () => {
  const c = activeCfg(); if (!c) return;
  if (!c.base_url) return toast('请先填写 Base URL', 'err');
  const btn = $('#btnModels'); btn.disabled = true; btn.textContent = '获取中…';
  $('#modelHint').className = 'hint'; $('#modelHint').textContent = '正在请求 /models …';
  try {
    const r = await api('/api/models', { base_url: c.base_url, api_key: c.api_key, proxy: c.proxy });
    if (r.ok) {
      c.models = r.models;
      c.hidden_models = (c.hidden_models || []).filter(m => r.models.includes(m));
      $('#modelHint').className = 'hint ok';
      $('#modelHint').textContent = '已从 ' + r.url + ' 获取到 ' + r.models.length + ' 个模型。点右侧 ▾ 挑模型，每条后面的 ✕ 可以把不要的删掉。';
      renderModelPicker(); openPicker();
      saveState(true);
      toast('获取到 ' + r.models.length + ' 个模型', 'ok');
    } else {
      $('#modelHint').className = 'hint err';
      $('#modelHint').textContent = (r.status ? 'HTTP ' + r.status + ' · ' : '') + (r.error || '获取失败') + '  → 可直接手动输入模型 ID 继续测试。';
      toast('模型列表获取失败（可手动输入模型）', 'err');
    }
  } finally { btn.disabled = false; btn.textContent = '获取模型'; }
};

/* ---------------- 次数选择 ---------------- */
$$('#segCount button').forEach(b => b.onclick = () => {
  $$('#segCount button').forEach(x => x.classList.remove('on'));
  b.classList.add('on'); S.test_count = parseInt(b.dataset.n, 10); saveState();
});

/* ---------------- Curl ---------------- */
function buildCurl(model, prompt, stream, system) {
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  msgs.push({ role: 'user', content: prompt || '只回复 OK' });
  const body = { model: model || 'MODEL_ID', messages: msgs };
  if (stream) body.stream = true;
  const json = JSON.stringify(body, null, 2).split('\n').join('\n  ');
  return `curl "$BASE_URL/chat/completions" \\\n  -H "Authorization: Bearer $API_KEY" \\\n  -H "Content-Type: application/json" \\\n${stream ? '  -N \\\n' : ''}  -d '${json}'`;
}
function copyText(txt, okMsg) {
  navigator.clipboard.writeText(txt).then(() => toast(okMsg || '已复制到剪贴板', 'ok'))
    .catch(() => {
      const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); ta.remove(); toast(okMsg || '已复制到剪贴板', 'ok');
    });
}
$('#btnCurl').onclick = () => {
  const c = activeCfg(); if (!c) return;
  copyText(buildCurl(c.model, $('#fPrompt').value, $('#fStream').checked, $('#fSystem').value), 'Curl 已复制（不含真实 Key）');
};

/* ---------------- 测试 ---------------- */
function renderResult(r) {
  const okBadge = $('#resBadge');
  if (!r) return;
  if (r.ok) { okBadge.className = 'badge ok'; okBadge.textContent = '成功'; setDot('ok'); }
  else { okBadge.className = 'badge err'; okBadge.textContent = '失败'; setDot('err'); }

  const est = r.usage_estimated;
  const u = r.usage || {};
  $('#mTtft').textContent = fmtMs(r.ttft_ms);
  $('#mTotal').textContent = fmtMs(r.total_ms);
  $('#mTps').textContent = r.tps == null ? 'N/A' : (r.tps_estimated ? '~' + r.tps : r.tps);
  $('#mTpsSub').textContent = r.tps == null ? '无可靠 Token 数' : (r.tps_estimated ? '近似值（无 usage）' : '输出速度');
  const st = $('#mStatus');
  st.textContent = r.status == null ? '—' : r.status;
  st.className = 'm-val ' + (r.ok ? 'ok' : 'err');
  $('#mIn').textContent = est ? 'N/A' : fmtNum(u.prompt_tokens);
  $('#mOut').textContent = est ? 'N/A' : fmtNum(u.completion_tokens);
  $('#mTot').textContent = est ? 'N/A' : fmtNum(u.total_tokens);
  $('#mChars').textContent = r.chars != null ? r.chars : ((r.text || '').length || '—');

  $('#resText').textContent = r.text ? r.text : (r.reasoning ? '[仅返回思考内容]\n' + r.reasoning : '（空响应）');
  const eb = $('#errBox');
  if (r.error) {
    eb.classList.remove('hidden');
    eb.textContent = '[' + (r.error_kind || 'error') + '] ' + r.error + (r.raw ? '\n\n原始响应：\n' + r.raw : '');
  } else eb.classList.add('hidden');
}

function pushRow(i, r) {
  const tb = $('#stabBody');
  const empty = $('.empty', tb); if (empty) empty.remove();
  const tr = document.createElement('tr');
  const note = r.ok ? (r.finish_reason || '') : (r.error || '').split('\n')[0];
  tr.innerHTML = `
    <td>${i}</td>
    <td class="${r.ok ? 'yes' : 'no'}">${r.ok ? '✓ 成功' : '✕ 失败'}</td>
    <td class="${r.status == null ? 'muted' : ''}">${r.status == null ? '—' : r.status}</td>
    <td>${fmtMs(r.ttft_ms)}</td>
    <td>${fmtMs(r.total_ms)}</td>
    <td>${r.tps == null ? 'N/A' : (r.tps_estimated ? '~' + r.tps : r.tps)}</td>
    <td class="muted">${esc(note).slice(0, 60)}</td>`;
  tb.appendChild(tr);
  tb.parentElement.parentElement.scrollTop = 1e6;
}

function updateStats() {
  const ok = results.filter(r => r.ok), bad = results.filter(r => !r.ok);
  const rate = results.length ? (ok.length / results.length * 100) : 0;
  const ttfts = ok.map(r => r.ttft_ms).filter(v => v != null);
  const tpss = ok.map(r => r.tps).filter(v => v != null);
  const totals = ok.map(r => r.total_ms).filter(v => v != null);
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const cards = [
    ['成功次数', ok.length], ['失败次数', bad.length],
    ['成功率', results.length ? rate.toFixed(1) + '%' : 'N/A'],
    ['平均 TTFT', fmtMs(avg(ttfts))], ['最快 TTFT', fmtMs(ttfts.length ? Math.min(...ttfts) : null)],
    ['最慢 TTFT', fmtMs(ttfts.length ? Math.max(...ttfts) : null)],
    ['平均 Tokens/s', avg(tpss) == null ? 'N/A' : avg(tpss).toFixed(1)],
    ['平均总耗时', fmtMs(avg(totals))],
    ['失败率', results.length ? (100 - rate).toFixed(1) + '%' : 'N/A'],
  ];
  $('#stats').innerHTML = cards.map(([l, v]) => `<div class="stat"><div class="s-lbl">${l}</div><div class="s-val">${v}</div></div>`).join('');
  const b = $('#stabBadge');
  if (!results.length) { b.className = 'badge'; b.textContent = '无数据'; }
  else if (bad.length === 0) { b.className = 'badge ok'; b.textContent = results.length + '/' + results.length + ' 全部成功'; }
  else { b.className = 'badge err'; b.textContent = ok.length + '/' + results.length + ' 成功'; }
  drawChart();
}

function drawChart() {
  const cv = $('#chart'); if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = 120;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  const cs = getComputedStyle(document.documentElement);
  const accent = cs.getPropertyValue('--accent').trim() || '#12B7F5';
  const errc = cs.getPropertyValue('--err').trim() || '#E5484D';
  const grid = cs.getPropertyValue('--border').trim() || '#E5E8ED';
  const fg3 = cs.getPropertyValue('--fg-3').trim() || '#8A94A3';
  if (!results.length) {
    g.fillStyle = fg3; g.font = '11px sans-serif'; g.textAlign = 'center';
    g.fillText('TTFT 折线图（测试后显示）', w / 2, h / 2); return;
  }
  const pad = { l: 44, r: 12, t: 12, b: 20 };
  const vals = results.map(r => r.ttft_ms);
  const max = Math.max(...vals.filter(v => v != null), 1);
  const n = results.length;
  const X = i => pad.l + (n === 1 ? (w - pad.l - pad.r) / 2 : i * (w - pad.l - pad.r) / (n - 1));
  const Y = v => h - pad.b - (v / max) * (h - pad.t - pad.b);
  g.strokeStyle = grid; g.lineWidth = 1;
  for (let k = 0; k <= 3; k++) {
    const y = pad.t + k * (h - pad.t - pad.b) / 3;
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
    g.fillStyle = fg3; g.font = '9px monospace'; g.textAlign = 'right';
    g.fillText(Math.round(max * (1 - k / 3)) + 'ms', pad.l - 6, y + 3);
  }
  g.beginPath(); let started = false;
  results.forEach((r, i) => {
    if (r.ttft_ms == null) { started = false; return; }
    if (!started) { g.moveTo(X(i), Y(r.ttft_ms)); started = true; } else g.lineTo(X(i), Y(r.ttft_ms));
  });
  g.strokeStyle = accent; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
  results.forEach((r, i) => {
    g.beginPath();
    g.arc(X(i), r.ttft_ms == null ? h - pad.b : Y(r.ttft_ms), r.ok ? 3.5 : 4.5, 0, 7);
    g.fillStyle = r.ok ? accent : errc; g.fill();
  });
}

$('#btnTest').onclick = async () => {
  if (running) return;
  const c = activeCfg(); if (!c) return toast('请先新建/选择一个配置', 'err');
  if (!c.base_url) return toast('请填写 Base URL', 'err');
  if (!c.model) return toast('请选择或手动输入模型 ID', 'err');
  const prompt = $('#fPrompt').value || '只回复 OK';
  const stream = $('#fStream').checked;
  const n = S.test_count || 1;

  running = true; results = [];
  $('#btnTest').disabled = true; $('#btnStop').disabled = false;
  $('#resBadge').className = 'badge busy'; $('#resBadge').textContent = '测试中…';
  $('#stabBody').innerHTML = ''; setDot('busy');
  testAbort = new AbortController();

  const payload = {
    base_url: c.base_url, api_key: c.api_key, model: c.model, prompt,
    stream, proxy: c.proxy, timeout: c.timeout || 90, config_name: c.name,
  };

  for (let i = 1; i <= n; i++) {
    if (testAbort.signal.aborted) break;
    $('#progBar').style.width = ((i - 1) / n * 100) + '%';
    let r;
    try {
      r = await api('/api/test', payload);
    } catch (e) {
      if (testAbort.signal.aborted) break;
      r = { ok: false, status: null, ttft_ms: null, total_ms: null, tps: null, error: '本地请求失败: ' + e, error_kind: 'local' };
    }
    results.push(r);
    renderResult(r); pushRow(i, r); updateStats();
    if (i === n) $('#progBar').style.width = '100%';
    await new Promise(res => setTimeout(res, 60));
  }

  $('#progBar').style.width = testAbort.signal.aborted ? '0%' : '100%';
  running = false; $('#btnTest').disabled = false; $('#btnStop').disabled = true;
  const bad = results.filter(r => !r.ok).length;
  if (results.length) toast(bad === 0 ? `全部 ${results.length} 次成功` : `${results.length - bad}/${results.length} 成功`, bad === 0 ? 'ok' : 'err');
  setTimeout(() => { $('#progBar').style.width = '0%'; }, 1200);
};

$('#btnStop').onclick = () => { if (testAbort) testAbort.abort(); toast('已停止测试'); };

/* ---------------- 聊天 ---------------- */
function renderChat() {
  const box = $('#chatBody');
  if (!chat.messages.length) { box.innerHTML = '<div class="chat-empty" id="chatEmpty">发一条消息，验证模型是否真的能用。</div>'; return; }
  box.innerHTML = chat.messages.map((m, i) => {
    const av = m.role === 'user' ? '我' : (m.role === 'system' ? 'S' : 'AI');
    const meta = m.meta ? `<div class="msg-meta">${esc(m.meta)}</div>` : '';
    const think = m.reasoning ? `<div class="thinking">${esc(m.reasoning)}</div>` : '';
    return `<div class="msg ${m.role}"><div class="av">${av}</div><div><div class="bubble ${m.streaming ? 'cursor' : ''}" data-i="${i}">${think}${esc(m.content)}</div>${meta}</div></div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}
function setBubble(i, content, reasoning) {
  const el = $(`.bubble[data-i="${i}"]`);
  if (!el) return;
  const think = reasoning ? `<div class="thinking">${esc(reasoning)}</div>` : '';
  el.innerHTML = think + esc(content);
  $('#chatBody').scrollTop = $('#chatBody').scrollHeight;
}

function chatPayload(msgs) {
  const c = activeCfg();
  return {
    base_url: c.base_url, api_key: c.api_key, model: c.model,
    messages: msgs, stream: true, proxy: c.proxy, timeout: 180, config_name: c.name,
  };
}

async function streamChat() {
  const c = activeCfg();
  if (!c || !c.base_url || !c.model) { toast('请先选择配置并填写模型', 'err'); return; }
  chat.busy = true;
  $('#btnSend').classList.add('hidden'); $('#btnStopChat').classList.remove('hidden');
  $('#chatFoot').textContent = '生成中…'; setDot('busy');
  const idx = chat.messages.length;
  chat.messages.push({ role: 'assistant', content: '', reasoning: '', streaming: true });
  renderChat();

  let content = '', reasoning = '', meta = '';
  chat.controller = new AbortController();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatPayload(chat.messages.filter(m => !m.streaming).map(m => ({ role: m.role, content: m.content })))),
      signal: chat.controller.signal,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error('本地服务 ' + res.status + ': ' + t.slice(0, 200));
    }
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n'); buf = parts.pop();
      for (const p of parts) {
        const line = p.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
        if (ev.type === 'delta') { content += ev.text; setBubble(idx, content, reasoning); }
        else if (ev.type === 'reasoning') { reasoning += ev.text; setBubble(idx, content, reasoning); }
        else if (ev.type === 'start') { $('#chatFoot').textContent = 'HTTP ' + ev.status + ' · ' + ev.model + ' · 生成中…'; }
        else if (ev.type === 'done') {
          meta = `TTFT ${fmtMs(ev.ttft_ms)} · 总 ${fmtMs(ev.total_ms)} · ${ev.tps == null ? 'N/A' : (ev.tps_estimated ? '~' + ev.tps : ev.tps) + ' tok/s'} · out ${ev.usage && ev.usage.completion_tokens != null ? ev.usage.completion_tokens : 'N/A'} tok`;
          $('#chatFoot').textContent = meta;
          setDot('ok');
        } else if (ev.type === 'error') {
          content += (content ? '\n\n' : '') + '⚠️ [' + ev.kind + '] ' + ev.message + (ev.raw ? '\n' + ev.raw : '');
          meta = '失败'; setDot('err');
          $('#chatFoot').textContent = '[' + ev.kind + '] ' + ev.message;
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') { meta = meta || '已停止'; $('#chatFoot').textContent = '已停止生成'; }
    else { content += (content ? '\n\n' : '') + '⚠️ ' + e.message; meta = '错误'; setDot('err'); $('#chatFoot').textContent = e.message; }
  }
  const m = chat.messages[idx];
  m.content = content; m.reasoning = reasoning; m.streaming = false; m.meta = meta;
  renderChat();
  chat.busy = false; chat.controller = null;
  $('#btnSend').classList.remove('hidden'); $('#btnStopChat').classList.add('hidden');
}

function sendChat() {
  if (chat.busy) return;
  const ta = $('#chatInput'); const text = ta.value.trim();
  if (!text) return;
  const sys = $('#fSystem').value.trim();
  if (sys && !chat.messages.some(m => m.role === 'system')) chat.messages.unshift({ role: 'system', content: sys });
  chat.messages.push({ role: 'user', content: text });
  ta.value = ''; ta.style.height = 'auto';
  renderChat(); streamChat();
}
$('#btnSend').onclick = sendChat;
$('#btnStopChat').onclick = () => { if (chat.controller) chat.controller.abort(); };
$('#btnClearChat').onclick = () => { chat.messages = []; renderChat(); $('#chatFoot').textContent = ''; setDot('idle'); };
$('#btnRegen').onclick = () => {
  if (chat.busy) return;
  while (chat.messages.length && chat.messages[chat.messages.length - 1].role === 'assistant') chat.messages.pop();
  if (!chat.messages.length) return toast('没有可重新生成的内容', 'err');
  renderChat(); streamChat();
};
$('#chatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
$('#chatInput').addEventListener('input', e => {
  const el = e.target; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px';
});

/* ---------------- 日志 ---------------- */
function fmtLogRow(l, i) {
  return `<tr class="clickable" data-i="${i}">
    <td>${esc(l.ts || '')}</td>
    <td>${esc(l.config_name || '—')}</td>
    <td>${esc(l.model || '—')}</td>
    <td class="${l.status == null ? 'muted' : (l.ok ? 'yes' : 'no')}">${l.status == null ? '—' : l.status}</td>
    <td>${fmtMs(l.ttft_ms)}</td>
    <td>${fmtMs(l.total_ms)}</td>
    <td>${l.tps == null ? 'N/A' : (l.tps_estimated ? '~' + l.tps : l.tps)}</td>
    <td class="${l.ok ? 'yes' : 'no'}">${l.ok ? '✓' : '✕'}</td>
  </tr>`;
}
function renderLogs() {
  $('#logBadge').textContent = logs.length + ' 条';
  const tb = $('#logBody');
  if (!logs.length) { tb.innerHTML = '<tr class="empty"><td colspan="8">暂无日志</td></tr>'; return; }
  tb.innerHTML = logs.map(fmtLogRow).join('');
  $$('#logBody tr.clickable').forEach(tr => tr.onclick = () => openLog(parseInt(tr.dataset.i, 10)));
}
async function reloadLogs() { const r = await api('/api/logs', undefined, 'GET'); logs = r.logs || []; renderLogs(); }
$('#btnReloadLogs').onclick = reloadLogs;
$('#btnClearLogs').onclick = async () => {
  if (!confirm('清空全部请求日志？')) return;
  await api('/api/logs', undefined, 'DELETE'); logs = []; renderLogs(); toast('日志已清空');
};

function openLog(i) {
  const l = logs[i]; if (!l) return;
  modalLog = l;
  $('#modalTitle').textContent = `${l.ts} · ${l.model || '—'} · ${l.ok ? '成功' : '失败'}`;
  const req = l.request || {};
  const hdrs = Object.entries(req.headers || {}).map(([k, v]) => k + ': ' + v).join('\n');
  let html = `
    <div class="kv-title">Request</div>
    <pre class="code">${esc(req.method || 'POST')} ${esc(req.url || '')}
${esc(hdrs)}

${esc(req.body || '')}</pre>`;
  html += `<div class="kv-title">Response</div><pre class="code">HTTP ${esc(String((l.response || {}).status ?? '—'))}

${esc((l.response || {}).body || '(空)')}</pre>`;
  if (l.error) html += `<div class="kv-title">Error</div><pre class="code">[${esc(l.error.kind || '')}] ${esc(l.error.message || '')}${l.error.body ? '\n\n' + esc(l.error.body) : ''}</pre>`;
  if (l.usage) html += `<div class="kv-title">Usage</div><pre class="code">${esc(JSON.stringify(l.usage))}</pre>`;
  $('#modalBody').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
$('#btnModalClose').onclick = () => $('#modal').classList.add('hidden');
$('#modal').onclick = e => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); };
$('#btnModalCurl').onclick = () => {
  const l = modalLog; if (!l) return;
  let body = {}; try { body = JSON.parse(l.request.body); } catch (e) { }
  copyText(buildCurl(l.model, (body.messages || []).map(m => m.content).join('\n') || '只回复 OK', !!l.stream, ''), 'Curl 已复制（不含真实 Key）');
};

/* ---------------- Tab ---------------- */
$$('.tab').forEach(t => t.onclick = () => {
  $$('.tab').forEach(x => x.classList.remove('active')); t.classList.add('active');
  $$('.pane').forEach(p => p.classList.remove('active'));
  $('#pane-' + t.dataset.tab).classList.add('active');
  if (t.dataset.tab === 'logs') reloadLogs();
  if (t.dataset.tab === 'test') drawChart();
});

/* ---------------- 启动 ---------------- */
(async function init() {
  try {
    const ping = await api('/api/ping', undefined, 'GET');
    $('#verTag').textContent = 'v' + (ping.version || '1.0.0');
  } catch (e) { }
  const st = await api('/api/state', undefined, 'GET');
  S = Object.assign(S, st || {});
  applyTheme();
  if (!S.configs.length) {
    S.configs.push({ id: uid(), name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', api_key: '', model: '', proxy: '', stream: true, timeout: 90 });
    S.active_id = S.configs[0].id;
  }
  if (!S.active_id || !S.configs.some(c => c.id === S.active_id)) S.active_id = S.configs[0].id;
  $('#fPrompt').value = S.test_prompt || '只回复 OK';
  $('#fPrompt').addEventListener('input', () => { S.test_prompt = $('#fPrompt').value; saveState(); });
  $$('#segCount button').forEach(b => b.classList.toggle('on', parseInt(b.dataset.n, 10) === (S.test_count || 1)));
  bindCfgInputs();
  renderCfgList();
  selectCfg(S.active_id);
  renderChat(); updateStats();
  reloadLogs();
})();
