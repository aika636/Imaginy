// Логирование Imaginy. Все сообщения идут с префиксом [Imaginy], чтобы их было легко
// найти в консоли рядом с логами SLAY и самого SillyTavern.

const PREFIX = '[Imaginy]';

export function logInfo(...args) {
    console.log(PREFIX, ...args);
}

export function logWarn(...args) {
    console.warn(PREFIX, ...args);
}

export function logError(...args) {
    console.error(PREFIX, ...args);
}

// Ключи, для которых предупреждение уже было показано в текущей сессии страницы.
// Используется для однократных предупреждений вроде «SLAY не найден» или
// «нераспознанный формат data-iig-instruction»: такие сообщения не должны сыпаться на
// каждый рендер сообщения.
const warnedKeys = new Set();

export function warnOnce(key, ...args) {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    logWarn(...args);
}
