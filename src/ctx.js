// Хелперы доступа к хосту SillyTavern. Контекст никогда не кэшируется в переменной
// модуля — он запрашивается заново в каждой точке использования (см.
// docs/sillytavern-api.md §1: сам SLAY делает так же, хост может пересоздать контекст).

import { logWarn } from './log.js';

export function getCtx() {
    return SillyTavern.getContext();
}

// SLAY использует ctx.event_types (snake_case), ST-AutoPulse — ctx.eventTypes
// (camelCase). Какой из них реально существует в этой версии ST — не проверено
// (docs/sillytavern-api.md §1), поэтому пробуем оба и фолбэчимся на пустой объект.
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
