// Тест настроек Imaginy (src/settings.js) под jsdom: мерж значений по умолчанию,
// сборка панели из settings.html, чекбоксы, поле «Запомненный стиль» и его обновление
// извне.
//
// Запуск из корня репозитория:
//   npm install --no-save jsdom
//   node tests/settings.test.mjs
//
// jQuery в зависимостях нет и не будет: settings.js использует всего пять методов
// ($.get, .val, .prop, .on, .append), поэтому здесь стоит минимальный мок поверх
// НАСТОЯЩЕГО DOM из jsdom — узлы одни и те же, и document.getElementById внутри
// refreshLastStyleField видит ровно то, что вставила панель. toastr тоже мок:
// src/ctx.js зовёт его через амбиентную глобаль.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const SRC = new URL('../src/', import.meta.url).pathname;
const SETTINGS_HTML = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');

const dom = new JSDOM('<body><div id="extensions_settings"></div></body>', { url: 'http://localhost' });
global.window = dom.window;
global.document = dom.window.document;
global.Element = dom.window.Element;

// ── контекст SillyTavern ────────────────────────────────────────────────────────
let extensionSettings = {};
let savedCount = 0;
global.SillyTavern = {
    getContext: () => ({
        extensionSettings,
        chat: [],
        eventSource: { on() {} },
        event_types: {},
        saveSettingsDebounced() {
            savedCount++;
        },
    }),
};

// ── мок toastr ──────────────────────────────────────────────────────────────────
let toasts = [];
global.toastr = {
    success(message, title) {
        toasts.push({ kind: 'success', message, title });
    },
    info(message, title) {
        toasts.push({ kind: 'info', message, title });
    },
    warning(message, title) {
        toasts.push({ kind: 'warning', message, title });
    },
    error(message, title) {
        toasts.push({ kind: 'error', message, title });
    },
};

// ── мок jQuery ──────────────────────────────────────────────────────────────────
// Пустая выборка обязана вести себя как в jQuery — молча ничего не делать: на этом
// держится устойчивость панели к отсутствию разметки.
let getCalls = [];
let getShouldFail = false;

function wrap(nodes) {
    const api = {
        nodes,
        length: nodes.length,
        val(value) {
            if (value === undefined) return nodes[0] ? nodes[0].value : undefined;
            for (const n of nodes) n.value = value;
            return api;
        },
        prop(name, value) {
            if (value === undefined) return nodes[0] ? nodes[0][name] : undefined;
            for (const n of nodes) n[name] = value;
            return api;
        },
        text(value) {
            if (value === undefined) return nodes.map((n) => n.textContent).join('');
            for (const n of nodes) n.textContent = value;
            return api;
        },
        on(event, handler) {
            for (const n of nodes) n.addEventListener(event, handler);
            return api;
        },
        append(html) {
            for (const n of nodes) n.insertAdjacentHTML('beforeend', html);
            return api;
        },
    };
    return api;
}

const $ = (selector) => {
    if (!selector) return wrap([]);
    if (typeof selector !== 'string') return wrap([selector]);
    return wrap([...document.querySelectorAll(selector)]);
};
$.get = async (url) => {
    getCalls.push(url);
    if (getShouldFail) throw new Error('404 settings.html');
    return SETTINGS_HTML;
};
global.$ = $;

const settings = await import(`${SRC}settings.js`);
const { MODULE_NAME, DEFAULT_SETTINGS, getSettings, saveSettings, initSettingsUI, refreshLastStyleField } = settings;

const results = [];
function check(name, actual, expected) {
    results.push({ name, ok: actual === expected, actual, expected });
}

// Возвращает панель в исходное состояние: чистый DOM, пустые настройки, обнулённые
// счётчики. Между сценариями это обязательно — обработчики висят на узлах, и старые
// узлы должны уходить вместе с ними.
function reset(initial = {}) {
    document.body.innerHTML = '<div id="extensions_settings"></div>';
    extensionSettings = initial;
    savedCount = 0;
    toasts = [];
    getCalls = [];
    getShouldFail = false;
}

function fire(id, type) {
    const el = document.getElementById(id);
    el.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
}

// ── 1. getSettings ──────────────────────────────────────────────────────────────
{
    reset({});
    const s = getSettings();
    check('getSettings: объект создан в extensionSettings', extensionSettings[MODULE_NAME] === s, true);
    check('getSettings: имя ключа', MODULE_NAME, 'Imaginy');
    check(
        'getSettings: набор ключей как в DEFAULT_SETTINGS',
        JSON.stringify(Object.keys(s).sort()),
        JSON.stringify(Object.keys(DEFAULT_SETTINGS).sort()),
    );
    check('getSettings: enabled по умолчанию', s.enabled, true);
    check('getSettings: showEditButton по умолчанию', s.showEditButton, true);
    check('getSettings: regenerateAfterSave по умолчанию', s.regenerateAfterSave, false);
    check('getSettings: syncImageSrc по умолчанию', s.syncImageSrc, true);
    check('getSettings: lastStyle по умолчанию', s.lastStyle, '');
    check('getSettings: клон, а не сам DEFAULT_SETTINGS', s === DEFAULT_SETTINGS, false);
    check('getSettings: DEFAULT_SETTINGS заморожен', Object.isFrozen(DEFAULT_SETTINGS), true);

    // Живой объект: правка снаружи видна при следующем обращении.
    s.lastStyle = 'oil painting';
    check('getSettings: возвращает живой объект', getSettings().lastStyle, 'oil painting');

    // Порча DEFAULT_SETTINGS через возвращённый объект невозможна.
    check('getSettings: DEFAULT_SETTINGS не испорчен мутацией', DEFAULT_SETTINGS.lastStyle, '');
}

{
    // Апгрейд: в настройках лежит объект «старой версии» без части ключей.
    reset({ [MODULE_NAME]: { enabled: false, showEditButton: true } });
    const s = getSettings();
    check('апгрейд: недостающий syncImageSrc домержен', s.syncImageSrc, true);
    check('апгрейд: недостающий lastStyle домержен', s.lastStyle, '');
    check('апгрейд: недостающий regenerateAfterSave домержен', s.regenerateAfterSave, false);
    check('апгрейд: существующее значение не затёрто', s.enabled, false);
    check('апгрейд: объект тот же самый (не пересоздан)', extensionSettings[MODULE_NAME] === s, true);
}

{
    // Ложные, но осмысленные значения не должны подменяться дефолтами: мерж идёт по
    // Object.hasOwn, а не по ?? / ||.
    reset({ [MODULE_NAME]: { enabled: false, showEditButton: false, regenerateAfterSave: false, syncImageSrc: false, lastStyle: '' } });
    const s = getSettings();
    check('мерж: syncImageSrc=false сохранён', s.syncImageSrc, false);
    check('мерж: showEditButton=false сохранён', s.showEditButton, false);
    check('мерж: пустой lastStyle сохранён', s.lastStyle, '');
}

{
    // Чужие ключи (например, от будущей версии) мерж не выбрасывает.
    reset({ [MODULE_NAME]: { customKey: 42 } });
    const s = getSettings();
    check('мерж: чужой ключ сохранён', s.customKey, 42);
    check('мерж: свои ключи добавлены', s.enabled, true);
}

// ── 2. saveSettings ─────────────────────────────────────────────────────────────
{
    reset({});
    saveSettings();
    check('saveSettings: зовёт saveSettingsDebounced', savedCount, 1);
    saveSettings();
    saveSettings();
    check('saveSettings: зовётся каждый раз', savedCount, 3);
}

// ── 3. initSettingsUI: сборка панели и чекбоксы ─────────────────────────────────
{
    reset({ [MODULE_NAME]: { enabled: false, showEditButton: true, regenerateAfterSave: true, syncImageSrc: false, lastStyle: 'ink' } });
    const changed = [];
    await initSettingsUI((s) => changed.push(s));

    check('initUI: settings.html запрошен один раз', getCalls.length, 1);
    check('initUI: путь на уровень выше src/', /\/settings\.html$/.test(getCalls[0]), true);
    check('initUI: путь не содержит src/', getCalls[0].includes('/src/'), false);
    check(
        'initUI: разметка вставлена в #extensions_settings',
        !!document.querySelector('#extensions_settings .imaginy-settings'),
        true,
    );

    check('initUI: enabled по настройкам', document.getElementById('imaginy_enabled').checked, false);
    check('initUI: showEditButton по настройкам', document.getElementById('imaginy_show_edit_button').checked, true);
    check('initUI: regenerateAfterSave по настройкам', document.getElementById('imaginy_regenerate_after_save').checked, true);
    check('initUI: syncImageSrc по настройкам', document.getElementById('imaginy_sync_image_src').checked, false);
    check('initUI: имя хоста подписано', document.getElementById('imaginy_host_name').textContent.length > 0, true);

    // enabled — с уведомлением decorate.js.
    savedCount = 0;
    document.getElementById('imaginy_enabled').checked = true;
    fire('imaginy_enabled', 'change');
    check('чекбокс enabled: записан в настройки', getSettings().enabled, true);
    check('чекбокс enabled: настройки сохранены', savedCount, 1);
    check('чекбокс enabled: onSettingsChanged вызван', changed.length, 1);
    check('чекбокс enabled: колбэк получил живые настройки', changed[0] === getSettings(), true);

    // showEditButton — тоже с уведомлением.
    document.getElementById('imaginy_show_edit_button').checked = false;
    fire('imaginy_show_edit_button', 'change');
    check('чекбокс showEditButton: записан в настройки', getSettings().showEditButton, false);
    check('чекбокс showEditButton: onSettingsChanged вызван', changed.length, 2);

    // regenerateAfterSave и syncImageSrc перерисовку не требуют — колбэк молчит.
    document.getElementById('imaginy_regenerate_after_save').checked = false;
    fire('imaginy_regenerate_after_save', 'change');
    check('чекбокс regenerateAfterSave: записан в настройки', getSettings().regenerateAfterSave, false);
    check('чекбокс regenerateAfterSave: onSettingsChanged НЕ вызван', changed.length, 2);

    document.getElementById('imaginy_sync_image_src').checked = true;
    fire('imaginy_sync_image_src', 'change');
    check('чекбокс syncImageSrc: записан в настройки', getSettings().syncImageSrc, true);
    check('чекбокс syncImageSrc: onSettingsChanged НЕ вызван', changed.length, 2);
    check('чекбоксы: каждое изменение сохраняется', savedCount, 4);
}

{
    // Без колбэка (?.) панель обязана работать так же.
    reset({});
    await initSettingsUI();
    document.getElementById('imaginy_enabled').checked = false;
    fire('imaginy_enabled', 'change');
    check('initUI без колбэка: изменение применилось', getSettings().enabled, false);
}

// ── 4. Поле «Запомненный стиль» ─────────────────────────────────────────────────
{
    reset({ [MODULE_NAME]: { lastStyle: 'watercolor, soft light' } });
    await initSettingsUI();
    const field = document.getElementById('imaginy_last_style');
    check('lastStyle: текущее значение подставлено', field.value, 'watercolor, soft light');

    savedCount = 0;
    field.value = 'oil painting';
    fire('imaginy_last_style', 'input');
    check('lastStyle: ввод записан в настройки', getSettings().lastStyle, 'oil painting');
    check('lastStyle: ввод сохранён', savedCount, 1);

    // В настройки кладётся тримленое значение — то же, что пишет редактор
    // (rememberStyle). Само поле не переписывается, чтобы не дёргать курсор.
    field.value = '  oil  ';
    fire('imaginy_last_style', 'input');
    check('lastStyle: в настройки записано тримленое', getSettings().lastStyle, 'oil');
    check('lastStyle: поле ввода не переписано', field.value, '  oil  ');

    // Стиль из одних пробелов равносилен пустому: редактор требует
    // lastStyle.trim().length > 0, иначе он лежал бы в настройках мёртвым грузом.
    field.value = '   ';
    fire('imaginy_last_style', 'input');
    check('lastStyle: значение из пробелов равно пустому', getSettings().lastStyle, '');

    // «Забыть» — чистит и поле, и настройку, и показывает тост.
    savedCount = 0;
    fire('imaginy_forget_style', 'click');
    check('Забыть: поле очищено', field.value, '');
    check('Забыть: настройка очищена', getSettings().lastStyle, '');
    check('Забыть: настройки сохранены', savedCount, 1);
    check('Забыть: тост показан', toasts.length, 1);
    check('Забыть: тип тоста', toasts[0]?.kind, 'success');
    check('Забыть: текст тоста', toasts[0]?.message, 'Запомненный стиль забыт');
    check('Забыть: заголовок тоста', toasts[0]?.title, 'Imaginy');
}

{
    // lastStyle отсутствует в настройках вовсе — поле должно быть пустым, не "undefined".
    reset({ [MODULE_NAME]: { enabled: true } });
    await initSettingsUI();
    check('lastStyle: отсутствующее значение → пустое поле', document.getElementById('imaginy_last_style').value, '');
}

// ── 5. refreshLastStyleField ────────────────────────────────────────────────────
{
    reset({ [MODULE_NAME]: { lastStyle: 'first' } });
    await initSettingsUI();
    const field = document.getElementById('imaginy_last_style');
    check('refresh: стартовое значение', field.value, 'first');

    // Редактор поменял lastStyle мимо панели.
    getSettings().lastStyle = 'second';
    check('refresh: до вызова поле устаревшее', field.value, 'first');
    refreshLastStyleField();
    check('refresh: поле обновлено', field.value, 'second');

    // Стиль забыли в редакторе — поле чистится.
    getSettings().lastStyle = '';
    refreshLastStyleField();
    check('refresh: пустое значение чистит поле', field.value, '');

    // Поле в фокусе — пользователь печатает, затирать нельзя.
    field.focus();
    check('refresh: поле действительно в фокусе', document.activeElement === field, true);
    field.value = 'печатаю прямо сейчас';
    getSettings().lastStyle = 'извне';
    refreshLastStyleField();
    check('refresh: ввод в фокусе не затёрт', field.value, 'печатаю прямо сейчас');

    // Фокус ушёл — обновление снова разрешено.
    field.blur();
    refreshLastStyleField();
    check('refresh: после blur обновление проходит', field.value, 'извне');

    // lastStyle === undefined → пустая строка, а не "undefined".
    delete extensionSettings[MODULE_NAME].lastStyle;
    // getSettings домержит ключ обратно, поэтому подменяем значение напрямую после мержа.
    extensionSettings[MODULE_NAME].lastStyle = undefined;
    refreshLastStyleField();
    check('refresh: undefined → пустая строка', field.value, '');
}

{
    // Элемента нет — тихий выход без исключения.
    reset({ [MODULE_NAME]: { lastStyle: 'x' } });
    let threw = false;
    try {
        refreshLastStyleField();
    } catch {
        threw = true;
    }
    check('refresh: без элемента не бросает', threw, false);
    check('refresh: без элемента ничего не создаёт', document.getElementById('imaginy_last_style'), null);
}

// ── 6. Язык интерфейса ──────────────────────────────────────────────────────────
// Панель — единственное место, где язык выбирают руками, и единственное, что
// перерисовывается сразу: редактор возьмёт новый язык при следующем открытии.
{
    reset({});
    await initSettingsUI(() => {});

    check('язык: по умолчанию «как в SillyTavern»', getSettings().language, 'auto');
    check('язык: селектор показывает то же', document.getElementById('imaginy_language').value, 'auto');

    const label = () => document.querySelector('[data-i18n="settings.enabled"]').textContent;

    document.getElementById('imaginy_language').value = 'ru';
    fire('imaginy_language', 'change');
    check('язык: русский записан в настройки', getSettings().language, 'ru');
    check('язык: подпись по-русски', label(), 'Включить Imaginy');

    document.getElementById('imaginy_language').value = 'en';
    fire('imaginy_language', 'change');
    check('язык: английский записан в настройки', getSettings().language, 'en');
    check('язык: подпись переведена', label(), 'Enable Imaginy');
    check('язык: настройки сохранены', savedCount > 0, true);

    // Перевод панели проходит по всем подписям сразу, включая имя хоста — а его
    // пишет отдельный код, и заглушка «определяется…» не должна остаться на экране.
    check('язык: имя хоста не затёрто заглушкой',
        document.getElementById('imaginy_host_name').textContent === 'detecting…', false);
}

{
    // Сохранённый язык поднимается в селектор при следующей сборке панели.
    reset({ Imaginy: { language: 'en' } });
    await initSettingsUI(() => {});
    check('язык: селектор восстановлен из настроек',
        document.getElementById('imaginy_language').value, 'en');
    check('язык: панель сразу на нужном языке',
        document.querySelector('[data-i18n="settings.enabled"]').textContent, 'Enable Imaginy');
}

// ── 7. Устойчивость ─────────────────────────────────────────────────────────────
{
    // settings.html не загрузился — initSettingsUI обязана вернуться штатно.
    reset({});
    getShouldFail = true;
    let threw = false;
    try {
        await initSettingsUI(() => {});
    } catch {
        threw = true;
    }
    check('провал загрузки: не бросает наружу', threw, false);
    check('провал загрузки: панель не вставлена', document.querySelector('.imaginy-settings'), null);
    check('провал загрузки: настройки не тронуты', extensionSettings[MODULE_NAME], undefined);
}

{
    // Разметка пришла пустой: ни одного ожидаемого элемента нет. Все .prop/.on/.val
    // должны отработать как пустая выборка jQuery, а bindLastStyle — не уронить панель.
    reset({});
    const originalGet = $.get;
    $.get = async () => '<div class="imaginy-settings"></div>';
    let threw = false;
    try {
        await initSettingsUI(() => {});
    } catch {
        threw = true;
    }
    $.get = originalGet;
    check('пустая разметка: не бросает', threw, false);
    check('пустая разметка: настройки всё равно созданы', getSettings().enabled, true);
    check('пустая разметка: панель вставлена', !!document.querySelector('.imaginy-settings'), true);
}

{
    // #extensions_settings в DOM нет (панель расширений ещё не отрисована). jQuery в
    // этом случае просто ничего не вставляет — и настройки остаются несобранными, но
    // исключения быть не должно.
    reset({});
    document.body.innerHTML = '';
    let threw = false;
    try {
        await initSettingsUI(() => {});
    } catch {
        threw = true;
    }
    check('нет #extensions_settings: не бросает', threw, false);
    check('нет #extensions_settings: разметки нет', document.querySelector('.imaginy-settings'), null);
}

{
    // Повторный вызов (ST умеет переинициализировать расширения) не должен ломаться;
    // фиксируем текущее поведение: панель вставляется второй раз.
    reset({});
    await initSettingsUI(() => {});
    await initSettingsUI(() => {});
    check('повторный init: панелей стало две', document.querySelectorAll('.imaginy-settings').length, 2);
}

let failed = 0;
for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ожидалось ${JSON.stringify(r.expected)}, получено ${JSON.stringify(r.actual)}`}`);
}
console.log(`\n${results.length - failed}/${results.length} проверок прошло`);
process.exit(failed ? 1 : 0);
