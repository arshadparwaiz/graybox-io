/* ************************************************************************
* ADOBE CONFIDENTIAL
* ___________________
*
* Copyright 2024 Adobe
* All Rights Reserved.
*
* NOTICE: All information contained herein is, and remains
* the property of Adobe and its suppliers, if any. The intellectual
* and technical concepts contained herein are proprietary to Adobe
* and its suppliers and are protected by all applicable intellectual
* property laws, including trade secret and copyright laws.
* Dissemination of this information or reproduction of this material
* is strictly forbidden unless prior written permission is obtained
* from Adobe.
************************************************************************* */

const AioLogger = require('@adobe/aio-lib-core-logging');

function getAioLogger(loggerName = 'main', logLevel = 'info') {
    return AioLogger(loggerName, { level: logLevel });
}

function strToArray(val) {
    if (val && typeof val === 'string') {
        return val.split(',').map((e) => e.trim()).filter((e) => e);
    }
    return val;
}

function toUTCStr(dt) {
    const ret = new Date(dt);
    return Number.isNaN(ret.getTime()) ? dt : ret.toUTCString();
}

function isFilePathWithWildcard(filePath, pattern) {
    if (!filePath || !pattern) {
        return false;
    }
    const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wildcardToRegex = (wildcard) => escapeRegExp(wildcard).replace(/\\\*/g, '.*');
    const regexPattern = new RegExp(`^${wildcardToRegex(pattern)}$`);
    return regexPattern.test(filePath);
}

function isFilePatternMatched(filePath, patterns) {
    if (patterns && Array.isArray(patterns)) {
        return !!patterns.find((pattern) => isFilePathWithWildcard(filePath, pattern) || isFilePathWithWildcard(filePath, `${pattern}/*`));
    }
    return isFilePathWithWildcard(filePath, patterns);
}

function logMemUsage() {
    const logger = getAioLogger();
const memStr = JSON.stringify(process.memoryUsage());
logger.info(`Memory Usage : ${memStr}`);
}

async function delay(milliseconds = 100) {
    // eslint-disable-next-line no-promise-executor-return
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function handleExtension(path) {
    const pidx = path.lastIndexOf('/');
    const fld = path.substring(0, pidx + 1);
    let fn = path.substring(pidx + 1);

    if (fn.endsWith('.xlsx')) {
        fn = fn.replace('.xlsx', '.json');
    }
    if (fn.toLowerCase() === 'index.docx') {
        fn = '';
    }
    if (fn.endsWith('.docx')) {
        fn = fn.substring(0, fn.lastIndexOf('.'));
    }

    fn = fn
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9.]+/g, '-')
        .replace(/^-|-$/g, '');

    return `${fld}${fn}`;
}

module.exports = {
    getAioLogger,
    strToArray,
    isFilePatternMatched,
    toUTCStr,
    logMemUsage,
    delay,
    handleExtension
};
