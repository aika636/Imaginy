// Общие для всех host-профилей константы и хелперы.
//
// Все четыре поддерживаемых расширения — родственники одного предка «Inline Image
// Generation»: они хранят параметры генерации в одном и том же атрибуте
// data-iig-instruction с одними и теми же ключами (prompt / style / aspect_ratio) и
// пользуются одним и тем же CSS-префиксом iig-. Различаются только обёртка вокруг
// картинки, кнопка перегенерации и мелкие особенности настроек — ровно то, что
// описывают профили в этой папке.

import { logWarn } from '../log.js';

export const ATTR = 'data-iig-instruction';

export const SEL_IMAGE = `img[${ATTR}]`;
export const SEL_VIDEO = `video[${ATTR}]`;

// VALID_ASPECT_RATIOS — один и тот же список во всех четырёх расширениях.
export const ASPECT_RATIOS = Object.freeze([
    '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
]);

export function safeClosest(el, selector) {
    try {
        return el?.closest?.(selector) ?? null;
    } catch (err) {
        return null;
    }
}

export function messageOf(el) {
    return safeClosest(el, '.mes');
}

// Сколько элементов с инструкцией в том же сообщении. Нужно профилю 0xl0cal: у него
// нет per-image перегенерации, и кнопка в меню сообщения перегенерирует все теги
// сразу — значит эквивалентом «перегенерировать эту картинку» она становится только
// когда картинка в сообщении одна.
export function countInstructionsInMessage(el) {
    const mes = messageOf(el);
    if (!mes) return 0;
    try {
        return mes.querySelectorAll(`[${ATTR}]`).length;
    } catch (err) {
        logWarn('countInstructionsInMessage: querySelectorAll упал', err);
        return 0;
    }
}

// Универсальная замена SLAY-классу iig-regen-busy, которого у форков нет: на время
// генерации форк подменяет саму картинку (или её обёртку) на .iig-loading-placeholder,
// то есть наша цель выпадает из документа. Проверка именно по цели, а не по всему
// сообщению: соседняя картинка, которая генерируется прямо сейчас, перегенерации этой
// не мешает.
//
// Тот же признак отлавливает и «сообщение перерисовали, пока был открыт редактор» —
// кликать по кнопке из отцепленного поддерева бессмысленно, хост её уже не слушает.
export function targetIsStale(el) {
    try {
        return !(el?.isConnected ?? false);
    } catch (err) {
        return false;
    }
}

// Кнопка «перегенерировать картинки» в меню сообщения — единственная кнопка, которую
// рисует форк 0xl0cal, и фолбэк-путь для остальных профилей (см. regenViaMessageFallback).
export const MESSAGE_REGEN_BTN = '.iig-regenerate-btn';

// Класс отказа. Нужен, чтобы src/regen.js мог различить «кнопки по профилю нет вовсе»
// (единственный случай, когда осмысленно пробовать фолбэк) от «кнопка есть, но сейчас
// нельзя» — busy/stale/multiple. Разбирать русскую фразу отказа для этого нельзя.
export const REFUSAL_NO_BUTTON = 'noButton';

export function no(reason, code = null) {
    return { ok: false, reason, btn: null, code };
}

export function yes(btn) {
    return { ok: true, reason: '', btn, code: null };
}

// Кнопка «перегенерировать картинки» в меню сообщения (.extraMesButtons). Она
// перегенерирует ВСЕ теги сообщения, перечитывая их из текста сообщения — то есть
// нашу правку она видит (persist.js пишет в текст), но применить её как «перегенерируй
// именно эту картинку» можно только когда картинка в сообщении одна. Иначе честнее
// отказаться, чем молча перегенерировать соседей.
export function regenViaMessageButton(targetEl, { btnSelector, reasons }) {
    if (targetIsStale(targetEl)) return no(reasons.stale ?? reasons.busy, 'stale');

    const mes = messageOf(targetEl);
    const btn = mes ? mes.querySelector(btnSelector) : null;
    if (!btn) return no(reasons.noButton, REFUSAL_NO_BUTTON);

    if (countInstructionsInMessage(targetEl) > 1) return no(reasons.multiple, 'multiple');

    return yes(btn);
}

// Фолбэк для профиля, у которого «своей» кнопки перегенерации на месте не нашлось.
//
// Зачем: детект хоста по ключам настроек переживает смену форка (src/host.js, п.2), а
// у 0xl0cal своих DOM-улик нет вообще — поэтому у того, кто раньше пользовался delidgi,
// профиль навсегда останется DELIDGI, хотя картинки рисует 0xl0cal. Кнопки delidgi в
// разметке нет, а кнопка меню сообщения — есть, и она перечитывает промпты из текста
// сообщения, то есть нашу правку видит. Ограничения те же, что у профиля L0CAL:
// перегенерируется всё сообщение, поэтому разрешаем только когда цель в сообщении одна.
// Причины — ключи локализации (src/i18n.js), а не готовый текст: профиль хоста не
// знает, на каком языке смотрит пользователь, а вердикт живёт до самого показа в
// тосте. Переводится он ровно в двух местах — в index.js и в подписи неактивной
// кнопки редактора.
const FALLBACK_REASONS = Object.freeze({
    noButton: 'regen.noButton',
    stale: 'regen.stale',
    multiple: 'regen.multiple',
});

export function regenViaMessageFallback(targetEl) {
    return regenViaMessageButton(targetEl, {
        btnSelector: MESSAGE_REGEN_BTN,
        reasons: FALLBACK_REASONS,
    });
}

// Кнопка перегенерации внутри обёртки хоста — общий случай для SLAY, delidgi и
// notsosillynotsoimages. busyClass задаётся только там, где хост его реально ставит.
export function regenViaWrapButton(targetEl, { wrapSelector, btnSelector, busyClass, reasons }) {
    if (targetIsStale(targetEl)) return no(reasons.stale ?? reasons.busy, 'stale');

    const wrap = safeClosest(targetEl, wrapSelector);
    const btn = wrap ? wrap.querySelector(btnSelector) : null;
    if (!wrap || !btn) return no(reasons.noButton, REFUSAL_NO_BUTTON);

    if (busyClass && btn.classList.contains(busyClass)) return no(reasons.busy, 'busy');

    return yes(btn);
}
