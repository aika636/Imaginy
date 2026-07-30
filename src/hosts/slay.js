// Профиль хоста: SLAY Images v4.3.1 (upstream/ — read-only клон, см. CLAUDE.md).
// Поведение этого профиля — ровно то, что Imaginy делал до появления host-профилей.

import { ATTR, SEL_IMAGE, SEL_VIDEO, no, regenViaWrapButton } from './common.js';

const REASONS = {
    video: 'SLAY не добавляет кнопку перегенерации к видео — промпт можно только сохранить.',
    error:
        'Кнопка «Попробовать снова» у неудавшейся генерации использует промпт, захваченный в замыкание SLAY, '
        + 'и не увидит правку. Сохраните промпт и обновите сообщение (свайп или смена чата), после чего повторите генерацию.',
    noButton: 'Кнопка перегенерации SLAY не найдена — возможно, SLAY отключён. Промпт сохранён.',
    busy: 'Генерация этого изображения уже идёт — дождитесь её завершения.',
    stale: 'Изображение уже перерисовано — промпт сохранён, нажмите карандаш заново и перегенерируйте.',
};

export const SLAY = Object.freeze({
    id: 'slay',
    name: 'SLAY Images',
    settingsModule: 'slay_image_gen',

    // window.slayWardrobe — единственный глобал SLAY (upstream/index.js:2157).
    detect: Object.freeze({
        globals: ['slayWardrobe'],
        dom: ['.iig-img-wrap', '.iig-regen-btn', '.iig-error-placeholder'],
        settingsKeys: [],
    }),

    selectors: Object.freeze({
        image: SEL_IMAGE,
        video: SEL_VIDEO,
        // SLAY оборачивает картинку в span.iig-img-wrap лениво (docs/sillytavern-api.md
        // §2.1) — если обёртки ещё нет, ждём следующей мутации, свою не делаем.
        imageWrap: '.iig-img-wrap',
        // Плашка неудавшейся генерации: div, сам себе контейнер для кнопки.
        errorTarget: `.iig-error-placeholder[${ATTR}]`,
        // Картинки-заглушки, которые SLAY подставляет при сбое отрисовки — не цель.
        imageSkipMatch: ['.iig-error-image'],
        imageSkipAncestor: ['.iig-error-placeholder'],
    }),

    // Обёртку SLAY делает сам; своя нужна только для видео (общее правило decorate.js).
    ownWrapFallback: false,

    // Кнопка перегенерации SLAY сидит в левом верхнем углу (top:8; left:8; 34x34) —
    // карандаш встаёт правее неё.
    btnPlacement: 'beside-host',

    quirks: Object.freeze({
        // per-image aspect_ratio SLAY использует только при глобальном 'auto'
        // (upstream/index.js:3260, :3377, :3437) — см. src/hostquirks.js.
        aspectAuto: true,
        styleOverride: 'slay',
    }),

    findRegen(targetEl, kind) {
        if (kind === 'video') return no(REASONS.video);
        // Стоп-фактор задокументирован в docs/sillytavern-api.md §2.2: .iig-error-retry
        // держит промпт в замыкании SLAY и не перечитывает data-iig-instruction.
        if (kind === 'error') return no(REASONS.error);

        return regenViaWrapButton(targetEl, {
            wrapSelector: '.iig-img-wrap',
            btnSelector: '.iig-regen-btn',
            // Класс занятости висит на кнопке, не на обёртке (docs/sillytavern-api.md §2.6).
            busyClass: 'iig-regen-busy',
            reasons: REASONS,
        });
    },
});
