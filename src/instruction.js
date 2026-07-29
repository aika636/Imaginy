// Чтение/парсинг/сериализация атрибута data-iig-instruction.
//
// Модуль намеренно не трогает DOM на уровне импорта (никаких обращений к document
// вне функций) — это позволяет смоук-тестировать его под голым node без браузера
// (см. задачу Фазы 3, раздел «Верификация»).

import { warnOnce } from './log.js';

// Декодирование HTML-энтити в точности как делает SLAY при чтении атрибута
// (upstream/index.js ~3698-3709, ~4196): порядок важен только в смысле, что все
// пять замен независимы (не пересекаются по результату), поэтому порядок как в
// апстриме сохранён дословно.
export function decodeEntities(str) {
    return String(str ?? '')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#34;/g, '"')
        .replace(/&amp;/g, '&');
}

// Порт upstream decodeNumericEntities (upstream/index.js ~3886). ST энтити-кодирует
// не-ASCII внутри атрибута при сохранении/рендере — кириллица приезжает как
// "&#1040;&#1085;...". SLAY чинит это на уровне значения промпта уже после
// JSON.parse, а не на уровне атрибута целиком; Imaginy повторяет это же место
// применения (см. ниже, readInstruction).
export function decodeNumericEntities(str) {
    if (typeof str !== 'string' || str.indexOf('&#') === -1) return str;
    return str
        .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => {
            try {
                return String.fromCodePoint(parseInt(h, 16));
            } catch (err) {
                return m;
            }
        })
        .replace(/&#(\d+);/g, (m, d) => {
            try {
                return String.fromCodePoint(parseInt(d, 10));
            } catch (err) {
                return m;
            }
        });
}

// Читает и разбирает data-iig-instruction с элемента. Возвращает
// { rawDom, data } | null. rawDom — сырое, ничем не тронутое значение атрибута:
// это ключ поиска, по которому persist.js ищет инструкцию в тексте сообщения.
export function readInstruction(el) {
    let rawDom;
    try {
        rawDom = el?.getAttribute?.('data-iig-instruction');
    } catch (err) {
        warnOnce('instruction-read-failed', 'readInstruction: getAttribute упал', err);
        return null;
    }
    if (typeof rawDom !== 'string' || rawDom.length === 0) return null;

    const decoded = decodeEntities(rawDom);
    let data = null;
    try {
        data = JSON.parse(decoded);
    } catch (err) {
        // Тот же фолбэк, что у SLAY (upstream 3698-3709): некоторые модели пишут JSON
        // с одинарными кавычками вместо двойных.
        try {
            data = JSON.parse(decoded.replace(/'/g, '"'));
        } catch (err2) {
            warnOnce(
                'instruction-parse-failed',
                'readInstruction: не удалось распарсить data-iig-instruction',
                err2,
            );
            return null;
        }
    }

    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        warnOnce(
            'instruction-parse-failed',
            'readInstruction: data-iig-instruction распарсился не в объект',
        );
        return null;
    }

    // decodeNumericEntities применяется здесь, а не к rawDom целиком: rawDom должен
    // остаться байт-в-байт тем, что реально лежит в атрибуте (это ключ поиска в
    // тексте сообщения), а числовые энтити внутри значений (кириллица) нужно
    // раскодировать только для показа пользователю в редакторе — так же, как SLAY
    // раскодирует их только на уровне значения промпта, а не атрибута.
    for (const key of Object.keys(data)) {
        if (typeof data[key] === 'string') {
            data[key] = decodeNumericEntities(data[key]);
        }
    }

    return { rawDom, data };
}

// То, что уходит в el.setAttribute(...). setAttribute принимает неэкранированное
// значение — HTML-парсер здесь не участвует, поэтому просто JSON.
export function serializeForDom(data) {
    return JSON.stringify(data);
}

// То, что уходит в текст сообщения, где SLAY пишет атрибут в одинарных кавычках
// (upstream 3854, 4428): "'" сломает атрибут, поэтому его нужно заэкранировать.
//
// Порядок замен load-bearing: сначала '&', потом "'". Если поменять местами, "&",
// который мы сами вносим при экранировании "'" в "&#39;", тут же попадёт под замену
// "&" -> "&amp;" и превратится в "&amp;#39;" (двойное экранирование, decodeEntities
// его не раскрутит обратно в "'").
//
// '"' намеренно НЕ экранируется: атрибут одинарный, а JSON использует '"' как
// служебный символ синтаксиса — если превратить их в &quot;, JSON.parse после
// decodeEntities увидит буквальные &quot; внутри строки и не сможет распарсить.
//
// '<' и '>' тоже намеренно НЕ экранируются: они легальны внутри HTML-атрибута в
// кавычках, а decodeEntities не содержит правил &lt;/&gt; (см. docs/sillytavern-api.md
// §2.3) — если бы мы их экранировали, обратное decodeEntities не раскрутило бы их
// назад, и промпт, ушедший в API генерации, оказался бы испорчен буквальными
// "&lt;"/"&gt;".
export function escapeForText(json) {
    return json.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
}

export function serializeForText(data) {
    return escapeForText(serializeForDom(data));
}
