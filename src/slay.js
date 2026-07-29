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
// upstream/index.js:4766 — у naistera в UI SLAY только три варианта.
const ASPECT_RATIOS_NAISTERA = ['1:1', '3:2', '2:3'];

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
