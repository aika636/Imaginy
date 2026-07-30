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

import { logError, logInfo } from './log.js';
import { getHost } from './host.js';

const REASON_UNKNOWN = 'Не удалось определить, можно ли перегенерировать. Промпт сохранён.';

// canRegen(targetEl, kind) -> { ok, reason, btn }. reason — русская фраза для
// пользователя при ok === false, пустая строка при ok === true.
export function canRegen(targetEl, kind) {
    try {
        return getHost().findRegen(targetEl, kind) ?? { ok: false, reason: REASON_UNKNOWN, btn: null };
    } catch (err) {
        logError('canRegen: профиль хоста упал', err);
        return { ok: false, reason: REASON_UNKNOWN, btn: null };
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
