// Синхронизация путей к перегенерированным картинкам.
//
// Зачем: текст сообщения ST лежит в шести местах (mes, extra.display_text,
// extra.extblocks, swipes[i], swipe_info[i].extra.display_text/.extblocks), а после
// перезагрузки страницы сообщение перерисовывается не обязательно из mes. Хост при
// перегенерации всего сообщения обновляет только message.mes (upstream
// index.js:4604 — там, в отличие от перегенерации одной картинки, не вызывается ни
// replaceImageSrcEverywhere, ни recordSrcRemap), поэтому остальные места остаются со
// старым путём, и при следующей загрузке чата возвращается САМАЯ ПЕРВАЯ генерация.
// Правку в upstream мы внести не можем, но дописать путь в остальные места — можем.
//
// Две независимые половины:
//   1. mirror — наблюдение за DOM: как только у картинки сменился src, тот же
//      переход old -> new применяется ко всем местам хранения. Ловит перегенерацию
//      в момент, когда она произошла, независимо от того, какой кнопкой хоста её
//      запустили.
//   2. reconcile — сверка мест хранения между собой при открытии чата, где истиной
//      считается message.mes. Чинит то, что уже испорчено: реероллы, сделанные до
//      установки Imaginy или в другом браузере.
//
// Ни одна из половин не делает сетевых вызовов и не трогает ничего, кроме атрибута
// src у картинок хоста.

import { getCtx, getEventTypes } from './ctx.js';
import { logError, logInfo, logWarn } from './log.js';
import { getSettings } from './settings.js';
import { replaceSrcEverywhere } from './persist.js';

// Пачка мутаций -> один проход. Дольше, чем у декорации (50 мс): здесь незачем
// спешить, а сама перегенерация идёт секундами.
const FLUSH_DELAY_MS = 200;
// Сверку запускаем не в момент CHAT_CHANGED, а с задержкой: ST в этот момент ещё
// достраивает ctx.chat, а хост — свою разметку.
const RECONCILE_DELAY_MS = 700;

const IMG_TAG_RE = /<img\b[^>]*>/gi;
const SRC_ATTR_RE = /(\bsrc\s*=\s*)(['"])([\s\S]*?)\2/i;
const INSTRUCTION_ATTR_RE = /\bdata-iig-instruction\s*=/i;

let observer = null;
let flushTimer = null;
let pendingMessages = new Set();
let saveTimer = null;

// Снимок «какие пути были у картинок этого сообщения» — источник oldSrc для mirror.
// Ключ — узел .mes_text, поэтому пересозданное сообщение начинает с чистого листа,
// а сборщик мусора не держит ничего лишнего.
const snapshots = new WeakMap();

function enabled() {
    try {
        const s = getSettings();
        return s.enabled !== false && s.syncImageSrc !== false;
    } catch (err) {
        return false;
    }
}

// Путь, который имеет смысл переносить между местами хранения. Заглушку ошибки
// исключаем намеренно: error.svg — общий для всех неудавшихся генераций, подстрочная
// замена задела бы все картинки сообщения разом. Путь ошибки хост и так проставляет
// во все места сам (upstream index.js:4395).
function isGeneratedPath(src) {
    if (typeof src !== 'string' || src.length < 2) return false;
    if (src.startsWith('data:') || src.startsWith('blob:')) return false;
    if (src.includes('error.svg')) return false;
    return src.includes('/');
}

function tagHasInstruction(tag) {
    return INSTRUCTION_ATTR_RE.test(tag);
}

function srcOfTag(tag) {
    const m = SRC_ATTR_RE.exec(tag);
    return m ? m[3] : '';
}

// Пути картинок хоста в строке, по порядку следования тегов.
export function generatedSrcsInText(text) {
    if (typeof text !== 'string' || !text.includes('data-iig-instruction')) return [];
    const out = [];
    for (const m of text.matchAll(IMG_TAG_RE)) {
        if (!tagHasInstruction(m[0])) continue;
        out.push(srcOfTag(m[0]));
    }
    return out;
}

// Расставляет пути из wanted по картинкам хоста, сопоставляя их по порядку.
// Вызывается только когда число картинок совпало (см. reconcileMessage).
export function applySrcByIndex(text, wanted) {
    let idx = -1;
    return text.replace(IMG_TAG_RE, (tag) => {
        if (!tagHasInstruction(tag)) return tag;
        idx++;
        const want = wanted[idx];
        const cur = srcOfTag(tag);
        if (!want || !cur || want === cur) return tag;
        if (!isGeneratedPath(want) || !isGeneratedPath(cur)) return tag;
        // Заменитель функцией, а не строкой: путь может содержать $&, $1 и прочие
        // спецпоследовательности String.replace.
        return tag.replace(SRC_ATTR_RE, (_all, head, quote) => `${head}${quote}${want}${quote}`);
    });
}

// ── 2. reconcile: сверка мест хранения между собой ─────────────────────────────

// Истина — message.mes: единственное место, которое обновляют ВСЕ пути хоста, в том
// числе сломанный (upstream index.js:4604), плюс штатное редактирование сообщения в ST.
//
// Чужие свайпы не трогаем принципиально. mes соответствует ТЕКУЩЕМУ свайпу, у
// остальных свой текст со своими картинками; совпадение их числа было бы случайным, а
// цена ошибки — подменённая картинка в чужом свайпе. Поэтому из swipes/swipe_info
// сверяется только элемент под swipe_id.
export function reconcileMessage(message) {
    const truth = generatedSrcsInText(message?.mes);
    if (truth.length === 0) return false;

    let changed = false;

    const fix = (holder, key) => {
        const val = holder?.[key];
        if (typeof val !== 'string') return;
        const got = generatedSrcsInText(val);
        // Разное число картинок — это другой набор (вынесенный блок, чужой текст),
        // сопоставлять по индексу нельзя.
        if (got.length !== truth.length) return;
        if (got.every((s, i) => s === truth[i])) return;
        const next = applySrcByIndex(val, truth);
        if (next !== val) {
            holder[key] = next;
            changed = true;
        }
    };

    fix(message.extra, 'display_text');
    fix(message.extra, 'extblocks');

    const sid = message.swipe_id;
    if (Number.isInteger(sid)) {
        if (Array.isArray(message.swipes)) fix(message.swipes, sid);
        const si = message.swipe_info?.[sid]?.extra;
        if (si) {
            fix(si, 'display_text');
            fix(si, 'extblocks');
        }
    }

    return changed;
}

// Подтягивает уже отрисованные картинки к message.mes. Без этого починка мест
// хранения не видна до перезагрузки: ST мог отрисовать сообщение из испорченного
// места, и на экране осталась бы старая картинка.
function healDom(mesEl, truth) {
    const mesTextEl = mesEl?.querySelector?.('.mes_text');
    if (!mesTextEl) return 0;
    const imgs = Array.from(mesTextEl.querySelectorAll('img[data-iig-instruction]'));
    if (imgs.length !== truth.length) return 0;

    let healed = 0;
    for (let i = 0; i < imgs.length; i++) {
        const cur = imgs[i].getAttribute('src') || '';
        const want = truth[i];
        if (!want || cur === want) continue;
        if (!isGeneratedPath(cur) || !isGeneratedPath(want)) continue;
        imgs[i].setAttribute('src', want);
        healed++;
    }
    // Снимок обновляем всегда: иначе наша же правка прилетит обратно как «пользователь
    // перегенерировал картинку» и mirror запишет её задом наперёд.
    snapshots.set(mesTextEl, currentSrcs(mesTextEl));
    return healed;
}

// Проход по всему чату. Дёшев: сообщения без картинок хоста отсекаются первой же
// проверкой в generatedSrcsInText по вхождению подстроки.
export function reconcileChat() {
    if (!enabled()) return;

    let ctx;
    try {
        ctx = getCtx();
    } catch (err) {
        return;
    }
    const chat = ctx?.chat;
    if (!Array.isArray(chat)) return;

    let fixedMessages = 0;
    let healedImages = 0;

    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        try {
            const changed = reconcileMessage(message);
            if (changed) fixedMessages++;
            const truth = generatedSrcsInText(message?.mes);
            if (truth.length) {
                const mesEl = document.querySelector(`#chat .mes[mesid="${i}"]`);
                if (mesEl) healedImages += healDom(mesEl, truth);
            }
        } catch (err) {
            logError(`reconcileChat: сообщение ${i} не удалось сверить`, err);
        }
    }

    if (fixedMessages || healedImages) {
        logInfo(
            `сверка мест хранения: починено сообщений ${fixedMessages}, картинок в DOM ${healedImages}`,
        );
    }
    if (fixedMessages) scheduleSave();
}

// Сверка в скрытой вкладке — работа, которую никто не увидит: чинить DOM там нечего
// (картинки не отрисованы для глаз), а фоновые вкладки браузер и так душит таймерами.
// Поэтому в скрытой вкладке проход откладывается до возвращения пользователя.
// Обходы декорации так НЕ откладываются намеренно: карандаш должен быть на месте уже
// к моменту возвращения, а стоит он копейки.
//
// Слушатель ставится один на все отложенные сверки: пока вкладка скрыта, событий
// CHAT_CHANGED может прийти сколько угодно, а сверка нужна ровно одна — она в любом
// случае проходит по всему чату целиком.
let reconcilePending = false;

function isHidden() {
    try {
        return document.visibilityState === 'hidden' || document.hidden === true;
    } catch (err) {
        return false;
    }
}

function runReconcile() {
    try {
        reconcileChat();
    } catch (err) {
        logError('reconcileChat упал', err);
    }
}

function onVisible() {
    if (isHidden()) return;
    document.removeEventListener('visibilitychange', onVisible);
    reconcilePending = false;
    runReconcile();
}

export function reconcileChatWhenVisible() {
    if (!isHidden()) {
        runReconcile();
        return;
    }
    if (reconcilePending) return;
    reconcilePending = true;
    document.addEventListener('visibilitychange', onVisible);
}

// ── 1. mirror: перенос смены src из DOM во все места хранения ──────────────────

function currentSrcs(mesTextEl) {
    return Array.from(mesTextEl.querySelectorAll('img[data-iig-instruction]'))
        .map((img) => img.getAttribute('src') || '');
}

function messageOf(mesEl) {
    const mesid = Number.parseInt(mesEl.getAttribute('mesid'), 10);
    if (!Number.isInteger(mesid)) return null;
    try {
        return getCtx().chat?.[mesid] ?? null;
    } catch (err) {
        return null;
    }
}

export function mirrorMessage(mesEl) {
    const mesTextEl = mesEl.querySelector('.mes_text');
    if (!mesTextEl) return false;

    const cur = currentSrcs(mesTextEl);
    const prev = snapshots.get(mesTextEl);

    if (!prev) {
        snapshots.set(mesTextEl, cur);
        return false;
    }

    // Картинок стало меньше — идёт генерация, картинка подменена плейсхолдером без
    // data-iig-instruction. Снимок НЕ трогаем: в нём лежит единственная копия
    // старого пути, по которой мы потом опознаем, что именно заменилось.
    if (cur.length < prev.length) return false;

    if (cur.length !== prev.length) {
        snapshots.set(mesTextEl, cur);
        return false;
    }

    const pairs = [];
    for (let i = 0; i < cur.length; i++) {
        if (prev[i] === cur[i]) continue;
        if (!isGeneratedPath(prev[i]) || !isGeneratedPath(cur[i])) continue;
        pairs.push([prev[i], cur[i]]);
    }
    snapshots.set(mesTextEl, cur);
    if (pairs.length === 0) return false;

    const message = messageOf(mesEl);
    if (!message) return false;

    let changed = false;
    for (const [oldSrc, newSrc] of pairs) {
        try {
            if (replaceSrcEverywhere(message, oldSrc, newSrc)) changed = true;
        } catch (err) {
            logError('mirrorMessage: замена пути упала', err);
        }
    }

    if (changed) {
        logInfo(`путь картинки перенесён во все места хранения (замен: ${pairs.length})`);
    }
    return changed;
}

// ── Сохранение ────────────────────────────────────────────────────────────────

// Хост после перегенерации сохраняет чат сам, но своим порядком и не на всех путях;
// собственное сохранение делаем отложенно, чтобы пачка правок дала одну запись.
function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        saveTimer = null;
        try {
            await getCtx().saveChat();
        } catch (err) {
            logWarn('srcsync: saveChat упал, фолбэк на saveChatDebounced', err);
            try {
                getCtx().saveChatDebounced?.();
            } catch (err2) {
                logWarn('srcsync: saveChatDebounced тоже упал', err2);
            }
        }
    }, 600);
}

// ── Наблюдение ────────────────────────────────────────────────────────────────

function flush() {
    flushTimer = null;
    const targets = pendingMessages;
    pendingMessages = new Set();
    if (!enabled()) return;

    let changed = false;
    for (const mesEl of targets) {
        if (!mesEl.isConnected) continue;
        try {
            if (mirrorMessage(mesEl)) changed = true;
        } catch (err) {
            logError('srcsync flush упал', err);
        }
    }
    if (changed) scheduleSave();
}

function collect(node) {
    if (!(node instanceof Element)) return;
    const mesEl = node.closest?.('.mes');
    if (mesEl) pendingMessages.add(mesEl);
}

function onMutations(mutations) {
    for (const m of mutations) {
        // Перегенерация одной картинки меняет атрибут (upstream index.js:3782),
        // перегенерация всего сообщения подменяет узел целиком (:4600) — нужны обе.
        if (m.type === 'attributes') collect(m.target);
        else for (const node of m.addedNodes) collect(node);
    }
    if (pendingMessages.size === 0) return;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

function chatRoot() {
    return document.getElementById('chat');
}

function bindObserver(chatEl) {
    if (!chatEl || chatEl.dataset.imaginySrcSyncBound === '1') return;
    try {
        // ST пересоздаёт #chat при смене чата — старое наблюдение отцепляем.
        observer?.disconnect();
        observer = new MutationObserver(onMutations);
        observer.observe(chatEl, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src'],
        });
        chatEl.dataset.imaginySrcSyncBound = '1';
    } catch (err) {
        logError('srcsync: bindObserver упал', err);
    }
}

export function initSrcSync() {
    const ctx = getCtx();
    const et = getEventTypes(ctx);

    bindObserver(chatRoot());

    const rebindAndReconcile = (delay) => {
        setTimeout(() => {
            // Наблюдатель цепляется всегда, даже в скрытой вкладке: перегенерация может
            // идти и там (её запустили до переключения), и пропущенную смену src потом
            // уже не восстановить — снимок в snapshots заводится по первому проходу.
            bindObserver(chatRoot());
            reconcileChatWhenVisible();
        }, delay);
    };

    if (et.APP_READY) ctx.eventSource.on(et.APP_READY, () => rebindAndReconcile(RECONCILE_DELAY_MS));
    if (et.CHAT_CHANGED) ctx.eventSource.on(et.CHAT_CHANGED, () => rebindAndReconcile(RECONCILE_DELAY_MS));

    // APP_READY мог пройти до загрузки модуля — первый проход делаем безусловно.
    rebindAndReconcile(1500);
}
