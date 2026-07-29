// Чтение настроек соседнего расширения SLAY Images (ctx.extensionSettings.slay_image_gen).
//
// Зачем это нужно: per-image `aspect_ratio` из data-iig-instruction попадает в генерацию
// только как options.aspectRatio, а SLAY использует его ТОЛЬКО когда его глобальная
// настройка соотношения выставлена в 'auto' («Из промпта»):
//
//   upstream/index.js:3260  settings.aspectRatio        === 'auto' ? options.aspectRatio : settings.aspectRatio
//   upstream/index.js:3377  (то же для Gemini)
//   upstream/index.js:3437  settings.naisteraAspectRatio === 'auto' ? options.aspectRatio : settings.naisteraAspectRatio
//
// Если там стоит конкретное значение (например '3:2'), правка поля в редакторе Imaginy
// уходит в JSON, но на картинку не влияет — и выглядит это как «не применяется».
// Поэтому редактор показывает предупреждение и предлагает переключить SLAY на «Из промпта».
//
// Imaginy НИЧЕГО не меняет в настройках SLAY без явного клика пользователя.

import { getCtx } from './ctx.js';
import { logInfo, logWarn } from './log.js';

const SLAY_MODULE = 'slay_image_gen';

// upstream/index.js:3216 — VALID_ASPECT_RATIOS для OpenAI/Gemini-путей.
const ASPECT_RATIOS_DEFAULT = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
// В UI самого SLAY у naistera только три варианта (upstream/index.js:4766), но список
// там — ограничение его выпадашки, а не API: naistera-путь кладёт aspect_ratio в тело
// запроса как есть, без сверки с VALID_ASPECT_RATIOS (upstream/index.js:3437 и :3451 —
// проверка есть только у Gemini, :3378). Поэтому широкоформатные 16:9 / 9:16 сюда
// добавлены сознательно; примет ли их конкретный бэкенд naistera — вопрос к нему.
const ASPECT_RATIOS_NAISTERA = ['16:9', '9:16', '2:3', '3:2', '1:1'];

function getSlaySettings() {
    try {
        return getCtx()?.extensionSettings?.[SLAY_MODULE] ?? null;
    } catch (err) {
        logWarn('getSlaySettings: не удалось прочитать настройки SLAY', err);
        return null;
    }
}

// Какой именно ключ настроек SLAY управляет соотношением сторон при текущем apiType,
// и какие значения имеет смысл предлагать в редакторе.
export function getAspectRatioContext() {
    const s = getSlaySettings();
    const naistera = s?.apiType === 'naistera';
    const key = naistera ? 'naisteraAspectRatio' : 'aspectRatio';
    const choices = naistera ? ASPECT_RATIOS_NAISTERA : ASPECT_RATIOS_DEFAULT;
    // Настроек SLAY нет вовсе (SLAY не установлен/не инициализирован) — не пугаем
    // пользователя предупреждением, просто отдаём полный список значений.
    const global = s ? (s[key] ?? 'auto') : 'auto';
    return {
        available: Boolean(s),
        key,
        global,
        choices,
        // 'auto' = «Из промпта»: только в этом режиме SLAY смотрит на per-image значение.
        overridden: Boolean(s) && global !== 'auto',
    };
}

// Выбранный в пикере SLAY стиль перекрывает per-image `style` из инструкции целиком:
//
//   upstream/index.js:3912  if (settings.slayStyle) style = settings.slayStyle;
//
// Это происходит внутри generateImageWithRetry, до всех API-путей, поэтому касается и
// naistera, и Gemini, и OpenAI. Пока в пикере выбран стиль, поле «Стиль» в редакторе
// Imaginy сохраняется в JSON, но на картинку не влияет.
export function getStyleContext() {
    const s = getSlaySettings();
    const style = s ? String(s.slayStyle ?? '') : '';
    const name = s ? String(s.slayStyleName ?? '') : '';
    return {
        available: Boolean(s),
        style,
        // Имя показываем пользователю; у SLAY пустое имя означает «Не заменять»
        // (upstream/index.js:4767 — `settings.slayStyleName || 'Не заменять'`).
        name: name || style,
        overridden: Boolean(s) && style.trim().length > 0,
    };
}

// Сбрасывает стиль в пикере SLAY на «Не заменять». Вызывается только по явному клику
// в редакторе. Возвращает true при успехе.
export function clearSlayStyle() {
    try {
        const s = getSlaySettings();
        if (!s) return false;
        s.slayStyle = '';
        s.slayStyleName = '';
        getCtx()?.saveSettingsDebounced?.();
        // Панель SLAY может быть открыта прямо сейчас — синхронизируем подпись, иначе
        // пользователь увидит в ней имя уже сброшенного стиля.
        const nameEl = document.getElementById('slay_style_name');
        if (nameEl) nameEl.textContent = 'Не заменять';
        logInfo("clearSlayStyle: SLAY slayStyle = '' (Не заменять)");
        return true;
    } catch (err) {
        logWarn('clearSlayStyle: не удалось изменить настройку SLAY', err);
        return false;
    }
}

// Переключает глобальную настройку SLAY на «Из промпта». Вызывается только по явному
// клику в редакторе. Возвращает true при успехе.
export function setAspectRatioFromPrompt() {
    try {
        const s = getSlaySettings();
        if (!s) return false;
        const { key } = getAspectRatioContext();
        s[key] = 'auto';
        getCtx()?.saveSettingsDebounced?.();
        // Панель настроек SLAY может быть открыта прямо сейчас — синхронизируем <select>,
        // иначе пользователь увидит в ней старое значение и «вернёт» его обратно.
        const selId = key === 'naisteraAspectRatio' ? 'slay_naistera_aspect_ratio' : 'slay_aspect_ratio';
        const sel = document.getElementById(selId);
        if (sel) sel.value = 'auto';
        logInfo(`setAspectRatioFromPrompt: SLAY ${key} = 'auto'`);
        return true;
    } catch (err) {
        logWarn('setAspectRatioFromPrompt: не удалось изменить настройку SLAY', err);
        return false;
    }
}
