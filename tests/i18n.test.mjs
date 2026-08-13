// Тест локализации (src/i18n.js).
//
// Запуск из корня репозитория:
//   node tests/i18n.test.mjs
//
// Через t() полноту переводов не проверить: незнакомый ключ там возвращается сам собой,
// и забытый перевод выглядел бы как исправная строка. Поэтому здесь две сверки поверх
// таблиц напрямую:
//   1. таблицы сверяются между собой — в английской ровно те же ключи, что в русской;
//   2. ключи, которые реально зовёт интерфейс, ищутся в исходниках и сверяются с
//      таблицей. Без этого опечатка в t('editor.sve') прошла бы молча: пользователь
//      увидел бы «editor.sve» вместо кнопки, а тест — ничего.
import { readFile, readdir } from 'node:fs/promises';

const SRC = new URL('../src/', import.meta.url);
const ROOT = new URL('../', import.meta.url);

// i18n.js обращается к SillyTavern только внутри функций, но getLocale() зовётся в
// t() — контекст нужен. Настройки языка подменяем прямо здесь.
let language = 'ru';
globalThis.SillyTavern = {
    getContext: () => ({ extensionSettings: { Imaginy: { language } } }),
};

// i18n логирует предупреждение, когда контекста ST нет вовсе (проверка ниже) —
// в выводе теста этот стек только мешает.
const realConsole = { log: console.log, warn: console.warn, error: console.error };
console.warn = () => {};
console.error = () => {};

const { t, getLocale, resetLocale, tableKeys, LOCALES, DEFAULT_LOCALE, FALLBACK_LOCALE } =
    await import(new URL('i18n.js', SRC).pathname);

const results = [];
function check(name, actual, expected) {
    results.push({ name, ok: Object.is(actual, expected), actual, expected });
}

function setLanguage(code) {
    language = code;
    resetLocale();
}

// ── 1. Таблицы сверяются между собой ───────────────────────────────────────────
{
    const ru = new Set(tableKeys('ru'));
    const en = new Set(tableKeys('en'));

    const missingInEn = [...ru].filter((k) => !en.has(k));
    const extraInEn = [...en].filter((k) => !ru.has(k));

    check(`перевод: нет ключей без английской строки (${missingInEn.join(', ') || '—'})`,
        missingInEn.length, 0);
    check(`перевод: нет английских ключей без русского оригинала (${extraInEn.join(', ') || '—'})`,
        extraInEn.length, 0);
    check('перевод: таблица не пустая', ru.size > 0, true);
}

// ── 2. Ключи, которые зовёт интерфейс, есть в таблицах ─────────────────────────
// Ключи ищем в исходниках по двум формам: t('ключ') и data-i18n="ключ" в settings.html.
// Динамические ключи (t(`editor.field.${field.key}`), t(host.name)) перечислены руками —
// их из текста не вычислить, а забыть перевод в них так же легко.
{
    const files = [];
    for (const name of await readdir(SRC)) {
        if (name.endsWith('.js')) files.push(new URL(name, SRC));
    }
    for (const name of await readdir(new URL('hosts/', SRC))) {
        if (name.endsWith('.js')) files.push(new URL(`hosts/${name}`, SRC));
    }
    files.push(new URL('index.js', ROOT));

    const used = new Set();
    for (const file of files) {
        const text = await readFile(file, 'utf8');
        // i18n.js — сама таблица: её строки не вызовы, а определения.
        if (file.pathname.endsWith('i18n.js')) continue;
        // Ловим любой строковый литерал вида «пространство.ключ» из известных
        // пространств имён, а не только аргумент t(): до t() ключ доезжает и через
        // тернарник (t(ok ? 'toast.promptCopied' : …)), и полем REASONS в профиле хоста.
        for (const m of text.matchAll(/'((?:decorate|editor|toast|regen|settings|host)\.[\w.]+)'/g)) {
            used.add(m[1]);
        }
    }

    const html = await readFile(new URL('settings.html', ROOT), 'utf8');
    for (const m of html.matchAll(/data-i18n="([\w.]+)"/g)) used.add(m[1]);

    // Собираются в коде из частей — глазами в исходнике их не видно.
    for (const key of ['prompt', 'style', 'aspect_ratio']) used.add(`editor.field.${key}`);

    const ru = new Set(tableKeys('ru'));
    const unknown = [...used].filter((k) => !ru.has(k));
    check(`интерфейс: все зовомые ключи есть в таблице (${unknown.join(', ') || '—'})`,
        unknown.length, 0);
    check('интерфейс: ключи вообще нашлись', used.size > 20, true);

    // Обратная сторона: ключ в таблице, который никто не зовёт, — это либо опечатка,
    // либо строка, пережившая свой интерфейс. И то и другое лучше заметить.
    const orphans = [...ru].filter((k) => !used.has(k));
    check(`таблица: нет ключей, которых никто не зовёт (${orphans.join(', ') || '—'})`,
        orphans.length, 0);
}

// ── 3. Выбор языка ─────────────────────────────────────────────────────────────
{
    setLanguage('ru');
    check('язык: русский из настройки', getLocale(), 'ru');
    check('язык: русская строка', t('editor.save'), 'Сохранить');

    setLanguage('en');
    check('язык: английский из настройки', getLocale(), 'en');
    check('язык: английская строка', t('editor.save'), 'Save');

    // Незнакомый код — английский: притворяться, что интерфейс переведён, нельзя.
    setLanguage('de');
    check('язык: незнакомый код → английский', getLocale(), FALLBACK_LOCALE);

    // 'ru-RU' и 'ru_RU' — тот же русский.
    setLanguage('ru-RU');
    check('язык: код с регионом', getLocale(), 'ru');

    check('язык: список локалей', LOCALES.join(','), 'ru,en');
    check('язык: оригинал — русский', DEFAULT_LOCALE, 'ru');
}

// ── 4. Незнакомый ключ и подстановка ───────────────────────────────────────────
{
    setLanguage('ru');
    check('ключ: незнакомый возвращается сам собой', t('editor.nosuchkey'), 'editor.nosuchkey');
    check('ключ: подстановка параметра',
        t('editor.title', { host: 'SLAY Images' }), 'Редактирование промпта — SLAY Images');
    // Потерянный параметр оставляет плейсхолдер: пустое место выглядело бы как
    // испорченный перевод, а видимый {host} показывает, где именно потеряли значение.
    check('ключ: без параметра плейсхолдер остаётся',
        t('editor.title'), 'Редактирование промпта — {host}');

    setLanguage('en');
    check('ключ: подстановка работает и в переводе',
        t('editor.history.was', { preview: 'a cat' }), 'Before: “a cat”');
}

// ── 5. Автовыбор языка от таверны ──────────────────────────────────────────────
// Настройка 'auto' означает «как в SillyTavern». getCurrentLocale есть не во всех
// версиях ST, поэтому проверяем и его, и то, что без него ничего не падает.
{
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: { Imaginy: { language: 'auto' } },
            getCurrentLocale: () => 'ru-RU',
        }),
    };
    resetLocale();
    check('авто: язык взят у таверны', getLocale(), 'ru');

    globalThis.SillyTavern = {
        getContext: () => ({ extensionSettings: { Imaginy: { language: 'auto' } } }),
    };
    resetLocale();
    check('авто: без getCurrentLocale язык всё равно определён',
        LOCALES.includes(getLocale()), true);

    // Контекст может быть недоступен вовсе (модуль загрузился раньше ST).
    globalThis.SillyTavern = {
        getContext: () => { throw new Error('нет контекста'); },
    };
    resetLocale();
    check('авто: без контекста t() не падает', typeof t('editor.save'), 'string');
}

Object.assign(console, realConsole);

let failed = 0;
for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ожидалось ${JSON.stringify(r.expected)}, получено ${JSON.stringify(r.actual)}`}`);
}
console.log(`\n${results.length - failed}/${results.length} проверок прошло`);
process.exit(failed ? 1 : 0);
