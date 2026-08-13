// Запись изменённой инструкции обратно в сообщение (все места хранения текста)
// и в DOM. Единственное место, где Imaginy пишет в объект сообщения ST.

import { getCtx } from './ctx.js';
import { logInfo, logWarn } from './log.js';
import { escapeForText, serializeForDom, serializeForText } from './instruction.js';
import { imageIndexOf, recordHistory } from './history.js';

// Обходит все места, где хост хранит текст сообщения — «пять мест» в его терминах,
// шесть отдельных полей, если считать display_text и extblocks в swipe_info раздельно.
// Дословный порт replaceImageSrcEverywhere из хоста; применяет
// transform(str) -> str к каждому полю.
// Возвращает true, если хотя бы одно место реально изменилось (transform вернул
// другую строку).
export function walkMessageStrings(message, transform) {
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

// Меняет путь к картинке во всех местах хранения текста сообщения.
// Нужна там, где хост обновил src не везде: SLAY при перегенерации всего сообщения
// пишет новый путь только в message.mes (upstream index.js:4604), и при следующей
// отрисовке из любого другого места возвращается предыдущая картинка.
// Замена подстрочная, как у хоста (upstream replaceImageSrcEverywhere): путь файла
// уникален, и если он встретился в чужом свайпе — там та же картинка, её тоже надо
// обновить. Возвращает true, если хоть одно место изменилось.
export function replaceSrcEverywhere(message, oldSrc, newSrc) {
    if (!message || !oldSrc || !newSrc || oldSrc === newSrc) return false;
    return walkMessageStrings(message, (str) => (
        str.includes(oldSrc) ? replaceAll(str, oldSrc, newSrc) : str
    ));
}

// Дословный порт брейс-каунтинг алгоритма извлечения JSON из хоста.
// text[jsonStart] должен быть '{'.
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

// Верхняя граница числа замен в одной строке. Реально в сообщении единицы картинок,
// так что предел недостижим; он существует только как последний предохранитель от
// зацикливания — цена ошибки здесь не «не сохранилось», а намертво повешенная вкладка
// (главный поток занят), из которой пользователь выходит только закрытием таверны.
const ANCHORED_MAX_PASSES = 500;

// Стратегия "anchored": находит тег по src, внутри тега — атрибут
// data-iig-instruction, вырезает его JSON-значение брейс-каунтингом и заменяет на
// textAfter. Повторяет для каждого вхождения src в строке. Возвращает новую строку
// Возвращает { result, hits } — hits считает найденные и переписанные атрибуты,
// в том числе когда новое значение совпало со старым (повторное сохранение без
// правок): «нашли» и «изменили» — разные вещи, см. persistInstruction.
function anchoredReplace(str, src, textAfter) {
    if (!src) return { result: str, hits: 0 };
    let result = str;
    let searchFrom = 0;
    let passes = 0;
    let hits = 0;

    // Работаем по копии, которую пересобираем по мере замен, чтобы индексы не съезжали.
    while (true) {
        if (++passes > ANCHORED_MAX_PASSES) {
            logWarn(`anchoredReplace: превышен предел в ${ANCHORED_MAX_PASSES} замен — прерываю`);
            break;
        }
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
        hits++;

        // Продолжаем поиск ЗА концом только что переписанного тега, а не за концом
        // вставленного JSON. Канонический порядок атрибутов у SLAY —
        // `<img data-iig-instruction='{...}' src="...">`, то есть
        // JSON стоит ПЕРЕД src. Прежняя точка (`jsonStart + textAfter.length`) оказывалась
        // левее найденного src, следующая итерация находила тот же src, переписывала тот
        // же атрибут тем же значением — и так вечно: главный поток вставал намертво, и
        // таверну приходилось закрывать. Max с текущей позицией гарантирует, что курсор
        // всегда двигается вперёд, даже если новый JSON сильно короче старого.
        const tagLengthAfter = tagSlice.length + textAfter.length - (jsonEndInTag - jsonStartInTag);
        searchFrom = Math.max(searchFrom + 1, tagStart + tagLengthAfter);
    }

    return { result, hits };
}

// ST энтити-кодирует не-ASCII в тексте сообщения десятичными энтити: кириллический
// промпт лежит в чате как "&#1040;&#1085;...", а getAttribute отдаёт его уже
// раскодированным. Без этой формы поиска ни одна из
// точных стратегий не совпадала на русском промпте, и запись всегда сваливалась в
// anchored.
function encodeNonAscii(str) {
    return str.replace(/[\u{80}-\u{10FFFF}]/gu, (ch) => `&#${ch.codePointAt(0)};`);
}

// Одна функция замены на все места хранения текста.
//
// Формы записи инструкции подбираются ДЛЯ КАЖДОГО ПОЛЯ ОТДЕЛЬНО, а не одна на всё
// сообщение. Раньше стратегии перебирались снаружи: первая, что изменила хоть одно
// поле, объявлялась победившей, и обход останавливался — а поля хранятся в разных
// формах (mes может лежать как есть, а extra.display_text — в экранированной или
// энтити-кодированной). В итоге часть мест хранения оставалась со старой инструкцией:
// расширение картинок перегенерировало по новому промпту, но стоило SillyTavern
// перерисовать сообщение из непочиненного поля — и в DOM возвращалась старая
// инструкция. Хост после генерации ищет свою картинку в DOM по значению
// data-iig-instruction (upstream findLiveImgByInstruction, index.js:3654) — по старому
// значению он её не находит, кладёт новый src в отсоединённый узел, и картинка
// появляется в галерее, но на экране остаётся прежней.
//
// Возвращает { rewrite, methods, wasMatched } — methods и признак совпадения
// наполняются по ходу обхода.
function buildRewriter({ rawDom, textAfter, src }) {
    const methods = new Set();
    let matched = false;
    const forms = [
        ['exact', rawDom],
        // getAttribute отдаёт декодированное значение, а в тексте лежит экранированное.
        // На любом промпте с "'" или "&" это не редкий фолбэк, а основной путь.
        ['escaped', escapeForText(rawDom)],
        // Числовые энтити ST (кириллица) decodeEntities не трогает, поэтому в rawDom они
        // остались бы как "&#1040;" — escapeForText превратил бы их "&" в "&amp;" и сломал
        // совпадение. Здесь экранируем только апостроф.
        ['escaped-quotes', rawDom.replace(/'/g, '&#39;')],
        // Кириллица (и любой не-ASCII) в том виде, в каком её хранит ST.
        ['entities', encodeNonAscii(escapeForText(rawDom))],
    ];

    const rewrite = (str) => {
        for (const [name, needle] of forms) {
            if (!needle || !str.includes(needle)) continue;
            methods.add(name);
            matched = true;
            return replaceAll(str, needle, textAfter);
        }
        // Последний рубеж: находим тег по src и вырезаем JSON брейс-каунтингом.
        if (src) {
            const { result, hits } = anchoredReplace(str, src, textAfter);
            if (hits > 0) {
                methods.add('anchored');
                matched = true;
                return result;
            }
        }
        return str;
    };

    return { rewrite, methods, wasMatched: () => matched };
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

// persistInstruction({ targetEl, rawDom, newData, prevData }) -> Promise<{ ok, method, savedToDisk }>
// prevData — инструкция в том виде, в каком её открыл редактор; нужна только истории
// промпта (src/history.js), запись в текст сообщения от неё не зависит.
export async function persistInstruction({ targetEl, rawDom, newData, prevData }) {
    const mesEl = targetEl?.closest?.('.mes');
    const mesid = mesEl ? Number.parseInt(mesEl.getAttribute('mesid'), 10) : NaN;

    const ctx = getCtx();
    const message = Number.isInteger(mesid) ? ctx.chat?.[mesid] : null;

    const textAfter = serializeForText(newData);
    const domAfter = serializeForDom(newData);

    let method = 'dom-only';
    let textChanged = false;
    // Успех определяется тем, НАШЛАСЬ ли инструкция в тексте сообщения, а не тем,
    // изменилась ли строка. Повторное сохранение без правок (открыл окно → сразу
    // «Сохранить и перегенерировать») переписывает текст тем же значением: замена
    // возвращает ту же строку, textChanged === false — и раньше это давало ложную
    // ошибку «правка применена только к DOM» плюс отказ от перегенерации в index.js,
    // хотя в чате лежал ровно нужный промпт.
    let matched = false;

    if (message) {
        // Один обход всех мест хранения: форма записи подбирается внутри, для каждого
        // поля своя (см. buildRewriter).
        const { rewrite, methods, wasMatched } = buildRewriter({
            rawDom,
            textAfter,
            src: targetEl?.getAttribute?.('src'),
        });
        textChanged = walkMessageStrings(message, rewrite);
        matched = wasMatched();
        if (matched) method = [...methods].join('+');
    }

    // DOM обновляем всегда, независимо от исхода записи в текст.
    const domCount = updateDomCopies(rawDom, domAfter);

    if (!message || !matched) {
        logWarn(
            `persistInstruction: инструкция не найдена в тексте сообщения (dom-only, обновлено DOM-копий: ${domCount})`,
        );
        return { ok: false, method: 'dom-only', savedToDisk: false };
    }

    // История промпта пишется здесь, а не в index.js, по одной причине: она обязана
    // уехать на диск той же записью чата, что и сам промпт. Только после matched —
    // если инструкция в тексте не нашлась, правка живёт лишь в DOM, и обещать «прошлую
    // версию» было бы враньём. Упасть история не должна утянуть за собой сохранение
    // промпта: она удобство, а он — то, зачем пользователь нажал кнопку.
    try {
        const index = imageIndexOf(targetEl);
        if (index < 0) {
            logWarn('persistInstruction: картинка не найдена в .mes_text — история промпта пропущена');
        } else {
            recordHistory(message, index, {
                before: prevData?.prompt,
                after: newData?.prompt,
            });
        }
    } catch (err) {
        logWarn('persistInstruction: не удалось записать историю промпта', err);
    }

    // saveChat зовём и когда текст не изменился: это идемпотентно, зато чинит случай,
    // когда предыдущая запись ушла в saveChatDebounced и на диск ещё не легла.
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

    logInfo(
        `инструкция записана (method=${method}, изменений в тексте: ${textChanged ? 'да' : 'нет (значение уже совпадало)'}`
        + `, DOM-копий обновлено: ${domCount})`,
    );

    return { ok: true, method, savedToDisk };
}
