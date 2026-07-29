// Поиск целей (картинка/видео/плашка ошибки от SLAY) и вставка кнопки-карандаша.
// Единственное место, где живут CSS-селекторы SLAY — переименование класса в апстриме
// чинится правкой одного объекта ниже (см. docs/plan-fork.md, раздел «Риски»).

import { getCtx, getEventTypes, toast } from './ctx.js';
import { logError, logWarn, warnOnce } from './log.js';
import { getSettings } from './settings.js';

export const SELECTORS = {
    // Обычная сгенерированная картинка. SLAY оборачивает её в span.iig-img-wrap лениво
    // (docs/sillytavern-api.md §2.1) — если обёртки ещё нет, ждём следующей мутации.
    image: 'img[data-iig-instruction]',
    imageWrap: '.iig-img-wrap',
    // Ошибочные картинки, которые SLAY подставляет сам при сбое отрисовки — не цель.
    errorImage: '.iig-error-image',
    errorPlaceholderAncestor: '.iig-error-placeholder',
    // SLAY никогда не оборачивает видео (hard return на не-IMG, §2.1 п.2) — Imaginy
    // создаёт для него собственную обёртку.
    video: 'video[data-iig-instruction]',
    // Плашка неудавшейся генерации: div, не обёрнута, position можно ставить сразу.
    errorPlaceholder: '.iig-error-placeholder[data-iig-instruction]',
    // Кнопка перегенерации SLAY — лежит внутри того же .iig-img-wrap (src/regen.js).
    regenBtn: '.iig-regen-btn',
    // Класс занятости висит на кнопке, не на обёртке (docs/sillytavern-api.md §2.6).
    regenBusyClass: 'iig-regen-busy',
};

const OWN_WRAP_CLASS = 'imaginy-img-wrap';
const BTN_CLASS = 'imaginy-edit-btn';
const BTN_CLASS_ERROR = 'imaginy-edit-btn--error';

// Фаза 5, п.5.4 («SLAY сменил формат data-iig-instruction»): намеренно не парсим
// инструкцию здесь ради самого предупреждения — это дублировало бы работу и
// добавило бы JSON.parse на каждый скан. instruction.js:readInstruction уже вызывает
// warnOnce('instruction-parse-failed', ...) при первом же провале парсинга (он
// срабатывает при первом клике по карандашу на нераспознанном элементе), и это
// достаточно дёшево и достаточно рано, чтобы не дублировать логику здесь.
let onEditCallback = null;
let observer = null;
let scanTimer = null;
let pendingScanRoots = new Set();

// SLAY детектируется по своим DOM-следам либо по единственному глобалу
// window.slayWardrobe (upstream/index.js:2157). Намеренно НЕ дизейблит декорацию
// насовсем при отсутствии — чат без картинок неотличим от отсутствия SLAY, поэтому
// правило: один раз предупредить и продолжать сканировать (селекторы просто ничего
// не найдут).
export function isSlayPresent() {
    try {
        return !!(
            document.querySelector('[data-iig-instruction]') ||
            document.querySelector(SELECTORS.imageWrap) ||
            window.slayWardrobe !== undefined
        );
    } catch (err) {
        logError('isSlayPresent: ошибка проверки', err);
        return false;
    }
}

function makeButton(kind) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BTN_CLASS + (kind === 'error' ? ` ${BTN_CLASS_ERROR}` : '');
    btn.title = 'Редактировать промпт';
    btn.innerHTML = '<i class="fa-solid fa-pen"></i>';
    btn.addEventListener('click', (e) => {
        // SLAY-лайтбокс — document-level listener с capture:true (docs §2.8). Клик по
        // <button> он и так игнорирует, но полагаться на чужой список селекторов нельзя.
        e.stopPropagation();
        e.preventDefault();
        try {
            // onEdit асинхронный: синхронный catch ловит только падение до первого await,
            // всё остальное иначе уходило бы в необработанный reject — молча, без следа
            // в UI. Ловим оба случая одинаково.
            const maybePromise = onEditCallback?.(btn.__imaginyTarget, kind, btn);
            if (maybePromise && typeof maybePromise.catch === 'function') {
                maybePromise.catch((err) => {
                    logError('onEdit callback упал (async)', err);
                    toast('error', `Ошибка редактора: ${err?.message ?? err}`);
                });
            }
        } catch (err) {
            logError('onEdit callback упал', err);
            toast('error', `Ошибка редактора: ${err?.message ?? err}`);
        }
    });
    return btn;
}

// Обёртка уже содержит нашу кнопку? Значит либо мы её уже поставили, либо ST
// клонировал DOM-узел вместе с dataset-флагом и кнопкой сразу (защита от дублей).
function containerAlreadyHasButton(container) {
    return !!container.querySelector(`.${BTN_CLASS}`);
}

function decorateImage(img) {
    if (img.dataset.imaginyBound === '1') return;
    if (img.classList.contains(SELECTORS.errorImage.slice(1))) return;
    if (img.closest(SELECTORS.errorPlaceholderAncestor)) return;

    const wrap = img.closest(SELECTORS.imageWrap);
    if (!wrap) return; // SLAY ещё не успел обернуть — придёт следующая мутация.

    if (containerAlreadyHasButton(wrap)) {
        img.dataset.imaginyBound = '1';
        return;
    }

    const btn = makeButton('image');
    btn.__imaginyTarget = img;
    wrap.appendChild(btn);
    img.dataset.imaginyBound = '1';
}

function decorateVideo(video) {
    if (video.dataset.imaginyBound === '1') return;

    // Если видео уже внутри нашей же обёртки (повторный проход) — не дублируем.
    let wrap = video.closest(`.${OWN_WRAP_CLASS}`);
    if (!wrap) {
        const parent = video.parentElement;
        if (!parent) return;
        wrap = document.createElement('span');
        wrap.className = OWN_WRAP_CLASS;
        parent.insertBefore(wrap, video);
        wrap.appendChild(video);
        video.dataset.imaginyOwnsWrap = '1';
    }

    if (containerAlreadyHasButton(wrap)) {
        video.dataset.imaginyBound = '1';
        return;
    }

    const btn = makeButton('video');
    btn.__imaginyTarget = video;
    wrap.appendChild(btn);
    video.dataset.imaginyBound = '1';
}

function decorateErrorPlaceholder(el) {
    if (el.dataset.imaginyBound === '1') return;

    if (containerAlreadyHasButton(el)) {
        el.dataset.imaginyBound = '1';
        return;
    }

    const btn = makeButton('error');
    btn.__imaginyTarget = el;
    el.appendChild(btn);
    el.dataset.imaginyBound = '1';

    // :has() фолбэк для браузеров без поддержки (iOS Safari < 15.4, см.
    // upstream-комментарий у SLAY ~3738). CSS-правило `.iig-error-placeholder:has(.imaginy-edit-btn)`
    // уже покрывает современные браузеры; здесь просто подстраховка.
    try {
        if (getComputedStyle(el).position === 'static') {
            el.style.position = 'relative';
        }
    } catch (err) {
        logWarn('decorateErrorPlaceholder: getComputedStyle упал', err);
    }
}

// Обходит root и все подходящие потомки, включая сам root (MutationObserver отдаёт
// добавленные узлы, которые сами могут быть целью, а не только контейнером для неё).
export function decorateRoot(root) {
    if (!root) return;
    const settings = getSettings();
    if (!settings.enabled || !settings.showEditButton) return;

    const candidates = [];

    const tryMatch = (el, selector, fn) => {
        try {
            if (el.matches?.(selector)) candidates.push([el, fn]);
        } catch (err) {
            // el.matches может отсутствовать на не-Element узлах — игнорируем.
        }
    };

    // root сам может быть целью.
    if (root instanceof Element) {
        tryMatch(root, SELECTORS.errorPlaceholder, decorateErrorPlaceholder);
        tryMatch(root, SELECTORS.image, decorateImage);
        tryMatch(root, SELECTORS.video, decorateVideo);
    }

    const query = (selector) => {
        try {
            return root.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : [];
        } catch (err) {
            logError(`decorateRoot: querySelectorAll(${selector}) упал`, err);
            return [];
        }
    };

    // Плашки ошибок сначала — они пересекаются по data-атрибуту с img-селектором быть
    // не могут (разные теги), порядок здесь не критичен, но так нагляднее.
    for (const el of query(SELECTORS.errorPlaceholder)) candidates.push([el, decorateErrorPlaceholder]);
    for (const el of query(SELECTORS.image)) candidates.push([el, decorateImage]);
    for (const el of query(SELECTORS.video)) candidates.push([el, decorateVideo]);

    for (const [el, fn] of candidates) {
        try {
            fn(el);
        } catch (err) {
            logError('decorateRoot: ошибка декорации элемента', err, el);
        }
    }
}

function scan() {
    try {
        decorateRoot(document.getElementById('chat') ?? document);
    } catch (err) {
        logError('scan упал', err);
    }
}

// root задаётся функцией, а не значением: #chat может быть пересоздан ST между
// постановкой таймера и его срабатыванием (тот же случай, из-за которого SLAY вешает
// свой лайтбокс на document, а не на #chat — upstream ~6080).
function scheduleScan(getRoot, delay) {
    setTimeout(() => {
        try {
            decorateRoot(getRoot() ?? document);
        } catch (err) {
            logError('scheduleScan упал', err);
        }
    }, delay);
}

const chatRoot = () => document.getElementById('chat');

function flushObserverScan() {
    scanTimer = null;
    const roots = pendingScanRoots;
    pendingScanRoots = new Set();
    for (const root of roots) {
        try {
            decorateRoot(root);
        } catch (err) {
            logError('flushObserverScan упал', err);
        }
    }
}

function onMutations(mutations) {
    for (const m of mutations) {
        for (const node of m.addedNodes) {
            if (node instanceof Element) pendingScanRoots.add(node);
        }
    }
    if (pendingScanRoots.size === 0) return;
    // Коалессируем: пачка мутаций -> один отложенный обход, не сотни.
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(flushObserverScan, 50);
}

function bindObserver(chatEl) {
    if (!chatEl || chatEl.dataset.imaginyObserverBound === '1') return;
    try {
        // ST пересоздаёт #chat при смене чата: старый observer наблюдает за узлом,
        // которого больше нет в документе — отцепляем, чтобы не течь.
        observer?.disconnect();
        observer = new MutationObserver(onMutations);
        observer.observe(chatEl, { childList: true, subtree: true });
        chatEl.dataset.imaginyObserverBound = '1';
    } catch (err) {
        logError('bindObserver упал', err);
    }
}

// Снимает все кнопки и dataset-флаги (используется при выключении настройки).
function clearAllDecoration() {
    try {
        document.querySelectorAll(`.${BTN_CLASS}`).forEach((btn) => btn.remove());
        document.querySelectorAll('[data-imaginy-bound="1"]').forEach((el) => {
            delete el.dataset.imaginyBound;
        });
    } catch (err) {
        logError('clearAllDecoration упал', err);
    }
}

export function setDecorationEnabled(flag) {
    if (flag) {
        scan();
        return;
    }
    clearAllDecoration();
    // Собственные video-обёртки намеренно не разбираем — они безвредны, а разборка
    // рискует потревожить DOM, которым может владеть ST (см. спецификацию задачи).
}

// mesid из data-атрибута сообщения ST ("mesid" на .mes) — используется, чтобы
// скоупить обход событий MESSAGE_* только на изменившееся сообщение.
function rootForMessageId(messageId) {
    if (Number.isInteger(messageId)) {
        const mesEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (mesEl) return mesEl;
    }
    return document.getElementById('chat');
}

export function initDecoration({ onEdit }) {
    onEditCallback = onEdit;

    const ctx = getCtx();
    const et = getEventTypes(ctx);

    bindObserver(chatRoot());

    if (et.APP_READY) {
        ctx.eventSource.on(et.APP_READY, () => {
            bindObserver(chatRoot());
            scheduleScan(chatRoot, 500);
        });
    }

    // APP_READY мог произойти до загрузки этого модуля — тогда подписка выше уже
    // никогда не сработает. Первый обход делаем безусловно.
    scheduleScan(chatRoot, 1000);

    // Проверку наличия SLAY делаем не на старте (в этот момент DOM всегда пуст, и
    // предупреждение было бы ложным), а после первого обхода.
    setTimeout(() => {
        if (!isSlayPresent()) {
            warnOnce(
                'slay-not-detected',
                'SLAY Images не обнаружен на странице. Imaginy продолжит работать, но кнопка-карандаш появится только там, где SLAY отрисует изображение (либо в этом чате просто нет сгенерированных картинок).',
            );
        }
    }, 1500);

    if (et.CHAT_CHANGED) {
        ctx.eventSource.on(et.CHAT_CHANGED, () => {
            // #chat пересоздаётся при смене чата — на новом узле dataset-флага нет,
            // так что observer перевешивается сам.
            bindObserver(chatRoot());
            scheduleScan(chatRoot, 350);
        });
    }

    const messageEvents = ['MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED', 'CHARACTER_MESSAGE_RENDERED'];
    for (const name of messageEvents) {
        if (!et[name]) continue;
        ctx.eventSource.on(et[name], (messageId) => {
            scheduleScan(() => rootForMessageId(messageId), 80);
        });
    }
}
