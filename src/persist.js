// Запись изменённой инструкции обратно в сообщение (все места хранения текста)
// и в DOM. Единственное место, где Imaginy пишет в объект сообщения ST.

import { getCtx } from './ctx.js';
import { logInfo, logWarn } from './log.js';
import { escapeForText, serializeForDom, serializeForText } from './instruction.js';

// Обходит все места, где SLAY хранит текст сообщения — «пять мест» в терминах апстрима,
// шесть отдельных полей, если считать display_text и extblocks в swipe_info раздельно
// (docs/data-model.md). Дословный порт replaceImageSrcEverywhere (upstream/index.js
// ~3542-3574, задокументировано в docs/sillytavern-api.md §2.4); применяет
// transform(str) -> str к каждому полю.
// Возвращает true, если хотя бы одно место реально изменилось (transform вернул
// другую строку).
function walkMessageStrings(message, transform) {
    if (!message) return false;
    let changed = false;

    const apply = (str) => {
        if (typeof str !== 'string') return str;
        const next = transform(str);
        if (next !== str) changed = true;
        return next;
    };

    if (typeof message.mes === 'string') message.mes = apply(message.mes);

    if (message.extra) {
        if (typeof message.extra.display_text === 'string') {
            message.extra.display_text = apply(message.extra.display_text);
        }
        if (typeof message.extra.extblocks === 'string') {
            message.extra.extblocks = apply(message.extra.extblocks);
        }
    }

    if (Array.isArray(message.swipes)) {
        for (let i = 0; i < message.swipes.length; i++) {
            if (typeof message.swipes[i] === 'string') message.swipes[i] = apply(message.swipes[i]);
        }
    }

    if (Array.isArray(message.swipe_info)) {
        for (let i = 0; i < message.swipe_info.length; i++) {
            const si = message.swipe_info[i];
            if (si?.extra) {
                if (typeof si.extra.display_text === 'string') si.extra.display_text = apply(si.extra.display_text);
                if (typeof si.extra.extblocks === 'string') si.extra.extblocks = apply(si.extra.extblocks);
            }
        }
    }

    return changed;
}

// Все вхождения substring -> replacement в строке (аналог upstream str.split(old).join(new)).
function replaceAll(str, search, replacement) {
    if (!search) return str;
    return str.split(search).join(replacement);
}

// Порт брейс-каунтинг алгоритма извлечения JSON (upstream/index.js ~4161-4169,
// api doc §2.5), дословно. text[jsonStart] должен быть '{'.
export function extractJsonSpan(text, jsonStart) {
    let braceCount = 0;
    let jsonEnd = -1;
    let inString = false;
    let escapeNext = false;
    for (let i = jsonStart; i < text.length; i++) {
        const char = text[i];
        if (escapeNext) {
            escapeNext = false;
            continue;
        }
        if (char === '\\' && inString) {
            escapeNext = true;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (!inString) {
            if (char === '{') {
                braceCount++;
            } else if (char === '}') {
                braceCount--;
                if (braceCount === 0) {
                    jsonEnd = i + 1;
                    break;
                }
            }
        }
    }
    return jsonEnd; // -1, если не нашли
}

// Стратегия "anchored": находит тег по src, внутри тега — атрибут
// data-iig-instruction, вырезает его JSON-значение брейс-каунтингом и заменяет на
// textAfter. Повторяет для каждого вхождения src в строке. Возвращает новую строку
// (или ту же, если ничего не поменялось).
function anchoredReplace(str, src, textAfter) {
    if (!src) return str;
    let result = str;
    let searchFrom = 0;

    // Работаем по копии, которую пересобираем по мере замен, чтобы индексы не съезжали.
    while (true) {
        const srcIdx = result.indexOf(src, searchFrom);
        if (srcIdx === -1) break;

        const tagStart = result.lastIndexOf('<', srcIdx);
        if (tagStart === -1) {
            searchFrom = srcIdx + src.length;
            continue;
        }
        const tagEnd = result.indexOf('>', srcIdx);
        if (tagEnd === -1) {
            searchFrom = srcIdx + src.length;
            continue;
        }

        const tagSlice = result.slice(tagStart, tagEnd + 1);
        const attrMatch = /data-iig-instruction\s*=\s*/.exec(tagSlice);
        if (!attrMatch) {
            searchFrom = srcIdx + src.length;
            continue;
        }

        const attrValueStartInTag = attrMatch.index + attrMatch[0].length;
        const jsonStartInTag = tagSlice.indexOf('{', attrValueStartInTag);
        if (jsonStartInTag === -1) {
            searchFrom = srcIdx + src.length;
            continue;
        }

        const jsonEndInTag = extractJsonSpan(tagSlice, jsonStartInTag);
        if (jsonEndInTag === -1) {
            searchFrom = srcIdx + src.length;
            continue;
        }

        const jsonStart = tagStart + jsonStartInTag;
        const jsonEnd = tagStart + jsonEndInTag;

        result = result.slice(0, jsonStart) + textAfter + result.slice(jsonEnd);
        // Продолжаем поиск после только что вставленного текста.
        searchFrom = jsonStart + textAfter.length;
    }

    return result;
}

// Обновляет data-iig-instruction на каждом элементе DOM, у которого текущее
// значение атрибута байт-в-байт равно rawDom. Делается всегда, независимо от
// исхода записи в текст сообщения — это то, что даёт последующему программному
// клику по .iig-regen-btn подхватить новый промпт (upstream 3813-3821).
function updateDomCopies(rawDom, domAfter) {
    let count = 0;
    try {
        document.querySelectorAll('[data-iig-instruction]').forEach((el) => {
            if (el.getAttribute('data-iig-instruction') === rawDom) {
                el.setAttribute('data-iig-instruction', domAfter);
                count++;
            }
        });
    } catch (err) {
        logWarn('updateDomCopies: querySelectorAll упал', err);
    }
    return count;
}

// persistInstruction({ targetEl, rawDom, newData }) -> Promise<{ ok, method, savedToDisk }>
export async function persistInstruction({ targetEl, rawDom, newData }) {
    const mesEl = targetEl?.closest?.('.mes');
    const mesid = mesEl ? Number.parseInt(mesEl.getAttribute('mesid'), 10) : NaN;

    const ctx = getCtx();
    const message = Number.isInteger(mesid) ? ctx.chat?.[mesid] : null;

    const textAfter = serializeForText(newData);
    const domAfter = serializeForDom(newData);

    let method = 'dom-only';
    let textChanged = false;

    if (message) {
        // 1. exact — rawDom как он есть.
        textChanged = walkMessageStrings(message, (str) => replaceAll(str, rawDom, textAfter));
        if (textChanged) {
            method = 'exact';
        } else {
            // 2. escaped — getAttribute отдаёт декодированное значение, а в тексте
            // сообщения лежит экранированная форма. На любом промпте с "'" или "&"
            // это не редкий фолбэк, а основной путь.
            const rawEscaped = escapeForText(rawDom);
            textChanged = walkMessageStrings(message, (str) => replaceAll(str, rawEscaped, textAfter));
            if (textChanged) {
                method = 'escaped';
            } else if (
                // 2b. quote-only — случай, когда в тексте уже лежат числовые энтити
                // (ST кодирует ими кириллицу, docs/sillytavern-api.md §2.3).
                // decodeEntities их не трогает, поэтому в rawDom они остаются как
                // "&#1040;" — и escapeForText превратил бы их "&" в "&amp;",
                // сломав совпадение. Здесь экранируем только апостроф.
                walkMessageStrings(message, (str) => replaceAll(str, rawDom.replace(/'/g, '&#39;'), textAfter))
            ) {
                textChanged = true;
                method = 'escaped-quotes';
            } else {
                // 3. anchored — по src тега, брейс-каунтингом.
                const src = targetEl?.getAttribute?.('src');
                if (src) {
                    textChanged = walkMessageStrings(message, (str) => anchoredReplace(str, src, textAfter));
                    if (textChanged) method = 'anchored';
                }
            }
        }
    }

    // DOM обновляем всегда, независимо от исхода записи в текст.
    const domCount = updateDomCopies(rawDom, domAfter);

    if (!message || !textChanged) {
        logWarn(
            `persistInstruction: инструкция не найдена в тексте сообщения (dom-only, обновлено DOM-копий: ${domCount})`,
        );
        return { ok: false, method: 'dom-only', savedToDisk: false };
    }

    let savedToDisk = false;
    try {
        await ctx.saveChat();
        savedToDisk = true;
    } catch (err) {
        logWarn('persistInstruction: ctx.saveChat() упал, фолбэк на saveChatDebounced', err);
        try {
            ctx.saveChatDebounced?.();
        } catch (err2) {
            logWarn('persistInstruction: saveChatDebounced тоже упал', err2);
        }
    }

    logInfo(`инструкция записана (method=${method}, DOM-копий обновлено: ${domCount})`);

    return { ok: true, method, savedToDisk };
}
