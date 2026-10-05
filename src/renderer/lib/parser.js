/*
 * Парсер страницы расписания ТОГУ (togudv.ru/rasp/groups/…).
 *
 * Вёрстка сайта может меняться, поэтому парсер не привязан к конкретным
 * классам: он понимает несколько типовых раскладок и классифицирует
 * содержимое ячеек по смыслу (время, аудитория, преподаватель, вид занятия,
 * пометка числитель/знаменатель и т.д.):
 *   1. Таблица «одна строка — одно занятие» (дни — строками-заголовками
 *      или отдельной колонкой, время — обычно с rowspan).
 *   2. Сетка «пары × дни» (дни — в заголовке колонок).
 *   3. Секции «Неделя по числителю» / «Неделя по знаменателю» или вкладки.
 *   4. Вёрстка без таблиц (разбор потока текстовых строк).
 *
 * Работает с любым DOM Document: DOMParser в приложении, jsdom в тестах.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RaspParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Звонки ТОГУ — используются, только если на странице указан лишь номер пары.
  const BELLS = {
    1: ['08:30', '10:00'],
    2: ['10:10', '11:40'],
    3: ['11:50', '13:20'],
    4: ['13:50', '15:20'],
    5: ['15:30', '17:00'],
    6: ['17:10', '18:40'],
    7: ['18:50', '20:20'],
    8: ['20:30', '22:00'],
  };

  const DAYS = [
    { full: 'понедельник', short: ['пн', 'пон', 'пнд'] },
    { full: 'вторник', short: ['вт', 'втр'] },
    { full: 'среда', short: ['ср', 'срд'] },
    { full: 'четверг', short: ['чт', 'чтв'] },
    { full: 'пятница', short: ['пт', 'птн'] },
    { full: 'суббота', short: ['сб', 'суб'] },
    { full: 'воскресенье', short: ['вс', 'вск'] },
  ];

  const L = '[а-яёa-z]'; // «буква» — \b в JS не работает с кириллицей
  const NOT_L = '(?=$|[^а-яёa-z])';

  const BLOCK_TAGS = new Set([
    'DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'TABLE', 'TR', 'TD', 'TH',
    'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'BLOCKQUOTE', 'PRE', 'DL', 'DT', 'DD', 'FIGURE',
    'FIGCAPTION', 'CAPTION', 'TBODY', 'THEAD', 'TFOOT', 'FORM', 'FIELDSET', 'NAV', 'ASIDE', 'MAIN',
  ]);
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'BUTTON', 'SELECT', 'OPTION', 'INPUT',
    'TEXTAREA', 'IFRAME', 'OBJECT', 'HEAD', 'LINK', 'META', 'LABEL', 'CANVAS', 'VIDEO', 'AUDIO',
  ]);

  const ROOM_HREF_RE = /\/rasp\/(?:rooms?|aud[а-яёa-z0-9_]*|auditor[а-яёa-z0-9_]*|classrooms?|places?)\//i;
  const TEACHER_HREF_RE = /\/rasp\/(?:teachers?|prep[а-яёa-z0-9_]*|lecturers?|persons?|employees?|staff|tutors?|people|sotrud[а-яёa-z0-9_]*)\//i;
  const GROUP_HREF_RE = /\/rasp\/groups?\//i;
  const KAFEDRA_HREF_RE = /\/rasp\/(?:kafedra|chairs?|departments?)\//i;

  // ───────────────────────── текстовые утилиты ─────────────────────────

  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/[   ​\t\r\n]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function norm(s) {
    return clean(s).toLowerCase().replace(/ё/g, 'е');
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function hhmm(h, m) {
    return pad2(h) + ':' + pad2(m);
  }

  function addMinutes(t, mins) {
    const [h, m] = t.split(':').map(Number);
    const total = h * 60 + m + mins;
    return hhmm(Math.floor(total / 60) % 24, total % 60);
  }

  // ───────────────────────────── время / пара ─────────────────────────────

  const TIME_RANGE_RE = /(\d{1,2})[:.](\d{2})\s*(?:-|–|—|‒|−|до)\s*(\d{1,2})[:.](\d{2})/;
  const TIME_RANGE_RE_G = new RegExp(TIME_RANGE_RE.source, 'g');
  const SINGLE_TIME_RE = /(?:^|[^\d.:])(\d{1,2}):(\d{2})(?!\d)/;

  const TWO_TIMES_RE = /^\s*(\d{1,2})[:.](\d{2})\s+(\d{1,2})[:.](\d{2})\s*$/;

  function parseTimeRange(text) {
    const m = String(text).match(TIME_RANGE_RE) || String(text).match(TWO_TIMES_RE);
    if (!m) return null;
    const [h1, m1, h2, m2] = [m[1], m[2], m[3], m[4]].map(Number);
    if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
    const start = hhmm(h1, m1);
    const end = hhmm(h2, m2);
    if (end <= start) return null;
    return { start, end };
  }

  function parseSingleTime(text) {
    const m = String(text).match(SINGLE_TIME_RE);
    if (!m) return null;
    const h = Number(m[1]);
    const mm = Number(m[2]);
    if (h > 23 || mm > 59 || h < 6) return null;
    return hhmm(h, mm);
  }

  const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8 };

  // Возвращает { num, rest } если в тексте указан номер пары.
  function parseLessonNum(text) {
    const t = norm(text);
    let m = t.match(/(?:^|[^\d])([1-9])\s*(?:-?\s*(?:я|ая))?\s*пара/);
    if (m) return { num: Number(m[1]), rest: clean(t.replace(m[0], ' ')) };
    m = t.match(/пара\s*(?:№\s*)?([1-9])/);
    if (m) return { num: Number(m[1]), rest: clean(t.replace(m[0], ' ')) };
    m = t.match(/^№?\s*([1-9])\s*[.)]?$/);
    if (m) return { num: Number(m[1]), rest: '' };
    m = t.match(/^(i|ii|iii|iv|v|vi|vii|viii)\s*[.)]?$/);
    if (m) return { num: ROMAN[m[1]], rest: '' };
    return null;
  }

  // ─────────────────────────── дни недели ───────────────────────────

  const MONTHS_RE = '(?:янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек)[а-я]*\\.?';
  const DAY_TAIL_RE = new RegExp(
    '^[\\s,.:;()\\[\\]\\-–—\\d/]*(?:' + MONTHS_RE + '[\\s\\d.,()\\-–—/]*)?(?:г\\.?)?[\\s)\\].]*$'
  );
  const WEEK_WORD_RE = /\(?\s*(?:по\s+)?(числител[а-яёa-z0-9_]*|знаменател[а-яёa-z0-9_]*|нечетн[а-яёa-z0-9_]*(?:\s+недел[а-яёa-z0-9_]*)?|четн[а-яёa-z0-9_]*(?:\s+недел[а-яёa-z0-9_]*)?)\s*\)?/;

  // { day: 0..6, week: 'num'|'den'|null } или null
  function matchDayInfo(text) {
    let t = norm(text);
    if (!t || t.length > 60) return null;
    t = t.replace(/^\d{1,2}\.\d{1,2}(?:\.\d{2,4})?\s*(?:г\.?)?\s*[,(–—-]?\s*/, '').replace(/[)\s]+$/, '');
    let week = null;
    const wm = t.match(WEEK_WORD_RE);
    if (wm) {
      week = weekFromToken(wm[1]);
      t = clean(t.replace(wm[0], ' '));
    }
    for (let i = 0; i < DAYS.length; i++) {
      const d = DAYS[i];
      if (t.startsWith(d.full)) {
        if (DAY_TAIL_RE.test(t.slice(d.full.length))) return { day: i, week };
      }
      for (const s of d.short) {
        if (t === s || t === s + '.') return { day: i, week };
        if (t.startsWith(s + '.') || t.startsWith(s + ',') || t.startsWith(s + ' ')) {
          const rest = t.slice(s.length + 1);
          if (/\d/.test(rest) && DAY_TAIL_RE.test(rest)) return { day: i, week };
        }
      }
    }
    return null;
  }

  // ─────────────────────── числитель / знаменатель ───────────────────────

  function weekFromToken(token) {
    const t = norm(token).replace(/[\s.:()[\]*«»"'-]/g, '');
    if (!t) return null;
    if (/^(?:ч|чс|чис[а-яёa-z0-9_]*|нечет[а-яёa-z0-9_]*|(?:неделя)?почисл[а-яёa-z0-9_]*|нед[а-яёa-z0-9_]*почисл[а-яёa-z0-9_]*|1нед[а-яёa-z0-9_]*)$/.test(t)) return 'num';
    if (/^(?:з|зн|знам[а-яёa-z0-9_]*|чет(?:н[а-яёa-z0-9_]*)?(?:неделя)?|(?:неделя)?познам[а-яёa-z0-9_]*|нед[а-яёa-z0-9_]*познам[а-яёa-z0-9_]*|2нед[а-яёa-z0-9_]*)$/.test(t)) return 'den';
    return null;
  }

  // «Ч: Математика», «(З) Физика», «[Ч] …», «Числ. …»
  const PREFIX_MARKER_RE = /^\s*[([]?\s*(ч|з|числ\.?|знам\.?|числитель|знаменатель)\s*(?:[)\]:.]|\s[-–—])\s*/i;
  // «… (числитель)», «… по знаменателю», «… (ч)»
  const INLINE_MARKER_RE = /[([]\s*(?:по\s+)?(числител[а-яёa-z0-9_]*|знаменател[а-яёa-z0-9_]*|ч|з)\s*[)\]]|(?:^|[\s,;–—-])по\s+(числител[а-яёa-z0-9_]*|знаменател[а-яёa-z0-9_]*)/i;

  // «Ч Математика» — отдельная буква-маркер перед названием с заглавной буквы
  const LETTER_MARKER_RE = /^\s*(Ч|З)\s+(?=[А-ЯЁA-Z])/;

  function stripWeekMarkers(text) {
    let t = text;
    let week = null;
    const p = t.match(PREFIX_MARKER_RE) || t.match(LETTER_MARKER_RE);
    if (p) {
      week = weekFromToken(p[1]);
      t = t.slice(p[0].length);
    }
    const m = t.match(INLINE_MARKER_RE);
    if (m) {
      const w = weekFromToken(m[1] || m[2]);
      if (w) {
        week = week || w;
        t = t.replace(m[0], ' ');
      }
    }
    return { text: clean(t), week };
  }

  // «Неделя по числителю», «Числитель», «Нечётная неделя»
  function sectionWeekFromText(text) {
    const t = norm(text).replace(/[:.]+$/, '').trim();
    if (!t || t.length > 40) return null;
    let m = t.match(/^(?:неделя\s+)?(?:по\s+)?(числител[а-яёa-z0-9_]*|знаменател[а-яёa-z0-9_]*)(?:\s+недел[а-яёa-z0-9_]*)?$/);
    if (m) return weekFromToken(m[1]);
    m = t.match(/^(нечетн[а-яёa-z0-9_]*|четн[а-яёa-z0-9_]*)\s+недел[а-яёa-z0-9_]*$/);
    if (m) return weekFromToken(m[1]);
    m = t.match(/^недел[а-яёa-z0-9_]*\s*[-–—:]\s*(числител[а-яёa-z0-9_]*|знаменател[а-яёa-z0-9_]*|нечетн[а-яёa-z0-9_]*|четн[а-яёa-z0-9_]*)$/);
    if (m) return weekFromToken(m[1]);
    return null;
  }

  const NUM_CLASS_RE = /^(?:danger|table-danger|bg-danger|error|pink|red|rose|numerator|chisl[а-яёa-z0-9_]*|chis[а-яёa-z0-9_]*|nechet[а-яёa-z0-9_]*|odd|week-?1|weektype-?1|wt-?1|type-?1|num|ch)$/i;
  const DEN_CLASS_RE = /^(?:info|table-info|bg-info|blue|primary|table-primary|denominator|znam[а-яёa-z0-9_]*|zn|chet[а-яёa-z0-9_]*|even|week-?2|weektype-?2|wt-?2|type-?2|den|denom|z)$/i;

  function weekFromClasses(el) {
    if (!el || !el.getAttribute) return null;
    const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    let num = false;
    let den = false;
    for (const c of cls) {
      if (NUM_CLASS_RE.test(c)) num = true;
      else if (DEN_CLASS_RE.test(c)) den = true;
    }
    if (num !== den) return num ? 'num' : 'den';
    return null;
  }

  function parseColor(str) {
    if (!str) return null;
    const s = str.trim().toLowerCase();
    let m = s.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/);
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = s.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    const named = { pink: [255, 192, 203], lightpink: [255, 182, 193], mistyrose: [255, 228, 225], lightblue: [173, 216, 230], lightskyblue: [135, 206, 250], skyblue: [135, 206, 235], lightcyan: [224, 255, 255], aliceblue: [240, 248, 255] };
    for (const k of Object.keys(named)) if (new RegExp('(?:^|[\\s:;])' + k + '(?:$|[\\s;!])').test(s)) return named[k];
    return null;
  }

  function hueOf([r, g, b]) {
    const R = r / 255, G = g / 255, B = b / 255;
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return { h: 0, s: 0, l };
    const s = d / (1 - Math.abs(2 * l - 1));
    let h;
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h = (h * 60 + 360) % 360;
    return { h, s, l };
  }

  // На сайте пары по числителю — в розовой ячейке, по знаменателю — в синей.
  function weekFromColor(el) {
    if (!el || !el.getAttribute) return null;
    const style = el.getAttribute('style') || '';
    const bg = (style.match(/background(?:-color)?\s*:\s*([^;]+)/i) || [])[1] || el.getAttribute('bgcolor');
    const rgb = parseColor(bg);
    if (!rgb) return null;
    const { h, s, l } = hueOf(rgb);
    if (s < 0.2 || l < 0.25 || l > 0.98) return null;
    if (h >= 290 || h <= 20) return 'num';
    if (h >= 170 && h <= 260) return 'den';
    return null;
  }

  function weekFromElement(el) {
    return weekFromClasses(el) || weekFromColor(el);
  }

  // ─────────────────────────── вид занятия ───────────────────────────

  const TYPE_RULES = [
    { kind: 'lecture', label: 'Лекция', re: /^(?:лекц[а-яёa-z0-9_]*(?:\s+занят[а-яёa-z0-9_]*)?|лек\.?|лк\.?|л\.)$/ },
    { kind: 'lab', label: 'Лабораторная', re: /^(?:лаб[а-яёa-z0-9_]*\.?(?:\s*(?:раб[а-яёa-z0-9_]*\.?|р\.|зан[а-яёa-z0-9_]*\.?))?|лр\.?|л\/р)$/ },
    { kind: 'practice', label: 'Практика', re: /^(?:практ[а-яёa-z0-9_]*\.?(?:\s+занят[а-яёa-z0-9_]*\.?)?|пр\.?|пз\.?|прак\.?|п\/з)$/ },
    { kind: 'seminar', label: 'Семинар', re: /^(?:семинар[а-яёa-z0-9_]*|сем\.?)$/ },
    { kind: 'consult', label: 'Консультация', re: /^(?:консульт[а-яёa-z0-9_]*|конс\.?)$/ },
    { kind: 'exam', label: 'Экзамен', re: /^(?:экзамен[а-яёa-z0-9_]*|экз\.?)$/ },
    { kind: 'credit', label: 'Зачёт', re: /^(?:(?:диф[а-яёa-z0-9_]*\.?\s*)?зач[её]т[а-яёa-z0-9_]*|(?:диф\.?\s*)?зач\.?)$/ },
    { kind: 'other', label: 'КСР', re: /^(?:кср|срс|курсов[а-яёa-z0-9_]*(?:\s+[а-яёa-z0-9_]+)?|кп|кр|контр[а-яёa-z0-9_]*\s+раб[а-яёa-z0-9_]*)$/ },
  ];

  function matchTypeExact(t) {
    for (const r of TYPE_RULES) if (r.re.test(t)) return r;
    return null;
  }

  // Строка целиком — вид занятия («Лекция», «лаб. раб.», «Практика, дистанционно»).
  function matchType(text) {
    const t = norm(text).replace(/^[([]|[)\]]$/g, '').trim();
    if (!t || t.length > 40) return null;
    let rule = matchTypeExact(t);
    if (!rule) {
      const parts = t.split(/\s*[,;]\s*/).filter(Boolean);
      if (parts.length > 1 && parts.every((p) => matchTypeExact(p) || FORMAT_RE.test(p))) {
        rule = parts.map(matchTypeExact).find(Boolean);
      }
    }
    if (!rule) return null;
    return { kind: rule.kind, label: rule.kind === 'other' ? clean(text).replace(/^[([]|[)\]]$/g, '') : rule.label };
  }

  // «Математика (лек.)», «лек. Математика», «Математика, лекция»
  function extractInlineType(text) {
    let m = text.match(/\s*[([]\s*([^()[\]]{1,30}?)\s*[)\]]\s*$/);
    if (m) {
      const ty = matchType(m[1]);
      if (ty) return { type: ty, text: clean(text.slice(0, m.index)) };
    }
    m = text.match(/^\s*(лекция|лек\.|практика|пр\.|лаб\.(?:\s*раб\.)?|лабораторная(?:\s+работа)?|сем\.|семинар|конс\.|экз\.|зач\.)\s+/i);
    if (m) {
      const ty = matchType(m[1]);
      if (ty) return { type: ty, text: clean(text.slice(m[0].length)) };
    }
    m = text.match(/[,;–—-]\s*([^,;–—-]{2,25})\s*$/);
    if (m) {
      const ty = matchType(m[1]);
      if (ty) return { type: ty, text: clean(text.slice(0, m.index)) };
    }
    return null;
  }

  // ─────────────────────── преподаватель / аудитория ───────────────────────

  const FIO_RE = /(?:[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?\s+[А-ЯЁ]\.\s?(?:[А-ЯЁ]\.)?|[A-Z][a-z]+(?:-[A-Z][a-z]+)?\s+[A-Z]\.\s?(?:[A-Z]\.)?)/;
  const FIO_RE_G = new RegExp(FIO_RE.source, 'g');
  const FIO_FULL_RE = /^[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(?:вич|вна|чна|ична|ич|оглы|кызы)$/;
  const TITLE_RE = /(?:^|\s|,)(?:доц\.?|доцент|проф\.?|профессор|ст\.?\s*преп\.?|старший\s+преподаватель|преп\.?|преподаватель|асс\.?|ассистент|зав\.?\s*каф\.?|к\.\s?[а-я]{1,4}\.\s?н\.|д\.\s?[а-я]{1,4}\.\s?н\.)(?=\s|$|,)/gi;

  function isTeacherText(text) {
    const t = clean(text);
    if (!t || t.length > 120) return false;
    if (/^ваканси/i.test(t)) return true;
    const stripped = clean(t.replace(TITLE_RE, ' '));
    if (FIO_RE.test(stripped)) {
      const rest = stripped.replace(FIO_RE_G, ' ').replace(/[\s,;.]/g, '');
      return rest.length <= 2;
    }
    const parts = stripped.split(/\s*[,;]\s*/).filter(Boolean);
    return parts.length > 0 && parts.every((p) => FIO_FULL_RE.test(p));
  }

  // «Математика Иванов И.И.» → { subject: 'Математика', teacher: 'Иванов И.И.' }
  function splitTrailingTeacher(text) {
    const all = [...text.matchAll(FIO_RE_G)];
    if (!all.length) return null;
    const first = all[0];
    let cut = first.index;
    const before = text.slice(0, cut);
    const tm = before.match(/(?:,?\s*(?:доц\.?|доцент|проф\.?|профессор|ст\.?\s*преп\.?|преп\.?|асс\.?)\s*)$/i);
    if (tm) cut -= tm[0].length;
    const subject = clean(text.slice(0, cut).replace(/[,;–—-]\s*$/, ''));
    const teacher = clean(text.slice(cut).replace(/^[,;\s]+/, ''));
    if (subject.length < 3 || !isTeacherText(teacher)) return null;
    return { subject, teacher };
  }

  const ROOM_RE = new RegExp(
    '^(?:(?:ауд(?:итория|\\.)?|каб(?:инет|\\.)?|а\\.)\\s*№?\\s*)?' +
      '((?:' + L + '{1,3}\\s?-\\s?)?\\d{1,4}\\s?' + L + '{0,3}(?:\\s?[-/]\\s?\\d{1,3}' + L + '?)?)' +
      '(?:\\s*\\([^)]{1,40}\\))?$',
    'i'
  );
  const ONLINE_RE = new RegExp(
    '^(?:дистанционн[а-яёa-z0-9_]*|дистант|онлайн|online|он-?лайн|эиос|сдо|moodle|zoom|teams|вебинар[а-яёa-z0-9_]*|' +
      'спорт\\.?\\s*зал[а-яёa-z0-9_]*|спортзал[а-яёa-z0-9_]*|спорткомплекс[а-яёa-z0-9_]*|бассейн[а-яёa-z0-9_]*|с/з|с/к|стадион[а-яёa-z0-9_]*|' +
      'корп(?:ус|\\.)\\s*\\S+.*)' + NOT_L,
    'i'
  );
  const INLINE_ROOM_RE = /(?:^|[\s,;(])(?:ауд(?:итория|\.)|каб(?:инет|\.))\s*№?\s*([0-9][^\s,;()]*(?:\s*\([^)]{1,30}\))?)/i;

  function isRoomText(text) {
    const t = clean(text);
    if (!t || t.length > 60) return false;
    if (/^(?:ауд|каб)/i.test(t)) return true;
    if (ONLINE_RE.test(t)) return true;
    const parts = t.split(/\s*[,;]\s*/).filter(Boolean);
    return parts.every((p) => {
      const m = p.match(ROOM_RE);
      if (!m) return false;
      const core = m[1].replace(/\s/g, '');
      const digits = (core.match(/\d+/) || [''])[0];
      const hasPrefix = /^(?:ауд|каб|а\.)/i.test(p);
      return hasPrefix || digits.length >= 3 || /\d[а-яёa-z]|[а-яёa-z]-?\d/i.test(core) || /[-/]/.test(core);
    });
  }

  function cleanRoom(text) {
    return clean(text).replace(/^(?:ауд(?:итория|\.)?|каб(?:инет|\.)?)\s*№?\s*/i, '');
  }

  const FORMAT_RE = /^(?:очно|очная|дистанционно|дистанционная|онлайн|online|смешанн[а-яёa-z0-9_]*|электронн[а-яёa-z0-9_]*\s+обуч[а-яёa-z0-9_]*|с\s+применением\s+дот|дот|эо\s*и\s*дот)$/i;

  // ─────────────────────────── подгруппы / даты ───────────────────────────

  const SUBGROUP_RE = /(?:([1-9])\s*(?:-?\s*(?:я|ая))?\s*(?:подгр[а-яёa-z0-9_]*\.?|п\/гр?\.?|пгр?\.?)|(?:подгр[а-яёa-z0-9_]*\.?|п\/гр?\.?|подгруппа)\s*(?:№\s*)?([1-9]))/i;

  function extractSubgroup(text) {
    const m = text.match(SUBGROUP_RE);
    if (!m) return null;
    return { subgroup: Number(m[1] || m[2]), text: clean(text.replace(m[0], ' ').replace(/^[,;\s()–—-]+|[,;\s(–—-]+$/g, '').replace(/\(\s*\)/g, '')) };
  }

  const DATE_TOKEN = '(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{2,4}))?';
  const DATE_TOKEN_RE = new RegExp(DATE_TOKEN, 'g');

  function dateToken(d, m, y) {
    const day = Number(d), mon = Number(m);
    if (!(day >= 1 && day <= 31 && mon >= 1 && mon <= 12)) return null;
    let year = y ? Number(y) : null;
    if (year && year < 100) year += 2000;
    return { y: year, m: mon, d: day };
  }

  function datesIn(s) {
    const out = [];
    for (const m of s.matchAll(DATE_TOKEN_RE)) {
      const tok = dateToken(m[1], m[2], m[3]);
      if (tok) out.push(tok);
    }
    return out;
  }

  // Ограничения по датам: «с 01.09 по 20.12», «до 15.10», «06.10, 20.10», «кроме 04.11»
  function extractDates(text) {
    let t = text;
    const dates = {};
    let found = false;
    const range = t.match(new RegExp('(?:^|[\\s(,;])с\\s*' + DATE_TOKEN + '\\s*(?:по|до|[-–—])\\s*' + DATE_TOKEN, 'i'));
    if (range) {
      dates.from = dateToken(range[1], range[2], range[3]);
      dates.to = dateToken(range[4], range[5], range[6]);
      t = t.replace(range[0], ' ');
      found = true;
    } else {
      const from = t.match(new RegExp('(?:^|[\\s(,;])с\\s*' + DATE_TOKEN, 'i'));
      if (from) {
        dates.from = dateToken(from[1], from[2], from[3]);
        t = t.replace(from[0], ' ');
        found = true;
      }
      const to = t.match(new RegExp('(?:^|[\\s(,;])(?:по|до)\\s*' + DATE_TOKEN, 'i'));
      if (to) {
        dates.to = dateToken(to[1], to[2], to[3]);
        t = t.replace(to[0], ' ');
        found = true;
      }
    }
    const except = t.match(new RegExp('кроме\\s*((?:' + DATE_TOKEN + '[\\s,;и]*)+)', 'i'));
    if (except) {
      dates.except = datesIn(except[1]);
      t = t.replace(except[0], ' ');
      found = true;
    }
    const onlyRe = new RegExp('^\\s*(?:только|даты?:?|по\\s+датам:?)?\\s*((?:' + DATE_TOKEN + '\\s*(?:г\\.?)?[\\s,;]*)+)\\s*$', 'i');
    const only = clean(t.replace(/[()]/g, ' ')).match(onlyRe);
    if (only) {
      dates.only = datesIn(only[1]);
      t = '';
      found = true;
    }
    if (!found) return null;
    return { dates, text: clean(t.replace(/\(\s*\)/g, '')) };
  }

  // ─────────────────────────── строки ячейки ───────────────────────────

  function isSpecialHref(href) {
    return ROOM_HREF_RE.test(href) || TEACHER_HREF_RE.test(href) || GROUP_HREF_RE.test(href) || KAFEDRA_HREF_RE.test(href);
  }

  // Разбивает содержимое элемента на «строки» (<br>, блочные теги, ссылки на
  // аудиторию/преподавателя). Для каждой строки запоминает ссылки.
  function extractLines(el, extraSkip) {
    const lines = [];
    let cur = { text: '', hrefs: [], weeks: [] };
    const flush = () => {
      const t = clean(cur.text);
      if (t) lines.push({ text: t, hrefs: [...new Set(cur.hrefs)], week: cur.weeks.length ? cur.weeks[cur.weeks.length - 1] : null });
      cur = { text: '', hrefs: [], weeks: [] };
    };
    (function walk(node, href, week) {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          cur.text += child.nodeValue;
          if (child.nodeValue.trim()) {
            if (href) cur.hrefs.push(href);
            if (week) cur.weeks.push(week);
          }
        } else if (child.nodeType === 1) {
          const tag = child.tagName.toUpperCase();
          if (SKIP_TAGS.has(tag) || (extraSkip && extraSkip.has(tag))) continue;
          if (tag === 'BR') {
            flush();
            continue;
          }
          let h = href;
          let split = BLOCK_TAGS.has(tag);
          if (tag === 'A') {
            const raw = child.getAttribute('href') || '';
            if (raw) h = raw;
            if (isSpecialHref(raw)) split = true;
          }
          if (child.getAttribute('title') && !child.textContent.trim()) {
            cur.text += ' ' + child.getAttribute('title') + ' ';
          }
          if (split) flush();
          walk(child, h, weekFromElement(child) || week);
          if (split) flush();
        }
      }
    })(el, null, null);
    flush();
    return lines;
  }

  // ──────────────────────── сборка одного занятия ────────────────────────

  function emptyLesson() {
    return {
      day: null, num: null, start: null, end: null, week: null,
      subject: null, type: null, typeKind: null, teachers: [], rooms: [],
      subgroup: null, format: null, notes: [], dates: null, timeGuessed: false,
    };
  }

  function pushUnique(arr, v) {
    const c = clean(v);
    if (c && !arr.includes(c)) arr.push(c);
  }

  // items: [{ text, hrefs, role, week }] — все строки одного занятия
  function buildLesson(items, base) {
    const lesson = Object.assign(emptyLesson(), base || {});
    const rest = [];
    let markerWeek = null;

    for (const it of items) {
      let t = clean(it.text);
      if (!t) continue;
      const role = it.role || null;
      const hrefs = it.hrefs || [];

      if (it.week && !markerWeek) markerWeek = it.week;

      if (hrefs.some((h) => ROOM_HREF_RE.test(h))) { pushUnique(lesson.rooms, cleanRoom(t)); continue; }
      if (hrefs.some((h) => TEACHER_HREF_RE.test(h))) { pushUnique(lesson.teachers, t); continue; }
      if (hrefs.some((h) => GROUP_HREF_RE.test(h) || KAFEDRA_HREF_RE.test(h))) continue;

      // время
      const tr = parseTimeRange(t);
      if (tr) {
        if (!lesson.start) { lesson.start = tr.start; lesson.end = tr.end; }
        t = clean(t.replace(TIME_RANGE_RE_G, ' '));
      } else if (role === 'time' || role === 'num' || /^\d{1,2}:\d{2}$/.test(t)) {
        const st = parseSingleTime(t);
        if (st) {
          if (!lesson.start) lesson.start = st;
          else if (!lesson.end && st > lesson.start) lesson.end = st;
          t = clean(t.replace(/\d{1,2}:\d{2}/, ' '));
        }
      }
      if (tr || role === 'time' || role === 'num' || /пара/i.test(t)) {
        const ln = parseLessonNum(t);
        if (ln) { if (!lesson.num) lesson.num = ln.num; t = ln.rest; }
      }
      if (!t) continue;
      if (tr && /^[\s\-–—,.:]*$/.test(t)) continue;

      // пометка недели
      const wk = weekFromToken(t);
      if (wk && t.length <= 24) { markerWeek = markerWeek || wk; continue; }
      const sm = stripWeekMarkers(t);
      if (sm.week) { markerWeek = markerWeek || sm.week; t = sm.text; if (!t) continue; }

      // роль колонки из заголовка таблицы
      if (role === 'room') { for (const p of t.split(/\s*[,;]\s*/)) pushUnique(lesson.rooms, cleanRoom(p)); continue; }
      if (role === 'teacher') { pushUnique(lesson.teachers, t); continue; }
      if (role === 'type') {
        const ty = matchType(t);
        if (ty) { lesson.type = ty.label; lesson.typeKind = ty.kind; }
        else if (FORMAT_RE.test(t)) lesson.format = t;
        else { lesson.type = t; lesson.typeKind = 'other'; }
        continue;
      }
      if (role === 'subgroup') {
        const sg = extractSubgroup(t) || (/^[1-9]$/.test(t) ? { subgroup: Number(t) } : null);
        if (sg) lesson.subgroup = sg.subgroup; else pushUnique(lesson.notes, t);
        continue;
      }
      if (role === 'group' || role === 'day') continue;
      if (role === 'dates') {
        const dd = extractDates(t);
        if (dd) lesson.dates = dd.dates;
        pushUnique(lesson.notes, t);
        continue;
      }
      if (role === 'num' || role === 'time') {
        if (/^[1-9]$/.test(t) && !lesson.num) lesson.num = Number(t);
        continue;
      }
      if (role === 'week') {
        if (/^[12]$/.test(t)) markerWeek = markerWeek || (t === '1' ? 'num' : 'den');
        continue;
      }

      // эвристики
      if (!role && /^[1-9]$/.test(t) && !lesson.num && !rest.length) { lesson.num = Number(t); continue; }

      const sg = extractSubgroup(t);
      if (sg) { lesson.subgroup = sg.subgroup; t = sg.text; if (!t) continue; }

      const dd = extractDates(t);
      if (dd) {
        lesson.dates = Object.assign(lesson.dates || {}, dd.dates);
        const original = clean(it.text);
        if (dd.text !== t) pushUnique(lesson.notes, original.length < 60 ? original : t.replace(dd.text, '').trim());
        t = dd.text;
        if (!t) continue;
      }

      if (role !== 'subject') {
        if (isRoomText(t)) { for (const p of t.split(/\s*[,;]\s*/)) pushUnique(lesson.rooms, cleanRoom(p)); continue; }
        if (isTeacherText(t)) { pushUnique(lesson.teachers, t); continue; }
        const ty = matchType(t);
        if (ty) { lesson.type = ty.label; lesson.typeKind = ty.kind; continue; }
        if (FORMAT_RE.test(t)) { lesson.format = t; continue; }
      }

      const ir = t.match(INLINE_ROOM_RE);
      if (ir) { pushUnique(lesson.rooms, cleanRoom(ir[1])); t = clean(t.replace(ir[0], ' ').replace(/[,;]\s*$/, '')); if (!t) continue; }

      rest.push({ text: t, role });
    }

    // предмет: колонка «Дисциплина» или первая содержательная строка
    let subjIdx = rest.findIndex((r) => r.role === 'subject' && /[а-яёa-z]{2}/i.test(r.text));
    if (subjIdx < 0) subjIdx = rest.findIndex((r) => /[а-яёa-z]{3}/i.test(r.text));
    if (subjIdx >= 0) {
      let s = rest[subjIdx].text;
      rest.splice(subjIdx, 1);
      const tt = splitTrailingTeacher(s);
      if (tt) { s = tt.subject; pushUnique(lesson.teachers, tt.teacher); }
      const it = extractInlineType(s);
      if (it) {
        if (!lesson.type) { lesson.type = it.type.label; lesson.typeKind = it.type.kind; }
        s = it.text;
      }
      lesson.subject = s.replace(/[,;:–—-]\s*$/, '').trim();
    }
    for (const r of rest) {
      if (FORMAT_RE.test(r.text)) lesson.format = r.text;
      else pushUnique(lesson.notes, r.text);
    }

    if (!lesson.week && markerWeek) lesson.week = markerWeek;
    if (!lesson.subject && lesson.type && (lesson.rooms.length || lesson.teachers.length)) lesson.subject = lesson.type;
    return lesson;
  }

  // ────────────────────────────── таблицы ──────────────────────────────

  function buildGrid(table) {
    const rows = Array.from(table.rows || []);
    const grid = [];
    rows.forEach((tr, r) => {
      grid[r] = grid[r] || [];
      let c = 0;
      for (const cell of Array.from(tr.cells || [])) {
        while (grid[r][c]) c++;
        const rs = Math.max(1, Math.min(parseInt(cell.getAttribute('rowspan'), 10) || 1, rows.length - r));
        const cs = Math.max(1, Math.min(parseInt(cell.getAttribute('colspan'), 10) || 1, 60));
        for (let i = 0; i < rs; i++) {
          grid[r + i] = grid[r + i] || [];
          for (let j = 0; j < cs; j++) grid[r + i][c + j] = { el: cell, r0: r, c0: c };
        }
        c += cs;
      }
    });
    return { rows, grid };
  }

  function rowEntries(grid, r) {
    const seen = new Set();
    const out = [];
    (grid[r] || []).forEach((e, c) => {
      if (!e || seen.has(e.el)) return;
      seen.add(e.el);
      out.push(Object.assign({ col: c, own: e.r0 === r }, e));
    });
    return out;
  }

  // Роль колонки по тексту заголовка («Аудитория» → room и т.п.)
  function headerRole(text) {
    const t = norm(text).replace(/[.:]+$/, '');
    if (!t || t.length > 30) return null;
    if (/^(?:неделя|тип\s+недели|ч\s*\/\s*з|числ[а-яё.]*\s*\/\s*знам[а-яё.]*|четность)$/.test(t)) return 'week';
    if (/^(?:преподавател[ьи]|педагог|фио(?:\s+преподавателя)?|лектор|ведущий)$/.test(t)) return 'teacher';
    if (/^(?:ауд\.?|аудитори[яи]|кабинет|помещение|место(?:\s+проведения)?|корпус(?:,?\s*ауд[а-яё.]*)?)$/.test(t)) return 'room';
    if (/^(?:подгруппа|подгр\.?|п\/г)$/.test(t)) return 'subgroup';
    if (/^(?:время|часы|начало|время\s+занятий?)$/.test(t)) return 'time';
    if (/^(?:вид(?:\s+занятия)?|тип(?:\s+занятия)?|форма(?:\s+занятия)?)$/.test(t)) return 'type';
    if (/^(?:дисциплин[аы]|предмет|занятие|наименование(?:\s+дисциплины)?|название|курс)$/.test(t)) return 'subject';
    if (/^(?:№|n|#|номер|пара|№\s*пары|номер\s+пары|пары)$/.test(t)) return 'num';
    if (/^(?:группа|группы)$/.test(t)) return 'group';
    if (/^(?:даты?|период)$/.test(t)) return 'dates';
    if (/^(?:день|дни|день\s+недели)$/.test(t)) return 'day';
    return null;
  }

  function isHeaderRow(tr, entries) {
    const cells = entries.filter((e) => e.own);
    if (cells.length < 2) return false;
    const inThead = tr.parentElement && tr.parentElement.tagName === 'THEAD';
    const allTh = cells.every((e) => e.el.tagName === 'TH');
    const roles = cells.map((e) => headerRole(e.el.textContent)).filter(Boolean);
    if ((inThead || allTh) && roles.length >= 1) return true;
    // заголовок из обычных <td>: почти все ячейки — названия колонок
    const filled = cells.filter((e) => clean(e.el.textContent));
    return roles.length >= 3 && roles.length >= filled.length - 1;
  }

  function processTable(table, ctx) {
    const { rows, grid } = buildGrid(table);
    if (!rows.length) return;
    ctx.stats.tables++;

    // Сетка «пары × дни»: строка, где в разных колонках стоят дни недели
    for (let r = 0; r < Math.min(rows.length, 4); r++) {
      const entries = rowEntries(grid, r);
      const dayCols = {};
      let count = 0;
      const daysSeen = new Set();
      for (const e of entries) {
        const di = matchDayInfo(e.el.textContent);
        if (di && !daysSeen.has(di.day)) {
          daysSeen.add(di.day);
          for (let c = e.c0; c < e.c0 + (parseInt(e.el.getAttribute('colspan'), 10) || 1); c++) dayCols[c] = di;
          count++;
        }
      }
      if (count >= 3) {
        processGridTable(rows, grid, r, dayCols, ctx);
        return;
      }
    }

    // Таблица «строка — занятие»
    ctx.stats.layouts.add('rows');
    let roles = {};
    for (let r = 0; r < rows.length; r++) {
      const entries = rowEntries(grid, r);
      if (!entries.length) continue;

      if (isHeaderRow(rows[r], entries)) {
        roles = {};
        for (const e of entries) {
          const role = headerRole(e.el.textContent);
          const span = parseInt(e.el.getAttribute('colspan'), 10) || 1;
          for (let c = e.c0; c < e.c0 + span; c++) roles[c] = role;
        }
        continue;
      }

      const own = entries.filter((e) => e.own && clean(e.el.textContent));
      if (!own.length) continue;

      // строка-заголовок дня или секции недели
      let dayEntry = null;
      for (const e of entries) {
        if (roles[e.col] === 'day' || e.own || e.el.getAttribute('rowspan')) {
          const di = matchDayInfo(e.el.textContent);
          if (di) {
            dayEntry = e;
            ctx.day = di.day;
            if (di.week) ctx.rowWeek = di.week;
            else if (e.own) ctx.rowWeek = null;
            break;
          }
        }
      }
      const content = own.filter((e) => e !== dayEntry);
      if (!content.length) continue;
      if (content.length === 1 && entries.length <= 2) {
        const sw = sectionWeekFromText(content[0].el.textContent);
        if (sw) { ctx.tableWeek = sw; continue; }
      }

      const items = [];
      let rowWeek = weekFromElement(rows[r]);
      for (const e of entries) {
        if (e === dayEntry) continue;
        const role = roles[e.col] || null;
        const cellWeek = weekFromElement(e.el);
        if (cellWeek && e.own && (role === 'week' || clean(e.el.textContent).length <= 3)) rowWeek = rowWeek || cellWeek;
        for (const ln of extractLines(e.el)) items.push(Object.assign({ role }, ln));
      }
      // нет ли в строке хотя бы одной «содержательной» ячейки
      const hasContent = content.some((e) => {
        const role = roles[e.col];
        if (role === 'time' || role === 'num' || role === 'week' || role === 'day') return false;
        const t = clean(e.el.textContent);
        return /[а-яёa-z]{3}/i.test(t) && !parseTimeRange(t) && !weekFromToken(t);
      });
      if (!hasContent) continue;
      if (ctx.day == null) { ctx.stats.orphanRows++; continue; }

      if (!rowWeek) {
        for (const e of content) {
          const t = clean(e.el.textContent);
          if (t.length > 3) {
            const w = weekFromElement(e.el);
            if (w) { rowWeek = w; break; }
          }
        }
      }
      const lesson = buildLesson(items, { day: ctx.day });
      lesson.week = lesson.week || rowWeek || ctx.rowWeek || ctx.tableWeek || ctx.sectionWeek || null;
      lesson.source = 'rows';
      if (lesson.subject) ctx.lessons.push(lesson);
    }
  }

  function processGridTable(rows, grid, headerRow, dayCols, ctx) {
    ctx.stats.layouts.add('grid');
    const doc = rows[0].ownerDocument;
    const lastByCol = {};
    for (let r = headerRow + 1; r < rows.length; r++) {
      const entries = rowEntries(grid, r);
      if (!entries.length) continue;
      // заголовок строки: время / номер пары
      const headItems = [];
      for (const e of entries) {
        if (dayCols[e.c0] === undefined) for (const ln of extractLines(e.el)) headItems.push(Object.assign({ role: 'time' }, ln));
      }
      const head = buildLesson(headItems, {});
      const rowWeekHead = entries.find((e) => dayCols[e.c0] === undefined && weekFromToken(e.el.textContent));
      const rowWeek = (rowWeekHead && weekFromToken(rowWeekHead.el.textContent)) || weekFromElement(rows[r]) || null;

      for (const e of entries) {
        const di = dayCols[e.c0];
        if (di === undefined) continue;
        if (!e.own) {
          // ячейка растянута на несколько пар — продлеваем время окончания
          const prev = lastByCol[e.c0];
          if (prev && prev.el === e.el && head.end) prev.lessons.forEach((l) => { l.end = head.end; });
          continue;
        }
        if (!clean(e.el.textContent)) continue;
        const made = [];
        for (const block of splitBlocks(e.el, doc)) {
          const lesson = buildLesson(block.lines.map((ln) => Object.assign({ role: null }, ln)), {
            day: di.day, num: head.num, start: head.start, end: head.end,
          });
          lesson.week = lesson.week || block.week || weekFromElement(e.el) || rowWeek || di.week || ctx.sectionWeek || null;
          lesson.source = 'grid';
          if (lesson.subject) { ctx.lessons.push(lesson); made.push(lesson); }
        }
        lastByCol[e.c0] = { el: e.el, lessons: made };
      }
    }
  }

  // Ячейка сетки может содержать несколько занятий (числитель/знаменатель).
  function splitBlocks(el, doc) {
    let container = el;
    while (
      container.children.length === 1 &&
      BLOCK_TAGS.has(container.children[0].tagName) &&
      !weekFromElement(container.children[0]) &&
      clean(container.children[0].textContent) === clean(container.textContent)
    ) container = container.children[0];

    const kids = Array.from(container.children).filter((k) => BLOCK_TAGS.has(k.tagName) && k.tagName !== 'HR' && clean(k.textContent));
    if (kids.length >= 2) {
      const weeks = kids.map(weekFromElement);
      if (weeks.some(Boolean) || container.querySelector(':scope > hr')) {
        return kids.map((k, i) => ({ lines: extractLines(k), week: weeks[i] || stripWeekMarkers(clean(k.textContent)).week }));
      }
    }

    if (container.querySelector(':scope > hr') && doc) {
      const parts = [];
      let frag = doc.createElement('div');
      for (const n of Array.from(container.childNodes)) {
        if (n.nodeType === 1 && n.tagName === 'HR') { parts.push(frag); frag = doc.createElement('div'); }
        else frag.appendChild(n.cloneNode(true));
      }
      parts.push(frag);
      const blocks = parts.filter((p) => clean(p.textContent)).map((p) => ({ lines: extractLines(p), week: null }));
      if (blocks.length) return blocks;
    }

    const groups = [];
    let cur = null;
    for (const ln of extractLines(el)) {
      const pm = ln.text.match(PREFIX_MARKER_RE);
      if (pm) {
        cur = { lines: [], week: weekFromToken(pm[1]) };
        groups.push(cur);
        const rest = clean(ln.text.slice(pm[0].length));
        if (rest) cur.lines.push(Object.assign({}, ln, { text: rest }));
        continue;
      }
      if (ln.week && cur && cur.week && ln.week !== cur.week) {
        cur = { lines: [], week: ln.week };
        groups.push(cur);
      }
      if (!cur) { cur = { lines: [], week: ln.week || null }; groups.push(cur); }
      cur.lines.push(ln);
    }
    return groups;
  }

  // ───────────────────── обход документа ─────────────────────

  function isLeafish(el) {
    for (const ch of Array.from(el.children)) if (BLOCK_TAGS.has(ch.tagName)) return false;
    return clean(el.textContent).length <= 60;
  }

  function walk(el, ctx) {
    const tag = el.tagName;
    if (!tag || SKIP_TAGS.has(tag) || tag === 'A' || tag === 'NAV') return;
    const paneWeek = el.id ? ctx.paneWeeks[el.id] : null;
    const savedSection = ctx.sectionWeek;
    if (paneWeek) { ctx.sectionWeek = paneWeek; ctx.pendingSections = []; }

    if (tag === 'TABLE' && !el.querySelector('table')) {
      ctx.pendingSections = [];
      ctx.tableWeek = null;
      ctx.rowWeek = null;
      processTable(el, ctx);
    } else {
      if (tag !== 'TABLE' && isLeafish(el)) {
        const txt = clean(el.textContent);
        const di = matchDayInfo(txt);
        if (di) {
          ctx.day = di.day;
          if (di.week) ctx.sectionWeek = di.week;
        } else {
          const sw = sectionWeekFromText(txt);
          if (sw) {
            // Подписи-переключатели «Неделя по числителю | … по знаменателю» стоят рядом —
            // такие пары считаем неоднозначными; маркер в другом месте начинает новую секцию.
            const prev = ctx.pendingSections[ctx.pendingSections.length - 1];
            if (prev && prev.parent !== el.parentElement) ctx.pendingSections = [];
            ctx.pendingSections.push({ week: sw, parent: el.parentElement });
            ctx.sectionWeek = new Set(ctx.pendingSections.map((p) => p.week)).size === 1 ? sw : null;
          }
        }
      }
      for (const ch of Array.from(el.children)) walk(ch, ctx);
    }
    if (paneWeek) ctx.sectionWeek = savedSection;
  }

  // Запасной вариант для вёрстки без таблиц: поток строк.
  function parseTextStream(body, ctx) {
    ctx.stats.layouts.add('text');
    let cur = null;
    const finish = () => {
      if (cur) {
        const lesson = buildLesson(cur.items, { day: cur.day });
        lesson.week = lesson.week || cur.week || null;
        lesson.source = 'text';
        if (lesson.subject && lesson.start) ctx.lessons.push(lesson);
      }
      cur = null;
    };
    let day = null;
    let section = null;
    for (const ln of extractLines(body, new Set(['HEADER', 'FOOTER', 'NAV', 'ASIDE', 'FORM']))) {
      if (/©|copyright|все права защищены/i.test(ln.text)) { finish(); continue; }
      const di = matchDayInfo(ln.text);
      if (di) { finish(); day = di.day; if (di.week) section = di.week; continue; }
      if (!ln.hrefs.length) {
        const sw = sectionWeekFromText(ln.text);
        if (sw) { finish(); section = sw; continue; }
      }
      const tr = parseTimeRange(ln.text);
      if (tr && day != null) {
        finish();
        cur = { items: [ln], day, week: section };
        continue;
      }
      if (cur) {
        cur.items.push(ln);
        if (cur.items.length > 10) finish();
      }
    }
    finish();
  }

  // ───────────────────── метаданные страницы ─────────────────────

  function pageTitle(doc) {
    const h1 = doc.querySelector('h1');
    const heads = Array.from(doc.querySelectorAll('h1, h2, h3')).map((h) => h.textContent);
    const candidates = [...heads, doc.title];
    for (const c of candidates) {
      const t = clean(c);
      if (!t) continue;
      const m = t.match(/групп[аы]\s+(.+?)\s*(?:\/|\||—\s*Тихоокеан|$)/i);
      if (m) return clean(m[1]);
    }
    return clean(h1 && h1.textContent) || null;
  }

  function semesterLabel(doc) {
    const sel = doc.querySelector('select[name*="semester"] option[selected], select[id*="semester"] option[selected]');
    if (sel) return clean(sel.textContent);
    const txt = clean(doc.body ? doc.body.textContent : '');
    const m = txt.match(/(20\d{2}\s*[-–/]\s*20\d{2}[^.,;]{0,30}?(?:осенн|весенн|зимн|летн)[а-яёa-z0-9_]*(?:\s+семестр)?)/i);
    return m ? clean(m[1]) : null;
  }

  // «Сейчас идёт 6-я неделя (знаменатель)», «Текущая неделя: числитель»
  function currentWeekHint(doc) {
    const txt = norm(doc.body ? doc.body.textContent : '');
    const toType = (w) => (/^нечетн|^числ/.test(w) ? 'num' : 'den');
    let m = txt.match(/(?:сейчас|текущ[а-яёa-z0-9_]*(?:\s+недел[а-яёa-z0-9_]*)?|ид[её]т|эта\s+неделя|на\s+этой\s+неделе)[^.!?]{0,40}?(числител|знаменател|нечетн|четн)/);
    if (m) {
      const n = m[0].match(/(\d{1,2})\s*(?:-?\s*я)?\s*(?:учебн[а-яёa-z0-9_]*\s+)?недел/);
      return { type: toType(m[1]), week: n ? Number(n[1]) : null };
    }
    m = txt.match(/(\d{1,2})\s*(?:-?\s*я)?\s*(?:учебн[а-яёa-z0-9_]*\s+)?неделя[\s,:(–—-]*(?:по\s+)?(числител|знаменател|нечетн|четн)/);
    if (m) return { type: toType(m[2]), week: Number(m[1]) };
    m = txt.match(/неделя[\s:]*(?:№\s*)?(\d{1,2})[\s,:(–—-]*(?:по\s+)?(числител|знаменател|нечетн|четн)/);
    if (m) return { type: toType(m[2]), week: Number(m[1]) };
    return null;
  }

  // Ссылки «Неделя по числителю» / «… по знаменателю» (фильтр или вкладки).
  function weekNavigation(doc) {
    const links = {};
    const panes = {};
    const els = doc.querySelectorAll('a[href], [data-target], [data-bs-target], [aria-controls]');
    for (const a of Array.from(els)) {
      const t = norm(a.textContent);
      let w = null;
      if (/числител|нечетн/.test(t)) w = 'num';
      else if (/знаменател|(?:^|[^е])четн/.test(t)) w = 'den';
      if (!w) continue;
      const href = a.getAttribute('href') || '';
      const target = a.getAttribute('data-bs-target') || a.getAttribute('data-target') || (a.getAttribute('aria-controls') ? '#' + a.getAttribute('aria-controls') : '');
      const paneRef = href.startsWith('#') ? href : target;
      if (paneRef && paneRef.startsWith('#') && paneRef.length > 1) panes[paneRef.slice(1)] = w;
      else if (href && !href.startsWith('#') && !/^javascript:/i.test(href) && (href.includes('?') || /week|nedel/i.test(href))) {
        if (!links[w]) links[w] = href;
      }
    }
    return { links, panes };
  }

  // ─────────────── страница «Расписание недель и звонков» ───────────────

  const DATE_RANGE_RE = /(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\s*(?:-|–|—|по)\s*(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/g;

  function tokenDate(d, m, y, ref) {
    let year = y ? Number(y) : null;
    if (year && year < 100) year += 2000;
    if (!year) {
      const startYear = ref.getMonth() >= 7 ? ref.getFullYear() : ref.getFullYear() - 1;
      year = Number(m) >= 8 ? startYear : startYear + 1;
    }
    return new Date(year, Number(m) - 1, Number(d));
  }

  /*
   * Ищет строку с диапазоном дат, в который попадает date, и определяет по ней
   * тип недели (слово «числитель»/«знаменатель», буква Ч/З или цвет ячейки).
   */
  function parseWeekTypesPage(doc, date) {
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const candidates = Array.from(doc.querySelectorAll('tr, li, p, div, td')).filter((el) => {
      const t = el.textContent || '';
      return t.length < 400 && /\d{1,2}\.\d{1,2}/.test(t);
    });
    // вложенные элементы идут после родителей — обходим с конца, чтобы сначала смотреть самые узкие
    for (const el of candidates.reverse()) {
      const text = clean(el.textContent);
      for (const m of text.matchAll(DATE_RANGE_RE)) {
        const from = tokenDate(m[1], m[2], m[3], day);
        const to = tokenDate(m[4], m[5], m[6] || m[3], day);
        if (!(day >= from && day <= to) || (to - from) / 86400000 > 8) continue;
        const wm = norm(text).match(/(числител|знаменател|нечетн|четн)/);
        if (wm) return { type: /^(?:числ|нечет)/.test(wm[1]) ? 'num' : 'den', from, to };
        const cells = el.tagName === 'TR' ? Array.from(el.cells) : [el];
        for (const c of cells) {
          const w = weekFromToken(c.textContent);
          if (w && clean(c.textContent).length <= 12) return { type: w, from, to };
        }
        const w = weekFromElement(el) || cells.map(weekFromElement).find(Boolean);
        if (w) return { type: w, from, to };
      }
    }
    return null;
  }

  // ───────────────────────────── API ─────────────────────────────

  function lessonKey(l) {
    return [l.day, l.start, l.end, l.num, l.subject, l.type, l.rooms.join(','), l.teachers.join(','), l.subgroup]
      .map((x) => norm(x == null ? '' : String(x)))
      .join('|');
  }

  function finalize(lessons) {
    // одинаковая пара и в числителе, и в знаменателе — значит, каждую неделю
    const byKey = new Map();
    for (const l of lessons) {
      const k = lessonKey(l);
      if (!byKey.has(k)) byKey.set(k, new Set());
      byKey.get(k).add(l.week || 'both');
    }
    lessons = lessons.map((l) => {
      const w = byKey.get(lessonKey(l));
      return l.week && w.has('num') && w.has('den') ? Object.assign({}, l, { week: null }) : l;
    });
    const seen = new Set();
    const out = [];
    for (const l of lessons) {
      if (!l.start && l.num && BELLS[l.num]) {
        l.start = BELLS[l.num][0];
        l.end = BELLS[l.num][1];
        l.timeGuessed = true;
      }
      if (l.start && !l.end) l.end = addMinutes(l.start, 90);
      if (!l.num && l.start) {
        for (const [n, [s]] of Object.entries(BELLS)) if (s === l.start) l.num = Number(n);
      }
      const k = lessonKey(l) + '|' + (l.week || '');
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(l);
    }
    out.sort((a, b) => a.day - b.day || String(a.start).localeCompare(String(b.start)) || (a.subgroup || 0) - (b.subgroup || 0));
    return out;
  }

  function parseSchedule(doc) {
    const body = doc.body || doc.documentElement;
    const nav = weekNavigation(doc);
    const ctx = {
      day: null,
      sectionWeek: null,
      pendingSections: [],
      tableWeek: null,
      rowWeek: null,
      paneWeeks: nav.panes,
      lessons: [],
      stats: { tables: 0, orphanRows: 0, layouts: new Set() },
    };
    walk(body, ctx);
    if (!ctx.lessons.length) parseTextStream(body, ctx);

    const lessons = finalize(ctx.lessons);
    const warnings = [];
    if (!lessons.length) warnings.push('Не удалось найти занятия на странице.');
    if (ctx.stats.orphanRows) warnings.push(`Строк без дня недели: ${ctx.stats.orphanRows}.`);
    return {
      title: pageTitle(doc),
      semester: semesterLabel(doc),
      weekHint: currentWeekHint(doc),
      weekLinks: nav.links,
      lessons,
      warnings,
      stats: {
        tables: ctx.stats.tables,
        layouts: [...ctx.stats.layouts],
        lessons: lessons.length,
        withWeek: lessons.filter((l) => l.week).length,
      },
    };
  }

  // Объединяет результаты страниц «только числитель» и «только знаменатель».
  function mergeWeekSplit(numRes, denRes) {
    const denLeft = new Map();
    for (const l of denRes.lessons) {
      const k = lessonKey(l);
      denLeft.set(k, (denLeft.get(k) || []).concat([l]));
    }
    const lessons = [];
    for (const l of numRes.lessons) {
      const k = lessonKey(l);
      const pool = denLeft.get(k);
      if (pool && pool.length && !l.week) {
        pool.shift();
        lessons.push(Object.assign({}, l, { week: null }));
      } else lessons.push(Object.assign({}, l, { week: l.week || 'num' }));
    }
    for (const pool of denLeft.values()) for (const l of pool) lessons.push(Object.assign({}, l, { week: l.week || 'den' }));
    return Object.assign({}, numRes, {
      lessons: finalize(lessons),
      stats: Object.assign({}, numRes.stats, { split: true, lessons: lessons.length, withWeek: lessons.filter((l) => l.week).length }),
    });
  }

  return {
    BELLS,
    parseSchedule,
    mergeWeekSplit,
    parseWeekTypesPage,
    // экспорт для тестов
    _internal: {
      matchDayInfo, parseTimeRange, parseLessonNum, weekFromToken, matchType, isTeacherText,
      isRoomText, extractDates, extractSubgroup, sectionWeekFromText, stripWeekMarkers,
      splitTrailingTeacher, extractInlineType, currentWeekHint, weekFromColor,
    },
  };
});
