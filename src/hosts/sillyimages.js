// Профили двух форков «sillyimages» (оба зовут себя inline image generation и оба
// живут в extensionSettings.inline_image_gen — различаются только разметкой и набором
// ключей настроек, см. src/host.js о детекте).
//
// delidgi/sillyimages, проверено по index.js@master (июль 2026):
//   10922-10963  wrapImageWithActions() — div.iig-image-wrapper[data-tag-index]
//                + .iig-image-actions > .iig-regen-single-btn (правый верхний угол)
//   10969-10992  wrapErrorImageWithRegen() — ошибочная картинка тоже получает обёртку
//                и кнопку перегенерации, поэтому у этого форка правка промпта работает
//                и на упавших генерациях (у SLAY — нет)
//   10994-11070  regenerateSingleImage(messageId, tagIndex) — читает промпт НЕ из DOM,
//                а из текста сообщения (parseMessageImageTags), то есть видит нашу
//                правку через persist.js
//   4870         options.aspectRatio || settings.aspectRatio — per-image значение в приоритете
//   2672-2675    resolveEffectiveStyle(): активный пресет стиля перекрывает per-image style
//   10919        настройка imgActionRegen может СПРЯТАТЬ кнопку (класс iig-btn-no-regen
//                на <body>), но из DOM она не исчезает — программный click() работает
//
// 0xl0cal/sillyimages, проверено по index.js@master (июнь 2026):
//   картинку не оборачивает вообще (нет ни .iig-image-wrapper, ни .iig-img-wrap) и
//   per-image кнопки перегенерации не имеет: единственная кнопка —
//   3275-3292  addRegenerateButton() → .iig-regenerate-btn в меню сообщения,
//   3141-3160  regenerateMessageImages() перегенерирует ВСЕ теги сообщения из его текста.
//   Поэтому здесь Imaginy делает свою обёртку под карандаш, а «Сохранить и
//   перегенерировать» разрешает только когда картинка в сообщении одна.
//   738-745 / 526-531  applyConfiguredStyleToTag/resolveEffectiveStyle — активный пресет
//   стиля так же перекрывает per-image style.

import {
    ATTR, MESSAGE_REGEN_BTN, SEL_IMAGE, SEL_VIDEO, regenViaMessageButton, regenViaWrapButton,
} from './common.js';

// Ключи локализации, а не текст — см. комментарий у FALLBACK_REASONS в common.js.
const COMMON_REASONS = {
    noButton: 'regen.noButton',
    busy: 'regen.busy',
    stale: 'regen.stale',
    multiple: 'regen.multiple',
};

const DELIDGI_REASONS = Object.freeze({
    ...COMMON_REASONS,
    video: 'regen.video.delidgi',
});

export const DELIDGI = Object.freeze({
    id: 'sillyimages-delidgi',
    name: 'sillyimages (delidgi)',
    settingsModule: 'inline_image_gen',

    detect: Object.freeze({
        globals: [],
        dom: ['.iig-regen-single-btn', '.iig-image-wrapper[data-tag-index]', '.iig-image-actions'],
        settingsKeys: ['imgActionRegen', 'avatarItems', 'connectionPresets'],
    }),

    selectors: Object.freeze({
        image: SEL_IMAGE,
        video: SEL_VIDEO,
        imageWrap: '.iig-image-wrapper',
        errorTarget: `img.iig-error-image[${ATTR}]`,
        imageSkipMatch: ['.iig-error-image'],
        imageSkipAncestor: [],
    }),

    ownWrapFallback: true,
    btnPlacement: 'top-left',

    // Ключи delidgi остаются в настройках навсегда, а у 0xl0cal своих DOM-улик нет —
    // так что за этим профилем реально может стоять 0xl0cal. Если кнопки delidgi на
    // месте нет, разрешаем фолбэк на кнопку меню сообщения (src/regen.js).
    messageRegenFallback: true,

    quirks: Object.freeze({
        aspectAuto: false,
        styleOverride: 'preset',
    }),

    findRegen(targetEl, kind) {
        // Видео живёт без обёртки — падаем на кнопку сообщения (сработает, если
        // картинка/видео в сообщении одно).
        if (kind === 'video') {
            return regenViaMessageButton(targetEl, {
                btnSelector: MESSAGE_REGEN_BTN,
                reasons: { ...DELIDGI_REASONS, noButton: DELIDGI_REASONS.video },
            });
        }

        // kind === 'error' здесь полноценная цель: обёртка с кнопкой у ошибок есть.
        return regenViaWrapButton(targetEl, {
            wrapSelector: '.iig-image-wrapper',
            btnSelector: '.iig-regen-single-btn',
            busyClass: '',
            reasons: DELIDGI_REASONS,
        });
    },
});

const L0CAL_REASONS = Object.freeze({
    ...COMMON_REASONS,
    noButton: 'regen.noButton.l0cal',
});

export const L0CAL = Object.freeze({
    id: 'sillyimages-0xl0cal',
    name: 'sillyimages (0xl0cal)',
    settingsModule: 'inline_image_gen',

    detect: Object.freeze({
        globals: [],
        // Уникальных DOM-следов у этого форка нет (он ничего не оборачивает и не рисует
        // своих кнопок у картинки) — детект идёт по ключам настроек.
        dom: [],
        settingsKeys: ['additionalReferences'],
    }),

    selectors: Object.freeze({
        image: SEL_IMAGE,
        video: SEL_VIDEO,
        // Хост не оборачивает картинку — обёртку под карандаш делаем сами, сразу.
        imageWrap: null,
        errorTarget: `img.iig-error-image[${ATTR}]`,
        imageSkipMatch: ['.iig-error-image'],
        imageSkipAncestor: [],
    }),

    ownWrapFallback: true,
    btnPlacement: 'top-left',

    // Фолбэк здесь бессмысленен: кнопка меню сообщения — и есть основной путь профиля.
    messageRegenFallback: false,

    quirks: Object.freeze({
        aspectAuto: false,
        styleOverride: 'preset',
    }),

    findRegen(targetEl, kind) {
        // Единственный путь — кнопка в меню сообщения, и она перегенерирует всё
        // сообщение: разрешаем только когда цель в сообщении одна.
        return regenViaMessageButton(targetEl, {
            btnSelector: MESSAGE_REGEN_BTN,
            reasons: L0CAL_REASONS,
        });
    },
});
