'use strict';
/* Margin, phone-only. Everything lives in this browser. Transcription runs through
   iPhone speech recognition or Deepgram; notes, questions and live answers go to
   Claude with your own API key. No Margin server. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  };

  const COLORS = ['#3E63DD', '#12A594', '#E5484D', '#F76B15', '#8E4EC6', '#5A6372'];
  const DEFAULT_TEMPLATE = '### Summary\n### Decisions\n### Action items\n### Open questions';
  const QUESTION_RE = /\?|\b(what|how|why|when|where|who|which|can you|could you|would you|do you|did you|does|is there|are you|have you|should we|thoughts on|walk (?:me|us) through|tell (?:me|us)|explain)\b/i;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  // ---------- settings (kept on this device only) ----------
  const DEFAULTS = { engine: SR ? 'browser' : 'deepgram', anthropicKey: '', deepgramKey: '', notesModel: 'claude-sonnet-5-5', liveModel: 'claude-haiku-5-5', lang: 'en-US' };
  let settings = { ...DEFAULTS };
  try { Object.assign(settings, JSON.parse(store.get('margin.settings') || '{}')); } catch { /* fresh */ }
  const saveSettings = () => store.set('margin.settings', JSON.stringify(settings));

  const S = {
    jobs: [], jobId: store.get('margin.job') || '', meetings: [], meeting: null,
    tab: 'notes', showRaw: false, query: '', scope: 'meeting', answer: null, confirmDel: false,
    busy: { enhance: false }, rec: null, editJob: null,
    live: store.get('margin.live') === '1',
    assist: { items: [], busy: false, queued: null, forcing: false, errShown: false },
  };

  // ---------- icons ----------
  const svg = (p) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const I = {
    back: svg('<path d="M15 18l-6-6 6-6"/>'),
    chev: svg('<path d="M7 10l5 5 5-5"/>'),
    gear: svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
    cog: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
    mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
    stop: svg('<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>'),
    spark: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>'),
    send: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
    trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
  };

  // ---------- formatting ----------
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  function dayLabel(ts) {
    const d = new Date(ts * 1000), now = new Date();
    const diff = Math.round((dayStart(now) - dayStart(d)) / 864e5);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  }
  const timeOf = (ts) => new Date(ts * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const dur = (s) => (s < 60 ? '<1 min' : `${Math.round(s / 60)} min`);
  function clock(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  function snippetOf(m) {
    for (const line of (m.enhanced || m.notes || '').split('\n')) {
      if (/^\s*#/.test(line)) continue;
      const t = line.replace(/^\s*([-*•]|\d+[.)])\s*/, '').trim();
      if (t) return t.slice(0, 160);
    }
    return '';
  }

  // ---------- tiny markdown ----------
  function inline(s) {
    return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function md(src, mine) {
    let html = '', list = null;
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    const cls = (t) => (mine ? (mine(t) ? ' class="mine"' : ' class="ai"') : '');
    for (const raw of String(src || '').split('\n')) {
      const line = raw.trimEnd();
      if (!line.trim()) { close(); continue; }
      let m = line.match(/^(#{1,4})\s+(.*)$/);
      if (m) {
        close();
        const lvl = m[1].length === 1 ? 2 : m[1].length === 4 ? 4 : 3;
        html += `<h${lvl}>${inline(m[2])}</h${lvl}>`;
        continue;
      }
      m = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)$/);
      if (m) {
        const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
        if (list !== tag) { close(); html += `<${tag}>`; list = tag; }
        html += `<li${cls(m[2])}>${inline(m[2])}</li>`;
        continue;
      }
      close();
      html += `<p${cls(line)}>${inline(line)}</p>`;
    }
    close();
    return html;
  }
  const STOP = new Set('the and for with that this from have will are was but not you your our they them their what when who how its into about just also can get got need needs should would could then than there here been being out over'.split(' '));
  const toks = (s) => new Set((s.toLowerCase().match(/[a-z0-9][a-z0-9'-]+/g) || []).filter((w) => w.length > 2 && !STOP.has(w)));
  function mineMatcher(notes) {
    const lines = String(notes || '').split('\n').map(toks).filter((t) => t.size);
    if (!lines.length) return () => false;
    return (text) => {
      const t = toks(text);
      if (!t.size) return false;
      return lines.some((u) => {
        let hit = 0;
        u.forEach((w) => { if (t.has(w)) hit++; });
        return hit >= Math.min(2, u.size) && hit / u.size >= 0.5;
      });
    };
  }

  // ---------- local data store ----------
  const Local = {
    data: null,
    load() {
      try { this.data = JSON.parse(store.get('margin.data') || 'null'); } catch { this.data = null; }
      if (!this.data || !Array.isArray(this.data.jobs) || !this.data.jobs.length) this.data = seed();
    },
    saveT: null, warned: false,
    save() {
      clearTimeout(this.saveT);
      this.saveT = null;
      if (!store.set('margin.data', JSON.stringify(this.data)) && !this.warned) {
        this.warned = true;
        toast("This phone's browser storage is full. Export a backup from Settings and delete old meetings.");
      }
    },
    saveSoon() { if (!this.saveT) this.saveT = setTimeout(() => this.save(), 1200); },
    meeting(id) { return this.data.meetings.find((m) => m.id === id); },
    summary(m) {
      return { id: m.id, job_id: m.job_id, title: m.title, started_at: m.started_at, duration: m.duration, snippet: snippetOf(m), has_enhanced: !!m.enhanced };
    },
    route(method, path, b) {
      const d = this.data;
      const count = (id) => d.meetings.filter((x) => x.job_id === id).length;
      let m;
      if (path === '/jobs') {
        if (method === 'GET') return d.jobs.map((j) => ({ ...j, meeting_count: count(j.id) }));
        const j = { id: uid(), name: b.name, color: b.color, context: b.context || '', template: b.template || DEFAULT_TEMPLATE, created_at: Date.now() / 1000 };
        d.jobs.push(j); this.save();
        return { ...j, meeting_count: 0 };
      }
      if ((m = path.match(/^\/jobs\/([^/]+)$/))) {
        const j = d.jobs.find((x) => x.id === m[1]);
        if (!j) throw new Error("That job doesn't exist.");
        if (method === 'PUT') { Object.assign(j, { name: b.name, color: b.color, context: b.context, template: b.template }); this.save(); return { ...j, meeting_count: count(j.id) }; }
        if (method === 'DELETE') {
          if (d.jobs.length < 2) throw new Error('Keep at least one job.');
          d.jobs = d.jobs.filter((x) => x !== j);
          d.meetings = d.meetings.filter((x) => x.job_id !== j.id);
          this.save();
          return null;
        }
      }
      if ((m = path.match(/^\/jobs\/([^/]+)\/meetings$/))) {
        if (method === 'GET') return d.meetings.filter((x) => x.job_id === m[1]).sort((a, c) => c.started_at - a.started_at).map((x) => this.summary(x));
        const x = { id: uid(), job_id: m[1], title: b.title || '', started_at: Date.now() / 1000, ended_at: null, duration: 0, notes: '', enhanced: '', segments: [] };
        d.meetings.push(x); this.save();
        return x;
      }
      if ((m = path.match(/^\/meetings\/([^/]+)$/))) {
        const x = this.meeting(m[1]);
        if (!x) throw new Error("That meeting doesn't exist.");
        if (method === 'GET') return x; // live object: edits and new segments land in the store
        if (method === 'PUT') { Object.assign(x, b); this.save(); return this.summary(x); }
        if (method === 'DELETE') { d.meetings = d.meetings.filter((y) => y !== x); this.save(); return null; }
      }
      throw new Error('Unknown request.');
    },
  };
  async function api(path, { method = 'GET', json } = {}) { return Local.route(method, path, json); }

  function seed() {
    const now = Date.now() / 1000;
    const at = (daysAgo, h, mnt) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, mnt, 0, 0); return Math.min(d.getTime() / 1000, now - 600); };
    const segs = (lines) => lines.map(([t, text]) => ({ t, text }));
    const mine = uid(), ex = uid();
    return {
      version: 1,
      jobs: [
        { id: mine, name: 'My job', color: '#3E63DD', context: '', template: DEFAULT_TEMPLATE, created_at: now },
        { id: ex, name: 'Examples', color: '#5A6372', context: 'Sample meetings to show how Margin works. Safe to delete this job.', template: DEFAULT_TEMPLATE, created_at: now },
      ],
      meetings: [
        {
          id: uid(), job_id: ex, title: 'DLP policy review (example)', started_at: at(0, 9, 30), ended_at: null, duration: 2040,
          notes: '- personal gdrive uploads: block or coach?\n- PCI rule false positives, finance team\n- Raj tenant restrictions mid Nov',
          segments: segs([
            [4, "Okay, let's start with the cloud storage policy since that's the one people keep asking about."],
            [19, 'Right now personal Google Drive uploads are just logged. Dana, are we blocking or coaching?'],
            [41, "I'd rather coach for two weeks first. Show the banner, let people pick a reason, then block."],
            [97, 'The PCI rule is the noisy one. Finance is getting flagged on spreadsheets that only have invoice numbers.'],
            [128, "Let's build an exception list for finance before we turn on enforcement."],
            [210, 'On tenant restrictions, I can have that live by mid November, probably the week of the fifteenth.'],
            [355, 'One question for legal: do they need to approve the wording on the coaching banner?'],
          ]),
          enhanced: '### Summary\n- Reviewed the cloud storage and PCI policies ahead of the November rollout.\n- Personal gdrive uploads: block or coach? Dana wants two weeks of coaching with a reason prompt, then block.\n### Decisions\n- PCI rule false positives for the finance team get an exception list before enforcement.\n### Action items\n- Raj: tenant restrictions live by mid Nov, likely the week of the 15th.\n- You: draft the finance exception list for Dana.\n### Open questions\n- Does legal need to approve the coaching banner wording?',
        },
        {
          id: uid(), job_id: ex, title: 'Pilot call, dental office (example)', started_at: at(1, 11, 15), ended_at: null, duration: 1320,
          notes: '- 6 front desk PCs, no IT person\n- worried about staff pasting patient info into ChatGPT',
          segments: segs([
            [22, 'Six front desk computers, two in the back, and nobody on staff who does IT.'],
            [75, 'My biggest worry is the girls pasting patient info into ChatGPT to write letters.'],
            [140, 'Is this going to slow the computers down? They already complain about the scheduling software.'],
            [205, "Send me the pricing and I'll talk it over with my partner next week."],
          ]),
          enhanced: '',
        },
      ],
    };
  }

  // ---------- Claude ----------
  async function claude({ system, user, model, maxTokens = 1024, onText, signal }) {
    if (!settings.anthropicKey) throw new Error('Add your Claude API key in Settings first.');
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': settings.anthropicKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }], stream: true }),
      });
    } catch { throw new Error("Can't reach the Claude API. Check your connection."); }
    if (!res.ok) {
      let msg = `Claude API error ${res.status}`;
      try { msg = (await res.json()).error?.message || msg; } catch { /* not json */ }
      if (res.status === 401) msg = 'Claude rejected the API key. Check it in Settings.';
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let d;
        try { d = JSON.parse(line.slice(5)); } catch { continue; }
        if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') { out += d.delta.text; onText?.(d.delta.text); }
        else if (d.type === 'error') throw new Error(d.error?.message || 'Claude API error');
      }
    }
    return out.trim();
  }

  const jobBrief = (j) => `Job/workspace: ${j.name}\nWhat to know about this job:\n${(j.context || '').trim() || '(nothing added yet)'}`;
  function transcriptText(m, limit = 48000) {
    let txt = m.segments.map((s) => `[${clock(s.t)}] ${s.text}`).join('\n');
    if (txt.length > limit) txt = `${txt.slice(0, limit / 2)}\n[... middle trimmed ...]\n${txt.slice(-limit / 2)}`;
    return txt;
  }
  const ENHANCE_SYSTEM = `You write meeting notes for one person. You get their rough notes, the transcript, a note template, and background on the job this meeting belongs to.

Rules:
- Keep every point the person wrote. Reuse their wording so they recognize it.
- Fill in what they missed from the transcript: decisions, owners, dates, numbers.
- Follow the template's headings. Drop a heading if nothing belongs under it.
- Output markdown only: '### ' headings and '- ' bullets. No preamble, no closing line.
- The transcript comes from a phone mic near a laptop, so speakers aren't labeled and some words may be misheard. Use the job background to fix obvious mishearings of names and terms. Never invent facts that aren't in the notes or transcript.`;
  const ASK_SYSTEM = "You answer questions about one person's meetings for a single job. Answer only from the material provided. If it isn't there, say so plainly. Be brief. Use '- ' bullets for lists and include [mm:ss] timestamps when citing the transcript.";
  const ASSIST_SYSTEM = `You help one person answer questions live, during a meeting. You get background on their job, their rough notes, and the last couple of minutes of a transcript from a phone mic (no speaker labels, some words misheard).

If the newest lines hold a question or request the person may need to respond to, reply in exactly this shape:
Q: <the question, under 15 words>
- <2 to 4 short bullets they can say out loud: first person, plain spoken>

Pull facts from the job background, notes and transcript. If you don't know a specific fact, suggest what to say or check instead of inventing it. Never answer a question listed as already answered.
If there is no new question, reply with exactly: NONE`;

  // ---------- toast & sheet ----------
  let toastT;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { el.hidden = true; }, 4500);
  }
  function openSheet(html) {
    const sh = $('#sheet');
    sh.innerHTML = html;
    sh.hidden = false;
    $('#scrim').hidden = false;
    const f = sh.querySelector('[autofocus]');
    if (f) setTimeout(() => f.focus(), 30);
  }
  function closeSheet() {
    $('#sheet').hidden = true;
    $('#scrim').hidden = true;
    S.editJob = null;
  }

  const job = () => S.jobs.find((j) => j.id === S.jobId);
  const setView = (v) => { $('#app').dataset.view = v; };
  const refreshSetup = () => { $('#setupPill').hidden = !!settings.anthropicKey; };

  // ---------- jobs ----------
  async function loadJobs() {
    S.jobs = await api('/jobs');
    if (!S.jobs.find((j) => j.id === S.jobId)) S.jobId = S.jobs[0]?.id || '';
    store.set('margin.job', S.jobId);
    renderJobSwitch();
    await loadMeetings();
  }
  async function loadMeetings() {
    S.meetings = S.jobId ? await api(`/jobs/${S.jobId}/meetings`) : [];
    renderList();
    renderMain();
  }
  function renderJobSwitch() {
    const j = job();
    $('#jobName').textContent = j ? j.name : 'No job';
    $('#jobDot').style.setProperty('--c', j ? j.color : 'var(--faint)');
    $('#search').placeholder = j ? `Search ${j.name}` : 'Search';
  }
  async function switchJob(id) {
    if (S.rec) { toast('Stop listening before you switch jobs.'); return; }
    flushSave();
    S.jobId = id;
    store.set('margin.job', id);
    S.meeting = null; S.answer = null; S.query = ''; $('#search').value = '';
    closeSheet();
    setView('list');
    S.jobs = await api('/jobs');
    renderJobSwitch();
    await loadMeetings();
  }
  function openJobPicker() {
    openSheet(`<h2>Jobs</h2>
      <p class="sub">Each job keeps its own meetings, notes and AI context. Search, questions and live answers never reach across jobs.</p>
      <div class="job-list">${S.jobs.map((j) => `
        <button class="job-row ${j.id === S.jobId ? 'on' : ''}" type="button" data-job="${esc(j.id)}">
          <span class="dot" style="--c:${esc(j.color)}"></span><span>${esc(j.name)}</span>
          <span class="count">${j.meeting_count ?? 0}</span>
        </button>`).join('')}</div>
      <div class="row"><button class="btn" type="button" data-act="new-job">${I.plus} New job</button><span class="spacer"></span><button class="btn ghost" type="button" data-act="close">Done</button></div>`);
  }
  function openJobForm(isNew) {
    const j = isNew ? { name: '', color: COLORS[S.jobs.length % COLORS.length], context: '', template: DEFAULT_TEMPLATE } : job();
    if (!j) return;
    S.editJob = isNew ? 'new' : j.id;
    const canDelete = !isNew && S.jobs.length > 1;
    openSheet(`<form id="jobForm" novalidate>
      <h2>${isNew ? 'New job' : 'Job settings'}</h2>
      <p class="sub">${isNew ? 'A separate space for one employer, client or side project.' : 'Used only for meetings in this job.'}</p>
      <label class="field"><span>Name</span><input id="jf-name" maxlength="60" value="${esc(j.name)}" placeholder="e.g. Day job, Acme contract" ${isNew ? 'autofocus' : ''}></label>
      <fieldset class="field"><legend>Color</legend><div class="swatches">${COLORS.map((c, i) => `
        <label><input type="radio" name="jf-color" id="jf-color-${i}" value="${c}" ${c.toLowerCase() === String(j.color).toLowerCase() ? 'checked' : ''}><span style="--c:${c}"></span></label>`).join('')}</div></fieldset>
      <label class="field"><span>What the AI should know</span><small>Your role, the company, people, products and acronyms. Live answers lean on this most.</small>
        <textarea id="jf-context" rows="5" placeholder="Senior security engineer. People: Dana (CISO), Raj (network). Terms: CASB, SSE, XSOAR.">${esc(j.context)}</textarea></label>
      <label class="field"><span>Note template</span><small>The headings your enhanced notes follow.</small>
        <textarea id="jf-template" rows="5">${esc(j.template || DEFAULT_TEMPLATE)}</textarea></label>
      <div class="row">
        <button class="btn primary" type="submit">${isNew ? 'Create job' : 'Save'}</button>
        <button class="btn ghost" type="button" data-act="close">Cancel</button>
        <span class="spacer"></span>
        ${isNew ? '' : `<button class="btn ghost" type="button" data-act="del-job" ${canDelete ? '' : 'disabled'}>${I.trash} Delete job</button>`}
      </div>
      ${!isNew && !canDelete ? '<p class="note-small">This is your only job, so it can\'t be deleted.</p>' : ''}
      <div class="confirm" id="jf-confirm" hidden>
        <p>Delete ${esc(j.name)} and its ${j.meeting_count ?? 0} meeting${j.meeting_count === 1 ? '' : 's'}? Notes and transcripts are removed for good.</p>
        <div class="row"><button class="btn danger sm" type="button" data-act="del-job-yes">Delete job</button><button class="btn ghost sm" type="button" data-act="del-job-no">Keep it</button></div>
      </div>
    </form>`);
  }
  async function saveJobForm() {
    const name = $('#jf-name').value.trim();
    if (!name) { toast('Give the job a name.'); $('#jf-name').focus(); return; }
    const body = {
      name,
      color: ($('input[name="jf-color"]:checked') || {}).value || COLORS[0],
      context: $('#jf-context').value,
      template: $('#jf-template').value.trim() || DEFAULT_TEMPLATE,
    };
    try {
      if (S.editJob === 'new') {
        if (S.rec) { toast('Stop listening before you switch jobs.'); return; }
        const j = await api('/jobs', { method: 'POST', json: body });
        S.editJob = null;
        await switchJob(j.id);
        toast(`Created ${j.name}.`);
      } else {
        const j = await api(`/jobs/${S.editJob}`, { method: 'PUT', json: body });
        S.jobs = S.jobs.map((x) => (x.id === j.id ? j : x));
        closeSheet();
        renderJobSwitch(); renderList(); renderMain();
        toast('Saved.');
      }
    } catch (e) { toast(e.message); }
  }
  async function deleteJob() {
    const id = S.editJob;
    try {
      await api(`/jobs/${id}`, { method: 'DELETE' });
      S.jobs = S.jobs.filter((j) => j.id !== id);
      S.editJob = null;
      await switchJob(S.jobs[0].id);
      toast('Job deleted.');
    } catch (e) { toast(e.message); }
  }

  // ---------- settings ----------
  function openSettings() {
    const hasSR = !!SR;
    openSheet(`<form id="settingsForm" novalidate autocomplete="off">
      <h2>Settings</h2>
      <p class="sub">Keys and meetings stay in this browser on this phone. Nothing goes through a Margin server.</p>
      <fieldset class="field"><legend>Transcription</legend><div class="choices">
        <label class="choice"><input type="radio" name="st-engine" value="browser" ${settings.engine === 'browser' ? 'checked' : ''} ${hasSR ? '' : 'disabled'}>
          <span><strong>iPhone speech</strong><small>${hasSR ? 'Free, no key. Good for trying it out. Pauses can cost a word or two.' : "This browser doesn't offer it. Use Safari on iPhone, or Deepgram."}</small></span></label>
        <label class="choice"><input type="radio" name="st-engine" value="deepgram" ${settings.engine === 'deepgram' ? 'checked' : ''}>
          <span><strong>Deepgram</strong><small>More accurate, streams in real time, best for live answers. About $0.30 an hour; new accounts get free credit.</small></span></label>
      </div></fieldset>
      <label class="field"><span>Deepgram API key</span><small>From <a href="https://console.deepgram.com" target="_blank" rel="noopener">console.deepgram.com</a>. Only needed for Deepgram.</small>
        <input id="st-dg" type="password" value="${esc(settings.deepgramKey)}" spellcheck="false" autocapitalize="off"></label>
      <label class="field"><span>Claude API key</span><small>From <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a>. Used for notes, questions and live answers.</small>
        <input id="st-ak" type="password" value="${esc(settings.anthropicKey)}" spellcheck="false" autocapitalize="off" placeholder="sk-ant-..."></label>
      <label class="field"><span>Notes model</span><input id="st-nm" value="${esc(settings.notesModel)}" spellcheck="false" autocapitalize="off"></label>
      <label class="field"><span>Live answers model</span><small>A fast model keeps answers quick.</small><input id="st-lm" value="${esc(settings.liveModel)}" spellcheck="false" autocapitalize="off"></label>
      <div class="row"><button class="btn primary" type="submit">Save</button><button class="btn ghost" type="button" data-act="close">Cancel</button></div>
      <hr class="divider">
      <fieldset class="field"><legend>Backup</legend><small>Meetings only live in this browser. Clearing Safari's website data deletes them, so export now and then.</small>
        <div class="row" style="margin-top:6px"><button class="btn sm" type="button" data-act="export">Export backup</button>
        <label class="btn sm" for="st-import">Import backup</label><input id="st-import" type="file" accept="application/json,.json" hidden></div></fieldset>
    </form>`);
  }
  function saveSettingsForm() {
    const engine = ($('input[name="st-engine"]:checked') || {}).value || settings.engine;
    Object.assign(settings, {
      engine,
      deepgramKey: $('#st-dg').value.trim(),
      anthropicKey: $('#st-ak').value.trim(),
      notesModel: $('#st-nm').value.trim() || DEFAULTS.notesModel,
      liveModel: $('#st-lm').value.trim() || DEFAULTS.liveModel,
    });
    if (engine === 'deepgram' && !settings.deepgramKey) { toast('Add a Deepgram key, or pick iPhone speech.'); return; }
    saveSettings();
    refreshSetup();
    closeSheet();
    toast('Settings saved.');
    S.assist.errShown = false;
  }
  function exportBackup() {
    Local.save();
    const blob = new Blob([JSON.stringify(Local.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `margin-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  async function importBackup(file) {
    try {
      const d = JSON.parse(await file.text());
      if (!Array.isArray(d.jobs) || !Array.isArray(d.meetings)) throw new Error('bad');
      const jobIds = new Set(Local.data.jobs.map((j) => j.id));
      const meetIds = new Set(Local.data.meetings.map((m) => m.id));
      let added = 0;
      for (const j of d.jobs) if (j && j.id && j.name && !jobIds.has(j.id)) { Local.data.jobs.push({ ...j }); jobIds.add(j.id); }
      for (const m of d.meetings) {
        if (m && m.id && jobIds.has(m.job_id) && !meetIds.has(m.id)) {
          Local.data.meetings.push({ notes: '', enhanced: '', segments: [], duration: 0, title: '', ...m });
          added++;
        }
      }
      Local.save();
      closeSheet();
      await loadJobs();
      toast(`Imported ${added} meeting${added === 1 ? '' : 's'}.`);
    } catch { toast("That file isn't a Margin backup."); }
  }

  // ---------- list ----------
  function renderList() {
    const el = $('#list');
    const q = S.query.trim().toLowerCase();
    const items = S.meetings.filter((m) => !q || `${m.title} ${m.snippet || ''}`.toLowerCase().includes(q));
    const name = esc(job()?.name || 'this job');
    if (!items.length) {
      el.innerHTML = `<p class="empty side-empty">${q ? `Nothing in ${name} matches “${esc(S.query)}”.` : `No meetings in ${name} yet. Start one, then set your phone next to your laptop.`}</p>`;
      return;
    }
    let html = '', last = '';
    for (const m of items) {
      const g = dayLabel(m.started_at);
      if (g !== last) { html += `<div class="group">${esc(g)}</div>`; last = g; }
      const live = S.rec && S.rec.meetingId === m.id;
      html += `<button class="item ${S.meeting?.id === m.id ? 'on' : ''}" type="button" data-open="${esc(m.id)}">
        <div class="item-title">${live ? '<span class="live" title="Listening"></span>' : ''}<span class="t ${m.title ? '' : 'untitled'}">${esc(m.title || 'Untitled meeting')}</span></div>
        <div class="item-meta">${timeOf(m.started_at)}${m.duration ? ` · ${dur(m.duration)}` : ''}${live ? ' · listening' : ''}</div>
        ${m.snippet ? `<div class="item-snip">${esc(m.snippet)}</div>` : ''}
      </button>`;
    }
    el.innerHTML = html;
  }
  function syncSummary() {
    const m = S.meeting;
    if (!m) return;
    const s = S.meetings.find((x) => x.id === m.id);
    if (s) { s.title = m.title; s.snippet = snippetOf(m); s.duration = m.duration; s.has_enhanced = !!m.enhanced; }
    renderList();
  }

  // ---------- meeting ----------
  async function openMeeting(id) {
    if (S.rec && S.rec.meetingId !== id) { toast('Stop listening before you open another meeting.'); return; }
    if (S.meeting?.id === id) { setView('meeting'); return; }
    flushSave();
    try { S.meeting = await api(`/meetings/${id}`); } catch (e) { toast(e.message); return; }
    S.tab = 'notes'; S.showRaw = false; S.answer = null; S.confirmDel = false; S.assist.items = [];
    setView('meeting');
    renderList();
    renderMain();
  }
  async function newMeeting() {
    if (S.rec) { toast('Stop listening before you start another meeting.'); return; }
    flushSave();
    const m = await api(`/jobs/${S.jobId}/meetings`, { method: 'POST', json: { title: '' } });
    S.meetings.unshift(Local.summary(m));
    const j = job(); if (j) j.meeting_count = (j.meeting_count || 0) + 1;
    S.meeting = m; S.tab = 'notes'; S.showRaw = false; S.answer = null; S.confirmDel = false; S.assist.items = [];
    setView('meeting');
    renderList();
    renderMain();
    $('#title')?.focus();
  }
  async function deleteMeeting() {
    const m = S.meeting;
    if (!m) return;
    if (S.rec?.meetingId === m.id) { toast('Stop listening first.'); return; }
    clearTimeout(saveT); pending = {}; pendingId = null;
    await api(`/meetings/${m.id}`, { method: 'DELETE' });
    S.meetings = S.meetings.filter((x) => x.id !== m.id);
    const j = job(); if (j) j.meeting_count = Math.max(0, (j.meeting_count || 1) - 1);
    S.meeting = null; S.confirmDel = false;
    setView('list');
    renderList(); renderMain();
    toast('Meeting deleted.');
  }

  let saveT = null, pending = {}, pendingId = null;
  function queueSave(patch) {
    if (pendingId && pendingId !== S.meeting.id) flushSave();
    pendingId = S.meeting.id;
    Object.assign(pending, patch);
    clearTimeout(saveT);
    saveT = setTimeout(flushSave, 600);
  }
  function flushSave() {
    clearTimeout(saveT);
    const patch = pending, id = pendingId;
    pending = {}; pendingId = null;
    if (!id || !Object.keys(patch).length) return;
    try { Local.route('PUT', `/meetings/${id}`, patch); } catch (e) { toast(`Couldn't save: ${e.message}`); }
  }

  function welcomeHTML() {
    const j = job();
    return `<div class="welcome">
      <h1>${esc(j?.name || 'Margin')}</h1>
      <p>Meetings for this job live here, apart from your other jobs.</p>
      <ol class="steps">
        <li><span><strong>Start a meeting</strong> on your phone before the call begins.</span></li>
        <li><span><strong>Set the phone by your laptop</strong> with the speakers on, not headphones, so it hears both sides.</span></li>
        <li><span><strong>Jot a few rough notes</strong>, then tap Enhance when the call ends.</span></li>
      </ol>
      <button class="btn primary" type="button" data-act="new">${I.plus} New meeting</button>
    </div>`;
  }
  const metaText = (m) => `${esc(dayLabel(m.started_at))} · ${timeOf(m.started_at)}${m.duration ? ` · ${dur(m.duration)}` : ''}`;
  function delHTML() {
    if (!S.confirmDel) return `<button class="icon-btn" type="button" data-act="del" aria-label="Delete meeting">${I.trash}</button>`;
    return `<span class="confirm-inline">Delete?
      <button class="btn danger sm" type="button" data-act="del-yes">Delete</button>
      <button class="btn ghost sm" type="button" data-act="del-no">Cancel</button></span>`;
  }
  function renderMain() {
    const el = $('#main');
    const m = S.meeting, j = job();
    if (!m || !j) { el.innerHTML = welcomeHTML(); return; }
    el.innerHTML = `<div class="note">
      <header class="note-head">
        <button class="icon-btn back" type="button" data-act="back" aria-label="All meetings">${I.back}</button>
        <span class="chip"><span class="dot" style="--c:${esc(j.color)}"></span>${esc(j.name)}</span>
        <span class="meta" id="meetMeta">${metaText(m)}</span>
        <span class="spacer"></span>
        <span id="delSlot">${delHTML()}</span>
      </header>
      <input id="title" class="title-input" value="${esc(m.title)}" placeholder="Untitled meeting" maxlength="140" aria-label="Meeting title" autocomplete="off">
      <div class="tabs" role="tablist">
        <button class="tab" role="tab" type="button" aria-selected="${S.tab === 'notes'}" data-tab="notes">Notes</button>
        <button class="tab" role="tab" type="button" aria-selected="${S.tab === 'transcript'}" data-tab="transcript">Transcript<span class="n" id="segCount">${m.segments.length || ''}</span></button>
      </div>
      <div class="tab-body" id="tabBody"></div>
      <div class="dock" id="dock"></div>
    </div>`;
    renderTab();
    renderDock();
  }

  const segHTML = (s, isNew) => `<div class="seg${isNew ? ' new' : ''}"><time>${clock(s.t)}</time><p>${esc(s.text)}</p></div>`;
  function renderTab() {
    const el = $('#tabBody');
    if (!el) return;
    const m = S.meeting;
    const r = S.rec?.meetingId === m.id ? S.rec : null;
    if (S.tab === 'transcript') {
      if (!m.segments.length && !r) {
        el.innerHTML = "<p class=\"empty\">Nothing transcribed yet. Tap <strong>Start listening</strong> and set your phone close to your laptop's speakers.</p>";
        return;
      }
      el.innerHTML = `${!m.segments.length ? '<p class="empty small">Listening. Lines show up here as people talk.</p>' : ''}
        <div class="segs" id="segs">${m.segments.map((s) => segHTML(s)).join('')}${r ? `<div class="seg interim" id="interim" ${r.interimText ? '' : 'hidden'}><time>${clock(Rec.elapsed(r))}</time><p>${esc(r.interimText)}</p></div>` : ''}</div>`;
      return;
    }
    if (m.enhanced && !S.showRaw) {
      el.innerHTML = `<div class="legend"><span class="key mine">Your notes</span><span class="key ai">Filled in from the transcript</span><span class="spacer"></span><button class="link" type="button" data-act="raw">Edit my notes</button></div>
        <article class="md">${md(m.enhanced, mineMatcher(m.notes))}</article>`;
      return;
    }
    el.innerHTML = `${m.enhanced ? '<div class="legend"><span>Your rough notes</span><span class="spacer"></span><button class="link" type="button" data-act="enhanced">Back to enhanced notes</button></div>' : ''}
      <textarea id="notes" class="notes" placeholder="Jot rough notes as you go. Margin fills in the rest from what it hears." aria-label="Your notes">${esc(m.notes)}</textarea>`;
  }

  function askHTML() {
    const prev = $('#askInput')?.value || '';
    return `<form class="ask" id="askForm">
      <input id="askInput" value="${esc(prev)}" autocomplete="off" aria-label="Ask a question" placeholder="${S.scope === 'job' ? 'Ask across this job' : 'Ask a question'}">
      <button class="scope" type="button" data-act="scope" aria-label="Question scope">${S.scope === 'job' ? 'Whole job' : 'This meeting'}</button>
      <button class="icon-btn sm" type="submit" aria-label="Ask">${I.send}</button>
    </form>`;
  }
  function answerHTML() {
    const a = S.answer;
    if (!a) return '';
    const body = a.text ? `<div class="md small" id="askA">${md(a.text)}</div>`
      : a.err ? `<p class="err">${esc(a.err)}</p>`
      : '<p class="pending"><span class="spin"></span> Thinking</p>';
    return `<div class="answer"><div class="answer-q"><span>${esc(a.q)}</span><button class="icon-btn sm" type="button" data-act="close-answer" aria-label="Close answer">${I.x}</button></div>${body}</div>`;
  }
  function liveToggleHTML() {
    return `<button class="live-toggle" type="button" data-act="live" aria-pressed="${S.live}"><span class="sw" aria-hidden="true"></span>Live answers</button>`;
  }
  function liveHTML() {
    if (!S.live) return '';
    const items = S.assist.items;
    const top = items[0];
    if (!top || top.dismissed) {
      if (S.assist.forcing) return '<div class="live-panel"><p class="live-hint"><span class="spin"></span> Reading the last couple of minutes</p></div>';
      if (S.rec?.meetingId === S.meeting?.id && !S.rec.stopping) return '<div class="live-panel"><p class="live-hint">Listening for questions. Suggested answers show up here a few seconds after someone asks.</p></div>';
      return '';
    }
    const earlier = items.slice(1);
    return `<div class="live-panel">
      <div class="live-q"><span class="tag">Asked</span><span class="q">${esc(top.q || 'Suggested reply')}</span>${top.pending ? '<span class="spin"></span>' : ''}<button class="icon-btn sm" type="button" data-act="live-close" aria-label="Hide answer">${I.x}</button></div>
      <div class="md small live-a" id="liveA">${md(top.text)}</div>
      ${earlier.length ? `<details class="earlier"><summary>Earlier answers (${earlier.length})</summary>${earlier.map((x) => `<div class="earlier-item"><p class="q">${esc(x.q || 'Suggested reply')}</p><div class="md small">${md(x.text)}</div></div>`).join('')}</details>` : ''}
    </div>`;
  }
  function renderDock() {
    const el = $('#dock');
    if (!el || !S.meeting) return;
    const m = S.meeting;
    const r = S.rec && S.rec.meetingId === m.id ? S.rec : null;
    let row;
    if (r) {
      row = r.stopping
        ? '<span class="pending"><span class="spin"></span> Wrapping up the transcript</span>'
        : `<button class="btn rec" type="button" data-act="stop">${I.stop} Stop</button>
           ${r.engine === 'deepgram' ? `<span class="meter" id="meter" aria-hidden="true">${'<i></i>'.repeat(16)}</span>` : '<span class="listen-dot">Listening</span>'}
           <span class="clock" id="clock">${clock(Rec.elapsed(r))}</span>
           <span class="pending" id="pending"></span>`;
    } else {
      const has = m.segments.length > 0;
      const canEnhance = has || m.notes.trim();
      row = `<button class="btn ${has ? '' : 'rec'}" type="button" data-act="start">${I.mic} ${has ? 'Resume' : 'Start listening'}</button>
        ${canEnhance ? `<button class="btn primary" type="button" data-act="enhance" ${S.busy.enhance ? 'disabled' : ''}>${S.busy.enhance ? '<span class="spin"></span> Writing notes' : `${I.spark} ${m.enhanced ? 'Redo notes' : 'Enhance notes'}`}</button>` : ''}`;
    }
    const liveRow = `<div class="dock-row">${liveToggleHTML()}<span class="spacer"></span>${S.live && (r || m.segments.length) ? '<button class="btn sm" type="button" data-act="answer-now">Answer now</button>' : ''}</div>`;
    const showAsk = m.segments.length || m.enhanced;
    el.innerHTML = `${liveHTML()}${answerHTML()}<div class="dock-row">${row}</div>${liveRow}${showAsk ? askHTML() : ''}`;
    if (r) updateLive();
  }
  function updateLive() {
    const r = S.rec;
    if (!r) return;
    const c = $('#clock');
    if (c) c.textContent = clock(Rec.elapsed(r));
    const p = $('#pending');
    if (p) { p.textContent = r.status || ''; p.classList.toggle('err', !!r.statusErr); }
  }

  function showNewSegment(meetingId, seg) {
    if (S.meeting?.id !== meetingId) { syncSummaryById(meetingId); return; }
    const n = $('#segCount'); if (n) n.textContent = S.meeting.segments.length;
    if (S.tab === 'transcript') {
      const box = $('#main');
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
      const interim = $('#interim');
      if (interim) interim.insertAdjacentHTML('beforebegin', segHTML(seg, true));
      else renderTab();
      if (nearBottom) box.scrollTop = box.scrollHeight;
    }
    if (!$('#askForm') || !$('[data-act="answer-now"]')) renderDock();
  }
  function syncSummaryById(id) {
    const m = Local.meeting(id), s = S.meetings.find((x) => x.id === id);
    if (m && s) { s.duration = m.duration; s.snippet = snippetOf(m); }
    renderList();
  }

  // ---------- enhance & ask ----------
  async function enhance() {
    const m = S.meeting;
    if (!m || S.busy.enhance) return;
    flushSave();
    const j = S.jobs.find((x) => x.id === m.job_id) || job();
    S.busy.enhance = true;
    renderDock();
    try {
      const user = `${jobBrief(j)}\n\nMeeting title: ${m.title || 'Untitled'}\n\nTemplate:\n${j.template || DEFAULT_TEMPLATE}\n\nMy rough notes:\n${m.notes.trim() || '(none)'}\n\nTranscript:\n${transcriptText(m) || '(no transcript)'}`;
      let out = await claude({ system: ENHANCE_SYSTEM, user, model: settings.notesModel, maxTokens: 2500 });
      out = out.replace(/^```(?:markdown)?\s*|\s*```$/g, '').trim();
      m.enhanced = out;
      Local.save();
      if (S.meeting?.id === m.id) { S.tab = 'notes'; S.showRaw = false; }
      syncSummary();
    } catch (e) {
      toast(e.message);
      if (!settings.anthropicKey) openSettings();
    } finally {
      S.busy.enhance = false;
      if (S.meeting?.id === m.id) renderMain();
    }
  }
  async function ask(q) {
    const m = S.meeting, j = job();
    S.answer = { q, scope: S.scope };
    const input = $('#askInput'); if (input) input.value = '';
    renderDock();
    const a = S.answer;
    let material;
    if (S.scope === 'meeting') {
      material = `Meeting: ${m.title || 'Untitled'}\n\nNotes:\n${m.enhanced || m.notes}\n\nTranscript:\n${transcriptText(m, 40000)}`;
    } else {
      let budget = 48000;
      const parts = [];
      for (const x of Local.data.meetings.filter((y) => y.job_id === j.id).sort((p, c) => c.started_at - p.started_at).slice(0, 40)) {
        const day = new Date(x.started_at * 1000).toISOString().slice(0, 10);
        const piece = `## ${x.title || 'Untitled'} (${day})\n${x.enhanced || x.notes || transcriptText(x, 3000)}\n`;
        if (piece.length > budget) break;
        parts.push(piece);
        budget -= piece.length;
      }
      material = parts.join('\n') || '(no meetings yet)';
    }
    try {
      a.text = '';
      await claude({
        system: ASK_SYSTEM, model: settings.notesModel, maxTokens: 900,
        user: `${jobBrief(j)}\n\nMaterial:\n${material}\n\nQuestion: ${q}`,
        onText: (t) => {
          a.text += t;
          const el = $('#askA');
          if (S.answer === a) { if (el) el.innerHTML = md(a.text); else renderDock(); }
        },
      });
    } catch (e) { a.err = e.message; a.text = ''; }
    if (S.answer === a) renderDock();
  }

  // ---------- live answers ----------
  async function assist(force) {
    const m = S.meeting;
    if (!m) return;
    if (S.assist.busy) { S.assist.queued = S.assist.queued === 'force' || force ? 'force' : 'auto'; return; }
    if (!m.segments.length) { if (force) toast('Nothing transcribed yet.'); return; }
    S.assist.busy = true;
    S.assist.forcing = force;
    if (force) renderDock();
    const j = S.jobs.find((x) => x.id === m.job_id) || job();
    const latest = m.segments[m.segments.length - 1].t;
    const recent = m.segments.filter((s) => s.t >= latest - 150).slice(-40).map((s) => `[${clock(s.t)}] ${s.text}`).join('\n');
    const answered = S.assist.items.slice(0, 10).map((x) => x.q).filter(Boolean).map((q) => `- ${q}`).join('\n') || '(none)';
    const mode = force
      ? "They tapped 'Answer now': answer the most recent question or topic, even if it isn't phrased as a question."
      : 'Only answer if the newest lines contain a new question.';
    const item = { q: '', text: '', pending: true };
    let buf = '', started = false;
    const update = (final) => {
      const s = buf.trimStart();
      if (!started) {
        if (/^NONE/i.test(s) || 'NONE'.startsWith(s.toUpperCase())) return;
        const qm = s.match(/^Q:\s*(.*)\n/i);
        if (qm) item.q = qm[1].trim();
        else if (!final && (/^Q/i.test(s) || s.length < 24)) return;
        else item.q = (s.match(/^Q:\s*(.*)$/i) || [])[1] || '';
        started = true;
        S.assist.items.unshift(item);
        S.assist.items.length = Math.min(S.assist.items.length, 20);
        if (S.meeting?.id === m.id) renderDock();
      }
      item.text = s.replace(/^Q:.*(\n|$)/i, '');
      const a = $('#liveA');
      if (a && S.assist.items[0] === item) a.innerHTML = md(item.text);
    };
    try {
      await claude({
        system: ASSIST_SYSTEM, model: settings.liveModel, maxTokens: 300,
        user: `${jobBrief(j)}\n\nTheir rough notes:\n${m.notes.trim().slice(-3000) || '(none)'}\n\nAlready answered:\n${answered}\n\n${mode}\n\nTranscript, newest last:\n${recent}`,
        onText: (t) => { buf += t; update(false); },
      });
      const s = buf.trim();
      if (!started && s && !/^NONE/i.test(s)) update(true);
      if (!started && force) toast("Didn't hear a question in the last couple of minutes.");
    } catch (e) {
      if (force || !S.assist.errShown) { toast(`Live answers: ${e.message}`); S.assist.errShown = true; }
    } finally {
      item.pending = false;
      S.assist.busy = false;
      S.assist.forcing = false;
      if (S.meeting?.id === m.id) renderDock();
      const q = S.assist.queued;
      S.assist.queued = null;
      if (q) assist(q === 'force');
    }
  }

  // ---------- recorder ----------
  let wake = null;
  async function wakeLock(on) {
    try {
      if (on && 'wakeLock' in navigator) wake = await navigator.wakeLock.request('screen');
      else if (!on && wake) { await wake.release(); wake = null; }
    } catch { /* not granted */ }
  }
  function downsampleTo16k(buf, rate) {
    const ratio = rate / 16000, len = Math.floor(buf.length / ratio), out = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      const a = Math.floor(i * ratio), b = Math.min(buf.length, Math.floor((i + 1) * ratio));
      let s = 0;
      for (let k = a; k < b; k++) s += buf[k];
      const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  }

  const Rec = {
    elapsed(r) { return r.offset + ((r.endedAt || Date.now()) - r.startedAt) / 1000; },
    async start(m) {
      if (S.rec) return;
      if (!window.isSecureContext) { toast('The mic only works over https.'); return; }
      const r = { meetingId: m.id, engine: settings.engine, startedAt: Date.now(), offset: m.duration || 0, level: 0, hist: [], frame: 0, stopping: false, utter: '', uStart: null, interimText: '', status: 'Starting', statusErr: false, lastFinal: '' };
      if (r.engine === 'deepgram' && !settings.deepgramKey) { toast('Add your Deepgram key in Settings, or switch to iPhone speech.'); openSettings(); return; }
      S.rec = r;
      try {
        if (r.engine === 'deepgram') await Rec.startDeepgram(r);
        else Rec.startBrowser(r);
      } catch (e) {
        Rec.cleanup(r);
        S.rec = null;
        toast(e.message);
        renderDock(); renderList();
        return;
      }
      wakeLock(true);
      r.tick = setInterval(updateLive, 500);
      if (r.engine === 'deepgram') Rec.meter();
      renderDock(); renderList();
      if (S.tab === 'transcript') renderTab();
    },

    // iPhone / browser speech recognition: free, restarts itself after pauses.
    startBrowser(r) {
      if (!SR) throw new Error("This browser doesn't have built-in speech recognition. Pick Deepgram in Settings.");
      const sr = new SR();
      sr.continuous = true;
      sr.interimResults = true;
      sr.lang = settings.lang || 'en-US';
      sr.onstart = () => { r.status = 'Transcribing live'; r.statusErr = false; updateLive(); };
      sr.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          const txt = res[0].transcript.trim();
          if (res.isFinal) { if (txt) Rec.final(r, txt); }
          else interim += `${txt} `;
        }
        interim = interim.trim();
        if (interim && r.uStart == null) r.uStart = Rec.elapsed(r);
        Rec.interim(r, interim);
      };
      sr.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          r.fatal = true;
          Rec.stop('Mic or speech access is blocked. Allow it for this site in Settings › Safari, then try again.');
        } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
          r.status = `Speech recognition hiccup (${e.error}), restarting`; r.statusErr = true; updateLive();
        }
      };
      sr.onend = () => {
        if (S.rec !== r || r.stopping || r.fatal) return;
        setTimeout(() => { if (S.rec === r && !r.stopping) { try { sr.start(); } catch { /* already started */ } } }, 250);
      };
      r.sr = sr;
      sr.start();
    },

    // Deepgram: phone mic -> 16 kHz PCM -> websocket, finals arrive within a second.
    async startDeepgram(r) {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't use the microphone here.");
      try {
        // Echo cancellation and noise suppression off: the laptop speaker IS the signal.
        r.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
      } catch (e) {
        throw new Error(e.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it for this site in Settings › Safari, then try again.' : `Couldn't start the microphone: ${e.message}`);
      }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      r.ctx = new Ctx();
      if (r.ctx.state === 'suspended') await r.ctx.resume().catch(() => {});
      r.src = r.ctx.createMediaStreamSource(r.stream);
      const params = new URLSearchParams({
        model: 'nova-3', language: 'en-US', encoding: 'linear16', sample_rate: '16000', channels: '1',
        smart_format: 'true', interim_results: 'true', endpointing: '300', utterance_end_ms: '1000', vad_events: 'true',
      });
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', settings.deepgramKey]);
        ws.binaryType = 'arraybuffer';
        const timer = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error("Deepgram didn't answer. Check your connection.")); }, 8000);
        ws.onopen = () => { clearTimeout(timer); r.ws = ws; r.status = 'Transcribing live'; resolve(); };
        ws.onerror = () => { clearTimeout(timer); if (!r.ws) reject(new Error('Deepgram refused the connection. Check your Deepgram key in Settings.')); };
        ws.onmessage = (ev) => Rec.onDeepgram(r, ev.data);
        ws.onclose = () => {
          if (r.ws === ws && S.rec === r && !r.stopping) {
            r.status = 'Connection dropped, reconnecting'; r.statusErr = true; updateLive();
            r.ws = null;
            setTimeout(() => { if (S.rec === r && !r.stopping) Rec.reconnect(r); }, 1000);
          }
        };
      });
      const onData = (f32) => {
        let s = 0;
        for (let i = 0; i < f32.length; i += 4) s += f32[i] * f32[i];
        r.level = Math.max(Math.sqrt(s / Math.max(1, f32.length / 4)), r.level * 0.9);
        if (r.ws && r.ws.readyState === 1 && !r.stopping) r.ws.send(downsampleTo16k(f32, r.ctx.sampleRate).buffer);
      };
      try {
        const code = "class T extends AudioWorkletProcessor{constructor(){super();this.b=[];this.n=0}process(i){const c=i[0]&&i[0][0];if(c){this.b.push(c.slice(0));this.n+=c.length;if(this.n>=2048){const o=new Float32Array(this.n);let k=0;for(const x of this.b){o.set(x,k);k+=x.length}this.port.postMessage(o,[o.buffer]);this.b=[];this.n=0}}return true}}registerProcessor('margin-tap',T)";
        await r.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
        r.node = new AudioWorkletNode(r.ctx, 'margin-tap');
        r.node.port.onmessage = (e) => onData(e.data);
      } catch {
        r.node = r.ctx.createScriptProcessor(4096, 1, 1);
        r.node.onaudioprocess = (e) => onData(new Float32Array(e.inputBuffer.getChannelData(0)));
      }
      r.mute = r.ctx.createGain();
      r.mute.gain.value = 0;
      r.src.connect(r.node); r.node.connect(r.mute); r.mute.connect(r.ctx.destination);
      r.stream.getAudioTracks()[0].addEventListener('ended', () => Rec.stop('The microphone was interrupted, so listening stopped.'));
      r.keepAlive = setInterval(() => { if (r.ws?.readyState === 1) r.ws.send(JSON.stringify({ type: 'KeepAlive' })); }, 8000);
    },
    async reconnect(r) {
      const params = new URLSearchParams({
        model: 'nova-3', language: 'en-US', encoding: 'linear16', sample_rate: '16000', channels: '1',
        smart_format: 'true', interim_results: 'true', endpointing: '300', utterance_end_ms: '1000', vad_events: 'true',
      });
      r.reconnectOffset = Rec.elapsed(r) - r.offset;
      const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', settings.deepgramKey]);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { r.ws = ws; r.status = 'Transcribing live'; r.statusErr = false; updateLive(); };
      ws.onmessage = (ev) => Rec.onDeepgram(r, ev.data);
      ws.onclose = () => { if (r.ws === ws && S.rec === r && !r.stopping) { r.ws = null; setTimeout(() => { if (S.rec === r && !r.stopping) Rec.reconnect(r); }, 3000); } };
    },
    onDeepgram(r, raw) {
      let d;
      try { d = JSON.parse(raw); } catch { return; }
      const base = r.offset + (r.reconnectOffset || 0);
      if (d.type === 'Results') {
        const txt = (d.channel?.alternatives?.[0]?.transcript || '').trim();
        if (d.is_final) {
          if (txt) {
            if (r.uStart == null) r.uStart = base + (d.start || 0);
            r.utter = r.utter ? `${r.utter} ${txt}` : txt;
          }
          if (d.speech_final) Rec.flushUtter(r);
          else Rec.interim(r, r.utter);
        } else {
          Rec.interim(r, `${r.utter} ${txt}`.trim());
        }
      } else if (d.type === 'UtteranceEnd') {
        Rec.flushUtter(r);
      }
    },
    flushUtter(r) {
      const t = r.utter.trim();
      r.utter = '';
      if (t) Rec.final(r, t);
      Rec.interim(r, '');
    },
    final(r, text, t) {
      if (text === r.lastFinal) return; // iOS sometimes repeats a final after restarting
      r.lastFinal = text;
      const m = Local.meeting(r.meetingId);
      if (!m) return;
      const seg = { t: Math.round((t ?? r.uStart ?? Math.max(r.offset, Rec.elapsed(r) - 3)) * 100) / 100, text };
      r.uStart = null;
      m.segments.push(seg);
      Local.saveSoon();
      showNewSegment(r.meetingId, seg);
      if (S.live && S.meeting?.id === r.meetingId && QUESTION_RE.test(text)) assist(false);
    },
    interim(r, text) {
      r.interimText = text;
      const el = $('#interim');
      if (el && S.meeting?.id === r.meetingId) {
        el.querySelector('p').textContent = text;
        el.querySelector('time').textContent = clock(r.uStart ?? Rec.elapsed(r));
        el.hidden = !text;
      }
    },
    meter() {
      const r = S.rec;
      if (!r || r.stopping) return;
      if (++r.frame % 3 === 0) {
        r.hist.push(r.level);
        if (r.hist.length > 16) r.hist.shift();
        const bars = $$('#meter i');
        bars.forEach((b, i) => {
          const v = r.hist[i - (bars.length - r.hist.length)] || 0;
          b.style.height = `${Math.round(Math.max(4, Math.min(24, 4 + Math.sqrt(v) * 70)))}px`;
        });
      }
      r.raf = requestAnimationFrame(Rec.meter);
    },
    cleanup(r) {
      cancelAnimationFrame(r.raf);
      clearInterval(r.keepAlive);
      try { r.src?.disconnect(); r.node?.disconnect(); r.mute?.disconnect(); } catch { /* gone */ }
      r.stream?.getTracks().forEach((t) => t.stop());
      r.ctx?.close().catch(() => {});
      try { r.ws?.close(); } catch { /* gone */ }
      try { r.sr?.abort(); } catch { /* gone */ }
    },
    async stop(msg) {
      const r = S.rec;
      if (!r || r.stopping) return;
      r.stopping = true;
      r.endedAt = Date.now();
      renderDock();
      if (msg) toast(msg);
      if (r.engine === 'deepgram' && r.ws?.readyState === 1) {
        try { r.ws.send(JSON.stringify({ type: 'CloseStream' })); } catch { /* */ }
        await sleep(1200); // let the last finals arrive
      } else if (r.sr) {
        try { r.sr.stop(); } catch { /* */ }
        await sleep(700);
      }
      if (r.utter) Rec.flushUtter(r);
      Rec.cleanup(r);
      wakeLock(false);
      clearInterval(r.tick);
      const m = Local.meeting(r.meetingId);
      if (m) { m.duration = Rec.elapsed(r); m.ended_at = Date.now() / 1000; }
      Local.save();
      S.rec = null;
      if (S.meeting?.id === r.meetingId) {
        const meta = $('#meetMeta'); if (meta) meta.innerHTML = metaText(S.meeting);
        syncSummary();
        renderDock();
        if (S.tab === 'transcript') renderTab();
      } else syncSummaryById(r.meetingId);
    },
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { flushSave(); Local.save(); }
    if (document.visibilityState === 'visible' && S.rec && !S.rec.stopping) {
      wakeLock(true);
      if (S.rec.ctx && S.rec.ctx.state !== 'running') S.rec.ctx.resume().catch(() => {});
    }
  });
  window.addEventListener('pagehide', () => { flushSave(); Local.save(); });
  window.addEventListener('beforeunload', (e) => {
    flushSave(); Local.save();
    if (S.rec) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act],[data-open],[data-tab],[data-job]');
    if (!t || t.disabled) return;
    if (t.dataset.open) { openMeeting(t.dataset.open); return; }
    if (t.dataset.tab) { S.tab = t.dataset.tab; S.confirmDel = false; renderMain(); return; }
    if (t.dataset.job) { switchJob(t.dataset.job); return; }
    switch (t.dataset.act) {
      case 'jobs': openJobPicker(); break;
      case 'edit-job': openJobForm(false); break;
      case 'new-job': openJobForm(true); break;
      case 'settings': openSettings(); break;
      case 'export': exportBackup(); break;
      case 'close': closeSheet(); break;
      case 'del-job': $('#jf-confirm').hidden = false; break;
      case 'del-job-no': $('#jf-confirm').hidden = true; break;
      case 'del-job-yes': deleteJob(); break;
      case 'new': newMeeting(); break;
      case 'back': flushSave(); setView('list'); syncSummary(); break;
      case 'del': S.confirmDel = true; $('#delSlot').innerHTML = delHTML(); break;
      case 'del-no': S.confirmDel = false; $('#delSlot').innerHTML = delHTML(); break;
      case 'del-yes': deleteMeeting(); break;
      case 'raw': S.showRaw = true; renderTab(); $('#notes')?.focus(); break;
      case 'enhanced': flushSave(); S.showRaw = false; renderTab(); break;
      case 'start': Rec.start(S.meeting); break;
      case 'stop': Rec.stop(); break;
      case 'enhance': enhance(); break;
      case 'scope': S.scope = S.scope === 'meeting' ? 'job' : 'meeting'; renderDock(); $('#askInput')?.focus(); break;
      case 'close-answer': S.answer = null; renderDock(); break;
      case 'live': S.live = !S.live; store.set('margin.live', S.live ? '1' : '0'); renderDock(); break;
      case 'answer-now': assist(true); break;
      case 'live-close': if (S.assist.items[0]) S.assist.items[0].dismissed = true; renderDock(); break;
      default: break;
    }
  });
  document.addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.target.id === 'jobForm') saveJobForm();
    else if (e.target.id === 'settingsForm') saveSettingsForm();
    else if (e.target.id === 'askForm') {
      const q = $('#askInput').value.trim();
      if (q) ask(q);
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'st-import' && e.target.files?.[0]) importBackup(e.target.files[0]);
  });
  document.addEventListener('input', (e) => {
    const id = e.target.id;
    if (id === 'search') { S.query = e.target.value; renderList(); }
    else if (id === 'title' && S.meeting) { S.meeting.title = e.target.value; queueSave({ title: e.target.value }); syncSummary(); }
    else if (id === 'notes' && S.meeting) {
      S.meeting.notes = e.target.value;
      queueSave({ notes: e.target.value });
      if (!$('[data-act="enhance"]') && e.target.value.trim() && !S.rec) renderDock();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
    if (e.key === 'Enter' && e.target.id === 'title') { e.preventDefault(); $('#notes')?.focus(); }
  });

  // ---------- boot ----------
  async function boot() {
    $$('[data-icon]').forEach((el) => { el.innerHTML = I[el.dataset.icon] || ''; });
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    Local.load();
    Local.save();
    refreshSetup();
    await loadJobs();
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  boot();
})();
