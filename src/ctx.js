// Хелперы доступа к хосту SillyTavern. Контекст никогда не кэшируется в переменной
// модуля — он запрашивается заново в каждой точке использования: хост может пересоздать
// контекст (сам SLAY делает так же).

import { logWarn } from './log.js';

export function getCtx() {
    return SillyTavern.getContext();
}

// SLAY использует ctx.event_types (snake_case), ST-AutoPulse — ctx.eventTypes
// (camelCase). Какой из них реально существует в конкретной версии ST — заранее не
// известно, поэтому пробуем оба и фолбэчимся на пустой объект.
export function getEventTypes(ctx) {
    return ctx?.event_types ?? ctx?.eventTypes ?? {};
}

// Безопасная обёртка над амбиентным toastr. Если toastr недоступен (например, при
// раннем вызове до полной загрузки ST), сообщение всё равно не теряется — уходит в
// консоль.
export function toast(kind, message, title = 'Imaginy') {
    try {
        if (typeof toastr !== 'undefined' && typeof toastr[kind] === 'function') {
            toastr[kind](message, title);
            return;
        }
    } catch (err) {
        logWarn('toast: ошибка вызова toastr', err);
    }
    logWarn(`toast (${kind}) ${title}: ${message}`);
}
