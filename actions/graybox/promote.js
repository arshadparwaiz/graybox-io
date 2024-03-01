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

const { getAioLogger } = require('../utils');
const grayboxConfig = require('../appConfig');
const { isGrayboxParamsValid } = require('./utils');

async function main(params) {
    const logger = getAioLogger();
    let responsePayload;
    logger.info('Graybox Promote action invoked');
    try {
        if (!isGrayboxParamsValid(params)) {
            responsePayload = 'Required data is not available to proceed with Graybox Promote action.';
            logger.error(responsePayload);
            return exitAction({
                code: 400,
                payload: responsePayload
            });
        }

        grayboxConfig.setAppConfig(params);

        const {
            rootFolder, gbRootFolder, experienceName, spToken, adminPageUri, projectExcelPath, promoteIgnorePaths, driveId, draftsOnly
        } = grayboxConfig.getPayload();
        responsePayload = {
            message: 'Graybox Promote action completed successfully',
            rootFolder,
            gbRootFolder,
            experienceName,
            spToken,
            adminPageUri,
            projectExcelPath,
            promoteIgnorePaths,
            driveId,
            draftsOnly
        };
        return exitAction({
            code: 200,
            payload: responsePayload
        });
    } catch (err) {
        logger.error('Unknown error occurred', err);
        responsePayload = err;
    }

    return exitAction({
        code: 500,
        payload: responsePayload,
    });
}

function exitAction(resp) {
    grayboxConfig.removePayload();
    return resp;
}

exports.main = main;
