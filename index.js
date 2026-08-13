// Точка входа Imaginy. Тонкий файл: только связывает модули, вся логика — в src/.

import { getCtx, getEventTypes, toast } from './src/ctx.js';
import { logError, logInfo } from './src/log.js';
import { initSettingsUI, getSettings } from './src/settings.js';
import { initDecoration, setDecorationEnabled } from './src/decorate.js';
import { readInstruction } from './src/instruction.js';
import { readHistoryFor } from './src/history.js';
import { openEditor } from './src/editor.js';
import { persistInstruction } from './src/persist.js';
import { canRegen, requestRegen } from './src/regen.js';
import { initSrcSync } from './src/srcsync.js';
import { VERSION } from './src/version.js';
import { t } from './src/i18n.js';

const BUSY_BTN_CLASS = 'imaginy-busy';
const SPIN_ICON_CLASS = 'fa-solid fa-spinner imaginy-spin';

// Гвард от повторного входа: пока идёт persist, дальнейшие клики по карандашу
// игнорируются (openEditor и так не даст открыть второй модал, но клик всё равно
// не должен молча копиться в очередь).
let editInFlight = false;

async function onEdit(targetEl, kind, btn) {
    if (editInFlight) return;

    const instruction = readInstruction(targetEl);
    if (!instruction) {
        toast('error', t('toast.readFailed'));
        return;
    }

    const regen = canRegen(targetEl, kind);
    const history = readHistoryFor(targetEl, instruction.data?.prompt);
    const result = await openEditor({ data: instruction.data, kind, regen, history });
    if (!result) return; // отменено пользователем

    editInFlight = true;

    // Busy-состояние на самом карандаше, пока идёт persist — то же самое, что SLAY
    // делает со своей иконкой (upstream ~3694, ~3825): подменяем класс <i>, в finally
    // возвращаем оригинал на любом исходе, включая исключение.
    const icon = btn?.querySelector?.('i');
    const originalIconClass = icon?.className;
    if (btn && icon) {
        btn.classList.add(BUSY_BTN_CLASS);
        icon.className = SPIN_ICON_CLASS;
    }

    try {
        const { ok, method, savedToDisk } = await persistInstruction({
            targetEl,
            rawDom: instruction.rawDom,
            newData: result.data,
            // Инструкция в том виде, в каком её открыл редактор: из неё берётся прошлый
            // промпт для истории. Читать её заново нельзя — атрибут в DOM к этому
            // моменту уже мог быть переписан.
            prevData: instruction.data,
        });

        if (!ok) {
            toast('error', t('toast.domOnly'));
        } else if (savedToDisk === false) {
            toast('warning', t('toast.savedDeferred'));
        } else {
            toast('success', t('toast.saved'));
        }
        logInfo(`onEdit: persist завершён (ok=${ok}, method=${method}, savedToDisk=${savedToDisk})`);

        // Регенерацию запускаем только если промпт реально лёг в текст сообщения
        // (ok === true). При ok === false правка живёт только в DOM: клик по кнопке
        // хоста формально сработал бы (часть хостов читает промпт из DOM), но результат
        // прикрепился бы к сообщению, чей текст всё ещё хранит старый промпт —
        // молчаливое рассогласование хуже отказа, поэтому отказываем сами. У хостов,
        // читающих промпт из текста сообщения (delidgi, 0xl0cal), при ok === false
        // перегенерация вообще взяла бы старый промпт.
        const wantsRegen = ok && (result.action === 'saveAndRegen' || (result.action === 'save' && getSettings().regenerateAfterSave));
        if (wantsRegen) {
            const regenResult = requestRegen(targetEl, kind);
            if (regenResult.ok) {
                toast('info', t('toast.regenStarted'));
            } else {
                // reason — ключ локализации (src/regen.js, src/hosts/*).
                toast('warning', t(regenResult.reason));
            }
        }
    } catch (err) {
        logError('onEdit: persistInstruction упал', err);
        toast('error', t('toast.saveFailed'));
    } finally {
        if (btn && icon) {
            icon.className = originalIconClass;
            btn.classList.remove(BUSY_BTN_CLASS);
        }
        editInFlight = false;
    }
}

function onSettingsChanged(updated) {
    try {
        setDecorationEnabled(updated.enabled && updated.showEditButton);
    } catch (err) {
        logError('setDecorationEnabled упал после смены настроек', err);
    }
}

// Панель настроек можно вешать только когда #extensions_settings уже отрисован —
// ST-AutoPulse делает это в APP_READY. Если событие уже прошло (или его имени нет
// в этой версии ST), падаем на отложенную попытку, чтобы не потерять панель совсем.
function initSettingsPanel() {
    let done = false;
    const run = async () => {
        if (done) return;
        done = true;
        try {
            await initSettingsUI(onSettingsChanged);
        } catch (err) {
            logError('initSettingsUI упал', err);
        }
    };

    try {
        const ctx = getCtx();
        const et = getEventTypes(ctx);
        if (et.APP_READY) ctx.eventSource.on(et.APP_READY, run);
    } catch (err) {
        logError('не удалось подписаться на APP_READY', err);
    }

    // Страховка на случай, когда APP_READY уже произошёл до загрузки модуля.
    setTimeout(run, 3000);
}

jQuery(async () => {
    try {
        initSettingsPanel();
        initDecoration({ onEdit });
        initSrcSync();
        logInfo(`v${VERSION} загружен`);
    } catch (err) {
        logError('инициализация упала', err);
    }
});
