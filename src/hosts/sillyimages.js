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
// 0xl0cal/sillyimages 2.0, проверено по src/*.js@master (октябрь 2026), и его форк
// niemandswasser/sillywardrobe3-0 (1.726, master@b544ced) — разметка у них одна:
//   src/imageActions.js  attachActions() заворачивает каждую img[data-iig-instruction] в
//                        span.iig-img-host, рядом кладёт div.iig-img-actions с кнопками
//                        .iig-img-download и .iig-img-regen (у упавшей — .iig-img-retry).
//                        Видео не оборачивает (селектор только img).
//   src/imageActions.js  у sillywardrobe «скачать» ищет картинку как ПРЯМОГО потомка
//                        обёртки (`:scope > img[data-iig-instruction]`), иначе берёт ту, что
//                        была при постройке кнопок. Своя обёртка Imaginy между ними ломала
//                        этот поиск: после перегенерации скачивалась самая первая версия.
//                        Поэтому карандаш кладём прямо в .iig-img-host.
//   src/pipeline.js      regenerateSingleTag() — промпт берёт из ТЕКСТА сообщения, то есть
//                        правку через persist.js видит; за «Повторить» у упавшей — она же.
//   src/parser.js        applyConfiguredStyleToTag/resolveEffectiveStyle — активный пресет
//                        стиля перекрывает per-image style.
//
// 0xl0cal до 2.0 (index.js@master, июнь 2026) картинку не оборачивал вовсе и per-image
// кнопки не имел: только .iig-regenerate-btn в меню сообщения, которая перегенерирует ВСЕ
// теги сообщения. На таких установках обёртки .iig-img-host нет — карандаш встаёт в свою
// обёртку, а «Сохранить и перегенерировать» разрешено, только когда картинка одна.

import {
    ATTR, MESSAGE_REGEN_BTN, SEL_IMAGE, SEL_VIDEO, regenViaMessageButton, regenViaWrapButton, safeClosest,
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
        // До 2.0 DOM-следов не было вовсе — тогда детект идёт по ключам настроек.
        dom: ['.iig-img-host', '.iig-img-actions', '.iig-img-regen'],
        settingsKeys: ['additionalReferences', 'characterReferenceLibrary'],
    }),

    selectors: Object.freeze({
        image: SEL_IMAGE,
        video: SEL_VIDEO,
        imageWrap: '.iig-img-host',
        errorTarget: `img.iig-error-image[${ATTR}]`,
        imageSkipMatch: ['.iig-error-image'],
        imageSkipAncestor: [],
    }),

    // Обёртку 2.0 ставит синхронно из своего MutationObserver, так что к нашему
    // отложенному обходу она уже есть. Не появилась (версия до 2.0) — делаем свою.
    ownWrapFallback: true,
    btnPlacement: 'top-left',

    // Кнопка меню сообщения — основной путь для версии до 2.0, её профиль пробует сам.
    messageRegenFallback: false,

    quirks: Object.freeze({
        aspectAuto: false,
        styleOverride: 'preset',
    }),

    findRegen(targetEl, kind) {
        if (safeClosest(targetEl, '.iig-img-host')) {
            return regenViaWrapButton(targetEl, {
                wrapSelector: '.iig-img-host',
                btnSelector: kind === 'error' ? '.iig-img-retry' : '.iig-img-regen',
                // Класса занятости нет: на время генерации картинка подменяется на
                // .iig-loading-placeholder, это ловит targetIsStale().
                busyClass: '',
                reasons: L0CAL_REASONS,
            });
        }

        // Версия до 2.0 или видео (его 2.0 не оборачивает): единственный путь — кнопка
        // в меню сообщения, и она перегенерирует всё сообщение.
        return regenViaMessageButton(targetEl, {
            btnSelector: MESSAGE_REGEN_BTN,
            reasons: L0CAL_REASONS,
        });
    },
});
