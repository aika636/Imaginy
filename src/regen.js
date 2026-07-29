// Программная перегенерация: клик по уже существующей кнопке SLAY .iig-regen-btn.
// Imaginy не делает никаких сетевых вызовов сам — после клика всё остальное (оверлей,
// таймер, ретраи, сохранение файла, replaceImageSrcEverywhere, saveChat) выполняет
// SLAY. Imaginy не отменяет и не дублирует генерацию, и ошибки самой генерации
// остаются зоной ответственности SLAY — Imaginy лишь решает, можно ли кликать.

import { logError, logInfo } from './log.js';
import { SELECTORS } from './decorate.js';

const REASON_VIDEO = 'SLAY не добавляет кнопку перегенерации к видео — промпт можно только сохранить.';

const REASON_ERROR =
    'Кнопка «Попробовать снова» у неудавшейся генерации использует промпт, захваченный в замыкание SLAY, ' +
    'и не увидит правку. Сохраните промпт и обновите сообщение (свайп или смена чата), после чего повторите генерацию.';

const REASON_NO_BUTTON =
    'Кнопка перегенерации SLAY не найдена — возможно, SLAY отключён. Промпт сохранён.';

const REASON_BUSY = 'Генерация этого изображения уже идёт — дождитесь её завершения.';

// canRegen(targetEl, kind) -> { ok, reason }. reason — русская фраза для пользователя
// при ok === false, пустая строка при ok === true.
export function canRegen(targetEl, kind) {
    if (kind === 'video') {
        return { ok: false, reason: REASON_VIDEO };
    }
    if (kind === 'error') {
        // Стоп-фактор задокументирован в docs/sillytavern-api.md §2.2: .iig-error-retry
        // держит промпт в замыкании SLAY и не перечитывает data-iig-instruction —
        // поэтому Imaginy сознательно не кликает по ней.
        return { ok: false, reason: REASON_ERROR };
    }

    const wrap = targetEl?.closest?.(SELECTORS.imageWrap);
    const btn = wrap?.querySelector?.(SELECTORS.regenBtn);
    if (!wrap || !btn) {
        return { ok: false, reason: REASON_NO_BUTTON };
    }

    if (btn.classList.contains(SELECTORS.regenBusyClass)) {
        return { ok: false, reason: REASON_BUSY };
    }

    return { ok: true, reason: '' };
}

// requestRegen(targetEl, kind) -> { ok, reason }. Перепроверяет canRegen (состояние
// могло измениться, пока был открыт модал редактора — это и есть смысл повторной
// проверки), и при ok кликает по найденной кнопке. Всё, что происходит после клика
// (оверлей, таймер, ретраи, сохранение файла, replaceImageSrcEverywhere, saveChat) —
// дело SLAY; Imaginy не отменяет и не дублирует генерацию, и в ошибки самой
// генерации не вмешивается.
export function requestRegen(targetEl, kind) {
    // Никогда не бросает: к этому моменту промпт уже сохранён, и исключение отсюда
    // в вызывающем коде выглядело бы как «не удалось сохранить» — ложь.
    try {
        const check = canRegen(targetEl, kind);
        if (!check.ok) return check;

        const wrap = targetEl.closest(SELECTORS.imageWrap);
        const btn = wrap.querySelector(SELECTORS.regenBtn);

        btn.click();
        logInfo(`requestRegen: клик по ${SELECTORS.regenBtn} выполнен`);

        return { ok: true, reason: '' };
    } catch (err) {
        logError('requestRegen упал', err);
        return { ok: false, reason: 'Не удалось запустить перегенерацию. Промпт сохранён.' };
    }
}
