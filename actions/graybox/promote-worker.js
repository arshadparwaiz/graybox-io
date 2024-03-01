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
const { isGrayboxParamsValid } = require('./utils');
const appConfig = require('../appConfig');

const logger = getAioLogger();

async function main(params) {
    let responsePayload;
    logger.info('Graybox Promote Worker invoked');

    if (!isGrayboxParamsValid(params)) {
        responsePayload = 'Required data is not available to proceed with Graybox Promote action.';
        logger.error(responsePayload);
        return exitAction({
            code: 400,
            payload: responsePayload
        });
    }

    appConfig.setAppConfig(params);
    const { gbRootFolder, experienceName } = appConfig.getPayload();

    logger.info(`GB ROOT FOLDER ::: ${gbRootFolder}`);
    logger.info(`GB EXP NAME ::: ${experienceName}`);

    responsePayload = 'Graybox Promote Worker action completed.';
    return exitAction({
        body: responsePayload,
    });
}

function exitAction(resp) {
    appConfig.removePayload();
    return resp;
}

exports.main = main;
