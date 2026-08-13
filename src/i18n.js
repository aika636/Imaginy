// Локализация интерфейса.
//
// Русский здесь — язык оригинала, английский — перевод. Это не то же самое, что
// «расширение переводят на русский»: формулировки сначала пишутся по-русски, и русская
// таблица — источник, с которым сверяется английская.
//
// Почему не штатный addLocaleData таверны. Он принимает данные только для текущего
// языка и молча выбрасывает остальные; ключом там служит английская строка целиком, а
// переопределять существующие ключи запрещено. Для расширения, где оригинал русский, он
// не работает ни в одну сторону: русские строки в него не положить, а английские он
// возьмёт только тогда, когда у пользователя уже выбран английский.
//
// Незнакомый ключ возвращается сам собой. Забытый перевод виден как `editor.save` —
// уродливо, зато сразу заметно; пустое место или молчаливый откат на русский выглядели
// бы как исправная работа. Полноту таблиц стережёт tests/i18n.test.mjs.
//
// Множественного числа здесь нет ни в одной строке, поэтому нет и правил склонения:
// неиспользуемый плюрализатор — это код, который нечем проверить. Если появится строка
// со счётчиком, правило пишется руками, а не через Intl.PluralRules: в старых вебвью
// Android Intl бывает урезан.

import { getCtx } from './ctx.js';
import { logInfo, logWarn } from './log.js';

export const DEFAULT_LOCALE = 'ru';
// Язык, на который сваливаемся с незнакомого: английский понимают шире, чем русский.
export const FALLBACK_LOCALE = 'en';

const STRINGS = {
    ru: {
        // ── Кнопка-карандаш (src/decorate.js) ──
        'decorate.editTitle': 'Редактировать промпт',

        // ── Редактор (src/editor.js) ──
        'editor.title': 'Редактирование промпта — {host}',
        'editor.field.prompt': 'Промпт',
        'editor.field.style': 'Стиль',
        'editor.field.aspect_ratio': 'Соотношение сторон',
        'editor.copyPrompt': 'Скопировать промпт',
        'editor.save': 'Сохранить',
        'editor.saveRegen': 'Сохранить и перегенерировать',
        'editor.saveRegen.short': 'Сохр. + реген.',
        'editor.cancel': 'Отмена',
        'editor.hotkeyHint': '{hotkey} — сохранить, Esc — отмена',
        'editor.aspect.unset': 'Не задано (значение возьмёт {host})',
        'editor.styleFromMemory': 'Подставлен последний использованный стиль.',
        'editor.forget': 'Забыть',
        'editor.hostStyleOverride':
            'В {host} выбран стиль «{style}» — он перекроет любой стиль, вписанный здесь.',
        'editor.hostStyleReset': 'Сбросить стиль хоста',
        'editor.hostAspectOverride':
            'В настройках {host} жёстко задано «{value}» — это значение перекроет любое выбранное здесь.',
        'editor.hostAspectSwitch': 'Переключить на «Из промпта»',
        'editor.history.was': 'Было: «{preview}»',
        'editor.history.earlier': 'Ещё раньше ({step}): «{preview}»',
        'editor.history.none': 'Прошлых версий больше нет.',
        'editor.history.foreign': 'Промпт меняли не через Imaginy. ',
        'editor.history.restore': 'Вернуть',

        // ── Тосты (index.js, src/editor.js, src/settings.js) ──
        'toast.readFailed': 'Не удалось прочитать параметры изображения',
        'toast.domOnly': 'Правка применена только к DOM и не переживёт перезагрузку',
        'toast.savedDeferred': 'Промпт сохранён, но запись на диск отложена',
        'toast.saved': 'Промпт сохранён',
        'toast.saveFailed': 'Не удалось сохранить промпт',
        'toast.regenStarted': 'Перегенерация запущена',
        'toast.editorAlreadyOpen': 'Редактор уже открыт',
        'toast.editorOpenFailed': 'Не удалось открыть редактор: {error}',
        'toast.editorError': 'Ошибка редактора: {error}',
        'toast.editorInvisible': 'Редактор v{build} не виден: {geometry}',
        'toast.promptCopied': 'Промпт скопирован',
        'toast.promptCopyFailed': 'Не удалось скопировать промпт',
        'toast.historyRestored': 'Прошлый промпт подставлен — сохраните, чтобы применить',
        'toast.hostStyleCleared':
            'Глобальный стиль {host} сброшен — теперь применяется стиль из инструкции',
        'toast.hostStyleClearFailed':
            'Не удалось изменить настройку {host} — сбросьте стиль вручную в его панели',
        'toast.hostAspectSwitched':
            '{host} переключён на «Из промпта» — соотношение теперь берётся из инструкции',
        'toast.hostAspectSwitchFailed':
            'Не удалось изменить настройку {host} — переключите вручную в его панели',
        'toast.styleForgotten': 'Запомненный стиль забыт',
        'toast.styleForgetFailed': 'Не удалось забыть стиль',

        // ── Вердикты перегенерации (src/regen.js, src/hosts/*) ──
        'regen.unknown': 'Не удалось определить, можно ли перегенерировать. Промпт сохранён.',
        'regen.failed': 'Не удалось запустить перегенерацию. Промпт сохранён.',
        'regen.noButton':
            'Кнопка перегенерации не найдена — возможно, расширение картинок отключено. Промпт сохранён.',
        'regen.noButton.generic':
            'Кнопка перегенерации не найдена: расширение картинок не опознано. '
            + 'Промпт сохранён — перегенерируйте штатной кнопкой самого расширения.',
        'regen.noButton.slay':
            'Кнопка перегенерации SLAY не найдена — возможно, SLAY отключён. Промпт сохранён.',
        'regen.noButton.l0cal':
            'В этом форке нет кнопки перегенерации отдельной картинки, а кнопки «Перегенерировать картинки» '
            + 'в меню сообщения не нашлось. Промпт сохранён.',
        'regen.stale':
            'Изображение уже перерисовано — промпт сохранён, нажмите карандаш заново и перегенерируйте.',
        'regen.busy': 'Генерация этого изображения уже идёт — дождитесь её завершения.',
        'regen.multiple':
            'В этом сообщении несколько картинок, а перегенерация здесь работает только на всё сообщение сразу. '
            + 'Промпт сохранён — запустите перегенерацию кнопкой в меню сообщения, если готовы обновить все картинки.',
        'regen.video.slay':
            'SLAY не добавляет кнопку перегенерации к видео — промпт можно только сохранить.',
        'regen.video.delidgi':
            'Видео этот форк не оборачивает и кнопки перегенерации к нему не добавляет. '
            + 'Промпт сохранён — перегенерируйте через меню сообщения.',
        'regen.video.nsnsi':
            'Это расширение не создаёт видео — перегенерировать нечем, промпт можно только сохранить.',
        'regen.error.slay':
            'Кнопка «Попробовать снова» у неудавшейся генерации использует промпт, захваченный в замыкание SLAY, '
            + 'и не увидит правку. Сохраните промпт и обновите сообщение (свайп или смена чата), после чего повторите генерацию.',
        'regen.error.nsnsi':
            'Неудавшаяся генерация здесь остаётся картинкой-заглушкой без кнопки перегенерации. '
            + 'Промпт сохранён — перегенерируйте через кнопку «Перегенерировать картинки» в меню сообщения.',

        // ── Панель настроек (settings.html, src/settings.js) ──
        'settings.enabled': 'Включить Imaginy',
        'settings.showEditButton': 'Показывать кнопку-карандаш на изображениях',
        'settings.regenerateAfterSave': 'Перегенерировать после сохранения промпта',
        'settings.syncImageSrc': 'Закреплять перегенерированные картинки',
        'settings.syncImageSrc.hint':
            'Дописывает путь к новой картинке во все места, где SillyTavern хранит текст '
            + 'сообщения. Без этого перегенерированная картинка после перезагрузки страницы '
            + 'может смениться обратно на самую первую.',
        'settings.lastStyle': 'Запомненный стиль',
        'settings.lastStyle.forget': 'Забыть',
        'settings.lastStyle.hint':
            'Подставляется в редакторе в поле «Стиль», когда у картинки своего стиля нет. '
            + 'Один на все чаты и всех ботов. Сам по себе на генерацию не влияет — только '
            + 'подставляется в редактор.',
        'settings.language': 'Язык интерфейса',
        'settings.language.auto': 'Как в SillyTavern',
        'settings.host': 'Расширение картинок:',
        'settings.host.unknown': 'не определено',
        'settings.host.detecting': 'определяется…',
        'settings.about':
            'Imaginy — тонкая надстройка над расширениями инлайн-генерации картинок '
            + '(SLAY Images, notsosillynotsoimages, sillyimages): позволяет редактировать промпт '
            + 'сгенерированного изображения, кликнув по кнопке-карандашу.',

        // ── Имя неопознанного хоста (src/hosts/generic.js) ──
        'host.generic.name': 'расширение картинок (не опознано)',
    },

    en: {
        'decorate.editTitle': 'Edit prompt',

        'editor.title': 'Edit prompt — {host}',
        'editor.field.prompt': 'Prompt',
        'editor.field.style': 'Style',
        'editor.field.aspect_ratio': 'Aspect ratio',
        'editor.copyPrompt': 'Copy prompt',
        'editor.save': 'Save',
        'editor.saveRegen': 'Save and regenerate',
        'editor.saveRegen.short': 'Save + regen',
        'editor.cancel': 'Cancel',
        'editor.hotkeyHint': '{hotkey} — save, Esc — cancel',
        'editor.aspect.unset': 'Not set ({host} decides)',
        'editor.styleFromMemory': 'Filled in with the last style you used.',
        'editor.forget': 'Forget',
        'editor.hostStyleOverride':
            '{host} has the style “{style}” selected — it overrides any style typed here.',
        'editor.hostStyleReset': 'Clear the host style',
        'editor.hostAspectOverride':
            '{host} is set to “{value}” — that value overrides anything selected here.',
        'editor.hostAspectSwitch': 'Switch to “From prompt”',
        'editor.history.was': 'Before: “{preview}”',
        'editor.history.earlier': 'Earlier ({step}): “{preview}”',
        'editor.history.none': 'No older versions left.',
        'editor.history.foreign': 'The prompt was changed outside Imaginy. ',
        'editor.history.restore': 'Restore',

        'toast.readFailed': 'Could not read the image parameters',
        'toast.domOnly': 'The edit was applied to the page only and will not survive a reload',
        'toast.savedDeferred': 'Prompt saved, but writing to disk was deferred',
        'toast.saved': 'Prompt saved',
        'toast.saveFailed': 'Could not save the prompt',
        'toast.regenStarted': 'Regeneration started',
        'toast.editorAlreadyOpen': 'The editor is already open',
        'toast.editorOpenFailed': 'Could not open the editor: {error}',
        'toast.editorError': 'Editor error: {error}',
        'toast.editorInvisible': 'Editor v{build} is not visible: {geometry}',
        'toast.promptCopied': 'Prompt copied',
        'toast.promptCopyFailed': 'Could not copy the prompt',
        'toast.historyRestored': 'Previous prompt filled in — save to apply it',
        'toast.hostStyleCleared':
            'The global {host} style is cleared — the style from the instruction applies now',
        'toast.hostStyleClearFailed':
            'Could not change the {host} setting — clear the style manually in its own panel',
        'toast.hostAspectSwitched':
            '{host} switched to “From prompt” — the aspect ratio now comes from the instruction',
        'toast.hostAspectSwitchFailed':
            'Could not change the {host} setting — switch it manually in its own panel',
        'toast.styleForgotten': 'Remembered style forgotten',
        'toast.styleForgetFailed': 'Could not forget the style',

        'regen.unknown': 'Could not tell whether regeneration is possible. The prompt is saved.',
        'regen.failed': 'Could not start the regeneration. The prompt is saved.',
        'regen.noButton':
            'No regenerate button found — the image extension may be disabled. The prompt is saved.',
        'regen.noButton.generic':
            'No regenerate button found: the image extension was not recognised. '
            + 'The prompt is saved — regenerate with the extension\'s own button.',
        'regen.noButton.slay':
            'The SLAY regenerate button was not found — SLAY may be disabled. The prompt is saved.',
        'regen.noButton.l0cal':
            'This fork has no per-image regenerate button, and no "Regenerate images" button was found '
            + 'in the message menu. The prompt is saved.',
        'regen.stale':
            'The image has already been redrawn — the prompt is saved; click the pencil again and regenerate.',
        'regen.busy': 'This image is already being generated — wait for it to finish.',
        'regen.multiple':
            'This message has several images, and regeneration here only works on the whole message at once. '
            + 'The prompt is saved — use the button in the message menu if you are ready to redo every image.',
        'regen.video.slay':
            'SLAY does not add a regenerate button to videos — the prompt can only be saved.',
        'regen.video.delidgi':
            'This fork neither wraps videos nor adds a regenerate button to them. '
            + 'The prompt is saved — regenerate from the message menu.',
        'regen.video.nsnsi':
            'This extension does not create videos — there is nothing to regenerate, the prompt can only be saved.',
        'regen.error.slay':
            'The "Try again" button of a failed generation uses the prompt captured in a SLAY closure and will not '
            + 'see your edit. Save the prompt, refresh the message (swipe or switch chats), then generate again.',
        'regen.error.nsnsi':
            'A failed generation stays here as a placeholder image with no regenerate button. '
            + 'The prompt is saved — regenerate with the "Regenerate images" button in the message menu.',

        'settings.enabled': 'Enable Imaginy',
        'settings.showEditButton': 'Show the pencil button on images',
        'settings.regenerateAfterSave': 'Regenerate after saving the prompt',
        'settings.syncImageSrc': 'Pin regenerated images',
        'settings.syncImageSrc.hint':
            'Writes the new image path into every place SillyTavern keeps the message text. '
            + 'Without it a regenerated image may revert to the very first one after a page reload.',
        'settings.lastStyle': 'Remembered style',
        'settings.lastStyle.forget': 'Forget',
        'settings.lastStyle.hint':
            'Pre-filled into the "Style" field of the editor when an image has no style of its own. '
            + 'Shared across all chats and characters. It does not affect generation by itself — it only '
            + 'gets pre-filled into the editor.',
        'settings.language': 'Interface language',
        'settings.language.auto': 'Same as SillyTavern',
        'settings.host': 'Image extension:',
        'settings.host.unknown': 'not detected',
        'settings.host.detecting': 'detecting…',
        'settings.about':
            'Imaginy is a thin add-on over the inline image generation extensions '
            + '(SLAY Images, notsosillynotsoimages, sillyimages): it lets you edit the prompt of a '
            + 'generated image by clicking the pencil button.',

        // Не буквальный перевод русского «расширение картинок (не опознано)»: имя
        // подставляется в строки вроде «Not set ({host} decides)», и скобки внутри
        // скобок там читаются плохо.
        'host.generic.name': 'unrecognised image extension',
    },
};

export const LOCALES = Object.freeze(Object.keys(STRINGS));

// Кэш вычисленного языка. Считается из настройки и языка таверны; обе величины меняются
// редко, а t() зовётся на каждую подпись в окне.
let cached = null;

function settingValue() {
    try {
        // Настройки читаем напрямую из контекста, а не через settings.js: тот сам зовёт
        // t() для панели, и импорт в обе стороны замкнул бы модули друг на друга.
        return getCtx()?.extensionSettings?.Imaginy?.language ?? 'auto';
    } catch (err) {
        return 'auto';
    }
}

// Язык самой таверны. getCurrentLocale есть не во всех версиях ST, поэтому за ним идут
// два запасных источника: ключ, которым ST хранит выбор языка, и язык браузера.
function tavernLocale() {
    try {
        const ctx = getCtx();
        const fromCtx = ctx?.getCurrentLocale?.();
        if (typeof fromCtx === 'string' && fromCtx) return fromCtx;
    } catch (err) {
        logWarn('i18n: getCurrentLocale упал', err);
    }
    try {
        const stored = localStorage.getItem('language');
        if (typeof stored === 'string' && stored) return stored;
    } catch (err) {
        // localStorage бывает недоступен (приватный режим, встроенный вебвью).
    }
    try {
        return navigator.language ?? '';
    } catch (err) {
        return '';
    }
}

// 'ru-RU' -> 'ru'. Незнакомый язык — английский: он понятнее большему числу людей, чем
// русский, а притворяться, что интерфейс переведён, всё равно нельзя.
function normalize(code) {
    const base = String(code ?? '').toLowerCase().split(/[-_]/)[0];
    return LOCALES.includes(base) ? base : FALLBACK_LOCALE;
}

export function getLocale() {
    if (cached) return cached;
    const setting = settingValue();
    cached = setting === 'auto' ? normalize(tavernLocale()) : normalize(setting);
    return cached;
}

// Зовётся после смены настройки языка: следующий t() пересчитает язык заново.
export function resetLocale() {
    cached = null;
}

export function setLocale(code) {
    resetLocale();
    logInfo(`язык интерфейса: ${code} -> ${getLocale()}`);
}

// {name} -> значение. Отсутствующий параметр оставляет плейсхолдер как есть: пустое
// место в строке выглядело бы как испорченный перевод, а видимый {host} сразу
// показывает, где именно потеряли значение.
function fill(template, params) {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name) => (
        Object.hasOwn(params, name) ? String(params[name]) : whole
    ));
}

export function t(key, params) {
    const table = STRINGS[getLocale()] ?? STRINGS[DEFAULT_LOCALE];
    const value = table[key];
    if (typeof value !== 'string') {
        // Возвращаем сам ключ — см. шапку модуля.
        return fill(String(key), params);
    }
    return fill(value, params);
}

// Для теста, который сверяет таблицы между собой.
export function tableKeys(locale) {
    return Object.keys(STRINGS[locale] ?? {});
}
