// История промпта у картинки: 2-3 прошлых значения, чтобы неудачную правку можно было
// откатить. До этого сохранение затирало старый промпт безвозвратно.
//
// Где хранится. В `extra` самого сообщения, то есть внутри файла чата — своего
// хранилища у истории нет, и настройки расширения она не раздувает. Ключ внутри
// сообщения — порядковый номер картинки среди элементов с data-iig-instruction в
// .mes_text. Не путь к файлу (он меняется при каждой перегенерации, см. srcsync.js) и
// не сам промпт (он и есть то, что мы правим). Побочная выгода: две картинки в одном
// сообщении с одинаковым промптом — известное ограничение README — для истории всё же
// различимы, у них разные номера.
//
// Свайпы. Пишем ровно в два места: message.extra и swipe_info[swipe_id].extra, то есть
// в текущий свайп и никуда больше. У чужих свайпов свой текст со своими картинками
// (тот же довод, что в комментарии про чужие свайпы в srcsync.js), и класть им нашу
// историю — значит приписать им версии промпта, которых у них никогда не было. Два
// места, а не одно, потому что SillyTavern при свайпе туда-обратно восстанавливает
// extra сообщения из swipe_info: запись в одно message.extra не пережила бы свайп.
//
// Размер. Промпты бывают по 2-4 КБ, а картинок в длинном чате сотни, поэтому:
//   * версий не больше HISTORY_LIMIT;
//   * текущий промпт целиком НЕ дублируется — от него хранится только короткая метка
//     (длина + хеш). Она нужна лишь чтобы заметить, что промпт меняли мимо нас, а
//     копия текущего промпта в файле чата и так есть — в самом теге картинки.

import { getCtx } from './ctx.js';
import { logWarn } from './log.js';

// Верхняя граница из плана. Две версии — это «откатить последнюю правку и ту, что была
// до неё»; третья добавляется почти бесплатно, а четвёртой уже никто не пользуется.
export const HISTORY_LIMIT = 3;

// Пустой промпт в историю не идёт: вернуть пустоту пользователь может и сам, а место
// в файле чата она занимает наравне с осмысленной версией.
function usable(prompt) {
    return typeof prompt === 'string' && prompt.trim().length > 0;
}

// Метка текущего промпта: длина плюс FNV-1a. Хранить нужно не значение, а только ответ
// на вопрос «это всё ещё тот промпт, который записали мы?» — для него хватает метки в
// пару десятков байт вместо полной копии в несколько килобайт. Совпадение хешей у двух
// разных промптов ничем не грозит: цена ошибки — не показанная строка «промпт меняли
// не через Imaginy», а не потерянные данные.
export function markOf(prompt) {
    const str = String(prompt ?? '');
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        // Умножение на 16777619 через сдвиги: обычное * вылезает за 32 бита в double и
        // теряет младшие разряды.
        hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return `${str.length}:${hash.toString(16)}`;
}

// Номер картинки внутри сообщения. Считается по .mes_text — по тому же набору
// элементов, который обходит srcsync, чтобы «картинка №2» означала в обоих модулях
// одно и то же.
export function imageIndexOf(targetEl) {
    const mesTextEl = targetEl?.closest?.('.mes_text');
    if (!mesTextEl) return -1;
    try {
        const nodes = Array.from(mesTextEl.querySelectorAll('[data-iig-instruction]'));
        return nodes.indexOf(targetEl);
    } catch (err) {
        logWarn('imageIndexOf: обход .mes_text упал', err);
        return -1;
    }
}

// Все места, куда история пишется: текущий свайп и сам объект сообщения. Читаем из
// первого, где она нашлась (порядок важен: message.extra — то, что SillyTavern
// показывает прямо сейчас).
function holders(message, { create }) {
    const out = [];
    const add = (owner) => {
        if (!owner) return;
        if (!owner.extra) {
            if (!create) return;
            owner.extra = {};
        }
        if (!owner.extra.imaginy) {
            if (!create) return;
            owner.extra.imaginy = {};
        }
        if (!owner.extra.imaginy.promptHistory) {
            if (!create) return;
            owner.extra.imaginy.promptHistory = {};
        }
        out.push(owner.extra.imaginy.promptHistory);
    };

    add(message);
    const sid = message?.swipe_id;
    if (Number.isInteger(sid) && Array.isArray(message?.swipe_info)) {
        add(message.swipe_info[sid]);
    }
    return out;
}

// readHistory(message, index) -> { versions: string[], mark: string|null }
// versions — от самой свежей к самой старой.
export function readHistory(message, index) {
    if (!message || !Number.isInteger(index) || index < 0) return { versions: [], mark: null };
    for (const store of holders(message, { create: false })) {
        const entry = store?.[String(index)];
        if (!entry) continue;
        const versions = Array.isArray(entry.versions) ? entry.versions.filter(usable) : [];
        if (versions.length === 0 && !entry.mark) continue;
        return { versions: versions.slice(0, HISTORY_LIMIT), mark: entry.mark ?? null };
    }
    return { versions: [], mark: null };
}

// Правка «не наша» — промпт в картинке разошёлся с меткой, которую мы записали при
// прошлом сохранении. Так бывает после ручного редактирования сообщения, отката файла
// чата или правки в другом форке. Без метки (истории ещё нет) врать про чужую правку
// не надо — отвечаем false.
export function isForeignEdit(history, currentPrompt) {
    if (!history?.mark) return false;
    return history.mark !== markOf(currentPrompt);
}

// То, что нужно редактору: прошлые версии этой картинки и признак «промпт меняли мимо
// нас». Всё, что может не найтись (сообщение, номер картинки, контекст ST), приводит к
// пустой истории, а не к отказу открыть редактор.
export function readHistoryFor(targetEl, currentPrompt) {
    const empty = { versions: [], foreign: false };
    try {
        const mesEl = targetEl?.closest?.('.mes');
        const mesid = mesEl ? Number.parseInt(mesEl.getAttribute('mesid'), 10) : NaN;
        const message = Number.isInteger(mesid) ? getCtx().chat?.[mesid] : null;
        const index = imageIndexOf(targetEl);
        if (!message || index < 0) return empty;

        const history = readHistory(message, index);
        return { versions: history.versions, foreign: isForeignEdit(history, currentPrompt) };
    } catch (err) {
        logWarn('readHistoryFor: не удалось прочитать историю промпта', err);
        return empty;
    }
}

// Записывает прошлый промпт в историю картинки. Возвращает true, если что-то легло.
//
// Пишется именно `before` — то, что реально стояло в картинке до сохранения, кто бы его
// туда ни поставил. История честно показывает «было — стало», а не «вот наши правки»:
// версия, пришедшая из чужого редактирования, для отката ничем не хуже нашей.
export function recordHistory(message, index, { before, after }) {
    if (!message || !Number.isInteger(index) || index < 0) return false;

    const stores = holders(message, { create: true });
    if (stores.length === 0) return false;

    const key = String(index);
    let versions = readHistory(message, index).versions;
    // Сохранение без правки промпта (поменяли только стиль, или открыли и сразу
    // сохранили) историю не трогает — иначе три «версии» подряд оказались бы одним и
    // тем же текстом, а настоящие прошлые промпты уехали бы за предел.
    if (usable(before) && before !== after && before !== versions[0]) {
        versions = [before, ...versions].slice(0, HISTORY_LIMIT);
    }

    const entry = { mark: markOf(after), versions };
    for (const store of stores) {
        // Своя копия массива на каждое место хранения: SillyTavern клонирует extra при
        // свайпах не везде, и общий по ссылке массив мог бы уехать в чужой свайп.
        store[key] = { mark: entry.mark, versions: [...entry.versions] };
    }
    return true;
}
