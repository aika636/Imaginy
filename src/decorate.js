// Поиск целей (картинка/видео/плашка ошибки) и вставка кнопки-карандаша.
//
// Конкретные CSS-селекторы живут не здесь, а в профиле активного хоста
// (src/hosts/*.js, выбор — src/host.js): у SLAY Images и у трёх форков семейства
// «inline image generation» одинаковый атрибут data-iig-instruction, но разные обёртки
// и кнопки. Этот модуль знает только общие правила декорации.

import { getCtx, getEventTypes, toast } from './ctx.js';
import { logError, logWarn, warnOnce } from './log.js';
import { getSettings } from './settings.js';
import { getHost, isHostPresent } from './host.js';

const OWN_WRAP_CLASS = 'imaginy-img-wrap';
const BTN_CLASS = 'imaginy-edit-btn';
const BTN_CLASS_ERROR = 'imaginy-edit-btn--error';
// Карандаш встаёт либо правее кнопки перегенерации хоста (SLAY держит свою в левом
// верхнем углу), либо в левый верхний угол (форки держат свои кнопки справа).
const BTN_CLASS_TOP_LEFT = 'imaginy-edit-btn--tl';

// Сколько ждать, пока хост сам обернёт картинку, прежде чем сделать свою обёртку.
// Нужно только профилям с ownWrapFallback и непустым imageWrap: у них обёртка обычно
// приезжает через мутацию, но на некоторых путях отрисовки (упавшая генерация, чужой
// рендер) не приезжает никогда — без своей обёртки карандаша там не будет совсем.
const OWN_WRAP_DELAY_MS = 1200;

function selectors() {
    return getHost().selectors;
}

// Элемент сам может быть контейнером для кнопки (div-плашка SLAY), а может не иметь
// права содержать потомков (img/video) — тогда нужна обёртка.
function canHostChildren(el) {
    const tag = el?.tagName;
    return tag !== 'IMG' && tag !== 'VIDEO';
}

// Про случай «хост сменил формат data-iig-instruction»: намеренно не парсим
// инструкцию здесь ради самого предупреждения — это дублировало бы работу и
// добавило бы JSON.parse на каждый скан. instruction.js:readInstruction уже вызывает
// warnOnce('instruction-parse-failed', ...) при первом же провале парсинга (он
// срабатывает при первом клике по карандашу на нераспознанном элементе), и это
// достаточно дёшево и достаточно рано, чтобы не дублировать логику здесь.
let onEditCallback = null;
let observer = null;
let scanTimer = null;
let pendingScanRoots = new Set();
// Все отложенные обходы (scheduleScan и отложенный повтор из resolveContainer): без
// учёта их id выключение декорации не гасило бы уже поставленные таймеры, и после
// выключения карандаши возвращались бы сами.
const pendingTimers = new Set();

// setTimeout, id которого не теряется: снимается из набора при срабатывании и может
// быть погашен целиком через clearPendingTimers().
function later(fn, delay) {
    const id = setTimeout(() => {
        pendingTimers.delete(id);
        fn();
    }, delay);
    pendingTimers.add(id);
    return id;
}

function clearPendingTimers() {
    for (const id of pendingTimers) clearTimeout(id);
    pendingTimers.clear();
}

function makeButton(kind, { errorMod = false } = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = [
        BTN_CLASS,
        errorMod ? BTN_CLASS_ERROR : '',
        getHost().btnPlacement === 'top-left' ? BTN_CLASS_TOP_LEFT : '',
    ].filter(Boolean).join(' ');
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

// Наша собственная обёртка вокруг элемента, который не может содержать кнопку сам
// (img/video) и которого не обернул хост. Возвращает обёртку или null.
function ownWrap(el) {
    const existing = el.closest(`.${OWN_WRAP_CLASS}`);
    if (existing) return existing;

    const parent = el.parentElement;
    if (!parent) return null;

    const wrap = document.createElement('span');
    wrap.className = OWN_WRAP_CLASS;
    parent.insertBefore(wrap, el);
    wrap.appendChild(el);
    el.dataset.imaginyOwnsWrap = '1';
    return wrap;
}

// Контейнер, в который ляжет кнопка для этой цели, или null — «пока нельзя, ждём».
//
// Правила (одинаковые для всех хостов, различия приходят из профиля):
//   * элемент, который может содержать потомков (плашка-div у SLAY) — сам себе контейнер;
//   * обёртка хоста, если профиль её объявил и она уже есть;
//   * своя обёртка — сразу, если хост не оборачивает вовсе (imageWrap === null),
//     или с задержкой, если хост обычно оборачивает, но здесь почему-то не обернул.
//
// hostWraps === false — про видео: его не оборачивает ни один из хостов (у SLAY это
// hard return на не-IMG, форки делают то же), поэтому обёртка сразу своя, без ожидания.
function resolveContainer(el, { hostWraps = true } = {}) {
    if (canHostChildren(el)) return el;

    const { imageWrap } = selectors();
    const host = getHost();

    if (imageWrap && hostWraps) {
        const hostWrap = el.closest(imageWrap);
        if (hostWrap) return hostWrap;

        if (!host.ownWrapFallback) return null; // обёртка хоста ещё придёт (SLAY)

        // Даём хосту время обернуть сам: своя обёртка внутри его разметки безвредна,
        // но лишний узел в DOM без нужды создавать не хочется.
        const seenAt = Number.parseInt(el.dataset.imaginySeen ?? '', 10);
        const now = Date.now();
        if (!Number.isInteger(seenAt)) {
            el.dataset.imaginySeen = String(now);
            // Один отложенный повтор: мутаций может больше не быть, и без него
            // карандаш не появился бы никогда.
            later(() => {
                try {
                    if (el.isConnected) decorateRoot(el);
                } catch (err) {
                    logError('resolveContainer: отложенный обход упал', err);
                }
            }, OWN_WRAP_DELAY_MS + 50);
            return null;
        }
        if (now - seenAt < OWN_WRAP_DELAY_MS) return null;
    }

    return ownWrap(el);
}

function decorateTarget(el, kind) {
    if (el.dataset.imaginyBound === '1') return;

    const container = resolveContainer(el, { hostWraps: kind !== 'video' });
    if (!container) return;
    // Общий класс для CSS (style.css): избавляет hover-правило от перечисления
    // селекторов обёрток каждого хоста поимённо.
    container.classList.add('imaginy-host-wrap');

    // Кнопка могла остаться от прошлого прохода не в самом контейнере, а в нашей же
    // обёртке снаружи него: хост мог пересоздать картинку и обернуть её своей обёрткой
    // уже внутри нашей. Второй карандаш на одну картинку — хуже, чем чуть менее удобно
    // расположенный первый.
    const outerWrap = container.closest(`.${OWN_WRAP_CLASS}`);
    if (containerAlreadyHasButton(container) || (outerWrap && containerAlreadyHasButton(outerWrap))) {
        // Хост пересоздал картинку внутри уже забинденной обёртки: кнопка осталась
        // от старой img, а её __imaginyTarget указывает на отсоединённый узел. Если
        // так, перенаводим ссылку на новую картинку, иначе следующий клик по карандашу
        // прочитает протухшую инструкцию и persist.js не найдёт .mes для сохранения.
        const btn = container.querySelector(`.${BTN_CLASS}`) ?? outerWrap?.querySelector(`.${BTN_CLASS}`);
        if (btn && (!btn.__imaginyTarget || !btn.__imaginyTarget.isConnected)) {
            btn.__imaginyTarget = el;
        }
        el.dataset.imaginyBound = '1';
        return;
    }

    // У неудавшейся генерации карандаш видно всегда: наводить курсор на плашку или на
    // картинку-заглушку, чтобы обнаружить кнопку, никто не догадается.
    const isError = kind === 'error';

    const btn = makeButton(kind, { errorMod: isError });
    btn.__imaginyTarget = el;
    container.appendChild(btn);
    el.dataset.imaginyBound = '1';

    // Плашка-div (SLAY) сама себе контейнер, и position ей может быть не задан.
    if (isError && container === el) {
        // :has() фолбэк для браузеров без поддержки (iOS Safari < 15.4, см.
        // upstream-комментарий у SLAY ~3738). CSS-правило
        // `.iig-error-placeholder:has(.imaginy-edit-btn)` уже покрывает современные
        // браузеры; здесь просто подстраховка.
        try {
            if (getComputedStyle(container).position === 'static') {
                container.style.position = 'relative';
            }
        } catch (err) {
            logWarn('decorateTarget: getComputedStyle упал', err);
        }
    }
}

function decorateImage(img) {
    const { imageSkipMatch, imageSkipAncestor } = selectors();
    for (const selector of imageSkipMatch) {
        if (img.matches?.(selector)) return;
    }
    for (const selector of imageSkipAncestor) {
        if (img.closest(selector)) return;
    }
    decorateTarget(img, 'image');
}

function decorateVideo(video) {
    decorateTarget(video, 'video');
}

function decorateErrorTarget(el) {
    decorateTarget(el, 'error');
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

    const sel = selectors();

    // root сам может быть целью.
    if (root instanceof Element) {
        if (sel.errorTarget) tryMatch(root, sel.errorTarget, decorateErrorTarget);
        tryMatch(root, sel.image, decorateImage);
        tryMatch(root, sel.video, decorateVideo);
    }

    const query = (selector) => {
        try {
            return root.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : [];
        } catch (err) {
            logError(`decorateRoot: querySelectorAll(${selector}) упал`, err);
            return [];
        }
    };

    // Цели-ошибки сначала: у форков ошибочная картинка — это img с инструкцией, то есть
    // она попадает и под общий img-селектор. Порядок гарантирует, что она будет
    // размечена как kind 'error' (у decorateImage она отсекается через imageSkipMatch),
    // а не как обычная картинка.
    if (sel.errorTarget) {
        for (const el of query(sel.errorTarget)) candidates.push([el, decorateErrorTarget]);
    }
    for (const el of query(sel.image)) candidates.push([el, decorateImage]);
    for (const el of query(sel.video)) candidates.push([el, decorateVideo]);

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
    later(() => {
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

// Отцепляет наблюдение за #chat и гасит все отложенные обходы. Флаг на #chat снимаем
// обязательно: bindObserver считает его признаком «здесь уже наблюдаем» и без снятия
// повторное включение декорации не перевесило бы observer.
function stopObserving() {
    try {
        observer?.disconnect();
    } catch (err) {
        logWarn('stopObserving: disconnect упал', err);
    }
    observer = null;

    const chatEl = chatRoot();
    if (chatEl?.dataset?.imaginyObserverBound) delete chatEl.dataset.imaginyObserverBound;

    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    pendingScanRoots = new Set();
    clearPendingTimers();
}

export function setDecorationEnabled(flag) {
    if (flag) {
        // Наблюдение могло быть отцеплено предыдущим выключением — поднимаем заново.
        bindObserver(chatRoot());
        scan();
        return;
    }
    stopObserving();
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

    // Проверку наличия хоста делаем не на старте (в этот момент DOM всегда пуст, и
    // предупреждение было бы ложным), а после первого обхода.
    setTimeout(() => {
        if (!isHostPresent()) {
            warnOnce(
                'host-not-detected',
                'Расширение генерации картинок (SLAY Images или один из форков inline image generation) не обнаружено на странице. '
                + 'Imaginy продолжит работать, но кнопка-карандаш появится только там, где такое расширение отрисует изображение '
                + '(либо в этом чате просто нет сгенерированных картинок).',
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
