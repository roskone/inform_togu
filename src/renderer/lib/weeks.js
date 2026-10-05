/*
 * Даты, числитель/знаменатель и выборка занятий на конкретный день.
 *
 * В ТОГУ числитель — нечётная неделя, считая от недели с 1 сентября,
 * знаменатель — чётная. Если на странице есть явная подсказка
 * («сейчас идёт … знаменатель») или пользователь выбрал тип недели вручную,
 * используется она.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RaspWeeks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_MS = 86400000;

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function addDays(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  }

  // Пн = 0 … Вс = 6
  function dayIndex(d) {
    return (d.getDay() + 6) % 7;
  }

  function mondayOf(d) {
    return addDays(startOfDay(d), -dayIndex(d));
  }

  function toISO(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function fromISO(s) {
    const [y, m, d] = String(s).split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  // Разница в неделях между понедельниками (без влияния перевода часов).
  function weeksBetween(a, b) {
    const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((ub - ua) / (7 * DAY_MS));
  }

  function academicYearStart(d) {
    const y = d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1; // с августа — новый учебный год
    return new Date(y, 8, 1);
  }

  function flip(t) {
    return t === 'num' ? 'den' : 'num';
  }

  // Номер учебной недели (неделя с 1 сентября — первая).
  function academicWeekNumber(d) {
    return weeksBetween(mondayOf(academicYearStart(d)), mondayOf(d)) + 1;
  }

  // anchor: { monday: 'YYYY-MM-DD', type: 'num'|'den' }
  function weekTypeFromAnchor(date, anchor) {
    const diff = weeksBetween(fromISO(anchor.monday), mondayOf(date));
    return Math.abs(diff) % 2 === 0 ? anchor.type : flip(anchor.type);
  }

  function defaultAnchor(date) {
    return { monday: toISO(mondayOf(academicYearStart(date))), type: 'num', source: 'rule' };
  }

  /*
   * Выбирает «якорь» для расчёта недели:
   *   override — ручная настройка пользователя { monday, type };
   *   hint — подсказка со страницы { type }, относится к неделе hintDate.
   */
  function resolveAnchor({ today, override, hint, hintDate }) {
    if (override && override.monday && override.type) return Object.assign({ source: 'manual' }, override);
    if (hint && hint.type) return { monday: toISO(mondayOf(hintDate || today)), type: hint.type, source: 'site' };
    return defaultAnchor(today);
  }

  function weekTypeFor(date, anchor) {
    return weekTypeFromAnchor(date, anchor || defaultAnchor(date));
  }

  // ───────────── ограничения по датам («с 01.09 по 20.12», «только 06.10») ─────────────

  function tokenToDate(tok, ref) {
    if (!tok) return null;
    let y = tok.y;
    if (!y) {
      const start = academicYearStart(ref);
      y = tok.m >= 8 ? start.getFullYear() : start.getFullYear() + 1;
    }
    return new Date(y, tok.m - 1, tok.d);
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function matchesDates(dates, date) {
    if (!dates) return true;
    const d = startOfDay(date);
    if (dates.only && dates.only.length) {
      return dates.only.some((t) => sameDay(tokenToDate(t, d), d));
    }
    if (dates.from && d < tokenToDate(dates.from, d)) return false;
    if (dates.to && d > tokenToDate(dates.to, d)) return false;
    if (dates.except && dates.except.some((t) => sameDay(tokenToDate(t, d), d))) return false;
    return true;
  }

  // ───────────────────────────── выборка ─────────────────────────────

  function lessonsFor(lessons, date, { weekType, subgroup } = {}) {
    const di = dayIndex(date);
    return (lessons || [])
      .filter((l) => l.day === di)
      .filter((l) => !l.week || !weekType || l.week === weekType)
      .filter((l) => !subgroup || !l.subgroup || l.subgroup === subgroup)
      .filter((l) => matchesDates(l.dates, date))
      .sort((a, b) => String(a.start).localeCompare(String(b.start)) || (a.subgroup || 0) - (b.subgroup || 0));
  }

  function minutesOf(t) {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }

  return {
    startOfDay, addDays, dayIndex, mondayOf, toISO, fromISO, weeksBetween, academicYearStart,
    academicWeekNumber, weekTypeFor, weekTypeFromAnchor, defaultAnchor, resolveAnchor,
    matchesDates, lessonsFor, minutesOf, flip,
  };
});
