const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const P = require('../src/renderer/lib/parser.js');
const W = require('../src/renderer/lib/weeks.js');

function load(name) {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  return new JSDOM(html).window.document;
}

function find(res, day, subject) {
  return res.lessons.filter((l) => l.day === day && l.subject === subject);
}

test('таблица «строка — занятие» с колонкой Ч/З и rowspan времени', () => {
  const res = P.parseSchedule(load('rows-bootstrap.html'));
  assert.equal(res.title, 'ПИ(б) - 41');
  assert.equal(res.semester, '2026-2027 осенний семестр');
  assert.deepEqual(res.weekHint, { type: 'den', week: 6 });
  assert.equal(res.weekLinks.num, '?semester_id=33&weektype=1');
  assert.equal(res.weekLinks.den, '?semester_id=33&weektype=2');

  const [db] = find(res, 0, 'Базы данных');
  assert.equal(db.start, '08:30');
  assert.equal(db.end, '10:00');
  assert.equal(db.week, null);
  assert.equal(db.type, 'Лекция');
  assert.deepEqual(db.rooms, ['504']);
  assert.deepEqual(db.teachers, ['Иванов И.И.']);

  const [os] = find(res, 0, 'Операционные системы');
  assert.equal(os.week, 'num');
  assert.equal(os.start, '10:10');
  assert.deepEqual(os.rooms, ['214л']);

  const [net] = find(res, 0, 'Компьютерные сети');
  assert.equal(net.week, 'den');
  assert.equal(net.start, '10:10', 'время наследуется из ячейки с rowspan');
  assert.equal(net.type, 'Практика');

  const lang = find(res, 1, 'Иностранный язык');
  assert.equal(lang.length, 2);
  assert.deepEqual(lang.map((l) => l.subgroup).sort(), [1, 2]);

  // пустая строка «З» у физкультуры не превращается в занятие
  const pe = res.lessons.filter((l) => l.day === 1 && l.start === '13:50');
  assert.equal(pe.length, 1);
  assert.equal(pe[0].week, 'num');

  const [ma] = find(res, 2, 'Математический анализ');
  assert.deepEqual(ma.rooms, ['Дистанционно']);
});

test('сетка «пары × дни» с блоками числителя/знаменателя в ячейке', () => {
  const res = P.parseSchedule(load('grid-days.html'));
  assert.equal(res.title, 'ИСТ(б) - 31');
  const mon1 = res.lessons.filter((l) => l.day === 0 && l.num === 1);
  assert.deepEqual(mon1.map((l) => [l.subject, l.week, l.rooms[0]]), [
    ['Алгоритмы', 'num', '214л'],
    ['Дискретная математика', 'den', '301ц'],
  ]);
  const [hist] = find(res, 0, 'История России');
  assert.equal(hist.type, 'Лекция');
  assert.equal(hist.start, '10:10');

  const [proj] = find(res, 2, 'Проектный практикум');
  assert.equal(proj.type, 'Лабораторная');
  assert.equal(proj.end, '11:40', 'rowspan=2 продлевает пару');

  const thu = res.lessons.filter((l) => l.day === 3 && l.num === 1);
  assert.deepEqual(thu.map((l) => [l.subject, l.week, l.teachers[0], l.rooms[0]]), [
    ['Физика', 'num', 'Орлов О.О.', '120л'],
    ['Химия', 'den', 'Белова Б.Б.', '121л'],
  ]);
  const [eng] = find(res, 3, 'Английский язык');
  assert.equal(eng.subgroup, 2);
  assert.deepEqual(eng.teachers, ['Smith J.']);
});

test('секции «Неделя по числителю / знаменателю»', () => {
  const res = P.parseSchedule(load('sections.html'));
  const ped = find(res, 0, 'Педагогика');
  assert.equal(ped.length, 1, 'одинаковая пара в обеих секциях схлопывается');
  assert.equal(ped[0].week, null);
  assert.equal(find(res, 0, 'Психология')[0].week, 'num');
  assert.equal(find(res, 0, 'Возрастная анатомия')[0].week, 'den');
  assert.equal(find(res, 1, 'Методика обучения')[0].week, 'num');
});

test('вёрстка без таблиц', () => {
  const res = P.parseSchedule(load('divs.html'));
  assert.equal(res.lessons.length, 3);
  const [stat] = find(res, 0, 'Статистика');
  assert.equal(stat.week, 'num');
  assert.equal(stat.type, 'Практика');
  const [mgmt] = find(res, 1, 'Менеджмент');
  assert.deepEqual(mgmt.dates.to, { y: null, m: 10, d: 20 });
  assert.ok(!mgmt.notes.some((n) => n.includes('©')));
});

test('объединение отдельных страниц числителя и знаменателя', () => {
  const mk = (rows) => `<table><tr><th>Время</th><th>Дисциплина</th><th>Аудитория</th></tr>
    <tr><th colspan="3">Понедельник</th></tr>${rows}</table>`;
  const num = P.parseSchedule(new JSDOM(mk(
    '<tr><td>08:30-10:00</td><td>Математика</td><td>101</td></tr><tr><td>10:10-11:40</td><td>Физика</td><td>202</td></tr>'
  )).window.document);
  const den = P.parseSchedule(new JSDOM(mk(
    '<tr><td>08:30-10:00</td><td>Математика</td><td>101</td></tr><tr><td>10:10-11:40</td><td>Химия</td><td>303</td></tr>'
  )).window.document);
  const merged = P.mergeWeekSplit(num, den);
  const map = Object.fromEntries(merged.lessons.map((l) => [l.subject, l.week]));
  assert.deepEqual(map, { 'Математика': null, 'Физика': 'num', 'Химия': 'den' });
});

test('маркер недели в одной строке с предметом', () => {
  const doc = new JSDOM(`<table><tr><th colspan="2">Четверг</th></tr>
    <tr><td>08:30-10:00</td><td><span class="danger">Ч</span> Математика<br>ауд. 101</td></tr>
    <tr><td>10:10-11:40</td><td>З: Физика (пр.)<br>Петров П.П.<br>ауд. 202</td></tr></table>`).window.document;
  const res = P.parseSchedule(doc);
  assert.deepEqual(res.lessons.map((l) => [l.subject, l.week, l.rooms[0]]), [
    ['Математика', 'num', '101'],
    ['Физика', 'den', '202'],
  ]);
});

test('страница «Расписание недель»', () => {
  const doc = load('weektypes.html');
  assert.equal(P.parseWeekTypesPage(doc, new Date(2026, 9, 4)).type, 'num');
  assert.equal(P.parseWeekTypesPage(doc, new Date(2026, 9, 6)).type, 'den');
  assert.equal(P.parseWeekTypesPage(doc, new Date(2026, 9, 12)).type, 'num');
  assert.equal(P.parseWeekTypesPage(doc, new Date(2026, 10, 30)), null);
});

test('распознавание отдельных полей', () => {
  const I = P._internal;
  assert.deepEqual(I.matchDayInfo('Понедельник'), { day: 0, week: null });
  assert.deepEqual(I.matchDayInfo('Среда, 07.10.2026'), { day: 2, week: null });
  assert.deepEqual(I.matchDayInfo('06.10.2026 (вторник)'), { day: 1, week: null });
  assert.deepEqual(I.matchDayInfo('Пт'), { day: 4, week: null });
  assert.equal(I.matchDayInfo('Среда программирования'), null);
  assert.equal(I.matchDayInfo('Четверговая соль'), null);

  assert.deepEqual(I.parseTimeRange('08:30 - 10:00'), { start: '08:30', end: '10:00' });
  assert.deepEqual(I.parseTimeRange('8.30–10.00'), { start: '08:30', end: '10:00' });
  assert.deepEqual(I.parseTimeRange('08:30 10:00'), { start: '08:30', end: '10:00' });

  assert.equal(I.weekFromToken('Ч'), 'num');
  assert.equal(I.weekFromToken('знам.'), 'den');
  assert.equal(I.weekFromToken('числитель'), 'num');
  assert.equal(I.weekFromToken('четверг'), null);

  assert.equal(I.matchType('Лабораторная работа').label, 'Лабораторная');
  assert.equal(I.matchType('пр.').label, 'Практика');
  assert.equal(I.matchType('Проектный практикум, лаб.'), null);

  assert.ok(I.isTeacherText('доц. Иванов И.И.'));
  assert.ok(I.isTeacherText('Иванов Иван Иванович'));
  assert.ok(!I.isTeacherText('Математический анализ'));

  for (const r of ['214л', 'ауд. 504', '310пх', 'Л-214', 'Спортзал', 'Дистанционно']) assert.ok(I.isRoomText(r), r);
  for (const r of ['1', 'Физика', '12']) assert.ok(!I.isRoomText(r), r);

  assert.equal(I.extractSubgroup('Английский язык (2 подгр.)').subgroup, 2);
  assert.equal(I.extractSubgroup('подгруппа 1').subgroup, 1);

  assert.equal(I.weekFromColor({ getAttribute: (n) => (n === 'style' ? 'background-color: #f2dede' : null) }), 'num');
  assert.equal(I.weekFromColor({ getAttribute: (n) => (n === 'style' ? 'background: #d9edf7' : null) }), 'den');
  assert.equal(I.weekFromColor({ getAttribute: (n) => (n === 'style' ? 'background: #f5f5f5' : null) }), null);
});

test('числитель/знаменатель по датам', () => {
  // 1 сентября 2026 — вторник; неделя 31.08–06.09 — первая (числитель)
  const anchor = W.defaultAnchor(new Date(2026, 9, 5));
  assert.equal(anchor.monday, '2026-08-31');
  assert.equal(W.weekTypeFor(new Date(2026, 8, 1), anchor), 'num');
  assert.equal(W.weekTypeFor(new Date(2026, 8, 7), anchor), 'den');
  assert.equal(W.weekTypeFor(new Date(2026, 9, 6), anchor), 'den');
  assert.equal(W.academicWeekNumber(new Date(2026, 9, 6)), 6);
  // переход через смену часового пояса/года не ломает чётность
  assert.equal(W.weekTypeFor(new Date(2027, 1, 15), anchor), W.weekTypeFor(new Date(2027, 1, 1), anchor));

  const site = W.resolveAnchor({ today: new Date(2026, 9, 5), hint: { type: 'num' } });
  assert.equal(site.source, 'site');
  assert.equal(W.weekTypeFor(new Date(2026, 9, 6), site), 'num');
  assert.equal(W.weekTypeFor(new Date(2026, 9, 12), site), 'den');

  const manual = W.resolveAnchor({ today: new Date(2026, 9, 5), override: { monday: '2026-10-05', type: 'den' }, hint: { type: 'num' } });
  assert.equal(manual.source, 'manual');
  assert.equal(W.weekTypeFor(new Date(2026, 9, 7), manual), 'den');
});

test('выборка занятий на день с учётом недели, подгруппы и дат', () => {
  const res = P.parseSchedule(load('rows-bootstrap.html'));
  const mon = new Date(2026, 9, 5);
  assert.deepEqual(W.lessonsFor(res.lessons, mon, { weekType: 'den' }).map((l) => l.subject), ['Базы данных', 'Компьютерные сети']);
  assert.deepEqual(W.lessonsFor(res.lessons, mon, { weekType: 'num' }).map((l) => l.subject), ['Базы данных', 'Операционные системы']);
  const tue = new Date(2026, 9, 6);
  assert.equal(W.lessonsFor(res.lessons, tue, { weekType: 'den', subgroup: 2 }).length, 1);
  assert.equal(W.lessonsFor(res.lessons, tue, { weekType: 'num' }).length, 3);

  const divs = P.parseSchedule(load('divs.html'));
  assert.equal(W.lessonsFor(divs.lessons, new Date(2026, 9, 6), {}).length, 1, 'до 20.10 — есть');
  assert.equal(W.lessonsFor(divs.lessons, new Date(2026, 9, 27), {}).length, 0, 'после 20.10 — нет');
});
