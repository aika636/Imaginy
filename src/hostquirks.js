// Чтение (и, по явному клику пользователя, правка) настроек активного хоста —
// того расширения генерации картинок, поверх которого работает Imaginy.
//
// Зачем это нужно: некоторые глобальные настройки хоста перекрывают per-image
// значения из data-iig-instruction, и тогда правка в редакторе Imaginy честно уходит
// в JSON, но на картинку не влияет — выглядит это как «не применяется». Редактор
// показывает предупреждение ровно в тех случаях, когда перекрытие реально есть.
//
// Что и как перекрывается — зависит от хоста (profile.quirks, docs/hosts.md):
//
//   aspectAuto (только SLAY): per-image aspect_ratio учитывается ТОЛЬКО когда
//   глобальная настройка соотношения стоит в 'auto' («Из промпта»):
//     upstream/index.js:3260  settings.aspectRatio         === 'auto' ? options.aspectRatio : settings.aspectRatio
//     upstream/index.js:3377  (то же для Gemini)
//     upstream/index.js:3437  settings.naisteraAspectRatio === 'auto' ? options.aspectRatio : settings.naisteraAspectRatio
//   У всех трёх форков приоритет обратный (options.aspectRatio || settings.aspectRatio),
//   поэтому предупреждать там не о чем.
//
//   styleOverride='slay': выбранный в пикере SLAY стиль перекрывает per-image style
//   целиком, до всех API-путей (upstream/index.js:3912).
//   styleOverride='preset' (0xl0cal, delidgi): то же делает активный пресет стиля
//   (resolveEffectiveStyle: `preset || tagStyle`).
//   styleOverride=null (notsosillynotsoimages): глобального стиля нет.
//
// Imaginy НИЧЕГО не меняет в настройках хоста без явного клика пользователя.

import { getCtx } from './ctx.js';
import { logInfo, logWarn } from './log.js';
import { getHost } from './host.js';
import { ASPECT_RATIOS } from './hosts/common.js';

// У naistera-пути свой короткий список в выпадашке хоста, но сам путь кладёт
// aspect_ratio в тело запроса как есть, без сверки с VALID_ASPECT_RATIOS (SLAY:
// upstream/index.js:3437 и :3451 — проверка есть только у Gemini, :3378; в форках так
// же). Поэтому широкоформатные 16:9 / 9:16 здесь сознательно оставлены; примет ли их
// конкретный бэкенд naistera — вопрос к нему.
const ASPECT_RATIOS_NAISTERA = ['16:9', '9:16', '2:3', '3:2', '1:1'];

function hostSettings() {
    try {
        return getCtx()?.extensionSettings?.[getHost().settingsModule] ?? null;
    } catch (err) {
        logWarn('hostSettings: не удалось прочитать настройки хоста', err);
        return null;
    }
}

// Какой ключ настроек хоста управляет соотношением сторон при текущем apiType и какие
// значения имеет смысл предлагать в редакторе. overridden === true только там, где
// глобальная настройка реально перебьёт per-image значение.
export function getAspectRatioContext() {
    const host = getHost();
    const s = hostSettings();
    const naistera = s?.apiType === 'naistera';
    const key = naistera ? 'naisteraAspectRatio' : 'aspectRatio';
    const choices = naistera ? ASPECT_RATIOS_NAISTERA : [...ASPECT_RATIOS];
    // Настроек хоста нет вовсе (не установлен/не инициализирован) — не пугаем
    // пользователя предупреждением, просто отдаём полный список значений.
    const global = s ? (s[key] ?? (host.quirks.aspectAuto ? 'auto' : '')) : '';

    return {
        available: Boolean(s),
        key,
        global,
        choices,
        // 'auto' = «Из промпта»: только в этом режиме SLAY смотрит на per-image значение.
        overridden: Boolean(s) && host.quirks.aspectAuto && global !== 'auto',
    };
}

// Активный пресет стиля у форков sillyimages: settings.styles[] + settings.activeStyleId.
function activePreset(settings) {
    const styles = Array.isArray(settings?.styles) ? settings.styles : [];
    return styles.find((style) => style?.id === settings?.activeStyleId) ?? null;
}

// Перекрыт ли per-image `style` глобальной настройкой хоста, и как эта настройка
// называется для пользователя.
export function getStyleContext() {
    const host = getHost();
    const s = hostSettings();
    if (!s || !host.quirks.styleOverride) {
        return { available: false, style: '', name: '', overridden: false };
    }

    if (host.quirks.styleOverride === 'slay') {
        const style = String(s.slayStyle ?? '');
        const name = String(s.slayStyleName ?? '');
        return {
            available: true,
            style,
            // У SLAY пустое имя означает «Не заменять» (upstream/index.js:4767).
            name: name || style,
            overridden: style.trim().length > 0,
        };
    }

    // styleOverride === 'preset'
    const preset = activePreset(s);
    const style = String(preset?.value ?? '');
    return {
        available: true,
        style,
        name: String(preset?.name ?? '') || style,
        overridden: style.trim().length > 0,
    };
}

// Сбрасывает глобальный стиль хоста («Не заменять» у SLAY, «стиль выключен» у форков).
// Вызывается только по явному клику в редакторе. Возвращает true при успехе.
export function clearHostStyle() {
    try {
        const host = getHost();
        const s = hostSettings();
        if (!s || !host.quirks.styleOverride) return false;

        if (host.quirks.styleOverride === 'slay') {
            s.slayStyle = '';
            s.slayStyleName = '';
            getCtx()?.saveSettingsDebounced?.();
            // Панель SLAY может быть открыта прямо сейчас — синхронизируем подпись,
            // иначе пользователь увидит в ней имя уже сброшенного стиля.
            const nameEl = document.getElementById('slay_style_name');
            if (nameEl) nameEl.textContent = 'Не заменять';
            logInfo("clearHostStyle: SLAY slayStyle = '' (Не заменять)");
            return true;
        }

        // У форков есть своя кнопка «Выключить стиль» (#iig_style_disable), которая
        // делает ровно то же (activeStyleId = ''), но ещё и перерисовывает свою панель.
        // Если панель настроек открыта — нажимаем её, чтобы не разъезжаться с UI хоста.
        const ownBtn = document.getElementById('iig_style_disable');
        if (ownBtn) {
            ownBtn.click();
            logInfo('clearHostStyle: нажата кнопка «Выключить стиль» хоста');
            return true;
        }

        s.activeStyleId = '';
        getCtx()?.saveSettingsDebounced?.();
        logInfo("clearHostStyle: activeStyleId = '' (стиль выключен)");
        return true;
    } catch (err) {
        logWarn('clearHostStyle: не удалось изменить настройку хоста', err);
        return false;
    }
}

// Переключает глобальную настройку соотношения на «Из промпта». Осмысленно только там,
// где есть квирк aspectAuto (SLAY). Вызывается только по явному клику в редакторе.
export function setAspectRatioFromPrompt() {
    try {
        const host = getHost();
        const s = hostSettings();
        if (!s || !host.quirks.aspectAuto) return false;

        const { key } = getAspectRatioContext();
        s[key] = 'auto';
        getCtx()?.saveSettingsDebounced?.();
        // Панель настроек хоста может быть открыта прямо сейчас — синхронизируем
        // <select>, иначе пользователь увидит старое значение и «вернёт» его обратно.
        const selId = key === 'naisteraAspectRatio' ? 'slay_naistera_aspect_ratio' : 'slay_aspect_ratio';
        const sel = document.getElementById(selId);
        if (sel) sel.value = 'auto';
        logInfo(`setAspectRatioFromPrompt: ${key} = 'auto'`);
        return true;
    } catch (err) {
        logWarn('setAspectRatioFromPrompt: не удалось изменить настройку хоста', err);
        return false;
    }
}
