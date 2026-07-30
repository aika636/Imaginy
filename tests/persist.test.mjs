// Тест записи инструкции в сообщение (src/persist.js) под jsdom.
//
// Запуск из корня репозитория:
//   npm install --no-save jsdom
//   node tests/persist.test.mjs
//
// Главное, что здесь проверяется, — два бага, найденные на мобильной таверне:
//   1. анкор-стратегия зацикливалась на каноническом порядке атрибутов SLAY
//      (data-iig-instruction перед src) и вешала вкладку намертво;
//   2. форма записи подбиралась одна на всё сообщение, поэтому часть мест хранения
//      оставалась со старой инструкцией — и картинка после перегенерации не менялась.
import { JSDOM } from 'jsdom';

const SRC = new URL('../src/', import.meta.url).pathname;

const dom = new JSDOM('<body><div id="chat"></div></body>', { url: 'http://localhost' });
global.window = dom.window;
global.document = dom.window.document;
global.Element = dom.window.Element;

let chat = [];
let savedToDisk = 0;
global.SillyTavern = {
    getContext: () => ({
        chat,
        extensionSettings: {},
        eventSource: { on() {} },
        event_types: {},
        async saveChat() {
            savedToDisk++;
        },
        saveChatDebounced() {},
    }),
};

const { persistInstruction } = await import(`${SRC}persist.js`);

const results = [];
function check(name, actual, expected) {
    results.push({ name, ok: actual === expected, actual, expected });
}

// Ставит в чат одно сообщение и рендерит его же в DOM, возвращая <img> как цель.
// domHtml задаётся отдельно: в DOM браузер уже раскодировал энтити, а в тексте
// сообщения они остаются — ровно это расхождение и ловит persist.
function setup({ message, domHtml }) {
    chat = [message];
    document.getElementById('chat').innerHTML = `
        <div class="mes" mesid="0"><div class="mes_text">${domHtml}</div></div>`;
    return document.querySelector('img[data-iig-instruction]');
}

const SRC_PATH = 'user/images/gen/iig_2026-07-30.png';
const NEW_DATA = { prompt: 'new prompt', style: 'anime' };

// ── 1. Канонический порядок атрибутов SLAY: инструкция ПЕРЕД src ────────────────
// В тексте сообщения инструкция лежит в форме, которую не находит ни одна точная
// стратегия (кавычки вокруг JSON поменяны моделью), поэтому запись уходит в anchored.
// До фикса этот вызов не возвращался никогда — вкладка вставала намертво.
{
    const stored = `<img data-iig-instruction='{"prompt": "old", "style": "anime"}' src="${SRC_PATH}">`;
    const img = setup({
        message: { mes: stored },
        // В DOM инструкция отличается от текста (лишние пробелы убраны), так что
        // exact/escaped/entities не совпадут и сработает именно anchored.
        domHtml: `<img data-iig-instruction='{"prompt":"old","style":"anime"}' src="${SRC_PATH}">`,
    });

    const res = await persistInstruction({
        targetEl: img,
        rawDom: img.getAttribute('data-iig-instruction'),
        newData: NEW_DATA,
    });

    check('anchored: запись завершилась (нет зацикливания)', res.ok, true);
    check('anchored: метод', res.method, 'anchored');
    check('anchored: новый промпт в тексте', chat[0].mes.includes('new prompt'), true);
    check('anchored: старый промпт вычищен', chat[0].mes.includes('"old"'), false);
    check('anchored: src не пострадал', chat[0].mes.includes(`src="${SRC_PATH}"`), true);
    check('anchored: тег остался одним', chat[0].mes.split('<img').length - 1, 1);
}

// ── 2. Разные формы в разных полях: чинятся все места, а не первое совпавшее ────
{
    const plain = `{"prompt":"old","style":"anime"}`;
    const escaped = plain.replace(/'/g, '&#39;');
    const img = setup({
        message: {
            // mes — как есть, display_text — с экранированным апострофом,
            // extblocks — с кириллицей в энтити-кодировке, как её хранит ST.
            mes: `<img data-iig-instruction='${plain}' src="${SRC_PATH}">`,
            extra: {
                display_text: `<img data-iig-instruction='${escaped}' src="${SRC_PATH}">`,
                extblocks: `<img data-iig-instruction='${plain}' src="${SRC_PATH}">`,
            },
            swipes: [`<img data-iig-instruction='${plain}' src="${SRC_PATH}">`],
        },
        domHtml: `<img data-iig-instruction='${plain}' src="${SRC_PATH}">`,
    });

    await persistInstruction({
        targetEl: img,
        rawDom: img.getAttribute('data-iig-instruction'),
        newData: NEW_DATA,
    });

    check('все места: mes обновлён', chat[0].mes.includes('new prompt'), true);
    check('все места: display_text обновлён', chat[0].extra.display_text.includes('new prompt'), true);
    check('все места: extblocks обновлён', chat[0].extra.extblocks.includes('new prompt'), true);
    check('все места: swipes[0] обновлён', chat[0].swipes[0].includes('new prompt'), true);
    check('все места: старой инструкции не осталось',
        [chat[0].mes, chat[0].extra.display_text, chat[0].extra.extblocks, chat[0].swipes[0]]
            .some((s) => s.includes('"old"')), false);
}

// ── 3. Кириллица: ST хранит её десятичными энтити, getAttribute отдаёт буквы ────
{
    const cyrillic = `{"prompt":"кот в шляпе","style":"аниме"}`;
    const asEntities = cyrillic.replace(/[\u{80}-\u{10FFFF}]/gu, (ch) => `&#${ch.codePointAt(0)};`);
    const img = setup({
        message: { mes: `<img data-iig-instruction='${asEntities}' src="${SRC_PATH}">` },
        domHtml: `<img data-iig-instruction='${asEntities}' src="${SRC_PATH}">`,
    });

    check('кириллица: getAttribute раскодировал энтити',
        img.getAttribute('data-iig-instruction'), cyrillic);

    const res = await persistInstruction({
        targetEl: img,
        rawDom: img.getAttribute('data-iig-instruction'),
        newData: { prompt: 'кот в кепке', style: 'аниме' },
    });

    check('кириллица: метод — точное совпадение по энтити', res.method, 'entities');
    check('кириллица: новый промпт в тексте', chat[0].mes.includes('кот в кепке'), true);
    check('кириллица: DOM-копия обновлена',
        img.getAttribute('data-iig-instruction').includes('кот в кепке'), true);
}

// ── 4. Инструкции нет в тексте вовсе: честный dom-only, без записи на диск ──────
{
    const savesBefore = savedToDisk;
    const img = setup({
        message: { mes: 'сообщение без картинки' },
        domHtml: `<img data-iig-instruction='{"prompt":"old"}' src="${SRC_PATH}">`,
    });

    const res = await persistInstruction({
        targetEl: img,
        rawDom: img.getAttribute('data-iig-instruction'),
        newData: NEW_DATA,
    });

    check('dom-only: ok=false', res.ok, false);
    check('dom-only: метод', res.method, 'dom-only');
    check('dom-only: чат не сохранялся', savedToDisk, savesBefore);
    check('dom-only: DOM всё равно обновлён',
        img.getAttribute('data-iig-instruction').includes('new prompt'), true);
}

// ── 5. Повторное сохранение без правок: значение уже совпадает — это успех ──────
// Сценарий с мобильной таверны: правим промпт → сохраняем → открываем окно снова →
// сразу «Сохранить и перегенерировать», ничего не меняя. Замена переписывает текст
// тем же значением, строка не меняется — раньше это давало ok=false, ложную ошибку
// «правка применена только к DOM» и отказ от перегенерации.
{
    const savesBefore = savedToDisk;
    const already = JSON.stringify(NEW_DATA);
    const img = setup({
        message: { mes: `<img data-iig-instruction='${already}' src="${SRC_PATH}">` },
        domHtml: `<img data-iig-instruction='${already}' src="${SRC_PATH}">`,
    });

    const res = await persistInstruction({
        targetEl: img,
        rawDom: img.getAttribute('data-iig-instruction'),
        newData: NEW_DATA,
    });

    check('без правок: ok=true', res.ok, true);
    check('без правок: метод не dom-only', res.method, 'exact');
    check('без правок: чат сохранён', savedToDisk, savesBefore + 1);
    check('без правок: текст остался корректным', chat[0].mes.includes('new prompt'), true);
}

// ── 6. То же самое, но через anchored (в тексте другая форма кавычек) ───────────
{
    const already = JSON.stringify(NEW_DATA);
    const img = setup({
        // В тексте JSON записан с пробелами — точные формы не совпадут, пойдёт anchored,
        // и подстановка даст ровно ту же строку, что уже там.
        message: { mes: `<img data-iig-instruction='{"prompt": "new prompt", "style": "anime"}' src="${SRC_PATH}">` },
        domHtml: `<img data-iig-instruction='${already}' src="${SRC_PATH}">`,
    });

    const res = await persistInstruction({
        targetEl: img,
        rawDom: img.getAttribute('data-iig-instruction'),
        newData: NEW_DATA,
    });

    check('без правок (anchored): ok=true', res.ok, true);
    check('без правок (anchored): метод', res.method, 'anchored');
}

let failed = 0;
for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ожидалось ${JSON.stringify(r.expected)}, получено ${JSON.stringify(r.actual)}`}`);
}
console.log(`\n${results.length - failed}/${results.length} проверок прошло`);
process.exit(failed ? 1 : 0);
