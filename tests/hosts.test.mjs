// Смоук-тест host-профилей Imaginy под jsdom: детект хоста, расстановка карандаша,
// вердикт canRegen для каждого из четырёх поддерживаемых расширений (docs/hosts.md).
//
// Запуск из корня репозитория:
//   npm install --no-save jsdom
//   node tests/hosts.test.mjs
//
// В браузер этот файл не попадает и в поставку расширения не входит — «без сборки»
// остаётся в силе. Разметка каждого хоста собрана руками по его исходникам:
// живьём ни один хост здесь не запускается.
import { JSDOM } from 'jsdom';

const SRC = new URL('../src/', import.meta.url).pathname;

const dom = new JSDOM('<body><div id="chat"></div></body>', { url: 'http://localhost' });
global.window = dom.window;
global.document = dom.window.document;
global.Element = dom.window.Element;
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.MutationObserver = dom.window.MutationObserver;

let extensionSettings = {};
global.SillyTavern = {
    getContext: () => ({
        extensionSettings,
        chat: [],
        eventSource: { on() {} },
        event_types: {},
        saveSettingsDebounced() {},
    }),
};

const host = await import(`${SRC}host.js`);
const decorate = await import(`${SRC}decorate.js`);
const regen = await import(`${SRC}regen.js`);
const quirks = await import(`${SRC}hostquirks.js`);

// getHost кэширует вывод на сессию — между сценариями сбрасываем детект.
async function freshModules() {
    host.resetHostDetection();
    return { host, decorate, regen };
}

const INSTR = `{"prompt":"a cat","style":"anime","aspect_ratio":"16:9"}`;

function mes(inner) {
    document.getElementById('chat').innerHTML = `
        <div class="mes" mesid="0">
            <div class="extraMesButtons"><div class="mes_button iig-regenerate-btn"></div></div>
            <div class="mes_text">${inner}</div>
        </div>`;
    return document.getElementById('chat');
}

const results = [];
function check(name, actual, expected) {
    const ok = actual === expected;
    results.push({ name, ok, actual, expected });
}

// ── SLAY ────────────────────────────────────────────────────────────────────────
{
    extensionSettings = { slay_image_gen: { apiType: 'naistera', naisteraAspectRatio: '3:2', slayStyle: 'oil' } };
    const root = mes(`
        <span class="iig-img-wrap"><img data-iig-instruction='${INSTR}' src="/a.png">
        <div class="iig-regen-btn"></div></span>
        <video data-iig-instruction='${INSTR}' src="/a.mp4"></video>
        <div class="iig-error-placeholder" data-iig-instruction='${INSTR}'>ошибка</div>`);
    const { host, decorate, regen } = await freshModules();
    check('slay: детект', host.getHost().id, 'slay');
    decorate.decorateRoot(root);
    check('slay: карандаш в .iig-img-wrap', !!document.querySelector('.iig-img-wrap > .imaginy-edit-btn'), true);
    check('slay: карандаш у видео в своей обёртке', !!document.querySelector('.imaginy-img-wrap > .imaginy-edit-btn'), true);
    check('slay: карандаш в плашке ошибки', !!document.querySelector('.iig-error-placeholder > .imaginy-edit-btn'), true);
    check('slay: плашка ошибки не в top-left', document.querySelector('.iig-error-placeholder > .imaginy-edit-btn').className.includes('--tl'), false);

    const img = document.querySelector('img[data-iig-instruction]');
    check('slay: regen картинки ok', regen.canRegen(img, 'image').ok, true);
    check('slay: regen видео запрещён', regen.canRegen(document.querySelector('video'), 'video').ok, false);
    check('slay: regen ошибки запрещён', regen.canRegen(document.querySelector('.iig-error-placeholder'), 'error').ok, false);

    // hostquirks импортирует свой экземпляр host.js — он детектит то же самое.
    check('slay: aspect перекрыт', quirks.getAspectRatioContext().overridden, true);
    check('slay: стиль перекрыт', quirks.getStyleContext().overridden, true);
}

// ── delidgi/sillyimages ─────────────────────────────────────────────────────────
{
    extensionSettings = { inline_image_gen: { imgActionRegen: true, avatarItems: [], styles: [{ id: 's1', name: 'Ink', value: 'ink' }], activeStyleId: 's1', aspectRatio: '3:2' } };
    const root = mes(`
        <div class="iig-image-wrapper" data-tag-index="0">
            <div class="iig-image-actions"><div class="iig-image-action-btn iig-regen-single-btn"></div></div>
            <img data-iig-instruction='${INSTR}' src="/a.png">
        </div>
        <div class="iig-image-wrapper iig-error-wrap" data-tag-index="1">
            <div class="iig-image-actions"><div class="iig-image-action-btn iig-regen-single-btn"></div></div>
            <img class="iig-error-image" data-iig-instruction='${INSTR}' src="/error.svg">
        </div>`);
    const { host, decorate, regen } = await freshModules();
    check('delidgi: детект', host.getHost().id, 'sillyimages-delidgi');
    decorate.decorateRoot(root);
    check('delidgi: карандаш в обёртке хоста', document.querySelectorAll('.iig-image-wrapper > .imaginy-edit-btn').length, 2);
    check('delidgi: карандаш слева', document.querySelector('.imaginy-edit-btn').className.includes('--tl'), true);
    check('delidgi: regen картинки ok', regen.canRegen(document.querySelector('.iig-image-wrapper img'), 'image').ok, true);
    check('delidgi: regen ошибки ok', regen.canRegen(document.querySelector('img.iig-error-image'), 'error').ok, true);

    check('delidgi: aspect НЕ перекрыт', quirks.getAspectRatioContext().overridden, false);
    check('delidgi: стиль перекрыт пресетом', quirks.getStyleContext().overridden, true);
    check('delidgi: имя пресета', quirks.getStyleContext().name, 'Ink');
}

// ── notsosillynotsoimages ───────────────────────────────────────────────────────
{
    extensionSettings = { inline_image_gen: { naisteraPreset: 'x', aspectRatio: '3:2' } };
    const root = mes(`
        <div class="iig-image-wrapper">
            <img class="iig-generated-image" data-iig-instruction='${INSTR}' src="/a.png">
            <button class="iig-action-btn iig-action-regen"></button>
            <button class="iig-action-btn iig-action-download"></button>
        </div>
        <img class="iig-error-image" data-iig-instruction='${INSTR}' src="/error.svg">`);
    const { host, decorate, regen } = await freshModules();
    check('nsnsi: детект', host.getHost().id, 'nsnsi');
    decorate.decorateRoot(root);
    check('nsnsi: карандаш в обёртке хоста', !!document.querySelector('.iig-image-wrapper > .imaginy-edit-btn'), true);
    check('nsnsi: regen картинки ok', regen.canRegen(document.querySelector('.iig-image-wrapper img'), 'image').ok, true);
    check('nsnsi: regen ошибки запрещён', regen.canRegen(document.querySelector('img.iig-error-image'), 'error').ok, false);

    check('nsnsi: стиль не перекрывается', quirks.getStyleContext().overridden, false);
}

// ── 0xl0cal/sillyimages ─────────────────────────────────────────────────────────
{
    extensionSettings = { inline_image_gen: { additionalReferences: [], styles: [], activeStyleId: '', aspectRatio: '3:2' } };
    const root = mes(`<img class="iig-generated-image" data-iig-instruction='${INSTR}' src="/a.png">`);
    const { host, decorate, regen } = await freshModules();
    check('0xl0cal: детект', host.getHost().id, 'sillyimages-0xl0cal');
    decorate.decorateRoot(root);
    check('0xl0cal: своя обёртка сразу', !!document.querySelector('.imaginy-img-wrap > .imaginy-edit-btn'), true);
    check('0xl0cal: regen через кнопку сообщения', regen.canRegen(document.querySelector('img[data-iig-instruction]'), 'image').ok, true);

    // Две картинки в сообщении — кнопка сообщения перегенерирует обе, отказываемся.
    const root2 = mes(`
        <img data-iig-instruction='${INSTR}' src="/a.png">
        <img data-iig-instruction='${INSTR}' src="/b.png">`);
    decorate.decorateRoot(root2);
    const verdict = regen.canRegen(document.querySelector('img[data-iig-instruction]'), 'image');
    check('0xl0cal: две картинки → отказ', verdict.ok, false);
    check('0xl0cal: причина про «всё сообщение»', /несколько картинок/.test(verdict.reason), true);
}

// ── неизвестный форк ────────────────────────────────────────────────────────────
{
    extensionSettings = {};
    const root = mes(`<span class="iig-unknown-wrap"><img data-iig-instruction='${INSTR}' src="/a.png"></span>`);
    const { host, decorate, regen } = await freshModules();
    check('generic: детект', host.getHost().id, 'generic');
    decorate.decorateRoot(root);
    // GENERIC ждёт обёртку хоста OWN_WRAP_DELAY_MS, потом делает свою — проверяем оба шага.
    check('generic: сразу карандаша нет', !!document.querySelector('.imaginy-edit-btn'), false);
    document.querySelector('img[data-iig-instruction]').dataset.imaginySeen = String(Date.now() - 5000);
    decorate.decorateRoot(root);
    check('generic: карандаш в своей обёртке', !!document.querySelector('.imaginy-img-wrap > .imaginy-edit-btn'), true);
    const verdict = regen.canRegen(document.querySelector('img[data-iig-instruction]'), 'image');
    check('generic: regen не найден', verdict.ok, false);
}

let failed = 0;
for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ожидалось ${JSON.stringify(r.expected)}, получено ${JSON.stringify(r.actual)}`}`);
}
console.log(`\n${results.length - failed}/${results.length} проверок прошло`);
process.exit(failed ? 1 : 0);
