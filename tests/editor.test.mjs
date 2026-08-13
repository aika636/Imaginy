// Тест модального редактора промпта (src/editor.js) под jsdom.
//
// Запуск из корня репозитория:
//   npm install --no-save jsdom
//   node tests/editor.test.mjs
//
// Редактор рисует собственный оверлей .imaginy-modal-overlay (а не popup хоста),
// поэтому под jsdom он проверяется целиком: openEditor() возвращает промис, который
// резолвится результатом по кнопке сохранения и null по отмене. Проверяем сборку
// результата, память стиля, подсказки о перекрытии настройками хоста и вердикт regen.
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';

const SRC = new URL('../src/', import.meta.url).pathname;

const dom = new JSDOM('<body><div id="chat"></div><input id="imaginy_last_style"></body>', { url: 'http://localhost' });
global.window = dom.window;
global.document = dom.window.document;
global.Element = dom.window.Element;
// global.navigator в Node только для чтения — не подменяем: редактор обращается к нему
// лишь в isMac() (подпись горячей клавиши) и в копировании промпта, которое здесь не
// проверяется.
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.MutationObserver = dom.window.MutationObserver;

// jQuery в node_modules нет, а settings.js (его импортирует editor.js) обращается к
// амбиентному $ внутри initSettingsUI. Редактор эту функцию не зовёт, но мок ставим,
// чтобы случайное обращение не валило тест непонятной ReferenceError.
const $stub = () => $stub;
Object.assign($stub, {
    val: () => $stub, prop: () => $stub, on: () => $stub, append: () => $stub,
    get: async () => '', text: () => $stub,
});
global.$ = () => $stub;
// toastr в ctx.js вызывается через typeof-проверку, поэтому мок не обязателен —
// но с ним видно, какие тосты редактор действительно показывает.
const toasts = [];
global.toastr = {
    info: (m) => toasts.push(['info', m]),
    success: (m) => toasts.push(['success', m]),
    warning: (m) => toasts.push(['warning', m]),
    error: (m) => toasts.push(['error', m]),
};

let extensionSettings = {};
let savedSettings = 0;
global.SillyTavern = {
    getContext: () => ({
        extensionSettings,
        chat: [],
        eventSource: { on() {} },
        event_types: {},
        saveSettingsDebounced() {
            savedSettings++;
        },
    }),
};

// Редактор логирует геометрию окна и предупреждения на каждое открытие; под jsdom
// getBoundingClientRect всегда нулевой, поэтому шума было бы больше, чем результатов.
const realConsole = { log: console.log, warn: console.warn, error: console.error };
console.log = () => {};
console.warn = () => {};
console.error = () => {};

const host = await import(`${SRC}host.js`);
const { openEditor } = await import(`${SRC}editor.js`);

const results = [];
function check(name, actual, expected) {
    results.push({ name, ok: actual === expected, actual, expected });
}
function checkJson(name, actual, expected) {
    results.push({
        name,
        ok: JSON.stringify(actual) === JSON.stringify(expected),
        actual,
        expected,
    });
}

// ── харнесс ────────────────────────────────────────────────────────────────────

// Пересобирает окружение: настройки хоста (от них зависит детект и подсказки о
// перекрытии) и настройки самого Imaginy.
function setEnv({ hostSettings = {}, lastStyle = '' } = {}) {
    extensionSettings = { ...hostSettings, Imaginy: { lastStyle } };
    savedSettings = 0;
    toasts.length = 0;
    host.resetHostDetection();
    document.getElementById('imaginy_last_style').value = lastStyle;
}

// Все интересные узлы открытой модалки. Селекторы — из src/editor.js: классы
// .imaginy-modal-*, .imaginy-field, порядок полей задан массивом FIELDS
// (prompt / style / aspect_ratio), кнопки различаем по подписи.
function els() {
    const overlay = document.querySelector('.imaginy-modal-overlay');
    if (!overlay) return null;
    const btn = (text) => [...overlay.querySelectorAll('.imaginy-modal-footer button')]
        .find((b) => b.textContent === text) ?? null;
    const fields = [...overlay.querySelectorAll('.imaginy-modal-body .imaginy-field')];
    return {
        overlay,
        fields,
        prompt: fields[0]?.querySelector('textarea'),
        style: fields[1]?.querySelector('textarea'),
        aspect: fields[2]?.querySelector('select'),
        hints: (i) => [...fields[i].querySelectorAll('.imaginy-field-warning')],
        save: btn('Сохранить'),
        saveRegen: btn('Сохранить и перегенерировать'),
        cancel: btn('Отмена'),
    };
}

// Правка поля пользователем: value + событие input (по нему редактор ставит dirty).
function type(input, value) {
    input.value = value;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

function key(k) {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
}

function ctrlEnter() {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Enter', ctrlKey: true, bubbles: true,
    }));
}

function backdropMouseDown(overlay) {
    overlay.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
}

// Ищет строку-подсказку по началу текста (createHintRow кладёт текст в <span>).
function hintByText(fieldIndex, needle) {
    return els().hints(fieldIndex).find((row) => row.textContent.includes(needle)) ?? null;
}

const BASE = { prompt: 'a cat', style: 'anime', aspect_ratio: '16:9' };

// ── 1. Отмена ──────────────────────────────────────────────────────────────────
{
    setEnv();
    const p = openEditor({ data: { ...BASE }, kind: 'image', regen: { ok: true } });
    check('отмена: оверлей появился', !!document.querySelector('.imaginy-modal-overlay'), true);
    els().cancel.click();
    check('отмена: кнопка «Отмена» → null', await p, null);
    check('отмена: оверлей убран из DOM', !!document.querySelector('.imaginy-modal-overlay'), false);
}

{
    setEnv();
    const p = openEditor({ data: { ...BASE }, kind: 'image', regen: { ok: true } });
    key('Escape');
    check('отмена: Escape → null', await p, null);
    check('отмена: Escape убирает оверлей', !!document.querySelector('.imaginy-modal-overlay'), false);
}

{
    setEnv();
    const p = openEditor({ data: { ...BASE }, kind: 'image', regen: { ok: true } });
    backdropMouseDown(els().overlay);
    check('отмена: клик по фону в чистой форме → null', await p, null);
}

{
    // Форма с правками не закрывается по случайному клику мимо окна.
    setEnv();
    const p = openEditor({ data: { ...BASE }, kind: 'image', regen: { ok: true } });
    const e = els();
    type(e.prompt, 'a dog');
    backdropMouseDown(e.overlay);
    check('отмена: клик по фону в грязной форме не закрывает', !!document.querySelector('.imaginy-modal-overlay'), true);
    e.cancel.click();
    check('отмена: правки после клика по фону не сохранены', await p, null);
}

{
    // Клик по самой модалке всплывает до оверлея, но e.target !== overlay — не закрываем.
    setEnv();
    const p = openEditor({ data: { ...BASE }, kind: 'image', regen: { ok: true } });
    document.querySelector('.imaginy-modal').dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
    check('отмена: клик внутри окна не закрывает', !!document.querySelector('.imaginy-modal-overlay'), true);
    els().cancel.click();
    await p;
}

// ── 2. Сохранение: обе кнопки и горячая клавиша ────────────────────────────────
{
    setEnv();
    const p = openEditor({ data: { ...BASE }, kind: 'image', regen: { ok: true } });
    const e = els();
    type(e.prompt, 'a dog in a hat');
    e.save.click();
    const res = await p;
    check('сохранение: action = save', res.action, 'save');
    check('сохранение: правка промпта в результате', res.data.prompt, 'a dog in a hat');
    check('сохранение: оверлей убран', !!document.querySelector('.imaginy-modal-overlay'), false);
}

{
    setEnv();
    const p = openEditor({ data: { ...BASE }, kind: 'image', regen: { ok: true } });
    els().saveRegen.click();
    const res = await p;
    check('сохранение: action = saveAndRegen', res.action, 'saveAndRegen');
    check('сохранение: данные при перегенерации те же', res.data.prompt, 'a cat');
}

{
    setEnv();
    const p = openEditor({ data: { ...BASE }, kind: 'image', regen: { ok: true } });
    type(els().prompt, 'hotkey prompt');
    ctrlEnter();
    const res = await p;
    check('сохранение: Ctrl+Enter → save', res.action, 'save');
    check('сохранение: Ctrl+Enter отдаёт правки', res.data.prompt, 'hotkey prompt');
}

// ── 3. buildResultData ─────────────────────────────────────────────────────────
{
    // Неизвестные редактору ключи инструкции обязаны пережить редактирование.
    setEnv();
    const data = {
        prompt: 'a cat', style: 'anime', aspect_ratio: '16:9',
        image_size: '1024x1024', quality: 'high', preset: 'my', negative_prompt: 'blur',
    };
    const p = openEditor({ data, kind: 'image', regen: { ok: true } });
    els().save.click();
    const res = await p;
    checkJson('buildResultData: неизвестные поля сохранены', {
        image_size: res.data.image_size,
        quality: res.data.quality,
        preset: res.data.preset,
        negative_prompt: res.data.negative_prompt,
    }, { image_size: '1024x1024', quality: 'high', preset: 'my', negative_prompt: 'blur' });
    check('buildResultData: исходный объект не мутирован', data.prompt, 'a cat');
    check('buildResultData: результат — новый объект', res.data === data, false);
}

{
    // Пробелы по краям срезаются у всех трёх полей.
    setEnv();
    const p = openEditor({ data: { ...BASE }, kind: 'image', regen: { ok: true } });
    const e = els();
    type(e.prompt, '   a whale  \n');
    type(e.style, '\t watercolor \n');
    e.save.click();
    const res = await p;
    check('buildResultData: промпт тримится', res.data.prompt, 'a whale');
    check('buildResultData: стиль тримится', res.data.style, 'watercolor');
}

{
    // Пустое значение при существовавшем ключе — ключ удаляется, а не пишется "".
    setEnv();
    const p = openEditor({ data: { ...BASE }, kind: 'image', regen: { ok: true } });
    const e = els();
    type(e.style, '   ');
    e.aspect.value = '';
    e.save.click();
    const res = await p;
    check('buildResultData: пустой стиль удаляет ключ', Object.hasOwn(res.data, 'style'), false);
    check('buildResultData: пустое соотношение удаляет ключ', Object.hasOwn(res.data, 'aspect_ratio'), false);
}

{
    // Ключа не было и поле пустое — ключ так и не появляется.
    setEnv();
    const p = openEditor({ data: { prompt: 'a cat' }, kind: 'image', regen: { ok: true } });
    els().save.click();
    const res = await p;
    checkJson('buildResultData: пустые поля не добавляют ключей', Object.keys(res.data), ['prompt']);
}

{
    // Выбор соотношения из выпадашки записывается как есть.
    setEnv();
    const p = openEditor({ data: { prompt: 'a cat' }, kind: 'image', regen: { ok: true } });
    const e = els();
    check('buildResultData: первый вариант выпадашки — «не задано»', e.aspect.options[0].value, '');
    e.aspect.value = '3:4';
    e.save.click();
    check('buildResultData: соотношение записано', (await p).data.aspect_ratio, '3:4');
}

{
    // Нестандартное значение из руками правленого JSON не теряется: оно добавляется
    // в список вариантов и остаётся выбранным.
    setEnv();
    const p = openEditor({ data: { prompt: 'a cat', aspect_ratio: '7:3' }, kind: 'image', regen: { ok: true } });
    const e = els();
    check('buildResultData: нестандартное соотношение выбрано', e.aspect.value, '7:3');
    e.save.click();
    check('buildResultData: нестандартное соотношение сохранено', (await p).data.aspect_ratio, '7:3');
}

{
    // Нестроковые значения приводятся к строке при показе (String(existing)).
    setEnv();
    const p = openEditor({ data: { prompt: 42 }, kind: 'image', regen: { ok: true } });
    check('buildResultData: число в промпте показано строкой', els().prompt.value, '42');
    els().save.click();
    check('buildResultData: число в промпте сохранено строкой', (await p).data.prompt, '42');
}

{
    // data вовсе нет — редактор всё равно открывается и отдаёт пустой объект.
    setEnv();
    const p = openEditor({ kind: 'image', regen: { ok: true } });
    check('buildResultData: без data редактор открылся', !!document.querySelector('.imaginy-modal-overlay'), true);
    els().save.click();
    checkJson('buildResultData: без data результат пустой', (await p).data, {});
}

// ── 4. Подстановка запомненного стиля ──────────────────────────────────────────
{
    setEnv({ lastStyle: 'oil painting' });
    const p = openEditor({ data: { prompt: 'a cat' }, kind: 'image', regen: { ok: true } });
    check('память стиля: подставлен в пустое поле', els().style.value, 'oil painting');
    check('память стиля: показана подсказка о подстановке', !!hintByText(1, 'Подставлен последний использованный стиль'), true);
    els().cancel.click();
    await p;
}

{
    setEnv({ lastStyle: 'oil painting' });
    const p = openEditor({ data: { prompt: 'a cat', style: 'anime' }, kind: 'image', regen: { ok: true } });
    check('память стиля: свой стиль важнее запомненного', els().style.value, 'anime');
    check('память стиля: без подстановки нет подсказки', !!hintByText(1, 'Подставлен последний использованный стиль'), false);
    els().cancel.click();
    await p;
}

{
    setEnv({ lastStyle: '   \n ' });
    const p = openEditor({ data: { prompt: 'a cat' }, kind: 'image', regen: { ok: true } });
    check('память стиля: пробельный lastStyle не подставляется', els().style.value, '');
    els().cancel.click();
    await p;
}

{
    setEnv({ lastStyle: '' });
    const p = openEditor({ data: { prompt: 'a cat' }, kind: 'image', regen: { ok: true } });
    check('память стиля: пустой lastStyle не подставляется', els().style.value, '');
    els().cancel.click();
    await p;
}

{
    // Поле в инструкции есть, но из одних пробелов — считается пустым, память побеждает.
    setEnv({ lastStyle: 'oil painting' });
    const p = openEditor({ data: { prompt: 'a cat', style: '   ' }, kind: 'image', regen: { ok: true } });
    check('память стиля: пробельный стиль картинки замещается памятью', els().style.value, 'oil painting');
    els().cancel.click();
    await p;
}

// ── 5. Запоминание стиля при сохранении ────────────────────────────────────────
{
    setEnv({ lastStyle: '' });
    const p = openEditor({ data: { prompt: 'a cat' }, kind: 'image', regen: { ok: true } });
    type(els().style, '  watercolor  ');
    els().save.click();
    await p;
    check('запоминание: непустой стиль записан тримленым', extensionSettings.Imaginy.lastStyle, 'watercolor');
    check('запоминание: настройки сохранены', savedSettings > 0, true);
    check('запоминание: поле панели синхронизировано', document.getElementById('imaginy_last_style').value, 'watercolor');
}

{
    // Очистка поля = «у этой картинки стиля нет», а не «забудь навсегда»: память цела.
    setEnv({ lastStyle: 'anime' });
    const p = openEditor({ data: { prompt: 'a cat', style: 'anime' }, kind: 'image', regen: { ok: true } });
    type(els().style, '   ');
    els().save.click();
    const res = await p;
    check('запоминание: пустой стиль не затирает память', extensionSettings.Imaginy.lastStyle, 'anime');
    check('запоминание: пустой стиль всё же убран из инструкции', Object.hasOwn(res.data, 'style'), false);
}

{
    // Тот же стиль, что уже в памяти, — лишней записи настроек нет.
    setEnv({ lastStyle: 'anime' });
    const p = openEditor({ data: { prompt: 'a cat', style: 'anime' }, kind: 'image', regen: { ok: true } });
    els().save.click();
    await p;
    check('запоминание: повтор того же стиля не пишет настройки', savedSettings, 0);
}

{
    setEnv({ lastStyle: 'anime' });
    const p = openEditor({ data: { prompt: 'a cat', style: 'ink' }, kind: 'image', regen: { ok: true } });
    els().saveRegen.click();
    await p;
    check('запоминание: работает и при «Сохранить и перегенерировать»', extensionSettings.Imaginy.lastStyle, 'ink');
}

{
    setEnv({ lastStyle: 'anime' });
    const p = openEditor({ data: { prompt: 'a cat', style: 'ink' }, kind: 'image', regen: { ok: true } });
    els().cancel.click();
    await p;
    check('запоминание: отмена ничего не запоминает', extensionSettings.Imaginy.lastStyle, 'anime');
}

// ── 6. Кнопка «Забыть» в подсказке о подставленном стиле ───────────────────────
{
    setEnv({ lastStyle: 'oil painting' });
    const p = openEditor({ data: { prompt: 'a cat' }, kind: 'image', regen: { ok: true } });
    const row = hintByText(1, 'Подставлен последний использованный стиль');
    row.querySelector('button').click();
    check('«Забыть»: поле стиля очищено', els().style.value, '');
    check('«Забыть»: память очищена', extensionSettings.Imaginy.lastStyle, '');
    check('«Забыть»: подсказка убрана', !!hintByText(1, 'Подставлен последний использованный стиль'), false);
    check('«Забыть»: поле панели очищено', document.getElementById('imaginy_last_style').value, '');
    // Форма стала грязной — клик по фону больше не закрывает окно молча.
    backdropMouseDown(els().overlay);
    check('«Забыть»: форма помечена грязной', !!document.querySelector('.imaginy-modal-overlay'), true);
    els().save.click();
    const res = await p;
    check('«Забыть»: стиль не вернулся в инструкцию', Object.hasOwn(res.data, 'style'), false);
    check('«Забыть»: сохранение не вернуло стиль в память', extensionSettings.Imaginy.lastStyle, '');
}

// ── 7. Вердикт regen и вид kind ────────────────────────────────────────────────
{
    setEnv();
    const p = openEditor({ data: { ...BASE }, kind: 'image', regen: { ok: true } });
    check('regen: при ok кнопка активна', els().saveRegen.disabled, false);
    els().cancel.click();
    await p;
}

{
    setEnv();
    const p = openEditor({ data: { ...BASE }, kind: 'video', regen: { ok: false, reason: 'Видео перегенерировать нельзя' } });
    const e = els();
    check('regen: при отказе кнопка заблокирована', e.saveRegen.disabled, true);
    check('regen: причина отказа в title', e.saveRegen.title, 'Видео перегенерировать нельзя');
    e.saveRegen.click();
    check('regen: клик по заблокированной кнопке не закрывает окно', !!document.querySelector('.imaginy-modal-overlay'), true);
    e.save.click();
    check('regen: обычное сохранение при отказе работает', (await p).action, 'save');
}

{
    setEnv();
    const p = openEditor({ data: { ...BASE }, kind: 'error', regen: { ok: false, reason: 'Нет кнопки перегенерации' } });
    check('regen: kind=error — кнопка заблокирована по вердикту', els().saveRegen.disabled, true);
    els().cancel.click();
    await p;
}

{
    // regen не передан вовсе — редактор не блокирует кнопку (вердикт неизвестен).
    setEnv();
    const p = openEditor({ data: { ...BASE }, kind: 'image' });
    check('regen: без вердикта кнопка активна', els().saveRegen.disabled, false);
    els().saveRegen.click();
    check('regen: без вердикта перегенерация разрешена', (await p).action, 'saveAndRegen');
}

{
    // kind сам по себе на разметку не влияет: и у video, и у image набор полей один.
    setEnv();
    const pImg = openEditor({ data: { ...BASE }, kind: 'image', regen: { ok: true } });
    const imgFields = els().fields.length;
    els().cancel.click();
    await pImg;
    const pVid = openEditor({ data: { ...BASE }, kind: 'video', regen: { ok: true } });
    check('kind: набор полей одинаков для image и video', els().fields.length, imgFields);
    els().cancel.click();
    await pVid;
}

// ── 8. Подсказки о перекрытии настройками хоста (SLAY) ─────────────────────────
{
    // У SLAY глобальный стиль и жёстко заданное соотношение перекрывают per-image
    // значения — редактор обязан об этом предупредить и предложить починку.
    setEnv({
        hostSettings: {
            slay_image_gen: { apiType: 'naistera', naisteraAspectRatio: '3:2', slayStyle: 'oil', slayStyleName: 'Масло' },
        },
    });
    const p = openEditor({ data: { ...BASE }, kind: 'image', regen: { ok: true } });
    check('квирки: детект хоста — slay', host.getHost().id, 'slay');
    const styleHint = hintByText(1, 'перекроет любой стиль');
    check('квирки: предупреждение о глобальном стиле', !!styleHint, true);
    check('квирки: в предупреждении имя стиля хоста', styleHint.textContent.includes('Масло'), true);
    const aspectHint = hintByText(2, 'перекроет любое выбранное здесь');
    check('квирки: предупреждение о соотношении', !!aspectHint, true);
    check('квирки: в предупреждении глобальное значение', aspectHint.textContent.includes('3:2'), true);

    // Кнопки чинят настройку хоста и убирают строку.
    styleHint.querySelector('button').click();
    check('квирки: «Сбросить стиль хоста» очистил slayStyle', extensionSettings.slay_image_gen.slayStyle, '');
    check('квирки: строка предупреждения о стиле убрана', !!hintByText(1, 'перекроет любой стиль'), false);

    aspectHint.querySelector('button').click();
    check('квирки: «Из промпта» выставил auto', extensionSettings.slay_image_gen.naisteraAspectRatio, 'auto');
    check('квирки: строка предупреждения о соотношении убрана', !!hintByText(2, 'перекроет любое выбранное здесь'), false);

    // Список соотношений на naistera-пути короче общего.
    checkJson('квирки: варианты naistera', [...els().aspect.options].map((o) => o.value),
        ['', '16:9', '9:16', '2:3', '3:2', '1:1']);
    els().cancel.click();
    await p;
}

{
    // Без настроек хоста (generic) предупреждений нет, а список соотношений — полный.
    setEnv();
    const p = openEditor({ data: { prompt: 'a cat' }, kind: 'image', regen: { ok: true } });
    check('квирки: у generic предупреждений нет',
        els().overlay.querySelectorAll('.imaginy-field-warning').length, 0);
    check('квирки: у generic полный список соотношений', els().aspect.options.length, 11);
    els().cancel.click();
    await p;
}

// ── 9. Повторный вызов при открытой модалке ────────────────────────────────────
{
    setEnv();
    const first = openEditor({ data: { prompt: 'первый' }, kind: 'image', regen: { ok: true } });
    const second = openEditor({ data: { prompt: 'второй' }, kind: 'image', regen: { ok: true } });
    check('повтор: второй вызов сразу резолвится null', await second, null);
    check('повтор: второго оверлея нет', document.querySelectorAll('.imaginy-modal-overlay').length, 1);
    check('повтор: показан тост «Редактор уже открыт»', toasts.some(([, m]) => m === 'Редактор уже открыт'), true);
    check('повтор: первое окно живо и содержит свои данные', els().prompt.value, 'первый');
    els().cancel.click();
    await first;

    // После закрытия редактор открывается снова.
    const third = openEditor({ data: { prompt: 'третий' }, kind: 'image', regen: { ok: true } });
    check('повтор: после закрытия открывается снова', els()?.prompt.value, 'третий');
    els().cancel.click();
    await third;
}

{
    // Залипший флаг: оверлей вынесли из DOM мимо редактора. Следующий вызов обязан
    // открыться, а не отвечать «Редактор уже открыт» до перезагрузки страницы.
    setEnv();
    const stuck = openEditor({ data: { prompt: 'зависший' }, kind: 'image', regen: { ok: true } });
    document.querySelector('.imaginy-modal-overlay').remove();
    const p = openEditor({ data: { prompt: 'новый' }, kind: 'image', regen: { ok: true } });
    check('залипший флаг: новое окно всё же открылось', els()?.prompt.value, 'новый');
    els().cancel.click();
    check('залипший флаг: новое окно резолвится', await p, null);
    // Промис вырванного окна обязан разрешиться в null: index.js ждёт его через await,
    // и без этого onEdit подвис бы навсегда.
    check('залипший флаг: промис вырванного окна резолвится в null', await stuck, null);
}

{
    // Компактный режим: низкий вьюпорт = телефон со всплывшей клавиатурой. Проверяем
    // ровно то, что освобождает место под редактируемое поле: короткие подписи кнопок
    // в один ряд, спрятанная подсказка про Ctrl+Enter и свёрнутые до двух строк соседи.
    // visualViewport в jsdom нет — заодно проверяется фолбэк на window.innerHeight.
    const realHeight = dom.window.innerHeight;
    Object.defineProperty(dom.window, 'innerHeight', { value: 420, configurable: true });
    setEnv();
    const p = openEditor({ data: { ...BASE }, kind: 'image', regen: { ok: true } });
    const overlay = document.querySelector('.imaginy-modal-overlay');
    const modal = overlay.querySelector('.imaginy-modal');
    const fields = [...overlay.querySelectorAll('.imaginy-modal-body .imaginy-field')];
    const prompt = fields[0].querySelector('textarea');
    const style = fields[1].querySelector('textarea');
    const buttons = [...overlay.querySelectorAll('.imaginy-modal-footer button')];

    check('компакт: класс на модалке', modal.classList.contains('imaginy-compact'), true);
    check('компакт: кнопки в ряд', modal.querySelector('.imaginy-modal-footer').style.flexDirection, 'row');
    check('компакт: подсказка о клавишах спрятана', modal.querySelector('.imaginy-modal-hint').style.display, 'none');
    checkJson('компакт: короткие подписи', buttons.map((b) => b.textContent), ['Сохранить', 'Сохр. + реген.', 'Отмена']);
    check('компакт: промпт развёрнут', prompt.rows, 8);
    check('компакт: стиль свёрнут до двух строк', style.rows, 2);

    // Пользователь тапнул в «Стиль» — высоту забирает он, промпт сворачивается.
    style.focus();
    check('компакт: после фокуса стиль развёрнут', style.rows, 3);
    check('компакт: после фокуса промпт свёрнут', prompt.rows, 2);
    // Ширина не изменилась, так что кнопки остались короткими — ищем по новой подписи.
    buttons.find((b) => b.textContent === 'Отмена').click();
    check('компакт: окно закрывается', await p, null);

    // Средняя ступень: места мало для просторной раскладки, но хватает, чтобы показать
    // все поля целиком. Обвязка ужимается, поля — нет. Пороги считаются в строках
    // (16px * 1.35 в jsdom ≈ 21.6): просторно от 30 строк (~648px), приоритет
    // фокусу — ниже 26 строк (~562px).
    Object.defineProperty(dom.window, 'innerHeight', { value: 600, configurable: true });
    setEnv();
    const mid = openEditor({ data: { ...BASE }, kind: 'image', regen: { ok: true } });
    const midModal = document.querySelector('.imaginy-modal');
    const midFields = [...midModal.querySelectorAll('.imaginy-field')];
    check('средняя ступень: обвязка ужата', midModal.classList.contains('imaginy-compact'), true);
    check('средняя ступень: промпт не свёрнут', midFields[0].querySelector('textarea').rows, 8);
    check('средняя ступень: стиль тоже развёрнут', midFields[1].querySelector('textarea').rows, 3);
    [...midModal.querySelectorAll('.imaginy-modal-footer button')]
        .find((b) => b.textContent === 'Отмена').click();
    await mid;

    Object.defineProperty(dom.window, 'innerHeight', { value: realHeight, configurable: true });
    setEnv();
    const q = openEditor({ data: { ...BASE }, kind: 'image', regen: { ok: true } });
    check('обычный режим: полные подписи вернулись', els().saveRegen?.textContent, 'Сохранить и перегенерировать');
    check('обычный режим: класс компакта снят',
        document.querySelector('.imaginy-modal').classList.contains('imaginy-compact'), false);
    els().cancel.click();
    await q;
}

{
    // Сенсорный ввод: фокус в промпт сразу поднял бы клавиатуру и открыл окно уже
    // наполовину закрытым — даже если человек зашёл только прочитать промпт. На мышке
    // фокус, наоборот, ставится сразу, и курсор — в начало текста, а не в конец.
    const realMatchMedia = dom.window.matchMedia;
    dom.window.matchMedia = (q) => (q === '(pointer: coarse)' ? { matches: true } : realMatchMedia.call(dom.window, q));
    setEnv();
    const touch = openEditor({ data: { ...BASE }, kind: 'image', regen: { ok: true } });
    const touchPrompt = els().prompt;
    await Promise.resolve();
    check('сенсорный ввод: фокус не украден', document.activeElement === touchPrompt, false);
    els().cancel.click();
    await touch;

    dom.window.matchMedia = realMatchMedia;
    setEnv();
    const mouse = openEditor({ data: { prompt: 'длинный промпт' }, kind: 'image', regen: { ok: true } });
    const mousePrompt = els().prompt;
    await Promise.resolve();
    check('мышь: фокус в промпте', document.activeElement === mousePrompt, true);
    check('мышь: курсор в начале текста', mousePrompt.selectionStart, 0);
    els().cancel.click();
    await mouse;
}

// ── 12. Версия ─────────────────────────────────────────────────────────────────
// Мест с версией осталось два — src/version.js и manifest.json (последний из модуля
// не прочитать без сетевого запроса, а их Imaginy не делает). Тест стережёт именно их
// расхождение: метка сборки в логе редактора нужна, чтобы на телефоне отличить
// «новый код не доехал» от «доехал, но не работает», и врущая метка хуже её отсутствия.
{
    const { VERSION } = await import(`${SRC}version.js`);
    const manifest = JSON.parse(
        await readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
    );
    check('версия: manifest совпадает с src/version.js', manifest.version, VERSION);
}

// ── итог ───────────────────────────────────────────────────────────────────────
Object.assign(console, realConsole);

let failed = 0;
for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ожидалось ${JSON.stringify(r.expected)}, получено ${JSON.stringify(r.actual)}`}`);
}
console.log(`\n${results.length - failed}/${results.length} проверок прошло`);
process.exit(failed ? 1 : 0);
