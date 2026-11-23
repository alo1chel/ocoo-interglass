/*
 * Прописи C++ — логика приложения.
 *
 * Как устроено:
 *  - Ed      — лист-пропись: код показан «карандашом», ученик печатает поверх (скрытое textarea).
 *  - Notes   — заметки на полях к текущей строке.
 *  - Pop     — всплывающие подсказки к словам кода (словарь GLOSSARY).
 *  - Term    — пример запуска: печатает вывод или проигрывает кадры анимации.
 *  - AI      — Claude (возможность `sample` страницы-артефакта): составляет уроки по запросу
 *              и отвечает на вопросы. Без Claude подбирается похожий готовый урок.
 *  - Course, Rules — списки уроков и справочник.
 * Прогресс хранится в localStorage этого браузера.
 */
(function () {
  'use strict';

  var LESSONS = window.PROPISI_LESSONS || [];
  var RULES = window.PROPISI_RULES || [];
  var ANATOMY = window.PROPISI_ANATOMY || null;
  var TERMS = window.PROPISI_TERMS || [];
  var GLOSSARY = window.PROPISI_GLOSSARY || {};
  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var FILE = 'main.cpp';

  /* ---------------------------------------------------------------- helpers */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; });
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.append(kid.nodeType ? kid : String(kid));
  }

  // Текст с `кодом` и [ссылками](https://...). Всё вставляется как текст, не как разметка.
  function rich(text) {
    var frag = document.createDocumentFragment();
    String(text == null ? '' : text).split('`').forEach(function (part, i) {
      if (i % 2 === 1) { frag.append(h('code', { class: 'ic' }, part)); return; }
      var re = /\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, last = 0, m;
      while ((m = re.exec(part))) {
        if (m.index > last) frag.append(part.slice(last, m.index));
        frag.append(h('a', { href: m[2], target: '_blank', rel: 'noopener noreferrer' }, m[1]));
        last = re.lastIndex;
      }
      if (last < part.length) frag.append(part.slice(last));
    });
    return frag;
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }
  function fmtTime(ms) {
    var s = Math.round(ms / 1000), m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е'); }

  var toastTimer = 0;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2800);
  }

  /* ---------------------------------------------------------------- storage */

  var KEY = 'propisi-cpp:v1';
  var state = (function () {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { s = null; }
    if (!s || typeof s !== 'object') s = {};
    var fresh = !s.current;
    s.done = s.done && typeof s.done === 'object' ? s.done : {};
    s.drafts = s.drafts && typeof s.drafts === 'object' ? s.drafts : {};
    s.my = Array.isArray(s.my) ? s.my : [];
    s.settings = Object.assign({ level: 'novice', auto: true, size: window.innerWidth < 520 ? 1 : 2, model: 'opus' }, s.settings || {});
    s.fresh = fresh;
    return s;
  })();
  var saveTimer = 0;
  function save(now) {
    clearTimeout(saveTimer);
    var run = function () {
      try {
        var copy = Object.assign({}, state);
        delete copy.fresh;
        localStorage.setItem(KEY, JSON.stringify(copy));
      } catch (e) { /* хранилище недоступно — работаем без него */ }
    };
    if (now) run(); else saveTimer = setTimeout(run, 400);
  }

  /* ---------------------------------------------------------------- tokenizer */

  var KW = new Set(('if else for while do return break continue switch case default struct class public private ' +
    'protected const static using namespace new delete true false nullptr this template typename sizeof static_cast ' +
    'enum inline constexpr operator try catch throw virtual override goto friend explicit mutable volatile extern ' +
    'typedef union noexcept decltype').split(' '));
  var TYPES = new Set(('int double float char bool void long short unsigned signed size_t auto wchar_t int8_t ' +
    'uint8_t int16_t uint16_t int32_t uint32_t int64_t uint64_t').split(' '));
  var OPS = ['<<=', '>>=', '->*', '...', '<<', '>>', '::', '->', '++', '--', '==', '!=', '<=', '>=', '&&', '||',
    '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='];

  // Разбивает C++-код на кусочки: {cls, s, e, term} — класс подсветки, границы и ключ подсказки.
  function tokenize(src) {
    var toks = [], n = src.length, i = 0, lineStart = true;
    function push(type, s, e, key) { if (e > s) toks.push({ type: type, s: s, e: e, key: key }); }
    while (i < n) {
      var c = src[i], j, k;
      if (c === '\n') { push('nl', i, i + 1); i++; lineStart = true; continue; }
      if (c === ' ' || c === '\t') {
        j = i; while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
        push('ws', i, j); i = j; continue;
      }
      if (c === '#' && lineStart) {
        j = i + 1; while (j < n && /[A-Za-z]/.test(src[j])) j++;
        var dir = src.slice(i, j);
        push('pre', i, j, dir); i = j; lineStart = false;
        if (dir === '#include') {
          k = i; while (k < n && src[k] === ' ') k++;
          push('ws', i, k); i = k;
          if (src[i] === '<' || src[i] === '"') {
            var close = src[i] === '<' ? '>' : '"', m = i + 1;
            while (m < n && src[m] !== close && src[m] !== '\n') m++;
            var name = src.slice(i + 1, m).replace(/\.h$/, '');
            if (m < n && src[m] === close) m++;
            push('inc', i, m, name); i = m;
          }
        }
        continue;
      }
      lineStart = false;
      if (c === '/' && src[i + 1] === '/') { j = i; while (j < n && src[j] !== '\n') j++; push('com', i, j); i = j; continue; }
      if (c === '/' && src[i + 1] === '*') { j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; push('com', i, j); i = j; continue; }
      if (c === '"' || c === "'") {
        var q = c, seg = i;
        j = i + 1;
        while (j < n && src[j] !== q && src[j] !== '\n') {
          if (src[j] === '\\' && j + 1 < n && src[j + 1] !== '\n') {
            push('str', seg, j);
            k = j + 1;
            if (/[0-7]/.test(src[k])) { var st = k; while (k < n && k < st + 3 && /[0-7]/.test(src[k])) k++; }
            else if (src[k] === 'x') { k++; while (k < n && /[0-9A-Fa-f]/.test(src[k])) k++; }
            else k++;
            push('esc', j, k, src.slice(j, k)); j = k; seg = j; continue;
          }
          j++;
        }
        if (j < n && src[j] === q) j++;
        push('str', seg, j); i = j; continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        j = i + 1;
        while (j < n && (/[0-9A-Za-z_.]/.test(src[j]) || ((src[j] === '+' || src[j] === '-') && /[eE]/.test(src[j - 1]) && !/^0[xX]/.test(src.slice(i, j))))) j++;
        push('num', i, j); i = j; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        j = i + 1; while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
        push('word', i, j, src.slice(i, j)); i = j; continue;
      }
      var op = null;
      for (var o = 0; o < OPS.length; o++) if (src.startsWith(OPS[o], i)) { op = OPS[o]; break; }
      if (!op) op = c;
      push(/^[{}()\[\];,]$/.test(op) ? 'punc' : 'op', i, i + op.length, op);
      i += op.length;
    }
    var sig = toks.filter(function (t) { return t.type !== 'ws' && t.type !== 'nl' && t.type !== 'com'; });
    toks.forEach(function (t) { t.cls = t.type; t.term = null; });
    sig.forEach(function (t, idx) {
      if (t.type !== 'word') {
        if (t.key && GLOSSARY[t.key]) t.term = t.key;
        return;
      }
      var w = t.key, prev = sig[idx - 1], next = sig[idx + 1];
      var afterScope = prev && prev.key === '::';
      var afterDot = prev && (prev.key === '.' || prev.key === '->');
      if (TYPES.has(w)) t.cls = 'type';
      else if (KW.has(w)) t.cls = 'kw';
      else if (w === 'std') t.cls = 'ns';
      else if (afterScope) t.cls = 'lib';
      else if (next && next.key === '(') t.cls = 'fn';
      else t.cls = 'id';
      var key = (t.cls === 'type' || t.cls === 'kw' || t.cls === 'ns' || afterScope || afterDot || w === 'main') ? w : null;
      t.term = key && GLOSSARY[key] ? key : null;
    });
    return toks;
  }

  // Статичная подсветка (для справочника и ответов учителя).
  function highlight(code) {
    var frag = document.createDocumentFragment();
    tokenize(code).forEach(function (t) {
      var text = code.slice(t.s, t.e);
      if (t.cls === 'ws' || t.cls === 'nl') { frag.append(text); return; }
      var sp = h('span', { class: 't-' + t.cls }, text);
      if (t.term && text.indexOf('\n') < 0) { sp.classList.add('gterm'); sp.dataset.k = t.term; }
      frag.append(sp);
    });
    return frag;
  }

  function codeBlock(code, cap, plain) {
    var pre = h('pre', { class: 'cpre', 'data-terms': '' }, h('code', null, plain ? code : highlight(code)));
    return h('figure', { class: 'cblock' + (plain ? ' cblock-term' : '') }, cap ? h('figcaption', null, cap) : null, h('div', { class: 'cscroll' }, pre));
  }

  /* ---------------------------------------------------------------- lessons */

  function allLessons() { return LESSONS.concat(state.my); }
  function findLesson(id) {
    if (!id) return null;
    for (var i = 0; i < LESSONS.length; i++) if (LESSONS[i].id === id) return LESSONS[i];
    for (var j = 0; j < state.my.length; j++) if (state.my[j].id === id) return state.my[j];
    return null;
  }

  function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

  // Приводит урок от Claude (или из хранилища) к безопасному виду. Бросает ошибку, если урок непригоден.
  function normalizeLesson(d, request) {
    if (!d || typeof d !== 'object') throw new Error('shape');
    var code = typeof d.code === 'string' ? d.code : '';
    code = code.replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
      .split('\n').map(function (l) { return l.replace(/\s+$/, ''); }).join('\n')
      .replace(/^\n+/, '').replace(/\n+$/, '');
    if (code.length < 20 || code.length > 9000) throw new Error('code');
    var nLines = code.split('\n').length;
    var notes = (Array.isArray(d.notes) ? d.notes : []).map(function (x) {
      x = x || {};
      var from = clamp(parseInt(x.from, 10) || 1, 1, nLines);
      var to = clamp(parseInt(x.to, 10) || from, from, nLines);
      return { from: from, to: to, title: str(x.title, 90), text: str(x.text, 1200), rule: typeof x.rule === 'string' ? x.rule : undefined };
    }).filter(function (x) { return x.title || x.text; }).sort(function (a, b) { return a.from - b.from; });
    var run = d.run && typeof d.run === 'object' ? d.run : {};
    var r;
    if (run.kind === 'frames' && Array.isArray(run.frames) && run.frames.length) {
      r = {
        kind: 'frames',
        delay: clamp(parseInt(run.delay, 10) || 100, 30, 2000),
        frames: run.frames.slice(0, 150).map(function (f) { return String(f).slice(0, 4000); })
      };
    } else {
      var out = typeof run.output === 'string' ? run.output : '';
      r = { kind: 'text', output: out.slice(0, 8000) };
    }
    if (typeof run.note === 'string') r.note = run.note.slice(0, 400);
    return {
      id: typeof d.id === 'string' && /^gen-[a-z0-9-]+$/.test(d.id) ? d.id : 'gen-' + Date.now().toString(36),
      title: str(d.title, 80) || 'Урок по запросу',
      summary: str(d.summary, 500),
      code: code,
      notes: notes,
      run: r,
      tasks: (Array.isArray(d.tasks) ? d.tasks : []).map(function (t) { return str(t, 400); }).filter(Boolean).slice(0, 5),
      concepts: (Array.isArray(d.concepts) ? d.concepts : []).map(function (t) { return str(t, 40); }).filter(Boolean).slice(0, 6),
      request: str(request != null ? request : d.request, 400),
      createdAt: typeof d.createdAt === 'number' ? d.createdAt : Date.now(),
      generated: true,
      by: d.by && typeof d.by.name === 'string' ? { name: d.by.name.slice(0, 80), fem: !!d.by.fem } : null
    };
  }

  // Уроки, составленные раньше: проверяем заново, повреждённые отбрасываем.
  state.my = state.my.map(function (l) {
    try { return normalizeLesson(l, l && l.request); } catch (e) { return null; }
  }).filter(Boolean).slice(0, 20);

  function matchLesson(text) {
    var q = norm(text), best = null, bestScore = 0;
    LESSONS.forEach(function (l) {
      var score = 0;
      (l.keywords || []).forEach(function (k) { if (q.indexOf(norm(k)) >= 0) score += k.length > 4 ? 2 : 1; });
      if (score > bestScore) { best = l; bestScore = score; }
    });
    return best;
  }

  /* ---------------------------------------------------------------- shell */

  var SHELL = [
    '<header class="top"><div class="top-in">',
    '  <a class="brand" href="#practice" aria-label="Прописи C++: к прописи"><span class="brand-word">Прописи</span><span class="brand-cpp">C++</span></a>',
    '  <nav class="tabs" aria-label="Разделы">',
    '    <a class="tab" href="#practice" data-view="practice">Пропись</a>',
    '    <a class="tab" href="#course" data-view="course">Уроки <span class="tab-badge" id="doneBadge"></span></a>',
    '    <a class="tab" href="#rules" data-view="rules">Правила</a>',
    '  </nav>',
    '</div></header>',
    '<main class="wrap">',
    '<section class="view" id="view-practice">',
    '  <form class="request" id="reqForm" autocomplete="off">',
    '    <label class="req-q" for="req">Что хочешь запрограммировать?</label>',
    '    <div class="req-row">',
    '      <textarea id="req" rows="2" maxlength="400" placeholder="Например: хочу, чтобы объект двигался по экрану и отскакивал от стенок"></textarea>',
    '      <div class="req-actions">',
    '        <button type="submit" class="btn btn-ink" id="reqGo">Составить пропись</button>',
    '        <button type="button" class="btn btn-line" id="reqStop" hidden>Остановить</button>',
    '      </div>',
    '    </div>',
    '    <div class="req-meta">',
    '      <div class="seg" role="radiogroup" aria-label="Мой уровень">',
    '        <button type="button" role="radio" id="lvlNovice" data-level="novice">Я новичок</button>',
    '        <button type="button" role="radio" id="lvlSome" data-level="some">Немного знаю</button>',
    '      </div>',
    '      <div class="model-pick" id="modelPick" hidden>',
    '        <span class="model-label" id="modelLabel">Модель Claude:</span>',
    '        <div class="model-seg" id="modelSeg" role="radiogroup" aria-labelledby="modelLabel"></div>',
    '      </div>',
    '    </div>',
    '    <p class="model-note" id="modelNote" hidden></p>',
    '    <div class="ideas" id="ideas"><span class="ideas-label">Идеи:</span></div>',
    '    <p class="req-status" id="reqStatus" aria-live="polite"></p>',
    '  </form>',
    '  <div class="lesson" id="lesson">',
    '    <div class="lmain">',
    '      <header class="lhead">',
    '        <p class="lkicker" id="lKicker"></p>',
    '        <h1 class="ltitle" id="lTitle"></h1>',
    '        <p class="lsum" id="lSum"></p>',
    '        <p class="lreq" id="lReq" hidden></p>',
    '        <ul class="lconcepts" id="lConcepts"></ul>',
    '        <p class="lstart" id="lStart" hidden></p>',
    '      </header>',
    '      <div class="ltools">',
    '        <dl class="stats" id="stats">',
    '          <div><dt>Готово</dt><dd id="stPct">0%</dd></div>',
    '          <div><dt>Ошибки</dt><dd id="stErr">0</dd></div>',
    '          <div><dt>Скорость</dt><dd id="stCpm">—</dd></div>',
    '          <div><dt>Время</dt><dd id="stTime">0:00</dd></div>',
    '        </dl>',
    '        <div class="tool-btns">',
    '          <button type="button" class="btn btn-small" id="btnRestart">Начать заново</button>',
    '          <button type="button" class="btn btn-small" id="btnAuto" aria-pressed="true" title="Отступы в начале строк ставятся сами">Автоотступ</button>',
    '          <span class="zoom" role="group" aria-label="Размер кода"><button type="button" class="btn btn-small" id="btnSmaller" aria-label="Код мельче">A−</button><button type="button" class="btn btn-small" id="btnBigger" aria-label="Код крупнее">A+</button></span>',
    '          <button type="button" class="btn btn-small" id="btnCopy">Копировать код</button>',
    '        </div>',
    '      </div>',
    '      <div class="sheet-wrap">',
    '        <div class="progress" aria-hidden="true"><span id="progressBar"></span></div>',
    '        <div class="sheet" id="sheet">',
    '          <div class="code" id="code"></div>',
    '          <textarea id="ta" class="ta" aria-label="Набор кода: печатай программу по образцу" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>',
    '          <span class="sheet-hint" id="sheetHint" aria-hidden="true">Нажми и печатай</span>',
    '        </div>',
    '      </div>',
    '      <div class="status" id="status" aria-live="polite"></div>',
    '      <section class="done" id="done" hidden></section>',
    '      <section class="term" id="term" aria-label="Пример запуска">',
    '        <div class="term-bar"><span class="term-title">Пример запуска</span><button type="button" class="btn btn-small btn-run" id="termRun">Запустить</button></div>',
    '        <pre class="term-screen" id="termScreen"></pre>',
    '        <p class="term-note" id="termNote"></p>',
    '      </section>',
    '      <section class="hw" id="hw"></section>',
    '    </div>',
    '    <aside class="margin" id="margin" aria-label="Заметки на полях">',
    '      <p class="margin-head"><span>На полях</span><span class="margin-where" id="marginWhere"></span></p>',
    '      <article class="note-now" id="noteNow"></article>',
    '      <details class="notes-all" id="notesAll"><summary id="notesSum">Все заметки урока</summary><ol class="notes-list" id="notesList"></ol></details>',
    '      <form class="teacher" id="teacher" autocomplete="off" hidden>',
    '        <label class="teacher-q" for="tq">Непонятно? Спроси учителя</label>',
    '        <div class="teacher-row"><input id="tq" type="text" maxlength="300" placeholder="Например: зачем здесь std::flush?"><button type="submit" class="btn btn-ink btn-small" id="tGo">Спросить</button></div>',
    '        <button type="button" class="chip" id="tLine">Объясни текущую строку подробнее</button>',
    '        <div class="teacher-log" id="tLog" aria-live="polite"></div>',
    '      </form>',
    '    </aside>',
    '  </div>',
    '</section>',
    '<section class="view" id="view-course" hidden>',
    '  <header class="vhead"><h1>Уроки</h1><p>Курс с нуля: от первой программы до маленькой игры. Каждый урок — пропись: печатаешь код поверх образца и читаешь заметки на полях.</p></header>',
    '  <ol class="course" id="courseList"></ol>',
    '  <section class="mine" id="mine"></section>',
    '</section>',
    '<section class="view" id="view-rules" hidden>',
    '  <div class="rules">',
    '    <nav class="toc" id="toc" aria-label="Разделы правил"></nav>',
    '    <div class="rules-body" id="rulesBody"></div>',
    '  </div>',
    '</section>',
    '</main>',
    '<div class="pop" id="pop" role="tooltip" hidden></div>',
    '<div class="toast" id="toast" role="status" hidden></div>',
    '<div class="copybox" id="copybox" hidden><div class="copybox-in"><p>Скопируй код вручную: он уже выделен.</p><textarea id="copyArea" readonly></textarea><button type="button" class="btn btn-ink btn-small" id="copyClose">Закрыть</button></div></div>'
  ].join('\n');

  /* ---------------------------------------------------------------- keyboard hints */

  var CHAR_NAMES = {
    ';': 'точка с запятой', ':': 'двоеточие', ',': 'запятая', '.': 'точка',
    '{': 'открывающая фигурная скобка', '}': 'закрывающая фигурная скобка',
    '(': 'открывающая круглая скобка', ')': 'закрывающая круглая скобка',
    '[': 'открывающая квадратная скобка', ']': 'закрывающая квадратная скобка',
    '<': 'знак «меньше»', '>': 'знак «больше»', '"': 'двойная кавычка', "'": 'апостроф',
    '#': 'решётка', '\\': 'обратная косая черта', '/': 'косая черта', '|': 'вертикальная черта',
    '&': 'амперсанд', '*': 'звёздочка', '+': 'плюс', '-': 'минус', '=': 'равно', '%': 'процент',
    '!': 'восклицательный знак', '_': 'подчёркивание', '~': 'тильда', '^': 'крышка', '?': 'вопросительный знак'
  };
  var KEYHINT = {
    '{': 'Shift + [ (клавиша Х)', '}': 'Shift + ] (клавиша Ъ)', '[': 'клавиша [ (это Х)', ']': 'клавиша ] (это Ъ)',
    '<': 'Shift + , (клавиша Б)', '>': 'Shift + . (клавиша Ю)', ';': 'клавиша ; (это Ж)', ':': 'Shift + ; (клавиша Ж)',
    '"': 'Shift + \' (клавиша Э)', "'": 'клавиша \' (это Э)', '#': 'Shift + 3', '&': 'Shift + 7',
    '|': 'Shift + \\ (клавиша над Enter)', '\\': 'клавиша \\ над Enter', '_': 'Shift + −', '+': 'Shift + =',
    '*': 'Shift + 8', '(': 'Shift + 9', ')': 'Shift + 0', '%': 'Shift + 5', '!': 'Shift + 1',
    '~': 'Shift + ` (клавиша Ё)', '^': 'Shift + 6', '?': 'Shift + / (клавиша с точкой справа)'
  };
  function describe(ch) {
    if (ch === ' ') return 'пробел';
    if (ch === '\n') return 'Enter (новая строка)';
    if (/[\u0400-\u04FF]/.test(ch)) return '«' + ch + '» (русская буква)';
    return '«' + ch + '»' + (CHAR_NAMES[ch] ? ' (' + CHAR_NAMES[ch] + ')' : '');
  }

  /* ---------------------------------------------------------------- editor */

  var Ed = {
    lesson: null, target: '', typed: '', shown: '', spans: [], lineEls: [], lineStart: [0], lineOf: null,
    focused: false, composing: false, preview: false, isDone: false, curLine: -1,
    stats: { keys: 0, mistakes: 0, elapsed: 0, last: 0 }, cyrAt: 0, caseAt: 0,

    init: function () {
      var self = this;
      this.sheet = $('#sheet'); this.codeEl = $('#code'); this.ta = $('#ta');
      var ta = this.ta;
      ta.addEventListener('input', function (e) {
        if (self.composing || e.isComposing) { self.previewRaw(ta.value); return; }
        self.applyRaw(ta.value);
      });
      ta.addEventListener('compositionstart', function () { self.composing = true; });
      ta.addEventListener('compositionend', function () { self.composing = false; self.applyRaw(ta.value); });
      ta.addEventListener('keydown', function (e) { self.onKey(e); });
      ta.addEventListener('paste', function (e) { e.preventDefault(); toast('Код здесь печатают руками: так он запоминается.'); });
      ta.addEventListener('drop', function (e) { e.preventDefault(); });
      ['select', 'click', 'keyup', 'mouseup'].forEach(function (ev) { ta.addEventListener(ev, function () { self.pin(); }); });
      ta.addEventListener('focus', function () {
        self.focused = true; self.sheet.classList.add('focus');
        setTimeout(function () { self.pin(); self.ensureVisible(); }, 0);
        self.updateStatus();
      });
      ta.addEventListener('blur', function () { self.focused = false; self.sheet.classList.remove('focus'); self.updateStatus(); });
      this.sheet.addEventListener('click', function () { if (!self.preview && !self.isDone && self.lesson) self.focus(); });
      window.addEventListener('resize', function () { self.placeTa(); });
    },

    focus: function () {
      try { this.ta.focus({ preventScroll: true }); } catch (e) { this.ta.focus(); }
    },

    pin: function () {
      if (this.composing) return;
      var n = this.ta.value.length;
      if (this.ta.selectionStart !== n || this.ta.selectionEnd !== n) this.ta.setSelectionRange(n, n);
    },

    onKey: function (e) {
      var k = e.key;
      if (k === 'Tab') {
        if (e.shiftKey) return;
        e.preventDefault();
        if (!this.composing) this.applyRaw(this.typed + '\t');
        return;
      }
      if (k === 'Escape') { this.ta.blur(); return; }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].indexOf(k) >= 0) { e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && /^[azyAZY]$/.test(k)) { e.preventDefault(); }
    },

    load: function (lesson, draft) {
      this.lesson = lesson; this.preview = false; this.isDone = false; this.curLine = -1;
      this.target = lesson.code;
      this.sheet.classList.remove('writing', 'is-done');
      this.build(lesson.code);
      var typed = draft && typeof draft.typed === 'string' && lesson.code.indexOf(draft.typed) === 0 && draft.typed.length < lesson.code.length ? draft.typed : '';
      this.stats = {
        keys: typed && draft.keys ? +draft.keys || 0 : 0,
        mistakes: typed && draft.mistakes ? +draft.mistakes || 0 : 0,
        elapsed: typed && draft.elapsed ? +draft.elapsed || 0 : 0,
        last: 0
      };
      this.typed = typed; this.shown = typed;
      this.ta.value = typed;
      this.paintAll();
      this.afterChange();
    },

    // Показ кода, который ещё пишется (поток от Claude): только образец, печатать нельзя.
    showPreview: function (code) {
      this.preview = true; this.isDone = false; this.lesson = null; this.curLine = -1;
      this.target = code || ' ';
      this.typed = ''; this.shown = '';
      if (this.focused) this.ta.blur();
      this.sheet.classList.add('writing');
      $('#sheetHint').hidden = true;
      this.build(this.target);
      this.paintAll();
      var last = this.spans[this.spans.length - 1];
      if (last) last.classList.add('pen');
      $('#progressBar').style.width = '0%';
    },

    build: function (code) {
      var toks = tokenize(code), spans = new Array(code.length), lineOf = new Int32Array(code.length + 1);
      var lineStart = [0], lineEls = [], frag = document.createDocumentFragment(), src = null, ln = 0;
      function newLine() {
        var row = document.createElement('div');
        row.className = 'ln';
        var g = document.createElement('span');
        g.className = 'gn';
        g.textContent = String(lineEls.length + 1);
        src = document.createElement('span');
        src.className = 'src';
        row.append(g, src);
        frag.append(row);
        lineEls.push(row);
      }
      newLine();
      toks.forEach(function (t) {
        var host = null;
        if (t.term && code.slice(t.s, t.e).indexOf('\n') < 0) {
          host = document.createElement('span');
          host.className = 'gterm';
          host.dataset.k = t.term;
          src.append(host);
        }
        for (var i = t.s; i < t.e; i++) {
          var ch = code[i], sp = document.createElement('span');
          lineOf[i] = ln;
          if (ch === '\n') {
            sp.className = 'c nl';
            sp.textContent = ' ';
            src.append(sp);
            spans[i] = sp;
            ln++; lineStart.push(i + 1); newLine(); host = null;
            continue;
          }
          sp.className = 'c t-' + t.cls;
          sp.textContent = ch;
          (host || src).append(sp);
          spans[i] = sp;
        }
      });
      lineOf[code.length] = ln;
      for (var k = 0; k < lineEls.length; k++) {
        var ind = 0;
        while (code[lineStart[k] + ind] === ' ') ind++;
        lineEls[k].lastChild.style.setProperty('--hang', (ind + 2) + 'ch');
      }
      this.codeEl.textContent = '';
      this.codeEl.append(frag);
      this.spans = spans; this.lineOf = lineOf; this.lineStart = lineStart; this.lineEls = lineEls;
      var self = this;
      if (this.lesson) (this.lesson.notes || []).forEach(function (n) { var el = self.lineEls[n.from - 1]; if (el) el.classList.add('nstart'); });
    },

    paint: function (i) {
      var sp = this.spans[i];
      if (!sp) return;
      var T = this.target, s = this.shown, t = T[i], ok = false, bad = false, txt;
      if (i < s.length) { if (s[i] === t) ok = true; else bad = true; }
      var cur = !this.preview && i === s.length;
      if (bad) { var c = s[i]; txt = c === '\n' ? '↵' : c === ' ' ? '·' : c; }
      else if (t === '\n') txt = cur ? '↵' : ' ';
      else txt = t;
      if (sp.textContent !== txt) sp.textContent = txt;
      sp.classList.toggle('ok', ok);
      sp.classList.toggle('bad', bad);
      sp.classList.toggle('cur', cur);
    },
    paintAll: function () { for (var i = 0; i < this.spans.length; i++) this.paint(i); },

    setShown: function (next) {
      var prev = this.shown;
      this.shown = next;
      var a = Math.max(0, Math.min(prev.length, next.length) - 1);
      var b = Math.min(this.target.length - 1, Math.max(prev.length, next.length) + 1);
      for (var i = a; i <= b; i++) this.paint(i);
      this.afterChange();
    },

    errorAt: function () {
      var s = this.shown, n = s.length;
      return n && s[n - 1] !== this.target[n - 1] ? n - 1 : -1;
    },

    // Сравнивает набранное с образцом. Оставляет не больше одной ошибки — в самом конце.
    process: function (raw) {
      var T = this.target, old = this.typed, auto = state.settings.auto;
      raw = raw.replace(/\r\n?/g, '\n');
      var p = 0, lim = Math.min(old.length, raw.length);
      while (p < lim && old.charCodeAt(p) === raw.charCodeAt(p)) p++;
      var out = old.slice(0, p), removed = old.length - p, ins = raw.slice(p);
      var res = { out: out, keys: 0, mistakes: 0, cyr: false, caseErr: false };
      var indentZone = function (s) { return /^ *$/.test(s.slice(s.lastIndexOf('\n') + 1)); };
      var hasErr = function (s) { return s.length > 0 && s[s.length - 1] !== T[s.length - 1]; };

      // Backspace в автоотступе: стираем весь отступ вместе с переводом строки.
      if (auto && removed === 1 && ins === '' && old[p] === ' ' && indentZone(out) && out.lastIndexOf('\n') >= 0) {
        out = out.replace(/ *$/, '');
        if (out.slice(-1) === '\n') out = out.slice(0, -1);
        res.out = out;
        return res;
      }
      var chars = Array.from(ins);
      for (var k = 0; k < chars.length; k++) {
        var ch = chars[k];
        if (ch.length > 1) ch = '?';
        if (out.length >= T.length || hasErr(out)) break;
        var j;
        if (ch === '\t') {
          j = out.length; while (j < T.length && T[j] === ' ') j++;
          out += T.slice(out.length, j);
          continue;
        }
        if (auto && indentZone(out)) {
          if (T[out.length] === ' ' && ch !== ' ') {
            j = out.length; while (j < T.length && T[j] === ' ') j++;
            out += T.slice(out.length, j);
          } else if (ch === ' ' && T[out.length] !== ' ') {
            continue; // лишний пробел в начале строки — отступ уже стоит
          }
        }
        var exp = T[out.length];
        out += ch; res.keys++;
        if (ch !== exp) {
          res.mistakes++;
          if (/[\u0400-\u04FF]/.test(ch)) res.cyr = true;
          if (exp && ch.toLowerCase() === exp.toLowerCase()) res.caseErr = true;
        } else if (ch === '\n' && auto) {
          j = out.length; while (j < T.length && T[j] === ' ') j++;
          out += T.slice(out.length, j);
        }
      }
      res.out = out;
      return res;
    },

    previewRaw: function (raw) {
      if (!this.lesson || this.preview || this.isDone) return;
      this.setShown(this.process(raw).out);
    },

    applyRaw: function (raw) {
      if (!this.lesson || this.preview || this.isDone) return;
      var r = this.process(raw), now = Date.now();
      if (r.keys) {
        var gap = this.stats.last ? now - this.stats.last : 0;
        if (gap > 0 && gap < 5000) this.stats.elapsed += gap;
        this.stats.last = now;
      }
      this.stats.keys += r.keys;
      this.stats.mistakes += r.mistakes;
      if (r.cyr) this.cyrAt = now;
      if (r.caseErr) this.caseAt = now;
      this.typed = r.out;
      if (this.ta.value !== r.out) this.ta.value = r.out;
      this.pin();
      Pop.hide();
      this.setShown(r.out);
      saveDraft();
    },

    afterChange: function () {
      var T = this.target, s = this.shown;
      var line = this.lineOf ? this.lineOf[Math.min(s.length, T.length)] : 0;
      if (line !== this.curLine) {
        if (this.lineEls[this.curLine]) this.lineEls[this.curLine].classList.remove('on');
        if (this.lineEls[line]) this.lineEls[line].classList.add('on');
        this.curLine = line;
        if (!this.preview) Notes.setLine(line + 1);
      }
      if (this.preview) return;
      this.placeTa();
      this.updateStats();
      this.updateStatus();
      $('#sheetHint').hidden = this.focused || this.isDone || s.length > 0;
      if (this.focused) this.ensureVisible();
      if (!this.composing && !this.isDone && this.typed === T && T.length) complete();
    },

    activeLine: function () { return Math.max(1, this.curLine + 1); },

    placeTa: function () {
      if (!this.spans.length) return;
      var sp = this.spans[Math.min(this.shown.length, this.spans.length - 1)];
      if (!sp) return;
      var sr = this.sheet.getBoundingClientRect(), r = sp.getBoundingClientRect();
      this.ta.style.transform = 'translate(' + Math.round(r.left - sr.left) + 'px,' + Math.round(r.top - sr.top) + 'px)';
    },

    ensureVisible: function () {
      var sp = this.spans[Math.min(this.shown.length, this.spans.length - 1)];
      if (!sp) return;
      var r = sp.getBoundingClientRect(), vv = window.visualViewport;
      var top = vv ? vv.offsetTop : 0, height = vv ? vv.height : window.innerHeight, pad = Math.min(90, height * 0.2);
      if (r.bottom > top + height - pad) window.scrollBy(0, r.bottom - (top + height - pad));
      else if (r.top < top + pad) window.scrollBy(0, r.top - (top + pad));
    },

    updateStats: function () {
      var T = this.target, s = this.typed, st = this.stats;
      var pct = T.length ? Math.floor(100 * s.length / T.length) : 0;
      if (this.isDone) pct = 100;
      $('#stPct').textContent = pct + '%';
      $('#stErr').textContent = String(st.mistakes);
      var good = Math.max(0, st.keys - st.mistakes);
      $('#stCpm').textContent = st.elapsed > 4000 ? Math.round(good / (st.elapsed / 60000)) + ' зн/мин' : '—';
      $('#stTime').textContent = fmtTime(st.elapsed);
      $('#progressBar').style.width = pct + '%';
    },

    updateStatus: function () {
      var box = $('#status');
      if (!box || this.preview || !this.lesson) return;
      var T = this.target, s = this.shown, err = this.errorAt();
      var pos = err >= 0 ? err : Math.min(s.length, T.length);
      var line = this.lineOf[pos] + 1, col = pos - this.lineStart[line - 1] + 1;
      var nLines = this.lineEls.length;
      box.textContent = '';
      box.className = 'status';
      var where = h('span', { class: 'st-pos' }, FILE + ':' + line + ':' + col);
      if (this.isDone) {
        box.classList.add('st-ok');
        box.append(h('span', { class: 'st-pos' }, FILE), h('span', { class: 'st-msg' }, 'Пропись готова: все ' + nLines + ' ' + plural(nLines, 'строка', 'строки', 'строк') + ' набраны верно.'));
        return;
      }
      if (err >= 0) {
        var exp = T[err], got = s[err];
        box.classList.add('st-err');
        box.append(where, h('span', { class: 'st-msg' }, h('b', null, 'ошибка: '), 'ожидалось: ' + describe(exp) + ', напечатано: ' + describe(got) + '.'));
        var tips = [];
        if (/[\u0400-\u04FF]/.test(got)) tips.push('Похоже, включена русская раскладка. Переключись на английскую: Alt + Shift или Win + Пробел в Windows, Ctrl + Пробел на Mac, значок глобуса на клавиатуре телефона.');
        else if (exp && got && exp !== got && exp.toLowerCase() === got.toLowerCase()) tips.push('Регистр важен: нужна ' + (exp === exp.toUpperCase() ? 'заглавная' : 'строчная') + ' буква.');
        if (KEYHINT[exp]) tips.push('«' + exp + '» на клавиатуре: ' + KEYHINT[exp] + '.');
        tips.push('Нажми Backspace, чтобы стереть ошибку.');
        box.append(h('span', { class: 'st-tip' }, tips.join(' ')));
        return;
      }
      var next = T[pos];
      var msg;
      if (!this.focused) msg = s.length ? 'Пауза. Нажми на лист, чтобы продолжить со строки ' + line + '.' : 'Нажми на лист и печатай поверх серых букв. Enter — новая строка, отступ поставится сам.';
      else if (next === '\n') msg = 'Конец строки ' + line + ': нажми Enter.';
      else if (KEYHINT[next]) msg = 'Дальше «' + next + '»: ' + KEYHINT[next] + '.';
      else msg = 'Строка ' + line + ' из ' + nLines + '. Esc — убрать клавиатуру.';
      box.append(where, h('span', { class: 'st-msg' }, msg));
      if (this.focused && Date.now() - this.cyrAt < 8000) box.append(h('span', { class: 'st-tip' }, 'Проверь раскладку: в коде C++ нужны английские буквы.'));
    },

    reset: function () {
      if (!this.lesson) return;
      delete state.drafts[this.lesson.id];
      save();
      openLesson(this.lesson, { fresh: true });
      this.focus();
    }
  };

  function saveDraft() {
    var L = Ed.lesson;
    if (!L || Ed.preview) return;
    if (Ed.typed && !Ed.isDone) {
      state.drafts[L.id] = { typed: Ed.typed, keys: Ed.stats.keys, mistakes: Ed.stats.mistakes, elapsed: Ed.stats.elapsed, at: Date.now() };
      var ids = Object.keys(state.drafts);
      if (ids.length > 30) {
        ids.sort(function (a, b) { return (state.drafts[a].at || 0) - (state.drafts[b].at || 0); });
        delete state.drafts[ids[0]];
      }
    } else {
      delete state.drafts[L.id];
    }
    save();
  }

  /* ---------------------------------------------------------------- completion */

  function complete() {
    var L = Ed.lesson;
    Ed.isDone = true;
    Ed.ta.blur();
    Ed.sheet.classList.add('is-done');
    Ed.paintAll();
    var st = Ed.stats;
    var acc = st.keys ? Math.max(0, (st.keys - st.mistakes) / st.keys) : 1;
    var grade = acc >= 0.97 ? 5 : acc >= 0.9 ? 4 : 3;
    var cpm = st.elapsed > 4000 ? Math.round(Math.max(0, st.keys - st.mistakes) / (st.elapsed / 60000)) : 0;
    var prevBest = state.done[L.id];
    if (!prevBest || grade >= prevBest.grade) state.done[L.id] = { grade: grade, acc: Math.floor(acc * 100), cpm: cpm, at: Date.now() };
    delete state.drafts[L.id];
    save(true);
    Ed.updateStats();
    Ed.updateStatus();
    renderDone(L, grade, acc, cpm, st);
    renderCourse();
    updateBadge();
    var done = $('#done');
    done.hidden = false;
    try { done.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' }); } catch (e) { done.scrollIntoView(); }
    setTimeout(function () { Term.run(); }, REDUCED ? 0 : 700);
  }

  function renderDone(L, grade, acc, cpm, st) {
    var box = $('#done');
    box.textContent = '';
    var words = { 5: 'Отлично!', 4: 'Хорошо!', 3: 'Неплохо!' };
    var comment = grade === 5 ? 'Почти без ошибок — рука уже привыкает к C++.' :
      grade === 4 ? 'Несколько опечаток — это нормально. Перепечатай ещё раз, и будет «пять».' :
        'Ошибок многовато. Попробуй ещё раз медленнее: точность важнее скорости.';
    var next = null;
    if (L.builtin) next = LESSONS[L.n] || null;
    box.append(
      h('div', { class: 'grade', 'aria-label': 'Оценка ' + grade }, h('span', null, String(grade))),
      h('div', { class: 'done-body' },
        h('p', { class: 'done-word' }, words[grade]),
        h('p', { class: 'done-text' }, comment),
        h('dl', { class: 'done-stats' },
          h('div', null, h('dt', null, 'Точность'), h('dd', null, Math.floor(acc * 100) + '%')),
          h('div', null, h('dt', null, 'Ошибки'), h('dd', null, String(st.mistakes))),
          h('div', null, h('dt', null, 'Скорость'), h('dd', null, cpm ? cpm + ' зн/мин' : '—')),
          h('div', null, h('dt', null, 'Время'), h('dd', null, fmtTime(st.elapsed)))
        ),
        h('div', { class: 'done-btns' },
          h('button', { type: 'button', class: 'btn btn-ink', onclick: function () { Term.run(); $('#term').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' }); } }, 'Запустить ещё раз'),
          next ? h('button', { type: 'button', class: 'btn btn-line', onclick: function () { go('lesson-' + next.id); } }, 'Следующий урок: ' + next.title) : null,
          h('button', { type: 'button', class: 'btn btn-line', onclick: function () { Ed.reset(); } }, 'Пройти заново')
        )
      )
    );
  }

  /* ---------------------------------------------------------------- notes */

  var Notes = {
    idx: -1, lines: [],
    set: function (L) {
      this.idx = -1; this.lines = [];
      var list = $('#notesList');
      list.textContent = '';
      var notes = L ? L.notes || [] : [];
      $('#notesSum').textContent = 'Все заметки урока (' + notes.length + ')';
      $('#notesAll').hidden = !notes.length;
      var self = this;
      notes.forEach(function (n, i) {
        list.append(h('li', null, h('button', { type: 'button', class: 'note-link', onclick: function () { self.peek(i); } },
          h('span', { class: 'note-link-lines' }, rangeText(n)), h('span', null, n.title || 'Заметка'))));
      });
      if (!notes.length) this.renderEmpty(L ? 'К этому уроку нет заметок.' : 'Заметки появятся, когда урок будет готов.');
    },
    renderEmpty: function (msg) {
      var box = $('#noteNow');
      box.textContent = '';
      box.append(h('p', { class: 'note-empty' }, msg));
      $('#marginWhere').textContent = '';
    },
    find: function (line) {
      var notes = Ed.lesson ? Ed.lesson.notes || [] : [], idx = -1;
      for (var i = 0; i < notes.length; i++) if (notes[i].from <= line) idx = i;
      return idx;
    },
    setLine: function (line) {
      $('#marginWhere').textContent = 'строка ' + line;
      var idx = this.find(line);
      if (idx !== this.idx) this.show(idx);
    },
    show: function (idx) {
      var notes = Ed.lesson ? Ed.lesson.notes || [] : [];
      this.idx = idx;
      this.lines.forEach(function (el) { el.classList.remove('inote'); });
      this.lines = [];
      $all('.note-link').forEach(function (b, i) { b.classList.toggle('on', i === idx); });
      var n = notes[idx];
      if (!n) { if (notes.length) this.renderEmpty('Начни печатать — здесь появятся объяснения к строкам.'); return; }
      for (var l = n.from; l <= n.to; l++) { var el = Ed.lineEls[l - 1]; if (el) { el.classList.add('inote'); this.lines.push(el); } }
      var box = $('#noteNow');
      box.textContent = '';
      var rule = n.rule && RULES.filter(function (r) { return r.id === n.rule; })[0];
      append(box, [
        h('p', { class: 'note-lines' }, rangeText(n)),
        h('h2', { class: 'note-title' }, n.title || 'Заметка'),
        h('p', { class: 'note-text' }, rich(n.text)),
        rule ? h('a', { class: 'note-rule', href: '#r-' + rule.id }, 'Правило: ' + rule.title) : null
      ]);
    },
    peek: function (i) {
      var n = (Ed.lesson.notes || [])[i];
      if (!n) return;
      this.show(i);
      var el = Ed.lineEls[n.from - 1];
      if (el) {
        try { el.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' }); } catch (e) { el.scrollIntoView(); }
        this.lines.forEach(function (x) { x.classList.add('flash'); setTimeout(function () { x.classList.remove('flash'); }, 1200); });
      }
    }
  };
  function rangeText(n) { return n.from === n.to ? 'Строка ' + n.from : 'Строки ' + n.from + '–' + n.to; }

  /* ---------------------------------------------------------------- glossary popover */

  var Pop = {
    timer: 0, anchor: null,
    init: function () {
      var self = this;
      document.addEventListener('pointerover', function (e) {
        if (e.pointerType !== 'mouse') return;
        var t = e.target.closest && e.target.closest('.gterm');
        if (!t || !t.closest('#code, [data-terms]')) return;
        clearTimeout(self.timer);
        self.timer = setTimeout(function () { self.show(t); }, 320);
      });
      document.addEventListener('pointerout', function (e) {
        if (e.pointerType !== 'mouse') return;
        var t = e.target.closest && e.target.closest('.gterm');
        if (t && !t.contains(e.relatedTarget)) { clearTimeout(self.timer); self.hide(); }
      });
      document.addEventListener('click', function (e) {
        var t = e.target.closest && e.target.closest('.gterm');
        if (t && t.closest('#code, [data-terms]')) self.show(t); else self.hide();
      });
      window.addEventListener('scroll', function () { self.hide(); }, { passive: true });
    },
    show: function (t) {
      var key = t.dataset.k, text = GLOSSARY[key];
      if (!text) return;
      var pop = $('#pop');
      pop.textContent = '';
      var label = key;
      if (t.classList.contains('t-inc') || (t.querySelector && t.querySelector('.t-inc'))) label = '<' + key + '>';
      pop.append(h('code', { class: 'pop-k' }, label), h('span', null, text));
      pop.hidden = false;
      var r = t.getBoundingClientRect(), w = pop.offsetWidth, ph = pop.offsetHeight;
      var left = clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8);
      var top = r.top - ph - 8;
      if (top < 8) top = r.bottom + 8;
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
      this.anchor = t;
    },
    hide: function () { var p = $('#pop'); if (p && !p.hidden) p.hidden = true; this.anchor = null; }
  };

  /* ---------------------------------------------------------------- terminal */

  var Term = {
    timer: 0, running: false, lesson: null,
    init: function () {
      var self = this;
      $('#termRun').addEventListener('click', function () { if (self.running) self.stop(true); else self.run(); });
    },
    set: function (L) {
      this.stop(false);
      this.lesson = L;
      var scr = $('#termScreen'), run = L && L.run;
      scr.textContent = '';
      $('#term').hidden = !run;
      if (!run) return;
      var lines = run.kind === 'frames' ? (run.frames[0] || '').split('\n').length : 0;
      scr.style.minHeight = lines ? 'calc(' + (lines + 3) + ' * 1.5em + 24px)' : '';
      scr.append(h('span', { class: 'tm-dim' }, '$ '), h('span', { class: 'tm-cmd' }, 'g++ ' + FILE + ' -o main && ./main'), '\n',
        h('span', { class: 'tm-dim' }, 'Нажми «Запустить», чтобы увидеть, что выведет программа.'));
      var note = $('#termNote');
      note.textContent = '';
      note.append(rich('Это показ результата: прописи не компилируют код. Как запустить программу по-настоящему — в разделе '), h('a', { href: '#r-run' }, 'Правила → Запуск'), '.');
      if (run.note) { note.append(' '); note.append(rich(run.note)); }
    },
    stop: function (finish) {
      clearTimeout(this.timer);
      this.running = false;
      var b = $('#termRun');
      if (b) { b.textContent = 'Запустить'; b.classList.remove('on'); }
      if (finish && this.lesson) this.set(this.lesson);
    },
    run: function () {
      var L = this.lesson;
      if (!L || !L.run) return;
      this.stop(false);
      this.running = true;
      var b = $('#termRun');
      b.textContent = 'Остановить'; b.classList.add('on');
      var scr = $('#termScreen'), self = this, run = L.run;
      scr.textContent = '';
      var head = [h('span', { class: 'tm-dim' }, '$ '), h('span', { class: 'tm-cmd' }, 'g++ ' + FILE + ' -o main && ./main'), '\n'];
      head.forEach(function (x) { scr.append(x); });
      var body = h('span', { class: 'tm-out' });
      scr.append(body);
      var finish = function () {
        scr.append('\n', h('span', { class: 'tm-dim' }, 'Программа завершилась с кодом 0'));
        self.running = false;
        b.textContent = 'Запустить'; b.classList.remove('on');
      };
      if (run.kind === 'frames') {
        var frames = run.frames, i = 0;
        if (REDUCED) { body.textContent = frames[frames.length - 1]; finish(); return; }
        var tick = function () {
          if (!self.running) return;
          body.textContent = frames[i];
          i++;
          if (i < frames.length) self.timer = setTimeout(tick, run.delay); else finish();
        };
        tick();
        return;
      }
      // Текст: вывод появляется построчно, ввод пользователя «печатается».
      var steps = [];
      String(run.output || '').split(/(\[\[[\s\S]*?\]\])/).forEach(function (part) {
        if (!part) return;
        if (part.slice(0, 2) === '[[' && part.slice(-2) === ']]') {
          var inp = part.slice(2, -2), span = h('span', { class: 'tm-in' });
          steps.push({ el: span, delay: 380 });
          Array.from(inp).forEach(function (ch) { steps.push({ to: span, text: ch, delay: 110 }); });
        } else {
          part.split(/(\n)/).forEach(function (seg) { if (seg) steps.push({ text: seg, delay: seg === '\n' ? 140 : 40 }); });
        }
      });
      if (REDUCED) {
        steps.forEach(function (s) { if (s.el) body.append(s.el); else (s.to || body).append(s.text); });
        finish();
        return;
      }
      var k = 0;
      var step = function () {
        if (!self.running) return;
        var s = steps[k++];
        if (!s) { finish(); return; }
        if (s.el) body.append(s.el); else (s.to || body).append(s.text);
        self.timer = setTimeout(step, s.delay);
      };
      self.timer = setTimeout(step, 250);
    }
  };

  /* ---------------------------------------------------------------- Claude */

  // Модели для переключателя. Если выбранная модель зрителю недоступна,
  // платформа отвечает моделью того же уровня (modelTier) — страница показывает, кто ответил.
  var MODELS = {
    haiku: { id: 'claude-haiku-5-5', tier: 'quick', label: 'Haiku 5.5',
      note: 'Haiku 5.5 — самая быстрая: отвечает почти сразу. Для коротких программ её хватает, в длинных она чаще ошибается.' },
    sonnet: { id: 'claude-sonnet-5-5', tier: 'default', label: 'Sonnet 5.5',
      note: 'Sonnet 5.5 — баланс скорости и качества: урок обычно готов меньше чем за минуту.' },
    opus: { id: 'claude-opus-5-5', tier: 'complex', label: 'Opus 5.5',
      note: 'Opus 5.5 — сильная модель: точнее код и объяснения. Думает дольше и тратит больше лимита Claude.' },
    fable: { id: 'claude-fable-5-2', tier: 'complex', label: 'Fable 5.2',
      note: 'Fable 5.2 — самая мощная модель Anthropic. Может думать несколько минут и тратит больше всего лимита; для простых уроков обычно не нужна.' },
    inherit: { inherit: true, tier: 'inherit', label: 'Как в Claude',
      note: 'Отвечает модель, которая выбрана у тебя в приложении Claude.' }
  };
  var MODEL_ORDER = ['haiku', 'sonnet', 'opus', 'fable', 'inherit'];
  var TIER_NAMES = { quick: 'Haiku', default: 'Sonnet', complex: 'Opus' };

  function modelAvailable(k) {
    var m = MODELS[k];
    if (!m) return false;
    if (m.inherit) return !!(AI.tiers && AI.tiers.indexOf('inherit') >= 0);
    return !AI.tiers || AI.tiers.indexOf(m.tier) >= 0;
  }
  function modelKey() {
    var k = state.settings.model;
    if (modelAvailable(k)) return k;
    return ['opus', 'sonnet', 'haiku'].filter(modelAvailable)[0] || 'sonnet';
  }
  function modelOptions(k) {
    var m = MODELS[k];
    return m.inherit ? { modelTier: 'inherit' } : { model: m.id, modelTier: m.tier };
  }
  // Кто на самом деле ответил: названная модель (modelApplied) или модель того же уровня.
  function answeredBy(k, res) {
    var m = MODELS[k];
    if (m.inherit) return { name: 'модель из твоих настроек Claude', fem: true, exact: true };
    if (res && res.modelApplied) return { name: 'Claude ' + m.label, fem: false, exact: true };
    var t = res && TIER_NAMES[res.modelTierApplied];
    return { name: t ? 'модель уровня ' + t : 'другая модель Claude', fem: true, exact: false };
  }
  function renderModelPick() {
    var seg = $('#modelSeg');
    if (!seg) return;
    seg.textContent = '';
    var cur = modelKey();
    MODEL_ORDER.forEach(function (k) {
      var m = MODELS[k], ok = modelAvailable(k);
      if (m.inherit && !ok) return;
      var b = h('button', {
        type: 'button', role: 'radio', 'aria-checked': k === cur ? 'true' : 'false',
        class: k === cur ? 'on' : null, disabled: ok ? null : true,
        title: ok ? null : 'Недоступно на этой странице', dataset: { model: k }
      }, m.label);
      b.addEventListener('click', function () { state.settings.model = k; save(); renderModelPick(); });
      seg.append(b);
    });
    $('#modelNote').textContent = MODELS[cur].note + ' Выбор действует и на ответы учителя.';
  }

  var AI = {
    sample: null, state: 'checking', ctl: null, busy: false, ticker: 0, ready: null, _resolve: null, tiers: null,
    init: function () {
      var self = this, c = window.claude;
      this.ready = new Promise(function (resolve) { self._resolve = resolve; });
      if (!c || typeof c.use !== 'function') { this.set('off'); return; }
      Promise.resolve().then(function () { return c.use('sample'); }).then(function (s) {
        self.sample = s || null;
        if (s && typeof s.limits === 'function') {
          s.limits().then(function (l) {
            self.tiers = l && Array.isArray(l.modelTiers) ? l.modelTiers : null;
            if (self.state === 'ready') renderModelPick();
          }, function () {});
        }
        self.set(s ? 'ready' : 'off');
      }, function () { self.set('off'); });
    },
    set: function (st) {
      this.state = st;
      $('#teacher').hidden = st !== 'ready';
      $('#modelPick').hidden = st !== 'ready';
      $('#modelNote').hidden = st !== 'ready';
      if (st === 'ready') renderModelPick();
      if (this._resolve) { this._resolve(); this._resolve = null; }
      if (!this.busy) idleStatus();
    }
  };

  var welcome = '';
  function idleStatus(msg) {
    var el = $('#reqStatus');
    el.textContent = '';
    el.className = 'req-status';
    if (msg) { el.append(rich(msg)); return; }
    if (welcome) {
      el.append(rich(welcome + (AI.state === 'off' ? ' Сейчас Claude здесь недоступен, поэтому по запросу подберётся похожий готовый урок из курса.' : '')));
      return;
    }
    if (AI.state === 'checking') el.textContent = 'Проверяю связь с Claude…';
    else if (AI.state === 'ready') el.textContent = 'Опиши задачу своими словами — Claude составит пропись с заметками. Это займёт до минуты.';
    else el.textContent = 'Claude здесь недоступен, поэтому я подберу похожий готовый урок из курса. Новые уроки по запросу составляются, когда страница открыта в Claude.';
  }

  function aiErrorText(e) {
    var code = e && e.code;
    switch (code) {
      case 'not_granted': return { text: 'Странице не разрешено обращаться к Claude, поэтому новые уроки не составляются. Готовые уроки работают как обычно.', off: true };
      case 'sampling_disabled': case 'not_declared': case 'capability_disabled': case 'capability_removed':
        return { text: 'Claude недоступен на этой странице. Готовые уроки работают как обычно.', off: true };
      case 'rate_limited': return { text: e.reason === 'usage_limit' ? 'Закончился лимит Claude. Попробуй позже, а пока пройди готовый урок.' : 'Слишком много запросов подряд. Подожди минуту и попробуй снова.' };
      case 'session_expired': return { text: 'Нужно заново войти в Claude, а потом повторить запрос.' };
      case 'refused': return { text: 'Claude не стал составлять такой урок. Переформулируй задачу.' };
      case 'truncated': return { text: 'Урок получился слишком длинным и оборвался. Попробуй ещё раз или опиши задачу проще.' };
      case 'invalid_json': case 'empty_completion': return { text: 'Урок пришёл в неправильном виде. Нажми «Составить пропись» ещё раз.' };
      case 'prompt_too_large': return { text: 'Запрос слишком длинный. Опиши задачу короче.' };
      case 'cancelled': return { text: 'Остановлено.' };
      default: return { text: 'Связь с Claude прервалась. Попробуй ещё раз.' };
    }
  }

  function lessonPrompt(request, level) {
    var lvl = level === 'some'
      ? 'немного знает C++: уже писал переменные, условия, циклы и функции'
      : 'новичок: знает только самые основы или не знает ничего';
    var passed = LESSONS.filter(function (l) { return state.done[l.id]; }).map(function (l) { return l.title + ' (' + l.concepts.join(', ') + ')'; });
    return [
      'Ты — терпеливый учитель программирования на C++. Ученик пишет, что хочет запрограммировать, а ты составляешь урок-пропись: готовую программу, которую он перепечатает поверх полупрозрачного образца, и заметки на полях, объясняющие каждую часть кода.',
      '',
      'Запрос ученика: «' + request + '»',
      'Уровень ученика: ' + lvl + '.',
      passed.length ? 'Уже пройденные уроки: ' + passed.join('; ') + '.' : 'Пройденных уроков пока нет.',
      '',
      'Требования к коду:',
      '- C++17, только стандартная библиотека, консольная программа. Без окон и графических библиотек, без windows.h, conio.h и system(). Если просят графику, игру или движение — покажи это в консоли символами: ASCII-анимация с перерисовкой строки через "\\r" или всего кадра через "\\033[H".',
      '- Не длиннее 40 строк (для новичка лучше 12–30), строки не длиннее 60 символов, отступ 4 пробела, без табуляции, без пробелов в конце строк.',
      '- Только ASCII-символы: тексты в кавычках и комментарии — на простом английском, без русских букв.',
      '- Пиши std:: явно, без using namespace std.',
      '- Фигурные скобки у каждого if, else, for и while, даже если внутри одна строка. Открывающая скобка — на той же строке.',
      '- Код компилируется без ошибок и предупреждений: g++ -std=c++17 -Wall -Wextra.',
      '- Анимации и игровые циклы конечны: ограниченное число кадров или ходов.',
      '- Если программа читает ввод, она должна правильно работать с примерным вводом из run.',
      '',
      'Заметки (notes) — по-русски, простыми словами, как для школьника:',
      '- 5–12 заметок по порядку строк, без пропусков важных строк; диапазоны строк не пересекаются.',
      '- from и to — номера строк кода, начиная с 1.',
      '- title — 2–5 слов; text — 1–4 предложения: что делает эта часть и как она работает. Объясняй новые слова и символы (::, <<, ;, & и т. п.). Код внутри текста оформляй обратными кавычками: `std::cout`.',
      '',
      'run — что увидит ученик при запуске:',
      '- обычный вывод: {"kind":"text","output":"..."}; то, что вводит пользователь, оберни в [[ ]], например "Name: [[Anna]]\\nHi, Anna!";',
      '- анимация: {"kind":"frames","delay":<пауза между кадрами в мс, как в коде>,"frames":["кадр 1","кадр 2"]} — от 10 до 40 кадров; каждый кадр — ровно то, что видно в терминале после перерисовки, строки через \\n;',
      '- note (необязательно) — одно предложение по-русски об особенности запуска.',
      '',
      'tasks — 3 небольших задания по-русски: что ученик может изменить в коде сам.',
      'concepts — 2–6 коротких названий тем C++ из урока, по-русски.',
      'title — название урока по-русски, 2–4 слова. summary — 1–2 предложения: что делает программа.',
      'Если запрос не про программирование или его нельзя сделать в консоли, придумай близкую по смыслу простую консольную программу и скажи об этом в summary.',
      '',
      'Ответь только JSON-объектом, без пояснений, с полями в таком порядке:',
      '{"title":"…","summary":"…","code":"…","notes":[{"from":1,"to":2,"title":"…","text":"…"}],"run":{"kind":"text","output":"…"},"tasks":["…"],"concepts":["…"]}'
    ].join('\n');
  }

  // Читает JSON-ответ: целиком, из блока ```json или от первой { до последней }.
  function parseLoose(text) {
    var t = String(text || '').trim(), m, a, b;
    try { return JSON.parse(t); } catch (e) { /* дальше */ }
    m = /```(?:json)?\s*\n([\s\S]*?)```/.exec(t);
    if (m) { try { return JSON.parse(m[1]); } catch (e) { /* дальше */ } }
    a = t.indexOf('{'); b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* нет */ } }
    return null;
  }

  // Достаёт строковое поле из JSON, который ещё не дописан.
  function partialJsonString(src, key) {
    var m = new RegExp('"' + key + '"\\s*:\\s*"').exec(src);
    if (!m) return null;
    var i = m.index + m[0].length, out = '';
    var map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
    while (i < src.length) {
      var ch = src[i];
      if (ch === '"') return { value: out, done: true };
      if (ch === '\\') {
        if (i + 1 >= src.length) break;
        var nx = src[i + 1];
        if (nx === 'u') {
          if (i + 5 >= src.length) break;
          out += String.fromCharCode(parseInt(src.substr(i + 2, 4), 16) || 63);
          i += 6; continue;
        }
        out += map[nx] != null ? map[nx] : nx;
        i += 2; continue;
      }
      out += ch; i++;
    }
    return { value: out, done: false };
  }

  var Gen = {
    prevLesson: null,
    submit: function (text, fresh) {
      text = String(text || '').trim();
      if (!text) { idleStatus('Напиши, что хочешь сделать: например, «таймер обратного отсчёта» или «ёлочка из звёздочек».'); $('#req').focus(); return; }
      if (AI.busy) return;
      welcome = '';
      if (AI.state === 'checking' && AI.ready) {
        var self = this;
        idleStatus('Проверяю связь с Claude…');
        AI.ready.then(function () { self.submit(text, fresh); });
        return;
      }
      if (AI.state === 'ready' && AI.sample) this.generate(text, fresh);
      else this.offline(text);
    },
    offline: function (text) {
      var L = matchLesson(text);
      if (L) {
        go('lesson-' + L.id);
        idleStatus('Claude здесь недоступен, поэтому я подобрал готовый урок «' + L.title + '» — он ближе всего к твоей задаче. Новые уроки составляются, когда страница открыта в Claude.');
      } else {
        idleStatus('Готового урока на эту тему нет, а Claude здесь недоступен. Открой страницу в Claude, чтобы урок составили по запросу, или выбери урок во вкладке «Уроки».');
      }
    },
    generate: function (text, fresh) {
      var self = this;
      AI.busy = true;
      AI.ctl = new AbortController();
      this.prevLesson = Ed.lesson;
      var started = Date.now(), chars = 0, lastDraw = 0;
      $('#reqGo').disabled = true;
      $('#reqStop').hidden = false;
      var status = $('#reqStatus');
      var tick = function () {
        status.className = 'req-status busy';
        status.textContent = (chars ? 'Claude пишет урок' : 'Claude думает над уроком') + '… ' + Math.round((Date.now() - started) / 1000) + ' с';
      };
      tick();
      AI.ticker = setInterval(tick, 1000);
      go('practice');
      Term.set(null);
      Notes.set(null);
      $('#done').hidden = true;
      $('#hw').hidden = true;
      $('#status').textContent = '';
      renderHead({ title: 'Составляю пропись…', summary: 'Код появится на листе карандашом, как только Claude начнёт его писать.', request: text, generated: true, concepts: [] }, true);
      Ed.showPreview('');
      var key = modelKey();
      var opts = {
        signal: AI.ctl.signal,
        onText: function (u) {
          chars = u.text.length;
          var now = Date.now();
          if (now - lastDraw < 220) return;
          lastDraw = now;
          var t = partialJsonString(u.text, 'title'), c = partialJsonString(u.text, 'code');
          if (t && t.value) $('#lTitle').textContent = t.value + (t.done ? '' : '…');
          var s = partialJsonString(u.text, 'summary');
          if (s && s.value) $('#lSum').textContent = s.value;
          if (c && c.value) Ed.showPreview(c.value);
        }
      };
      Object.assign(opts, modelOptions(key));
      if (fresh) opts.cache = false;
      AI.sample(lessonPrompt(text, state.settings.level), opts).then(function (res) {
        var data = parseLoose(res.text);
        if (!data) throw { code: res.truncated ? 'truncated' : 'invalid_json' };
        var L = normalizeLesson(data, text);
        var by = answeredBy(key, res);
        L.by = { name: by.name, fem: by.fem };
        state.my = [L].concat(state.my.filter(function (x) { return x.id !== L.id; })).slice(0, 20);
        save(true);
        self.finish();
        idleStatus('Готово: пропись «' + L.title + '». ' + (by.exact ? '' : 'Выбрана модель ' + MODELS[key].label + ', но ответила ' + by.name + '. ') + 'Печатай поверх серых букв, а объяснения к строкам — в заметках на полях.');
        renderCourse();
        go('lesson-' + L.id);
      }).catch(function (e) {
        self.finish();
        var info = e && e.code ? aiErrorText(e) : { text: 'Claude прислал урок с ошибкой в формате. Попробуй ещё раз или переформулируй задачу.' };
        if (Ed.preview && self.prevLesson) openLesson(self.prevLesson);
        if (info.off) AI.set('off');
        idleStatus(info.text);
        $('#reqStatus').classList.add('warn');
      });
    },
    finish: function () {
      AI.busy = false;
      clearInterval(AI.ticker);
      $('#reqGo').disabled = false;
      $('#reqStop').hidden = true;
    }
  };

  /* ---------------------------------------------------------------- teacher */

  var Teacher = {
    turns: [], busy: false, ctl: null,
    init: function () {
      var self = this;
      $('#teacher').addEventListener('submit', function (e) {
        e.preventDefault();
        var q = $('#tq').value.trim();
        if (!q) { $('#tq').focus(); return; }
        $('#tq').value = '';
        self.ask(q);
      });
      $('#tLine').addEventListener('click', function () {
        var L = Ed.lesson;
        if (!L) return;
        var n = Ed.activeLine(), line = (L.code.split('\n')[n - 1] || '').trim();
        self.ask('Объясни подробнее строку ' + n + ': ' + (line || '(пустая строка)'));
      });
    },
    reset: function () {
      if (this.ctl) this.ctl.abort();
      this.turns = [];
      $('#tLog').textContent = '';
    },
    ask: function (q) {
      var L = Ed.lesson, self = this;
      if (!L || !AI.sample || this.busy) return;
      var log = $('#tLog');
      var a = h('div', { class: 't-a' }, h('p', { class: 't-wait' }, 'Думаю…'));
      log.append(h('p', { class: 't-q' }, q), a);
      this.busy = true;
      $('#tGo').disabled = true;
      this.ctl = new AbortController();
      var numbered = L.code.split('\n').map(function (s, i) { return String(i + 1).padStart(2, ' ') + '| ' + s; }).join('\n');
      var intro = 'Ты — добрый учитель C++ для новичка. Ученик перепечатывает код урока «' + L.title + '» в тренажёре «Прописи C++» и задаёт вопрос. ' +
        'Отвечай по-русски, коротко (до 120 слов), простыми словами, как школьнику. Если нужен пример, дай не больше 6 строк кода. ' +
        'Код внутри текста оформляй обратными кавычками, блоки кода — тройными. Без заголовков и таблиц. ' +
        'Если вопрос не про программирование, мягко верни разговор к уроку.\n\nКод урока:\n' + numbered + '\n\nУченик сейчас на строке ' + Ed.activeLine() + '.';
      var input = [{ role: 'user', content: intro }].concat(this.turns.slice(-6), [{ role: 'user', content: q }]);
      var key = modelKey();
      AI.sample(input, Object.assign({
        cache: false, signal: this.ctl.signal,
        onText: function (u) { renderAnswer(a, u.text); }
      }, modelOptions(key))).then(function (res) {
        renderAnswer(a, res.text);
        var by = answeredBy(key, res);
        a.append(h('p', { class: 't-by' }, (by.fem ? 'Ответила ' : 'Ответил ') + by.name));
        self.turns.push({ role: 'user', content: q }, { role: 'assistant', content: res.text });
      }).catch(function (e) {
        if (e && e.code === 'cancelled') { a.remove(); return; }
        var info = aiErrorText(e);
        if (e && e.text && e.code !== 'refused') { renderAnswer(a, e.text); a.append(h('p', { class: 't-err' }, 'Ответ оборвался. ' + info.text)); }
        else { a.textContent = ''; a.append(h('p', { class: 't-err' }, info.text)); }
        if (info.off) AI.set('off');
      }).then(function () {
        self.busy = false;
        $('#tGo').disabled = false;
      });
    }
  };

  function renderAnswer(el, text) {
    el.textContent = '';
    String(text).split(/```[A-Za-z+]*\n?/).forEach(function (part, i) {
      if (i % 2 === 1) { el.append(codeBlock(part.replace(/\n+$/, ''))); return; }
      part.split(/\n{2,}/).forEach(function (par) {
        if (!par.trim()) return;
        var p = h('p');
        par.split('\n').forEach(function (ln, k) {
          if (k) p.append(h('br'));
          p.append(rich(ln.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^\s*[-*]\s+/, '• ')));
        });
        el.append(p);
      });
    });
  }

  /* ---------------------------------------------------------------- lesson view */

  var current = null;

  function renderHead(L, writing) {
    var kicker = $('#lKicker');
    if (L.builtin) {
      var d = state.done[L.id];
      kicker.textContent = 'Урок ' + L.n + ' из ' + LESSONS.length + (d ? ' · пройден на «' + d.grade + '»' : '');
    } else {
      var mk = MODELS[modelKey()];
      if (writing) kicker.textContent = 'Пропись составляет Claude' + (mk.inherit ? '' : ' ' + mk.label);
      else kicker.textContent = 'Урок по запросу · ' + (L.by ? (L.by.fem ? 'составила ' : 'составил ') + L.by.name : 'составил Claude');
    }
    $('#lTitle').textContent = L.title;
    $('#lSum').textContent = L.summary || '';
    var req = $('#lReq');
    req.hidden = !L.request;
    req.textContent = '';
    if (L.request) {
      req.append(h('span', { class: 'lreq-label' }, 'Запрос: '), '«' + L.request + '»');
      if (!writing && L.generated) req.append(' ', h('button', { type: 'button', class: 'linkbtn', onclick: function () { Gen.submit(L.request, true); } }, 'Составить другой вариант'));
    }
    var ul = $('#lConcepts');
    ul.textContent = '';
    (L.concepts || []).forEach(function (c) { ul.append(h('li', null, c)); });
    var start = $('#lStart');
    var first = LESSONS[0];
    var showStart = !writing && L.builtin && L.n > 1 && first && !state.done[first.id];
    start.hidden = !showStart;
    start.textContent = '';
    if (showStart) start.append('Совсем новичок? ', h('a', { href: '#lesson-' + first.id }, 'Начни с первого урока «' + first.title + '»'), '.');
  }

  function renderHomework(L) {
    var hw = $('#hw');
    hw.textContent = '';
    hw.hidden = !(L.tasks && L.tasks.length);
    if (hw.hidden) return;
    var ol = h('ol', { class: 'hw-list' });
    L.tasks.forEach(function (t) { ol.append(h('li', null, rich(t))); });
    hw.append(
      h('h2', { class: 'hw-title' }, 'Домашнее задание'),
      h('p', { class: 'hw-sub' }, 'Когда допишешь пропись, попробуй изменить программу сам — в настоящем компиляторе.'),
      ol
    );
  }

  function openLesson(L, opts) {
    opts = opts || {};
    if (!L) return;
    if (AI.busy) { AI.ctl && AI.ctl.abort(); }
    current = L;
    state.current = L.id;
    Ed.load(L, opts.fresh ? null : state.drafts[L.id]);
    Notes.set(L);
    Notes.idx = -2;
    Notes.setLine(Ed.activeLine());
    Term.set(L);
    renderHead(L);
    renderHomework(L);
    Teacher.reset();
    $('#done').hidden = true;
    save();
    $all('.lcard').forEach(function (c) { c.classList.toggle('cur', c.dataset.id === L.id); });
  }

  /* ---------------------------------------------------------------- course */

  function renderCourse() {
    var list = $('#courseList');
    if (!list) return;
    list.textContent = '';
    LESSONS.forEach(function (L) {
      var d = state.done[L.id], dr = state.drafts[L.id];
      var mark = d ? h('span', { class: 'lmark g' + d.grade, title: 'Пройден на «' + d.grade + '»' }, String(d.grade))
        : dr ? h('span', { class: 'lprog' }, Math.floor(100 * dr.typed.length / L.code.length) + '%') : null;
      list.append(h('li', null, h('a', { class: 'lcard' + (current && current.id === L.id ? ' cur' : ''), href: '#lesson-' + L.id, dataset: { id: L.id } },
        h('span', { class: 'lcard-n' }, String(L.n)),
        h('span', { class: 'lcard-body' },
          h('span', { class: 'lcard-title' }, L.title),
          h('span', { class: 'lcard-sum' }, L.summary),
          h('span', { class: 'lcard-tags' }, L.concepts.join(' · '))
        ),
        mark
      )));
    });
    var mine = $('#mine');
    mine.textContent = '';
    mine.append(h('h2', { class: 'mine-title' }, 'Мои уроки по запросам'));
    if (!state.my.length) {
      mine.append(h('p', { class: 'mine-empty' }, 'Здесь появятся уроки, которые Claude составит по твоим запросам во вкладке «Пропись». Они хранятся только в этом браузере.'));
      return;
    }
    var ul = h('ul', { class: 'mine-list' });
    state.my.forEach(function (L) {
      var d = state.done[L.id];
      var del = h('button', { type: 'button', class: 'linkbtn mine-del' }, 'Удалить');
      var armed = 0;
      del.addEventListener('click', function () {
        if (!armed) {
          del.textContent = 'Точно удалить?';
          armed = setTimeout(function () { armed = 0; del.textContent = 'Удалить'; }, 3000);
          return;
        }
        clearTimeout(armed);
        state.my = state.my.filter(function (x) { return x.id !== L.id; });
        delete state.drafts[L.id];
        delete state.done[L.id];
        save(true);
        if (current && current.id === L.id) openLesson(findLesson('move') || LESSONS[0]);
        renderCourse();
      });
      ul.append(h('li', { class: 'mine-item' },
        h('a', { class: 'mine-link', href: '#lesson-' + L.id }, h('span', { class: 'mine-name' }, L.title), h('span', { class: 'mine-req' }, '«' + L.request + '»')),
        h('span', { class: 'mine-date' }, new Date(L.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) + (L.by ? ' · ' + L.by.name : '')),
        d ? h('span', { class: 'lmark g' + d.grade }, String(d.grade)) : null,
        del
      ));
    });
    mine.append(ul);
  }

  function updateBadge() {
    var n = LESSONS.filter(function (l) { return state.done[l.id]; }).length;
    $('#doneBadge').textContent = n ? n + '/' + LESSONS.length : '';
  }

  /* ---------------------------------------------------------------- rules */

  function renderRules() {
    var toc = $('#toc'), body = $('#rulesBody');
    toc.append(h('p', { class: 'toc-title' }, 'Правила C++'));
    var ul = h('ul', { class: 'toc-list' });
    RULES.forEach(function (r) { ul.append(h('li', null, h('a', { href: '#r-' + r.id, dataset: { id: r.id } }, r.short || r.title))); });
    toc.append(ul);
    body.append(h('header', { class: 'vhead' }, h('h1', null, 'Как устроена программа на C++'),
      h('p', null, 'Справочник к прописям: из чего состоит программа, по каким правилам она пишется и как читать ошибки компилятора. Наведи на слово в коде или нажми на него — появится подсказка.')));
    RULES.forEach(function (r) {
      var sec = h('section', { class: 'rule', id: 'r-' + r.id, 'aria-labelledby': 'rh-' + r.id }, h('h2', { id: 'rh-' + r.id }, r.title));
      r.blocks.forEach(function (b) { sec.append(renderBlock(b)); });
      body.append(sec);
    });
  }

  function renderBlock(b) {
    if (b.p) return h('p', null, rich(b.p));
    if (b.code) return codeBlock(b.code, b.cap, b.plain);
    if (b.list) {
      var ul = h('ul', { class: 'rlist' });
      b.list.forEach(function (x) { ul.append(h('li', null, rich(x))); });
      return b.title ? h('div', null, h('h3', null, b.title), ul) : ul;
    }
    if (b.steps) {
      var ol = h('ol', { class: 'rsteps' });
      b.steps.forEach(function (x) { ol.append(h('li', null, rich(x))); });
      return ol;
    }
    if (b.table) {
      var t = h('table', { class: 'rtable' });
      var tr = h('tr');
      b.table.head.forEach(function (c) { tr.append(h('th', { scope: 'col' }, c)); });
      t.append(h('thead', null, tr));
      var tb = h('tbody');
      b.table.rows.forEach(function (row) { var r = h('tr'); row.forEach(function (c) { r.append(h('td', null, rich(c))); }); tb.append(r); });
      t.append(tb);
      return h('div', { class: 'tscroll' }, t);
    }
    if (b.tip) return h('p', { class: 'callout tip' }, h('b', null, 'Совет. '), rich(b.tip));
    if (b.warn) return h('p', { class: 'callout warn' }, h('b', null, 'Внимание. '), rich(b.warn));
    if (b.anatomy) return renderAnatomy();
    if (b.flow) return renderFlow();
    if (b.terms) {
      var dl = h('dl', { class: 'terms' });
      TERMS.forEach(function (t) { dl.append(h('div', null, h('dt', null, t[0]), h('dd', null, rich(t[1])))); });
      return dl;
    }
    return document.createTextNode('');
  }

  function renderAnatomy() {
    if (!ANATOMY) return document.createTextNode('');
    var code = h('code');
    ANATOMY.lines.forEach(function (line, li) {
      if (li) code.append('\n');
      line.forEach(function (part) {
        if (typeof part === 'string') { code.append(part); return; }
        var span = h('span', { class: 'anat', dataset: { n: String(part[1]) } }, highlight(part[0]), h('sup', { class: 'anat-n' }, String(part[1])));
        code.append(span);
      });
    });
    var list = h('ol', { class: 'anat-list' });
    ANATOMY.labels.forEach(function (l) {
      list.append(h('li', { dataset: { n: String(l[0]) } }, h('span', { class: 'anat-badge' }, String(l[0])),
        h('span', null, h('b', null, l[1]), ' — ', rich(l[2]))));
    });
    var box = h('div', { class: 'anatomy' }, h('div', { class: 'anat-code cscroll' }, h('pre', { class: 'cpre', 'data-terms': '' }, code)), list);
    var hl = function (n) { $all('[data-n]', box).forEach(function (el) { el.classList.toggle('hl', el.dataset.n === n); }); };
    box.addEventListener('pointerover', function (e) { var t = e.target.closest('[data-n]'); hl(t ? t.dataset.n : null); });
    box.addEventListener('pointerleave', function () { hl(null); });
    box.addEventListener('focusin', function (e) { var t = e.target.closest('[data-n]'); hl(t ? t.dataset.n : null); });
    return box;
  }

  function renderFlow() {
    var ol = h('ol', { class: 'flow' });
    ANATOMY.flow.forEach(function (f) { ol.append(h('li', null, h('b', null, f[0]), h('span', null, rich(f[1])))); });
    return ol;
  }

  /* ---------------------------------------------------------------- routing */

  function show(view) {
    ['practice', 'course', 'rules'].forEach(function (v) {
      $('#view-' + v).hidden = v !== view;
    });
    $all('.tab').forEach(function (t) {
      var on = t.dataset.view === view;
      t.classList.toggle('on', on);
      if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    Pop.hide();
  }

  function route() {
    var hs = decodeURIComponent(location.hash.slice(1));
    if (hs.indexOf('lesson-') === 0) {
      var L = findLesson(hs.slice(7));
      show('practice');
      if (L && (!current || current.id !== L.id || Ed.preview)) openLesson(L);
      if (window.innerWidth < 960) $('#lesson').scrollIntoView(); else window.scrollTo(0, 0);
      return;
    }
    if (hs === 'course') { show('course'); window.scrollTo(0, 0); return; }
    if (hs === 'rules' || hs.indexOf('r-') === 0) {
      show('rules');
      var sec = hs.indexOf('r-') === 0 && document.getElementById(hs);
      if (sec) sec.scrollIntoView(); else window.scrollTo(0, 0);
      $all('.toc a').forEach(function (a) { a.classList.toggle('on', 'r-' + a.dataset.id === hs); });
      return;
    }
    show('practice');
  }

  function go(hash) {
    if (location.hash === '#' + hash) route(); else location.hash = hash;
  }

  /* ---------------------------------------------------------------- settings */

  // Размер шрифта кода и сторона клетки тетради (целые пиксели, чтобы строки ложились в клетки).
  var SIZES = [[13, 23], [14, 24], [15, 26], [16, 28], [18, 31], [20, 34]];
  function applySize() {
    state.settings.size = clamp(state.settings.size | 0, 0, SIZES.length - 1);
    var sz = SIZES[state.settings.size];
    document.documentElement.style.setProperty('--code-size', sz[0] + 'px');
    document.documentElement.style.setProperty('--cell', sz[1] + 'px');
    $('#btnSmaller').disabled = state.settings.size === 0;
    $('#btnBigger').disabled = state.settings.size === SIZES.length - 1;
    Ed.placeTa();
  }
  function applyAuto() {
    var b = $('#btnAuto');
    b.setAttribute('aria-pressed', state.settings.auto ? 'true' : 'false');
    b.textContent = state.settings.auto ? 'Автоотступ: вкл' : 'Автоотступ: выкл';
  }
  function applyLevel() {
    $all('.seg [data-level]').forEach(function (b) {
      var on = b.dataset.level === state.settings.level;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.classList.toggle('on', on);
    });
  }

  function copyCode() {
    var code = Ed.lesson ? Ed.lesson.code : '';
    if (!code) return;
    var fallback = function () {
      var box = $('#copybox'), area = $('#copyArea');
      area.value = code;
      box.hidden = false;
      area.focus();
      area.select();
    };
    try {
      navigator.clipboard.writeText(code).then(function () { toast('Код скопирован. Вставь его в файл main.cpp.'); }, fallback);
    } catch (e) { fallback(); }
  }

  /* ---------------------------------------------------------------- boot */

  var IDEAS = [
    ['ёлочка из звёздочек', 'Нарисовать ёлочку из звёздочек'],
    ['падающий снег', 'Хочу, чтобы в консоли падал снег'],
    ['калькулятор', 'Калькулятор: ввожу два числа и действие, программа считает'],
    ['два кубика', 'Бросить два игральных кубика и показать сумму'],
    ['таблица умножения', 'Напечатать таблицу умножения'],
    ['змейка', 'Змейка ползёт по экрану']
  ];

  function boot() {
    var app = document.getElementById('app');
    if (!app) return;
    if (!document.documentElement.lang) document.documentElement.lang = 'ru';
    app.innerHTML = SHELL;

    Ed.init(); Pop.init(); Term.init(); Teacher.init();

    var ideas = $('#ideas');
    IDEAS.forEach(function (t) {
      ideas.append(h('button', { type: 'button', class: 'chip', onclick: function () { var r = $('#req'); r.value = t[1]; r.focus(); } }, t[0]));
    });

    $('#reqForm').addEventListener('submit', function (e) { e.preventDefault(); Gen.submit($('#req').value); });
    $('#req').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); Gen.submit($('#req').value); }
    });
    $('#reqStop').addEventListener('click', function () { if (AI.ctl) AI.ctl.abort(); });
    $all('.seg [data-level]').forEach(function (b) {
      b.addEventListener('click', function () { state.settings.level = b.dataset.level; applyLevel(); save(); });
    });
    $('#btnRestart').addEventListener('click', function () { Ed.reset(); });
    $('#btnAuto').addEventListener('click', function () { state.settings.auto = !state.settings.auto; applyAuto(); save(); });
    $('#btnSmaller').addEventListener('click', function () { state.settings.size--; applySize(); save(); });
    $('#btnBigger').addEventListener('click', function () { state.settings.size++; applySize(); save(); });
    $('#btnCopy').addEventListener('click', copyCode);
    $('#copyClose').addEventListener('click', function () { $('#copybox').hidden = true; });
    $('#toc').addEventListener('click', function (e) {
      var a = e.target.closest('a[data-id]');
      if (!a) return;
      e.preventDefault();
      go('r-' + a.dataset.id);
    });
    $('#courseList').addEventListener('click', function (e) {
      var a = e.target.closest('.lcard');
      if (!a) return;
      e.preventDefault();
      go('lesson-' + a.dataset.id);
    });

    renderRules();
    applySize(); applyAuto(); applyLevel();

    var first = findLesson(state.current) || findLesson('move') || LESSONS[0];
    openLesson(first);
    renderCourse();
    updateBadge();
    if (state.fresh && first && first.id === 'move') {
      welcome = 'Ниже — готовый урок по запросу «хочу, чтобы объект двигался». Напиши свою задачу, и получишь такую же пропись: код карандашом, поверх которого ты печатаешь, и заметки на полях.';
    }
    idleStatus();
    window.addEventListener('hashchange', route);
    route();
    AI.init();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
