// Профиль хоста: «⊹ INLINE IMAGE GENERATION ⊹» (aceeenvw/notsosillynotsoimages v2.1).
//
// Проверено по index.js@main (июнь 2026):
//   1526-1580  wrapImageWithActions() — div.iig-image-wrapper + .iig-action-regen/.iig-action-download
//   1672-1690  regenerateSingleImage(imgElement) — читает промпт из getAttribute(data-iig-instruction),
//              то есть правку Imaginy в DOM видит так же, как её видит SLAY
//   1717-1720  options.aspectRatio = data.aspect_ratio → далее (698) options.aspectRatio || settings.aspectRatio,
//              то есть per-image значение в приоритете, «auto»-оговорки SLAY здесь нет
//   1762-1766  ошибка генерации → img.iig-error-image с сохранённым data-iig-instruction,
//              но БЕЗ обёртки и без кнопки перегенерации
//   видео этот форк не создаёт вовсе (нет ни одного createElement('video'))
//   глобального стиля-перекрытия нет: settings.styles/activeStyleId отсутствуют

import { ATTR, SEL_IMAGE, SEL_VIDEO, no, regenViaWrapButton } from './common.js';

const REASONS = {
    video: 'Это расширение не создаёт видео — перегенерировать нечем, промпт можно только сохранить.',
    error:
        'Неудавшаяся генерация здесь остаётся картинкой-заглушкой без кнопки перегенерации. '
        + 'Промпт сохранён — перегенерируйте через кнопку «Перегенерировать картинки» в меню сообщения.',
    noButton: 'Кнопка перегенерации не найдена — возможно, расширение картинок отключено. Промпт сохранён.',
    busy: 'Генерация этого изображения уже идёт — дождитесь её завершения.',
    stale: 'Изображение уже перерисовано — промпт сохранён, нажмите карандаш заново и перегенерируйте.',
};

export const NSNSI = Object.freeze({
    id: 'nsnsi',
    name: 'INLINE IMAGE GENERATION (notsosillynotsoimages)',
    settingsModule: 'inline_image_gen',

    detect: Object.freeze({
        globals: [],
        dom: ['.iig-action-regen', '.iig-lightbox-actions', '.iig-action-download'],
        // naisteraPreset есть только у этого форка; styles/activeStyleId, наоборот,
        // только у двух других — отсутствие ключа тоже признак (см. src/host.js).
        settingsKeys: ['naisteraPreset'],
    }),

    selectors: Object.freeze({
        image: SEL_IMAGE,
        video: SEL_VIDEO,
        imageWrap: '.iig-image-wrapper',
        // В отличие от SLAY, ошибочная картинка здесь сохраняет инструкцию — значит
        // промпт можно поправить, просто перегенерации на месте не будет.
        errorTarget: `img.iig-error-image[${ATTR}]`,
        imageSkipMatch: ['.iig-error-image'],
        imageSkipAncestor: [],
    }),

    // Обёртку форк делает сам, но только в момент отрисовки картинки; если её почему-то
    // нет (упавшая отрисовка, чужой рендер-путь), Imaginy делает свою, иначе карандаш
    // не появится совсем.
    ownWrapFallback: true,

    // Свои кнопки форк держит в правом верхнем углу — карандаш ставим в левый.
    btnPlacement: 'top-left',

    quirks: Object.freeze({
        aspectAuto: false,
        styleOverride: null,
    }),

    findRegen(targetEl, kind) {
        if (kind === 'video') return no(REASONS.video);
        if (kind === 'error') return no(REASONS.error);

        return regenViaWrapButton(targetEl, {
            wrapSelector: '.iig-image-wrapper',
            btnSelector: '.iig-action-regen',
            // Своего класса занятости форк не ставит: на время генерации он подменяет
            // обёртку на .iig-loading-placeholder — это ловит targetIsStale().
            busyClass: '',
            reasons: REASONS,
        });
    },
});
