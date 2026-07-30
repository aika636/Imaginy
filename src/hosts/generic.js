// Профиль-фолбэк: расширение семейства «iig» на странице есть (или ещё непонятно,
// какое именно), но по следам его не удалось опознать. Задача профиля — не потерять
// главную функцию Imaginy (правку и сохранение промпта) на форке, которого мы не
// знаем: селекторы берём объединением известных, кнопку перегенерации ищем перебором.
//
// Этот же профиль работает до того, как детект успел что-то увидеть (на старте ST
// настройки уже есть, а DOM ещё пуст — см. src/host.js).

import { ATTR, SEL_IMAGE, SEL_VIDEO, no, safeClosest, targetIsStale, yes } from './common.js';

const REASONS = {
    noButton:
        'Кнопка перегенерации не найдена: расширение картинок не опознано. '
        + 'Промпт сохранён — перегенерируйте штатной кнопкой самого расширения.',
    stale: 'Изображение уже перерисовано — промпт сохранён, нажмите карандаш заново и перегенерируйте.',
};

// Порядок = от самой узкой (per-image) кнопки к самой общей. Кнопку в меню сообщения
// (.iig-regenerate-btn) здесь НЕ трогаем: она перегенерирует всё сообщение, и без
// знания форка нельзя обещать, что это безопасно.
const REGEN_BUTTONS = [
    ['.iig-img-wrap', '.iig-regen-btn', 'iig-regen-busy'],
    ['.iig-image-wrapper', '.iig-regen-single-btn', ''],
    ['.iig-image-wrapper', '.iig-action-regen', ''],
];

export const GENERIC = Object.freeze({
    id: 'generic',
    name: 'расширение картинок (не опознано)',
    settingsModule: 'inline_image_gen',

    detect: Object.freeze({ globals: [], dom: [], settingsKeys: [] }),

    selectors: Object.freeze({
        image: SEL_IMAGE,
        video: SEL_VIDEO,
        // closest() принимает список селекторов — подойдёт любая из известных обёрток.
        imageWrap: '.iig-img-wrap, .iig-image-wrapper',
        errorTarget: `.iig-error-placeholder[${ATTR}], img.iig-error-image[${ATTR}]`,
        imageSkipMatch: ['.iig-error-image'],
        imageSkipAncestor: ['.iig-error-placeholder'],
    }),

    ownWrapFallback: true,
    btnPlacement: 'top-left',

    quirks: Object.freeze({
        aspectAuto: false,
        styleOverride: null,
    }),

    findRegen(targetEl, kind) {
        if (targetIsStale(targetEl)) return no(REASONS.stale);

        for (const [wrapSelector, btnSelector, busyClass] of REGEN_BUTTONS) {
            const wrap = safeClosest(targetEl, wrapSelector);
            const btn = wrap ? wrap.querySelector(btnSelector) : null;
            if (!btn) continue;
            if (busyClass && btn.classList.contains(busyClass)) {
                return no('Генерация этого изображения уже идёт — дождитесь её завершения.');
            }
            return yes(btn);
        }

        return no(REASONS.noButton);
    },
});
