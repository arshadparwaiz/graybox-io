/* ************************************************************************
* ADOBE CONFIDENTIAL
* ___________________
*
* Copyright 2025 Adobe
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

import { toUTCStr } from '../utils.js';

/**
 * Writes a status update to the project's status.json file.
 * @param {Object} filesWrapper - The filesWrapper instance
 * @param {string} statusJsonPath - Path to the status.json file
 * @param {Object} statusEntry - The status entry to add (object)
 * @param {string} [overallStatus] - Optional. If provided, sets the top-level status field.
 */
export async function writeProjectStatus(filesWrapper, statusJsonPath, statusEntry, overallStatus) {
    let statusJson = {};
    try {
        statusJson = await filesWrapper.readFileIntoObject(statusJsonPath);
    } catch (err) {
        // If file doesn't exist, create new object
        statusJson = { statuses: [] };
    }
    if (!Array.isArray(statusJson.statuses)) {
        statusJson.statuses = [];
    }
    statusJson.statuses.push({
        ...statusEntry,
        timestamp: statusEntry.timestamp || toUTCStr(new Date())
    });
    if (overallStatus) {
        statusJson.status = overallStatus;
    }
    await filesWrapper.writeFile(statusJsonPath, statusJson);
}
