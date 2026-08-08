// Тест чтения и разбора атрибута data-iig-instruction (src/instruction.js) под jsdom.
//
// Запуск из корня репозитория:
//   npm install --no-save jsdom
//   node tests/instruction.test.mjs
//
// Атрибут — единственный контракт между Imaginy и всеми четырьмя расширениями-хостами
// (см. src/hosts/common.js: ATTR, ключи prompt / style / aspect_ratio), поэтому здесь
// проверяется именно поведение readInstruction на реальном DOM-элементе: что доезжает
// в data, что отдаётся в rawDom и что происходит на мусорном входе.
//
// Значения атрибута ставятся через setAttribute, а не через innerHTML: HTML-парсер сам
// раскодировал бы энтити ещё до нашего кода, и порт decodeEntities/decodeNumericEntities
// из хоста остался бы непокрытым.
import { JSDOM } from 'jsdom';

const SRC = new URL('../src/', import.meta.url).pathname;

const dom = new JSDOM('<body><div id="chat"></div></body>', { url: 'http://localhost' });
global.window = dom.window;
global.document = dom.window.document;
global.Element = dom.window.Element;

const {
    readInstruction,
    decodeEntities,
    decodeNumericEntities,
    serializeForDom,
    serializeForText,
    escapeForText,
} = await import(`${SRC}instruction.js`);

// warnOnce пишет в console.warn — глушим, чтобы вывод теста читался, но считаем
// сообщения: однократность предупреждений тоже часть контракта.
const warnings = [];
console.warn = (...args) => warnings.push(args.join(' '));

const results = [];
function check(name, actual, expected) {
    results.push({ name, ok: actual === expected, actual, expected });
}

// Элемент с атрибутом, поставленным «сырым» — ровно тем, что реально лежит в DOM.
function el(raw, { tag = 'img', attr = true } = {}) {
    const node = document.createElement(tag);
    if (attr) node.setAttribute('data-iig-instruction', raw);
    return node;
}

// ── 1. Валидный JSON: все поля доезжают ─────────────────────────────────────────
{
    const raw = '{"prompt":"a cat on a roof","style":"anime","aspect_ratio":"16:9"}';
    const r = readInstruction(el(raw));
    check('валидный JSON: результат не null', r !== null, true);
    check('валидный JSON: prompt', r.data.prompt, 'a cat on a roof');
    check('валидный JSON: style', r.data.style, 'anime');
    check('валидный JSON: aspect_ratio', r.data.aspect_ratio, '16:9');
    check('валидный JSON: набор ключей', Object.keys(r.data).join(','), 'prompt,style,aspect_ratio');
    check('валидный JSON: rawDom байт-в-байт', r.rawDom, raw);
    check('валидный JSON: форма ответа', Object.keys(r).sort().join(','), 'data,rawDom');

    // index.js:26-52 берёт из результата ровно два поля: data (в редактор) и rawDom
    // (ключ поиска для persist.js). Проверяем, что оба пригодны к употреблению.
    check('валидный JSON: data — обычный объект', Object.getPrototypeOf(r.data) === Object.prototype, true);
    check('валидный JSON: rawDom — строка', typeof r.rawDom, 'string');

    // Каждый вызов отдаёт свежий объект: редактор правит data по месту, и общий
    // на всех вызовов объект протёк бы правкой в соседнюю картинку.
    const node = el(raw);
    check('валидный JSON: data не переиспользуется', readInstruction(node).data === readInstruction(node).data, false);
}

// Лишние ключи хоста (у форков в атрибуте бывает больше полей) не теряются.
{
    const r = readInstruction(el('{"prompt":"p","style":"s","aspect_ratio":"1:1","seed":123,"model":"nai"}'));
    check('лишние ключи: seed сохранён', r.data.seed, 123);
    check('лишние ключи: model сохранён', r.data.model, 'nai');
}

// Пустой объект — валидный вход: это не «не смогли прочитать».
{
    const r = readInstruction(el('{}'));
    check('пустой объект: не null', r !== null, true);
    check('пустой объект: ключей нет', Object.keys(r.data).length, 0);
    check('пустой объект: rawDom сохранён', r.rawDom, '{}');
}

// ── 2. Носитель атрибута ────────────────────────────────────────────────────────
// readInstruction читает атрибут ТОЛЬКО с переданного элемента (getAttribute, без
// closest). Так и задумано: селекторы хостов (SEL_IMAGE/SEL_VIDEO в hosts/common.js)
// матчат сам носитель атрибута, а decorate.js кладёт в btn.__imaginyTarget именно его.
{
    const RAW = '{"prompt":"cat","style":"anime","aspect_ratio":"1:1"}';

    check('носитель: img', readInstruction(el(RAW, { tag: 'img' }))?.data.prompt, 'cat');
    check('носитель: video', readInstruction(el(RAW, { tag: 'video' }))?.data.prompt, 'cat');
    check('носитель: div-плашка ошибки', readInstruction(el(RAW, { tag: 'div' }))?.data.prompt, 'cat');

    // Атрибут на предке, а спрашиваем про потомка — null. Это не баг, а контракт:
    // цель декорации всегда сама несёт атрибут.
    const wrap = document.createElement('span');
    wrap.className = 'iig-img-wrap';
    wrap.setAttribute('data-iig-instruction', RAW);
    const inner = document.createElement('img');
    wrap.appendChild(inner);
    check('носитель: атрибут на предке — потомок не видит', readInstruction(inner), null);
    check('носитель: сама обёртка читается', readInstruction(wrap)?.data.prompt, 'cat');

    // Атрибут и на элементе, и на предке — приоритет у самого элемента.
    const wrap2 = document.createElement('span');
    wrap2.setAttribute('data-iig-instruction', '{"prompt":"предок"}');
    const img2 = document.createElement('img');
    img2.setAttribute('data-iig-instruction', '{"prompt":"потомок"}');
    wrap2.appendChild(img2);
    check('носитель: приоритет у самого элемента', readInstruction(img2).data.prompt, 'потомок');
    check('носитель: предок читается независимо', readInstruction(wrap2).data.prompt, 'предок');

    // Отцепленный от документа узел читается так же: readInstruction ничего не знает
    // про isConnected (это забота targetIsStale в hosts/common.js).
    const detached = el(RAW);
    check('носитель: отцепленный узел читается', readInstruction(detached)?.data.prompt, 'cat');
}

// ── 3. Мусор на входе: наружу ничего не бросается, возвращается null ────────────
function nothrow(fn) {
    try {
        return { threw: false, value: fn() };
    } catch (err) {
        return { threw: true, value: String(err) };
    }
}

{
    const cases = [
        ['атрибута нет', el('', { attr: false })],
        ['атрибут пустой', el('')],
        ['атрибут из пробелов', el('   ')],
        ['невалидный JSON', el('это не json')],
        ['обрезанный JSON', el('{"prompt":')],
        ['JSON с хвостовой запятой', el('{"prompt":"x",}')],
        ['JSON-число', el('42')],
        ['JSON-строка', el('"просто строка"')],
        ['JSON-массив', el('[{"prompt":"x"}]')],
        ['JSON-null', el('null')],
        ['JSON-true', el('true')],
        ['голый перевод строки в JSON-строке', el('{"prompt":"первая\nвторая"}')],
        ['el === null', null],
        ['el === undefined', undefined],
        ['el без getAttribute', {}],
        ['el.getAttribute вернул не строку', { getAttribute: () => 42 }],
        ['el.getAttribute вернул null', { getAttribute: () => null }],
        ['el.getAttribute бросает', { getAttribute() { throw new Error('boom'); } }],
    ];
    for (const [name, node] of cases) {
        const r = nothrow(() => readInstruction(node));
        check(`мусор (${name}): не бросает`, r.threw, false);
        check(`мусор (${name}): null`, r.value, null);
    }
}

// Фолбэк на одинарные кавычки (порт из SLAY): модель иногда пишет так.
{
    const r = readInstruction(el("{'prompt':'a cat','style':'anime'}"));
    check('одинарные кавычки: разобрано', r?.data.prompt, 'a cat');
    check('одинарные кавычки: rawDom остался исходным', r?.rawDom, "{'prompt':'a cat','style':'anime'}");
}

// Обратная сторона того же фолбэка: валидный JSON, который не разобрался с первого
// раза, второй попыткой калечится — апостроф внутри значения становится кавычкой.
// Здесь первая попытка проваливается из-за одинарных кавычек снаружи, а апостроф
// внутри значения превращает вход в мусор → null (а не в порченые данные).
{
    const r = readInstruction(el("{'prompt':'it's a cat'}"));
    check('фолбэк: апостроф внутри одинарных кавычек → null', r, null);
}

// Предупреждения однократны: второй провал разбора нового шума в консоль не даёт.
{
    const before = warnings.length;
    readInstruction(el('снова не json'));
    readInstruction(el('и ещё раз не json'));
    check('warnOnce: повторные провалы разбора молчат', warnings.length, before);
    check('warnOnce: предупреждение о разборе всё-таки было', warnings.some((w) => w.includes('data-iig-instruction')), true);
}

// ── 4. Экранирование внутри атрибута ────────────────────────────────────────────
{
    // &amp; — единственная энтити, которая честно переживает круг: escapeForText
    // экранирует '&' первым, decodeEntities раскручивает его последним.
    const r = readInstruction(el('{"prompt":"Ben &amp; Jerry"}'));
    check('энтити &amp;: раскодирована', r?.data.prompt, 'Ben & Jerry');

    // Апостроф: хост пишет атрибут в одинарных кавычках, поэтому "'" уезжает энтитями.
    check('энтити &#39;: раскодирована', readInstruction(el('{"prompt":"it&#39;s"}'))?.data.prompt, "it's");
    check('энтити &apos;: раскодирована', readInstruction(el('{"prompt":"it&apos;s"}'))?.data.prompt, "it's");

    // Двойные кавычки в JSON-строке — обычное экранирование JSON, работает.
    check('JSON-экранирование кавычки', readInstruction(el('{"prompt":"say \\"hi\\""}'))?.data.prompt, 'say "hi"');

    // ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ (о нём предупреждает warnOnLiteralEntities в instruction.js):
    // буквальная &quot; раскодируется в '"' ДО JSON.parse и ломает разбор целиком.
    check('буквальная &quot; ломает разбор', readInstruction(el('{"prompt":"say &quot;hi&quot;"}')), null);
    check('буквальная &#34; ломает разбор', readInstruction(el('{"prompt":"say &#34;hi&#34;"}')), null);

    // Перевод строки и таб — только в экранированном JSON-виде.
    const nl = readInstruction(el('{"prompt":"первая\\nвторая\\tтретья"}'));
    check('перевод строки', nl?.data.prompt, 'первая\nвторая\tтретья');

    // Юникод: и напрямую, и \u-эскейпами, и числовыми энтитями ST.
    check('юникод напрямую', readInstruction(el('{"prompt":"кот 🐱 に"}'))?.data.prompt, 'кот 🐱 に');
    check('юникод \\u-эскейпом', readInstruction(el('{"prompt":"\\u043a\\u043e\\u0442"}'))?.data.prompt, 'кот');
    check('числовые энтити ST (десятичные)', readInstruction(el('{"prompt":"&#1082;&#1086;&#1090;"}'))?.data.prompt, 'кот');
    check('числовые энтити ST (hex)', readInstruction(el('{"prompt":"&#x43a;&#x43e;&#x442;"}'))?.data.prompt, 'кот');
    check('числовые энтити вне диапазона не роняют', nothrow(() => readInstruction(el('{"prompt":"&#99999999;"}'))).threw, false);
    check('числовые энтити вне диапазона остаются как есть', readInstruction(el('{"prompt":"&#99999999;"}'))?.data.prompt, '&#99999999;');

    // rawDom не трогается никаким декодированием — persist.js ищет по нему в тексте.
    const rawWithEntities = '{"prompt":"&#1082;&#1086;&#1090; &amp; &#39;"}';
    check('rawDom не декодируется', readInstruction(el(rawWithEntities))?.rawDom, rawWithEntities);

    // Декодирование числовых энтити — только у строковых значений верхнего уровня.
    const nested = readInstruction(el('{"meta":{"prompt":"&#1082;"},"&#1082;":"x"}'));
    check('числовые энтити: вложенные значения не декодируются', nested?.data.meta.prompt, '&#1082;');
    check('числовые энтити: ключи не декодируются', Object.keys(nested.data).includes('&#1082;'), true);

    // '<' и '>' намеренно не экранируются — они должны доезжать буквально.
    check('угловые скобки доезжают', readInstruction(el('{"prompt":"a <b>bold</b> cat"}'))?.data.prompt, 'a <b>bold</b> cat');
}

// Чистые функции декодирования — отдельно от DOM.
{
    check('decodeEntities: все пять замен', decodeEntities('&quot;&apos;&#39;&#34;&amp;'), '"\'\'"&');
    check('decodeEntities: null → пустая строка', decodeEntities(null), '');
    check('decodeEntities: число приводится к строке', decodeEntities(5), '5');
    check('decodeNumericEntities: без "&#" вход возвращается как есть', decodeNumericEntities('обычный текст'), 'обычный текст');
    check('decodeNumericEntities: не-строка возвращается как есть', decodeNumericEntities(42), 42);
}

// ── 5. Круг «сериализовать → положить в DOM/текст → прочитать» ──────────────────
{
    const data = { prompt: "кот с 'апострофом' & \"кавычками\" <тег>", style: 'anime', aspect_ratio: '3:2' };

    // Путь в DOM: setAttribute принимает неэкранированное значение.
    const node = el(serializeForDom(data));
    const back = readInstruction(node);
    check('круг DOM: prompt совпал', back?.data.prompt, data.prompt);
    check('круг DOM: aspect_ratio совпал', back?.data.aspect_ratio, '3:2');

    // Путь в текст сообщения: там атрибут пишется в одинарных кавычках, поэтому
    // "'" и "&" экранируются. После HTML-парсера значение атрибута — тот же escaped
    // текст (jsdom-парсер раскодирует его сам, поэтому здесь эмулируем именно
    // вариант, когда энтити доезжают до нас нетронутыми).
    const escaped = serializeForText(data);
    check('круг текст: апостроф заэкранирован', escaped.includes('&#39;'), true);
    check('круг текст: нет двойного экранирования', escaped.includes('&amp;#39;'), false);
    check('круг текст: кавычки JSON не тронуты', escaped.includes('&quot;'), false);
    check('круг текст: прочитано обратно', readInstruction(el(escaped))?.data.prompt, data.prompt);
    check('escapeForText: порядок замен', escapeForText(`&'`), '&amp;&#39;');

    // Через настоящий HTML-парсер (как это происходит в живом чате) — тоже читается.
    document.getElementById('chat').innerHTML =
        `<div class="mes"><div class="mes_text"><img data-iig-instruction='${escaped}' src="/a.png"></div></div>`;
    const fromHtml = readInstruction(document.querySelector('img[data-iig-instruction]'));
    check('круг через HTML-парсер: prompt совпал', fromHtml?.data.prompt, data.prompt);
}

// ── 6. Крайние случаи ───────────────────────────────────────────────────────────
{
    // Очень длинный промпт.
    const long = 'очень длинный промпт '.repeat(10000);
    const r = readInstruction(el(JSON.stringify({ prompt: long, style: 's' })));
    check('длинный промпт: длина сохранена', r?.data.prompt.length, long.length);
    check('длинный промпт: содержимое сохранено', r?.data.prompt === long, true);

    // Неожиданные типы: readInstruction ничего не нормализует — что было, то и отдаёт.
    const typed = readInstruction(el('{"prompt":42,"style":null,"aspect_ratio":true,"tags":["a"],"meta":{"k":1}}'));
    check('типы: число не приводится к строке', typed?.data.prompt, 42);
    check('типы: null сохраняется', typed?.data.style, null);
    check('типы: boolean сохраняется', typed?.data.aspect_ratio, true);
    check('типы: массив сохраняется', JSON.stringify(typed?.data.tags), '["a"]');
    check('типы: вложенный объект сохраняется', typed?.data.meta.k, 1);

    // Дубли ключей в JSON — побеждает последний (поведение JSON.parse).
    check('дубль ключа: побеждает последний', readInstruction(el('{"prompt":"a","prompt":"b"}'))?.data.prompt, 'b');

    // Ключ __proto__ не должен ломать объект-результат.
    const proto = nothrow(() => readInstruction(el('{"__proto__":{"x":1},"prompt":"p"}')));
    check('__proto__ в JSON: не бросает', proto.threw, false);
    check('__proto__ в JSON: prompt читается', proto.value?.data.prompt, 'p');
    check('__proto__ в JSON: прототип не отравлен', ({}).x, undefined);

    // BOM/пробелы вокруг JSON — JSON.parse пробелы терпит.
    check('пробелы вокруг JSON', readInstruction(el('  {"prompt":"p"}  '))?.data.prompt, 'p');
}

let failed = 0;
for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ожидалось ${JSON.stringify(r.expected)}, получено ${JSON.stringify(r.actual)}`}`);
}
console.log(`\n${results.length - failed}/${results.length} проверок прошло`);
process.exit(failed ? 1 : 0);
