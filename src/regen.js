// Программная перегенерация: клик по уже существующей кнопке активного хоста.
// Imaginy не делает никаких сетевых вызовов сам — после клика всё остальное (оверлей,
// таймер, ретраи, сохранение файла, подмена src в сообщении, saveChat) выполняет сам
// хост. Imaginy не отменяет и не дублирует генерацию, и ошибки самой генерации
// остаются зоной ответственности хоста — Imaginy лишь решает, можно ли кликать.
//
// Какая именно кнопка ищется и почему в каких-то случаях перегенерация невозможна —
// решает профиль хоста (src/hosts/*.js, обзор в docs/hosts.md): у SLAY это
// .iig-regen-btn в его обёртке, у delidgi — .iig-regen-single-btn, у
// notsosillynotsoimages — .iig-action-regen, у 0xl0cal per-image кнопки нет вовсе и
// используется кнопка сообщения (только когда картинка в сообщении одна).
//
// Единственное решение, которое принимает этот модуль сам, — фолбэк на кнопку меню
// сообщения, когда кнопки, которую ждёт профиль, в разметке не оказалось (см. canRegen).

import { logError, logInfo } from './log.js';
import { getHost } from './host.js';
import { REFUSAL_NO_BUTTON, regenViaMessageFallback } from './hosts/common.js';

const REASON_UNKNOWN = 'Не удалось определить, можно ли перегенерировать. Промпт сохранён.';

// canRegen(targetEl, kind) -> { ok, reason, btn }. reason — русская фраза для
// пользователя при ok === false, пустая строка при ok === true.
//
// Отказ вида «кнопки, которую ждёт профиль, в разметке нет» (code === noButton) — это
// ещё и симптом неверно опознанного хоста: детект по ключам настроек переживает смену
// форка, а 0xl0cal своих DOM-улик не оставляет вовсе (src/host.js, п.2), поэтому за
// профилем delidgi/SLAY/nsnsi реально может стоять он. Прежде чем отказать, пробуем
// кнопку меню сообщения — но только у профилей, которые это разрешают
// (messageRegenFallback), и только с её собственными ограничениями (перегенерируется
// всё сообщение ⇒ можно лишь когда цель в сообщении одна).
//
// Остальные отказы (busy / stale / multiple / «кнопки нет по сути форка») фолбэк не
// трогает, и неудачный фолбэк не подменяет исходную причину отказа своей — она точнее.
export function canRegen(targetEl, kind) {
    try {
        const host = getHost();
        const verdict = host.findRegen(targetEl, kind) ?? { ok: false, reason: REASON_UNKNOWN, btn: null, code: null };
        if (verdict.ok || verdict.code !== REFUSAL_NO_BUTTON || !host.messageRegenFallback) return verdict;

        const fallback = regenViaMessageFallback(targetEl);
        if (!fallback.ok) return verdict;

        logInfo(`canRegen: кнопки профиля ${host.id} нет — фолбэк на кнопку перегенерации в меню сообщения`);
        return fallback;
    } catch (err) {
        logError('canRegen: профиль хоста упал', err);
        return { ok: false, reason: REASON_UNKNOWN, btn: null, code: null };
    }
}

// requestRegen(targetEl, kind) -> { ok, reason }. Перепроверяет canRegen (состояние
// могло измениться, пока был открыт модал редактора — это и есть смысл повторной
// проверки), и при ok кликает по найденной кнопке. Всё, что происходит после клика, —
// дело хоста.
export function requestRegen(targetEl, kind) {
    // Никогда не бросает: к этому моменту промпт уже сохранён, и исключение отсюда
    // в вызывающем коде выглядело бы как «не удалось сохранить» — ложь.
    try {
        const check = canRegen(targetEl, kind);
        if (!check.ok) return { ok: false, reason: check.reason };
        if (!check.btn) return { ok: false, reason: REASON_UNKNOWN };

        // Кнопка может быть скрыта настройкой хоста (например imgActionRegen у delidgi
        // вешает на <body> класс, который её прячет) — из DOM она при этом не исчезает,
        // а обработчики у форков делегированные, так что click() всё равно работает.
        check.btn.click();
        logInfo(`requestRegen: клик по кнопке перегенерации выполнен (хост ${getHost().id})`);

        return { ok: true, reason: '' };
    } catch (err) {
        logError('requestRegen упал', err);
        return { ok: false, reason: 'Не удалось запустить перегенерацию. Промпт сохранён.' };
    }
}
