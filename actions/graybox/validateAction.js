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

const AppConfig = require('../appConfig');
const GrayboxUser = require('../grayboxUser');

function isGrayboxParamsValid(params) {
    const {
        rootFolder,
        gbRootFolder,
        projectExcelPath,
        experienceName,
        spToken,
        adminPageUri,
        draftsOnly,
        promoteIgnorePaths
    } = params;

    const requiredParams = [rootFolder, gbRootFolder, projectExcelPath,
        experienceName, spToken, adminPageUri, draftsOnly, promoteIgnorePaths];

    // Return true if all required parameters are present
    return !requiredParams.some((param) => !param);
}

async function isUserAuthorized(params, grpIds) {
    const appConfig = new AppConfig(params);
    const grayboxUser = new GrayboxUser({ appConfig });
    const found = await grayboxUser.isInGroups(grpIds);
    return found;
}

async function validateAction(params, grpIds, ignoreUserCheck = false) {
    if (!isGrayboxParamsValid(params)) {
        return {
            code: 400,
            payload: 'Required data is not available to proceed with Graybox Promote action.'
        };
    }
    if (!ignoreUserCheck) {
        const isUserAuth = await isUserAuthorized(params, grpIds);
        if (!isUserAuth) {
            return {
                code: 401,
                payload: 'User is not authorized to perform this action.'
            };
        }
    }
    return {
        code: 200
    };
}

module.exports = {
    validateAction
};
