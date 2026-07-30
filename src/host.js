// Определение активного расширения-хоста (SLAY Images или один из форков семейства
// «inline image generation») и выдача его профиля остальным модулям.
//
// Все четыре хоста используют один и тот же атрибут data-iig-instruction, а три форка —
// ещё и один и тот же ключ настроек `inline_image_gen`, поэтому различить их можно
// только по совокупности следов:
//
//   1. DOM — самый надёжный признак: разметку рисует именно тот хост, который работает
//      прямо сейчас. Минус — до появления первой картинки следов нет.
//   2. Ключи настроек — доступны сразу при загрузке, но переживают смену форка: у того,
//      кто раньше пользовался delidgi, ключи delidgi останутся в настройках навсегда.
//      Поэтому DOM всегда важнее настроек, а вывод, сделанный только по настройкам,
//      считается предварительным и перепроверяется.
//   3. Ничего не совпало — GENERIC: правка промпта работает, перегенерация ищется
//      перебором известных кнопок (src/hosts/generic.js).
//
// Профили и то, чем именно хосты различаются: docs/hosts.md.

import { getCtx } from './ctx.js';
import { logInfo, logWarn, warnOnce } from './log.js';
import { ATTR } from './hosts/common.js';
import { SLAY } from './hosts/slay.js';
import { NSNSI } from './hosts/nsnsi.js';
import { DELIDGI, L0CAL } from './hosts/sillyimages.js';
import { GENERIC } from './hosts/generic.js';

// Порядок — приоритет при равном весе улик.
export const PROFILES = Object.freeze([SLAY, DELIDGI, NSNSI, L0CAL]);

// Сколько профилей претендует на один и тот же ключ настроек: если ключ уникален
// (как slay_image_gen), его наличия уже достаточно для опознания.
const MODULE_USERS = PROFILES.reduce((acc, p) => {
    acc[p.settingsModule] = (acc[p.settingsModule] ?? 0) + 1;
    return acc;
}, {});

// Сколько профилей внутри одного settingsModule перечисляют один и тот же ключ
// настроек: у ключа, который называет только один профиль, совпадение — сильная улика
// (профиль только что был активен), а у ключа, который называют несколько профилей
// одного модуля, — слабая (мог остаться от любого из них после смены форка).
const KEY_USERS = PROFILES.reduce((acc, p) => {
    const byKey = (acc[p.settingsModule] ??= {});
    for (const key of p.detect.settingsKeys) {
        byKey[key] = (byKey[key] ?? 0) + 1;
    }
    return acc;
}, {});

// Все DOM- и глобальные улики всех профилей, собранные в одном месте: isHostPresent()
// не должен дублировать литералы селекторов — они живут только в профилях (CLAUDE.md).
const ALL_DOM_CLUES = PROFILES.flatMap((p) => p.detect.dom).join(', ');
const ALL_GLOBAL_CLUES = Object.freeze([...new Set(PROFILES.flatMap((p) => p.detect.globals))]);

// Как часто перепроверять предварительный вывод (GENERIC или «опознан только по
// настройкам»). Детект дешёвый — несколько querySelector — но вызывается он на каждом
// обходе DOM, поэтому без троттлинга это лишняя работа.
const RECHECK_MS = 3000;

let current = null;
let checkedAt = 0;
let confirmedByDom = false;
let lastDom = 0;

function settingsOf(module) {
    try {
        return getCtx()?.extensionSettings?.[module] ?? null;
    } catch (err) {
        return null;
    }
}

function score(profile) {
    let dom = 0;
    for (const name of profile.detect.globals) {
        try {
            if (window[name] !== undefined) dom += 2;
        } catch (err) {
            /* доступ к глобалу может бросить в экзотическом окружении — не признак */
        }
    }
    for (const selector of profile.detect.dom) {
        try {
            if (document.querySelector(selector)) dom += 2;
        } catch (err) {
            logWarn(`детект хоста: селектор ${selector} невалиден`, err);
        }
    }

    let cfg = 0;
    const settings = settingsOf(profile.settingsModule);
    if (settings) {
        if (MODULE_USERS[profile.settingsModule] === 1) cfg += 2;
        for (const key of profile.detect.settingsKeys) {
            if (!Object.hasOwn(settings, key)) continue;
            const shared = KEY_USERS[profile.settingsModule]?.[key] > 1;
            cfg += shared ? 1 : 3;
        }
    }

    return { profile, dom, cfg };
}

function detect() {
    const scored = PROFILES.map(score);

    // Улики из DOM полностью вытесняют улики из настроек — см. шапку модуля.
    const byDom = scored.filter((s) => s.dom > 0);
    const pool = byDom.length > 0 ? byDom : scored.filter((s) => s.cfg > 0);

    if (pool.length === 0) {
        return { profile: GENERIC, dom: 0, cfg: 0 };
    }

    pool.sort((a, b) => (b.dom - a.dom) || (b.cfg - a.cfg)
        || (PROFILES.indexOf(a.profile) - PROFILES.indexOf(b.profile)));

    const best = pool[0];
    const rival = pool[1];
    if (byDom.length > 1) {
        warnOnce(
            'host-ambiguous',
            `На странице следы сразу нескольких расширений картинок (${best.profile.name} и ${rival.profile.name}) — `
            + `выбран ${best.profile.name}. Если карандаш ведёт себя не так, отключите лишнее расширение.`,
        );
    }

    return best;
}

// Активный профиль хоста. Никогда не возвращает null: в худшем случае — GENERIC.
export function getHost() {
    const now = Date.now();
    // Как только вывод подтверждён разметкой, он окончательный: перерешать на каждом
    // обходе нечего, а мигание профиля посреди сессии хуже любой неточности.
    if (current && confirmedByDom) return current;
    // Троттлим переопрос только когда прошлый вывод сам опирался на DOM (dom > 0, но
    // ещё не confirmedByDom — например, кворум не набран). Вывод, сделанный только по
    // настройкам или упавший в GENERIC (dom === 0), переопрашиваем на каждом вызове —
    // иначе окно троттлинга кэширует непроверенный GENERIC до появления первой картинки.
    if (current && lastDom > 0 && now - checkedAt < RECHECK_MS) return current;

    checkedAt = now;
    const { profile, dom, cfg } = detect();

    if (profile !== current) {
        logInfo(`хост: ${profile.name} (id=${profile.id}, улики: dom=${dom}, настройки=${cfg})`);
        current = profile;
    }
    confirmedByDom = dom > 0;
    lastDom = dom;

    return current;
}

// Сбрасывает кэш детекта: следующий getHost() решает заново. Нужно для смоук-тестов
// (docs/development.md) и для ручной диагностики из консоли, когда хост поменяли, не
// перезагружая страницу.
export function resetHostDetection() {
    current = null;
    checkedAt = 0;
    confirmedByDom = false;
    lastDom = 0;
}

// Есть ли на странице вообще хоть какое-то расширение картинок этого семейства.
// Намеренно НЕ выключает декорацию при false: чат без картинок неотличим от чата без
// хоста, поэтому решение одно — один раз предупредить и продолжать сканировать.
export function isHostPresent() {
    try {
        if (document.querySelector(`[${ATTR}]`)) return true;
        if (ALL_DOM_CLUES && document.querySelector(ALL_DOM_CLUES)) return true;
        for (const name of ALL_GLOBAL_CLUES) {
            if (window[name] !== undefined) return true;
        }
        for (const module of Object.keys(MODULE_USERS)) {
            if (settingsOf(module)) return true;
        }
        return false;
    } catch (err) {
        logWarn('isHostPresent: ошибка проверки', err);
        return false;
    }
}
