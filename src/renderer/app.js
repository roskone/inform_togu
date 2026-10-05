/* Логика окна: загрузка страницы, разбор, выбор дня и отрисовка. */
(function () {
  'use strict';

  const { icon } = window.Icons;
  const P = window.RaspParser;
  const W = window.RaspWeeks;
  const api = window.api;

  const DEFAULT_URL = 'https://togudv.ru/rasp/groups/69092/?semester_id=33';
  const AUTO_REFRESH_MS = 2 * 60 * 60 * 1000;
  const DAY_NAMES = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
  const DAY_PREP = ['В понедельник', 'Во вторник', 'В среду', 'В четверг', 'В пятницу', 'В субботу', 'В воскресенье'];

  const state = {
    settings: { url: DEFAULT_URL, subgroup: 0, weekOverride: null, theme: 'dark' },
    cache: null, // { url, fetchedAt, pages: { base, num, den, rendered, weektypes } }
    schedule: null,
    offset: 1,
    loading: false,
    error: null,
    todayKey: W.toISO(new Date()),
  };

  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function fmtDuration(mins) {
    const h = Math.floor(mins / 60), m = mins % 60;
    if (!h) return `${m} мин`;
    return m ? `${h} ч ${m} мин` : `${h} ч`;
  }

  const fmtDayMonth = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
  const fmtTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const fmtShort = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' });

  function today() {
    return W.startOfDay(new Date());
  }

  function selectedDate() {
    return W.addDays(today(), state.offset);
  }

  function relativeLabel(offset) {
    return { '-2': 'Позавчера', '-1': 'Вчера', 0: 'Сегодня', 1: 'Завтра', 2: 'Послезавтра' }[offset] ||
      (offset > 0 ? `Через ${offset} ${plural(offset, 'день', 'дня', 'дней')}` : `${-offset} ${plural(-offset, 'день', 'дня', 'дней')} назад`);
  }

  function fetchedLabel(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const diff = Math.round((today() - W.startOfDay(d)) / 86400000);
    const time = fmtTime.format(d);
    if (diff === 0) return `сегодня в ${time}`;
    if (diff === 1) return `вчера в ${time}`;
    return `${fmtShort.format(d)} в ${time}`;
  }

  // ───────────────────────────── разбор ─────────────────────────────

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  // Ссылка «числитель/знаменатель» должна вести на ту же страницу группы.
  function resolveWeekUrl(href, baseUrl) {
    try {
      const u = new URL(href, baseUrl);
      const b = new URL(baseUrl);
      if (u.origin !== b.origin || u.pathname !== b.pathname) return null;
      for (const [k, v] of b.searchParams) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
      return u.toString();
    } catch {
      return null;
    }
  }

  // Из сохранённых страниц собирает итоговое расписание.
  function buildSchedule(cache) {
    if (!cache || !cache.pages || !cache.pages.base) return null;
    const pages = cache.pages;
    let result = P.parseSchedule(parseHtml(pages.base));
    let mode = 'single';
    if (pages.num && pages.den) {
      const merged = P.mergeWeekSplit(P.parseSchedule(parseHtml(pages.num)), P.parseSchedule(parseHtml(pages.den)));
      if (merged.lessons.length) {
        result = Object.assign({}, merged, { title: result.title || merged.title, semester: result.semester, weekHint: result.weekHint });
        mode = 'split';
      }
    }
    if (!result.lessons.length && pages.rendered) {
      const rendered = P.parseSchedule(parseHtml(pages.rendered));
      if (rendered.lessons.length) { result = rendered; mode = 'rendered'; }
    }
    result.mode = mode;
    if (pages.weektypes && cache.fetchedAt) {
      const wt = P.parseWeekTypesPage(parseHtml(pages.weektypes), new Date(cache.fetchedAt));
      if (wt) result.weekTypesHint = { type: wt.type };
    }
    return result;
  }

  function currentAnchor() {
    const s = state.schedule;
    const hintDate = state.cache && state.cache.fetchedAt ? new Date(state.cache.fetchedAt) : new Date();
    const hint = (s && s.weekHint) || (s && s.weekTypesHint) || null;
    return W.resolveAnchor({ today: today(), override: state.settings.weekOverride, hint, hintDate });
  }

  // ───────────────────────────── загрузка ─────────────────────────────

  async function refresh({ silent } = {}) {
    if (state.loading) return;
    const url = state.settings.url;
    state.loading = true;
    state.error = null;
    renderChrome();
    if (!state.schedule) renderLessons();

    try {
      let base = await api.fetchPage(url);
      // 403/503 и т.п. — возможно, защитная проверка сайта: пробуем как браузер
      if (!base.ok && base.status) {
        const rendered = await api.renderPage(url);
        if (rendered.ok) base = rendered;
      }
      if (!base.ok) throw new Error(base.error || 'Не удалось загрузить страницу');
      const pages = { base: base.html };
      const first = P.parseSchedule(parseHtml(base.html));
      const pageUrl = base.url || url;

      // Если есть фильтры «Неделя по числителю/знаменателю» — берём обе версии
      // страницы: так тип недели каждой пары известен точно.
      const numUrl = first.weekLinks.num && resolveWeekUrl(first.weekLinks.num, pageUrl);
      const denUrl = first.weekLinks.den && resolveWeekUrl(first.weekLinks.den, pageUrl);
      if (numUrl && denUrl) {
        const [n, d] = await Promise.all([api.fetchPage(numUrl), api.fetchPage(denUrl)]);
        if (n.ok && d.ok) { pages.num = n.html; pages.den = d.html; }
      }

      if (!first.lessons.length && !pages.num) {
        const rendered = await api.renderPage(pageUrl);
        if (rendered.ok) pages.rendered = rendered.html;
      }

      try {
        const wt = await api.fetchPage(new URL('/rasp/weektypes/', pageUrl).toString());
        if (wt.ok) pages.weektypes = wt.html;
      } catch { /* необязательно */ }

      const cache = { url, fetchedAt: Date.now(), pages };
      const schedule = buildSchedule(cache);
      state.cache = cache;
      state.schedule = schedule;
      await api.saveCache(cache);
      if (!schedule.lessons.length) state.error = { kind: 'parse', message: 'Страница загрузилась, но занятий на ней не найдено.' };
      else if (!silent) toast(`Расписание обновлено · ${schedule.lessons.length} ${plural(schedule.lessons.length, 'занятие', 'занятия', 'занятий')}`);
    } catch (err) {
      state.error = { kind: 'network', message: String(err.message || err) };
    } finally {
      state.loading = false;
      render();
    }
  }

  // ───────────────────────────── отрисовка ─────────────────────────────

  function render() {
    renderChrome();
    renderLessons();
  }

  function renderChrome() {
    const s = state.schedule;
    const date = selectedDate();
    const anchor = currentAnchor();
    const weekType = W.weekTypeFor(date, anchor);

    $('group-name').textContent = (s && s.title) || 'Расписание';
    const sem = $('semester-badge');
    sem.hidden = !(s && s.semester);
    if (s && s.semester) sem.textContent = s.semester.replace(/\s*семестр$/i, '');

    $('day-eyebrow').textContent = `${relativeLabel(state.offset)} · ${W.academicWeekNumber(date)} неделя`;
    const dn = DAY_NAMES[W.dayIndex(date)];
    $('day-title').textContent = `${dn}, ${fmtDayMonth.format(date)}`;
    document.title = `${relativeLabel(state.offset)} — Расписание ТОГУ`;

    for (const t of document.querySelectorAll('#quick-tabs .tab')) t.classList.toggle('active', Number(t.dataset.offset) === state.offset);

    const pill = $('week-pill');
    pill.className = 'week-pill ' + weekType;
    pill.innerHTML = `<span class="dot"></span><b>${weekType === 'num' ? 'Числитель' : 'Знаменатель'}</b>`;
    pill.title = anchorSourceText(anchor);

    const btn = $('btn-refresh');
    btn.disabled = state.loading;
    btn.classList.toggle('spin', state.loading);

    // статус-бар
    const left = $('status-left');
    if (state.loading) left.innerHTML = '<span class="status-dot busy"></span>Загрузка расписания…';
    else if (state.error && state.cache) left.innerHTML = `<span class="status-dot warn"></span>Нет связи · данные от ${esc(fetchedLabel(state.cache.fetchedAt))}`;
    else if (state.error) left.innerHTML = '<span class="status-dot warn"></span>Нет данных';
    else if (state.cache) left.innerHTML = `<span class="status-dot ok"></span>Обновлено ${esc(fetchedLabel(state.cache.fetchedAt))}`;
    else left.innerHTML = '<span class="status-dot"></span>Ожидание';
    let host = 'togudv.ru';
    try { host = new URL(state.settings.url).host; } catch { /* оставляем по умолчанию */ }
    $('status-site').innerHTML = `${esc(host)} ${icon('external-link', 12)}`;
  }

  function anchorSourceText(anchor) {
    if (anchor.source === 'manual') return 'Тип недели задан вручную в настройках';
    if (anchor.source === 'site') return 'Тип недели — по данным сайта ТОГУ';
    return 'Тип недели — по правилу: нечётная неделя от 1 сентября — числитель';
  }

  function renderBanner() {
    const el = $('banner');
    if (!state.error || state.loading) { el.innerHTML = ''; return; }
    const isParse = state.error.kind === 'parse';
    const title = isParse ? 'Не удалось прочитать расписание' : state.cache ? 'Не удалось обновить расписание' : 'Не удалось загрузить расписание';
    let text = esc(state.error.message);
    if (!isParse) {
      text += state.cache ? `. Показаны сохранённые данные от ${esc(fetchedLabel(state.cache.fetchedAt))}.` : '.';
      text += ' Сайт ТОГУ может быть недоступен через VPN — попробуйте отключить его.';
    } else {
      text += ' Проверьте ссылку в настройках или откройте диагностику.';
    }
    el.innerHTML = `
      <div class="admonition ${state.cache && !isParse ? '' : 'danger'}">
        ${icon(isParse ? 'bug' : 'wifi-off', 16)}
        <div>
          <div class="admonition-title">${title}</div>
          <div class="admonition-text">${text}</div>
          <button class="btn btn-default" data-action="${isParse ? 'debug' : 'refresh'}">${isParse ? 'Диагностика' : 'Повторить'}</button>
        </div>
      </div>`;
  }

  function lessonsForSelected() {
    if (!state.schedule) return [];
    const date = selectedDate();
    return W.lessonsFor(state.schedule.lessons, date, {
      weekType: W.weekTypeFor(date, currentAnchor()),
      subgroup: Number(state.settings.subgroup) || 0,
    });
  }

  function renderLessons() {
    renderBanner();
    const list = $('lessons');
    const stats = $('stats');

    if (!state.schedule) {
      stats.innerHTML = '';
      if (state.loading) { list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>'; return; }
      list.innerHTML = state.error
        ? emptyState('calendar-days', 'Расписание не загружено', 'Как только сайт ТОГУ станет доступен, пары появятся здесь.', '')
        : emptyState('calendar-days', 'Расписание не загружено', 'Нажмите «Загрузить», чтобы получить расписание группы с сайта ТОГУ.', '<button class="btn btn-primary" data-action="refresh">Загрузить</button>');
      return;
    }

    const date = selectedDate();
    const lessons = lessonsForSelected();

    if (!lessons.length) {
      stats.innerHTML = '';
      const dayIdx = W.dayIndex(date);
      const next = findNextStudyDay();
      const jump = next != null && next !== state.offset
        ? `<button class="btn btn-default" data-jump="${next}">${icon('calendar', 14)} Ближайшие пары: ${esc(relativeLabel(next).toLowerCase())}, ${esc(DAY_NAMES[W.dayIndex(W.addDays(today(), next))].toLowerCase())}</button>`
        : '';
      const title = dayIdx === 6 ? 'Воскресенье — выходной' : 'Пар нет';
      const sub = dayIdx === 6 ? 'Можно отдохнуть.' : `${DAY_PREP[dayIdx]}, ${fmtDayMonth.format(date)}, занятий не найдено.`;
      list.innerHTML = emptyState('coffee', title, sub, jump);
      return;
    }

    const first = lessons[0];
    const last = lessons[lessons.length - 1];
    stats.innerHTML = `
      <div class="stat"><div class="stat-label">Пар</div><div class="stat-value">${lessons.length}</div></div>
      <div class="stat"><div class="stat-label">Начало</div><div class="stat-value">${esc(first.start || '—')}</div></div>
      <div class="stat"><div class="stat-label">Конец</div><div class="stat-value">${esc(last.end || '—')}</div></div>`;

    const now = new Date();
    const isToday = state.offset === 0;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    let nextMarked = null; // время начала ближайшей следующей пары
    const parts = [];
    lessons.forEach((l, i) => {
      if (i > 0) {
        const prev = lessons[i - 1];
        const gap = W.minutesOf(l.start) - W.minutesOf(prev.end);
        if (gap > 0) {
          const win = gap >= 40;
          parts.push(`<div class="gap ${win ? 'gap-window' : ''}"><span class="gap-line"></span><span class="gap-text">${icon(win ? 'hourglass' : 'coffee', 12)}${win ? 'Окно' : 'Перерыв'} ${fmtDuration(gap)}</span><span class="gap-line"></span></div>`);
        } else if (gap === 0 || l.start === prev.start) {
          parts.push('<div class="gap"></div>');
        }
      }
      let status = '';
      if (isToday && l.start && l.end) {
        const s = W.minutesOf(l.start), e = W.minutesOf(l.end);
        if (nowMin >= e) status = 'past';
        else if (nowMin >= s) status = 'now';
        else if (!nextMarked || l.start === nextMarked) { status = 'next'; nextMarked = l.start; }
      }
      parts.push(lessonCard(l, status, isToday ? nowMin : null));
    });
    list.innerHTML = parts.join('');
  }

  function findNextStudyDay() {
    for (let k = 1; k <= 14; k++) {
      const off = state.offset + k;
      const d = W.addDays(today(), off);
      if (W.lessonsFor(state.schedule.lessons, d, { weekType: W.weekTypeFor(d, currentAnchor()), subgroup: Number(state.settings.subgroup) || 0 }).length) return off;
    }
    return null;
  }

  function emptyState(ic, title, text, actions) {
    return `<div class="empty"><div class="empty-icon">${icon(ic, 20)}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${actions || ''}</div>`;
  }

  const ONLINE_RE = /дистанц|онлайн|online|эиос|сдо|moodle|zoom|teams|вебинар/i;

  function lessonCard(l, status, nowMin) {
    const badges = [];
    if (status === 'now') badges.push('<span class="badge badge-brand"><span class="pulse"></span>Идёт сейчас</span>');
    if (status === 'next') badges.push('<span class="badge badge-warning">Следующая</span>');
    if (l.type) badges.push(`<span class="badge">${esc(l.type)}</span>`);
    if (l.week === 'num') badges.push('<span class="badge badge-num" title="Только по числителю">Числ.</span>');
    if (l.week === 'den') badges.push('<span class="badge badge-den" title="Только по знаменателю">Знам.</span>');
    if (l.subgroup) badges.push(`<span class="badge badge-outline">${l.subgroup} подгр.</span>`);
    if (l.format && !(l.rooms.length && l.rooms.some((r) => ONLINE_RE.test(r)))) badges.push(`<span class="badge badge-outline">${esc(l.format)}</span>`);

    const meta = [];
    if (l.teachers.length) meta.push(`<span>${icon('user', 13)}${esc(l.teachers.join(', '))}</span>`);
    if (l.timeGuessed) meta.push(`<span title="На странице указан только номер пары">${icon('info', 13)}время по звонкам</span>`);

    const room = l.rooms.length ? l.rooms.join(', ') : '';
    let roomCls = '';
    let roomLabel = `${icon('door-open', 11)}Ауд.`;
    let roomValue = esc(room);
    if (!room && l.format && ONLINE_RE.test(l.format)) { roomCls = 'room-online'; roomLabel = 'Формат'; roomValue = esc(l.format); }
    else if (room && ONLINE_RE.test(room)) { roomCls = 'room-online'; roomLabel = 'Формат'; }
    else if (room && !/\d/.test(room)) { roomLabel = `${icon('map-pin', 11)}Место`; }
    else if (!room) { roomCls = 'room-none'; roomValue = 'не указана'; }

    let progress = '';
    if (status === 'now' && nowMin != null) {
      const s = W.minutesOf(l.start), e = W.minutesOf(l.end);
      const pct = Math.max(0, Math.min(100, ((nowMin - s) / (e - s)) * 100));
      progress = `<div class="l-progress" title="Осталось ${fmtDuration(e - nowMin)}"><div style="width:${pct.toFixed(1)}%"></div></div>`;
    }

    return `
      <article class="lesson ${status ? 'is-' + status : ''}">
        <div class="l-time">
          <span class="t-start">${esc(l.start || '—')}</span>
          <span class="t-end">${esc(l.end || '')}</span>
          ${l.num ? `<span class="l-num">${l.num} пара</span>` : ''}
        </div>
        <div class="l-body">
          <div class="l-badges">${badges.join('')}</div>
          <h3 class="l-subject">${esc(l.subject)}</h3>
          ${meta.length ? `<div class="l-meta">${meta.join('')}</div>` : ''}
          ${l.notes.length ? `<div class="l-notes">${esc(l.notes.join(' · '))}</div>` : ''}
        </div>
        <div class="room ${roomCls}" title="${esc(room)}">
          <div class="room-label">${roomLabel}</div>
          <div class="room-value">${roomValue}</div>
        </div>
        ${progress}
      </article>`;
  }

  // ───────────────────────────── настройки ─────────────────────────────

  let draft = null;

  function openSheet(id) {
    closeSheets();
    $('backdrop').hidden = false;
    $(id).hidden = false;
  }

  function closeSheets() {
    $('backdrop').hidden = true;
    for (const s of document.querySelectorAll('.sheet')) s.hidden = true;
  }

  function anySheetOpen() {
    return !$('backdrop').hidden;
  }

  function openSettings() {
    draft = JSON.parse(JSON.stringify(state.settings));
    $('set-url').value = draft.url;
    $('set-url').classList.remove('invalid');
    const maxSg = Math.max(0, ...((state.schedule && state.schedule.lessons) || []).map((l) => l.subgroup || 0));
    document.querySelector('#set-subgroup [data-value="3"]').hidden = maxSg < 3;
    syncSettingsForm();
    const s = state.schedule;
    $('set-debug-summary').textContent = s
      ? `${s.lessons.length} ${plural(s.lessons.length, 'занятие', 'занятия', 'занятий')}, с пометкой Ч/З: ${s.stats.withWeek}`
      : 'Расписание ещё не загружено';
    openSheet('sheet-settings');
  }

  function syncSettingsForm() {
    setSeg('set-subgroup', String(draft.subgroup || 0));
    setSeg('set-week', draft.weekOverride ? W.weekTypeFor(today(), draft.weekOverride) : 'auto');
    setSeg('set-theme', draft.theme || 'dark');
    const auto = W.resolveAnchor({
      today: today(),
      hint: state.schedule && (state.schedule.weekHint || state.schedule.weekTypesHint),
      hintDate: state.cache && state.cache.fetchedAt ? new Date(state.cache.fetchedAt) : new Date(),
    });
    const autoType = W.weekTypeFor(today(), auto) === 'num' ? 'числитель' : 'знаменатель';
    const src = auto.source === 'site' ? 'по данным сайта' : 'по правилу «нечётная неделя от 1 сентября — числитель»';
    $('set-week-help').textContent = `Авто: сейчас ${autoType} (${src}). Выберите вручную, если не совпадает с вашим расписанием.`;
  }

  function setSeg(id, value) {
    for (const b of $(id).querySelectorAll('button')) b.classList.toggle('active', b.dataset.value === value);
  }

  async function saveSettings() {
    const url = $('set-url').value.trim();
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
    } catch {
      $('set-url').classList.add('invalid');
      $('set-url').focus();
      return;
    }
    const urlChanged = url !== state.settings.url;
    draft.url = url;
    state.settings = draft;
    await api.saveSettings(state.settings);
    applyTheme();
    closeSheets();
    render();
    if (urlChanged) {
      state.schedule = null;
      state.cache = null;
      refresh();
    }
  }

  function applyTheme() {
    const t = state.settings.theme || 'dark';
    const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    api.setTheme(t);
  }

  // ───────────────────────────── диагностика ─────────────────────────────

  function openDebug() {
    const s = state.schedule;
    const body = $('debug-body');
    if (!s) {
      body.innerHTML = emptyState('bug', 'Нет данных', 'Сначала загрузите расписание.', '');
      openSheet('sheet-debug');
      return;
    }
    const modeText = { single: 'одна страница', split: 'страницы Ч и З', rendered: 'после выполнения скриптов' }[s.mode] || s.mode;
    const rows = [];
    let lastDay = -1;
    for (const l of s.lessons) {
      if (l.day !== lastDay) { rows.push(`<tr class="day-row"><td colspan="7">${DAY_NAMES[l.day]}</td></tr>`); lastDay = l.day; }
      rows.push(`<tr>
        <td>${esc(l.start || '')}–${esc(l.end || '')}</td>
        <td>${l.week === 'num' ? '<span class="badge badge-num">Числ.</span>' : l.week === 'den' ? '<span class="badge badge-den">Знам.</span>' : '—'}</td>
        <td class="subj">${esc(l.subject)}${l.subgroup ? ` <span class="badge badge-outline">${l.subgroup} п/г</span>` : ''}</td>
        <td>${esc(l.type || '')}</td>
        <td>${esc(l.rooms.join(', '))}</td>
        <td>${esc(l.teachers.join(', '))}</td>
        <td>${esc(l.notes.join(' · '))}</td>
      </tr>`);
    }
    const anchor = currentAnchor();
    body.innerHTML = `
      <div class="debug-grid">
        <div class="card"><div class="stat-label">Занятий</div><div class="stat-value">${s.lessons.length}</div></div>
        <div class="card"><div class="stat-label">С пометкой Ч/З</div><div class="stat-value">${s.stats.withWeek}</div></div>
        <div class="card"><div class="stat-label">Раскладка</div><div class="stat-value" style="font-size:14px">${esc((s.stats.layouts || []).join(', ') || '—')}</div></div>
        <div class="card"><div class="stat-label">Источник</div><div class="stat-value" style="font-size:14px">${esc(modeText)}</div></div>
      </div>
      <div class="admonition debug-warn" style="border-color:var(--border);background:var(--surface-75)">
        ${icon('info', 16)}
        <div><div class="admonition-title">Неделя: ${W.weekTypeFor(today(), anchor) === 'num' ? 'числитель' : 'знаменатель'}</div>
        <div class="admonition-text">${esc(anchorSourceText(anchor))}.${s.weekHint ? ' Подсказка на странице: ' + (s.weekHint.type === 'num' ? 'числитель' : 'знаменатель') + '.' : ''}
        ${s.warnings.length ? '<br>' + esc(s.warnings.join(' ')) : ''}
        Если что-то разобрано неверно — сохраните HTML и пришлите его разработчику.</div></div>
      </div>
      <div class="debug-table-wrap">
        <table class="debug-table">
          <thead><tr><th>Время</th><th>Нед.</th><th>Дисциплина</th><th>Вид</th><th>Ауд.</th><th>Преподаватель</th><th>Прочее</th></tr></thead>
          <tbody>${rows.join('') || '<tr><td colspan="7">Ничего не найдено</td></tr>'}</tbody>
        </table>
      </div>`;
    openSheet('sheet-debug');
  }

  function debugJson() {
    const s = state.schedule;
    return JSON.stringify({ url: state.settings.url, fetchedAt: state.cache && state.cache.fetchedAt, schedule: s }, null, 2);
  }

  // ───────────────────────────── тосты ─────────────────────────────

  function toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.innerHTML = `${icon(kind === 'warn' ? 'triangle-alert' : 'check', 15)}<span>${esc(text)}</span>`;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  // ───────────────────────────── события ─────────────────────────────

  function go(offset) {
    state.offset = Math.max(-30, Math.min(60, offset));
    render();
    $('content').scrollTop = 0;
  }

  function handleAction(action) {
    switch (action) {
      case 'refresh': return refresh();
      case 'settings': return openSettings();
      case 'debug': return openDebug();
      case 'today': return go(0);
      case 'tomorrow': return go(1);
      case 'prev': return go(state.offset - 1);
      case 'next': return go(state.offset + 1);
      case 'open-site': return api.openExternal(state.settings.url);
    }
  }

  function bind() {
    $('logo').innerHTML = icon('calendar-days', 14);
    $('btn-refresh').innerHTML = icon('refresh-cw', 15);
    $('btn-settings').innerHTML = icon('settings', 15);
    $('btn-prev').innerHTML = icon('chevron-left', 16);
    $('btn-next').innerHTML = icon('chevron-right', 16);
    $('set-url-open').innerHTML = icon('external-link', 14);
    for (const b of document.querySelectorAll('[data-close]')) if (!b.textContent.trim()) b.innerHTML = icon('x', 16);

    $('btn-refresh').addEventListener('click', () => refresh());
    $('btn-settings').addEventListener('click', openSettings);
    $('btn-prev').addEventListener('click', () => go(state.offset - 1));
    $('btn-next').addEventListener('click', () => go(state.offset + 1));
    $('status-site').addEventListener('click', () => api.openExternal(state.settings.url));
    for (const t of document.querySelectorAll('#quick-tabs .tab')) t.addEventListener('click', () => go(Number(t.dataset.offset)));

    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-action]');
      if (a) handleAction(a.dataset.action);
      const j = e.target.closest('[data-jump]');
      if (j) go(Number(j.dataset.jump));
      if (e.target.closest('[data-close]')) closeSheets();
    });
    $('backdrop').addEventListener('click', closeSheets);

    $('set-subgroup').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) { draft.subgroup = Number(b.dataset.value); syncSettingsForm(); }
    });
    $('set-week').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      draft.weekOverride = b.dataset.value === 'auto' ? null : { monday: W.toISO(W.mondayOf(today())), type: b.dataset.value };
      syncSettingsForm();
    });
    $('set-theme').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) { draft.theme = b.dataset.value; syncSettingsForm(); }
    });
    $('set-url').addEventListener('input', () => $('set-url').classList.remove('invalid'));
    $('set-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSettings(); });
    $('set-url-open').addEventListener('click', () => api.openExternal($('set-url').value.trim()));
    $('set-save').addEventListener('click', saveSettings);
    $('set-debug-open').addEventListener('click', openDebug);

    $('debug-export').addEventListener('click', async () => {
      const pages = (state.cache && state.cache.pages) || {};
      const res = await api.exportDebug({ html: pages.base || '', json: debugJson() });
      if (res && res.ok) toast('HTML страницы сохранён');
    });
    $('debug-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(debugJson()); toast('JSON скопирован'); } catch { toast('Не удалось скопировать', 'warn'); }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && anySheetOpen()) { closeSheets(); return; }
      if (anySheetOpen() || e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
      if (e.key === 'ArrowLeft') go(state.offset - 1);
      else if (e.key === 'ArrowRight') go(state.offset + 1);
    });

    api.onMenu(handleAction);

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.settings.theme === 'system') applyTheme();
    });

    // смена даты в полночь и «идёт сейчас»
    setInterval(() => {
      const key = W.toISO(new Date());
      if (key !== state.todayKey) { state.todayKey = key; render(); }
      else if (state.offset === 0 && !anySheetOpen()) renderLessons();
    }, 30000);

    window.addEventListener('focus', () => {
      if (!state.loading && (!state.cache || Date.now() - state.cache.fetchedAt > AUTO_REFRESH_MS)) refresh({ silent: true });
    });
    setInterval(() => refresh({ silent: true }), AUTO_REFRESH_MS);
  }

  async function init() {
    document.documentElement.classList.add('platform-' + api.platform);
    bind();
    const saved = await api.loadState();
    state.settings = Object.assign({}, state.settings, saved.settings || {});
    delete state.settings.windowBounds;
    applyTheme();
    if (saved.cache && saved.cache.url === state.settings.url) {
      state.cache = saved.cache;
      try { state.schedule = buildSchedule(saved.cache); } catch (e) { console.error(e); }
    }
    render();
    const fresh = state.cache && Date.now() - state.cache.fetchedAt < 10 * 60 * 1000;
    if (!fresh) refresh({ silent: !!state.schedule });
  }

  init();
})();
