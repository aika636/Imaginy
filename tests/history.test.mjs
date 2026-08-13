// Тест истории промпта (src/history.js) и её записи через persist (src/persist.js).
//
// Запуск из корня репозитория:
//   npm install --no-save jsdom
//   node tests/history.test.mjs
//
// Три ловушки из плана, которые здесь и проверяются:
//   * история ложится в extra текущего свайпа и НЕ размножается по чужим свайпам —
//     у них свой текст со своими картинками;
//   * версий не больше предела: промпты бывают по 2-4 КБ, а картинок в чате сотни;
//   * промпт могли поменять мимо Imaginy — история обязана показать это честно, а не
//     притвориться, что все версии наши.
import { JSDOM } from 'jsdom';

const SRC = new URL('../src/', import.meta.url).pathname;

const dom = new JSDOM('<body><div id="chat"></div></body>', { url: 'http://localhost' });
global.window = dom.window;
global.document = dom.window.document;
global.Element = dom.window.Element;

let chat = [];
let saveChatCalls = 0;
global.SillyTavern = {
    getContext: () => ({
        chat,
        extensionSettings: {},
        eventSource: { on() {} },
        event_types: {},
        async saveChat() { saveChatCalls++; },
        saveChatDebounced() {},
    }),
};

const {
    HISTORY_LIMIT, markOf, imageIndexOf, readHistory, readHistoryFor, isForeignEdit, recordHistory,
} = await import(`${SRC}history.js`);
const { persistInstruction } = await import(`${SRC}persist.js`);

const results = [];
function check(name, actual, expected) {
    results.push({ name, ok: Object.is(actual, expected), actual, expected });
}
function checkDeep(name, actual, expected) {
    results.push({
        name,
        ok: JSON.stringify(actual) === JSON.stringify(expected),
        actual,
        expected,
    });
}

const instr = (prompt) => `data-iig-instruction='{"prompt":"${prompt}"}'`;
const tag = (prompt, src) => `<img ${instr(prompt)} src="${src}">`;

// ── 1. Метка текущего промпта ──────────────────────────────────────────────────
// Метка заменяет копию промпта: она отвечает на единственный вопрос — тот ли это
// текст, который мы записали. Значит, обязана совпадать сама с собой и расходиться на
// изменённом тексте, в том числе на кириллице и на длинном промпте.
{
    check('метка: устойчива', markOf('a cat'), markOf('a cat'));
    check('метка: другой текст — другая метка', markOf('a cat') === markOf('a dog'), false);
    check('метка: кириллица', markOf('кот на окне') === markOf('кот на столе'), false);
    check('метка: пустой промпт и undefined совпадают', markOf(''), markOf(undefined));
    const long = 'x'.repeat(4000);
    check('метка: длинный промпт не ломает счёт', markOf(long) === markOf(`${long}y`), false);
}

// ── 2. Номер картинки внутри сообщения ─────────────────────────────────────────
// Ключ истории — порядковый номер, а не путь к файлу: путь меняется при каждой
// перегенерации (см. srcsync.js), и история потерялась бы ровно тогда, когда нужна.
{
    document.getElementById('chat').innerHTML = `
        <div class="mes" mesid="0"><div class="mes_text">
            ${tag('первый', 'a.png')} текст ${tag('второй', 'b.png')}
        </div></div>`;
    const imgs = document.querySelectorAll('#chat img[data-iig-instruction]');
    check('номер: первая картинка', imageIndexOf(imgs[0]), 0);
    check('номер: вторая картинка', imageIndexOf(imgs[1]), 1);

    const orphan = document.createElement('img');
    orphan.setAttribute('data-iig-instruction', '{}');
    check('номер: элемент вне .mes_text', imageIndexOf(orphan), -1);
    check('номер: null', imageIndexOf(null), -1);
}

// ── 3. Запись и чтение ─────────────────────────────────────────────────────────
{
    const message = { mes: 'текст', extra: {} };

    recordHistory(message, 0, { before: 'версия 1', after: 'версия 2' });
    checkDeep('запись: прошлый промпт лёг в историю', readHistory(message, 0).versions, ['версия 1']);
    check('запись: метка соответствует новому промпту',
        isForeignEdit(readHistory(message, 0), 'версия 2'), false);

    recordHistory(message, 0, { before: 'версия 2', after: 'версия 3' });
    checkDeep('запись: свежая версия впереди',
        readHistory(message, 0).versions, ['версия 2', 'версия 1']);

    // Соседняя картинка того же сообщения — своя история, чужую она не видит.
    recordHistory(message, 1, { before: 'другая картинка', after: 'её новый промпт' });
    checkDeep('запись: у второй картинки своя история',
        readHistory(message, 1).versions, ['другая картинка']);
    checkDeep('запись: история первой не пострадала',
        readHistory(message, 0).versions, ['версия 2', 'версия 1']);

    check('чтение: у незнакомой картинки история пуста', readHistory(message, 7).versions.length, 0);
    check('чтение: отрицательный номер', readHistory(message, -1).versions.length, 0);
    check('чтение: без сообщения', readHistory(null, 0).versions.length, 0);
}

// ── 4. Предел числа версий ─────────────────────────────────────────────────────
// Размер файла чата — причина, по которой хранится 2-3 версии, а не «вся история».
{
    const message = { mes: 'текст', extra: {} };
    for (let i = 1; i <= HISTORY_LIMIT + 3; i++) {
        recordHistory(message, 0, { before: `промпт ${i}`, after: `промпт ${i + 1}` });
    }
    const versions = readHistory(message, 0).versions;
    check('предел: версий не больше лимита', versions.length, HISTORY_LIMIT);
    check('предел: самая свежая — первая', versions[0], `промпт ${HISTORY_LIMIT + 3}`);
    check('предел: самая старая вытеснена', versions.includes('промпт 1'), false);
}

// ── 5. Повторное сохранение без правки промпта ─────────────────────────────────
// Открыл окно, поменял только стиль, сохранил — промпт тот же. Если бы такие
// сохранения попадали в историю, три «прошлые версии» оказались бы одним и тем же
// текстом, а настоящие прошлые промпты вытеснились бы за предел.
{
    const message = { mes: 'текст', extra: {} };
    recordHistory(message, 0, { before: 'один', after: 'два' });
    recordHistory(message, 0, { before: 'два', after: 'два' });
    recordHistory(message, 0, { before: 'два', after: 'два' });
    checkDeep('без правки: история не растёт', readHistory(message, 0).versions, ['один']);

    // Пустой промпт возвращать некуда — в историю он не идёт.
    recordHistory(message, 1, { before: '   ', after: 'что-то' });
    check('пустой промпт в историю не идёт', readHistory(message, 1).versions.length, 0);
}

// ── 6. Свайпы ──────────────────────────────────────────────────────────────────
// История ложится в текущий свайп и в сам объект сообщения — и никуда больше. Чужой
// свайп это другой текст с другими картинками: приписать ему наши версии промпта
// значило бы соврать (тот же довод, что про чужие свайпы в srcsync.js).
{
    const message = {
        mes: 'текущий свайп',
        extra: {},
        swipes: ['первый свайп', 'текущий свайп'],
        swipe_id: 1,
        swipe_info: [{ extra: {} }, { extra: {} }],
    };

    recordHistory(message, 0, { before: 'старый промпт', after: 'новый промпт' });

    checkDeep('свайпы: extra сообщения',
        message.extra.imaginy.promptHistory['0'].versions, ['старый промпт']);
    checkDeep('свайпы: текущий свайп',
        message.swipe_info[1].extra.imaginy.promptHistory['0'].versions, ['старый промпт']);
    check('свайпы: чужой свайп не тронут', message.swipe_info[0].extra.imaginy, undefined);

    // Массивы версий в разных местах — разные объекты: иначе правка одного места
    // молча меняла бы другое, включая то, что уедет в чужой свайп при клонировании.
    check('свайпы: массивы не общие по ссылке',
        message.extra.imaginy.promptHistory['0'].versions
            === message.swipe_info[1].extra.imaginy.promptHistory['0'].versions,
        false);

    // Свайп туда-обратно: SillyTavern восстанавливает extra сообщения из swipe_info.
    // История обязана пережить это, иначе запись только в message.extra была бы
    // бесполезной.
    message.extra = JSON.parse(JSON.stringify(message.swipe_info[1].extra));
    checkDeep('свайпы: история пережила свайп туда-обратно',
        readHistory(message, 0).versions, ['старый промпт']);
}

// ── 7. Чужая правка ────────────────────────────────────────────────────────────
// Промпт могли поменять руками через редактор сообщения ST или в другом форке.
// История это видит по метке и обязана сказать честно.
{
    const message = { mes: 'текст', extra: {} };
    recordHistory(message, 0, { before: 'было', after: 'стало' });

    check('чужая правка: наш промпт — не чужая',
        isForeignEdit(readHistory(message, 0), 'стало'), false);
    check('чужая правка: промпт поменяли мимо нас',
        isForeignEdit(readHistory(message, 0), 'кто-то переписал'), true);
    check('чужая правка: без истории не выдумываем',
        isForeignEdit({ versions: [], mark: null }, 'что угодно'), false);
}

// ── 8. readHistoryFor: то, что видит редактор ──────────────────────────────────
{
    chat = [{ mes: `Смотри: ${tag('новый', 'a.png')}`, extra: {} }];
    document.getElementById('chat').innerHTML = `
        <div class="mes" mesid="0"><div class="mes_text">${tag('новый', 'a.png')}</div></div>`;
    const img = document.querySelector('#chat img[data-iig-instruction]');

    checkDeep('редактор: пока истории нет — пусто',
        readHistoryFor(img, 'новый'), { versions: [], foreign: false });

    recordHistory(chat[0], 0, { before: 'старый', after: 'новый' });
    checkDeep('редактор: версия и отсутствие чужой правки',
        readHistoryFor(img, 'новый'), { versions: ['старый'], foreign: false });
    checkDeep('редактор: чужая правка видна',
        readHistoryFor(img, 'подменённый'), { versions: ['старый'], foreign: true });

    // Картинка вне чата (сообщение не найдено) не должна ронять редактор.
    const orphan = document.createElement('img');
    orphan.setAttribute('data-iig-instruction', '{}');
    checkDeep('редактор: картинка без сообщения',
        readHistoryFor(orphan, 'что угодно'), { versions: [], foreign: false });
}

// ── 9. Запись через persist: история и шесть мест хранения ─────────────────────
// Главная проверка ветки: история пишется тем же вызовом, что и промпт, и не мешает
// записи текста ни в одно из шести мест хранения.
{
    const rawDom = '{"prompt":"старый промпт"}';
    const domAttr = `data-iig-instruction='${rawDom}'`;
    const text = `Смотри: <img ${domAttr} src="pic.png">`;
    chat = [{
        mes: text,
        extra: { display_text: text, extblocks: text },
        swipes: ['чужой свайп', text],
        swipe_id: 1,
        swipe_info: [{ extra: { display_text: 'чужой свайп' } }, { extra: { display_text: text, extblocks: text } }],
    }];
    document.getElementById('chat').innerHTML = `
        <div class="mes" mesid="0"><div class="mes_text">
            <img ${domAttr} src="pic.png">
        </div></div>`;
    const img = document.querySelector('#chat img[data-iig-instruction]');

    saveChatCalls = 0;
    const res = await persistInstruction({
        targetEl: img,
        rawDom,
        newData: { prompt: 'новый промпт' },
        prevData: { prompt: 'старый промпт' },
    });

    check('persist: сохранение удалось', res.ok, true);
    check('persist: чат сохранён один раз', saveChatCalls, 1);

    const message = chat[0];
    const hasNew = (s) => typeof s === 'string' && s.includes('новый промпт');
    check('persist: mes', hasNew(message.mes), true);
    check('persist: extra.display_text', hasNew(message.extra.display_text), true);
    check('persist: extra.extblocks', hasNew(message.extra.extblocks), true);
    check('persist: swipes[текущий]', hasNew(message.swipes[1]), true);
    check('persist: swipe_info.display_text', hasNew(message.swipe_info[1].extra.display_text), true);
    check('persist: swipe_info.extblocks', hasNew(message.swipe_info[1].extra.extblocks), true);

    checkDeep('persist: прошлый промпт записан в историю',
        readHistory(message, 0).versions, ['старый промпт']);
    check('persist: история не уехала в чужой свайп',
        message.swipe_info[0].extra.imaginy, undefined);
    check('persist: чужой свайп текстом не тронут', hasNew(message.swipes[0]), false);

    // Второе сохранение: история накапливается, а не перезаписывается.
    const rawDom2 = '{"prompt":"новый промпт"}';
    document.querySelector('#chat img').setAttribute('data-iig-instruction', rawDom2);
    await persistInstruction({
        targetEl: document.querySelector('#chat img'),
        rawDom: rawDom2,
        newData: { prompt: 'третий промпт' },
        prevData: { prompt: 'новый промпт' },
    });
    checkDeep('persist: вторая правка добавила версию',
        readHistory(chat[0], 0).versions, ['новый промпт', 'старый промпт']);
}

// ── 10. Инструкция не найдена в тексте ─────────────────────────────────────────
// Правка осталась только в DOM: обещать «прошлую версию» в этом случае нельзя —
// сохранённого промпта, к которому её привязывать, в чате нет.
{
    chat = [{ mes: 'сообщение без картинок', extra: {} }];
    document.getElementById('chat').innerHTML = `
        <div class="mes" mesid="0"><div class="mes_text">
            <img data-iig-instruction='{"prompt":"чужой"}' src="ghost.png">
        </div></div>`;
    const img = document.querySelector('#chat img[data-iig-instruction]');

    const res = await persistInstruction({
        targetEl: img,
        rawDom: '{"prompt":"чужой"}',
        newData: { prompt: 'новый' },
        prevData: { prompt: 'чужой' },
    });

    check('dom-only: сохранение не удалось', res.ok, false);
    check('dom-only: история не записана', chat[0].extra.imaginy, undefined);
}

let failed = 0;
for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ожидалось ${JSON.stringify(r.expected)}, получено ${JSON.stringify(r.actual)}`}`);
}
console.log(`\n${results.length - failed}/${results.length} проверок прошло`);
process.exit(failed ? 1 : 0);
