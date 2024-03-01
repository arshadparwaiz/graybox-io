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

// eslint-disable-next-line import/no-extraneous-dependencies
const openwhisk = require('openwhisk');
const { getAioLogger } = require('../utils');
const appConfig = require('../appConfig');
const { isGrayboxParamsValid } = require('./utils');

async function main(params) {
    const logger = getAioLogger();
    const ow = openwhisk();
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

        appConfig.setAppConfig(params);

        return exitAction(ow.actions.invoke({
            name: 'graybox/promote-worker',
            blocking: false,
            result: false,
            params
        }).then(async (result) => {
            logger.info(result);
            return {
                code: 200,
                payload: responsePayload
            };
        }).catch(async (err) => {
            logger.error('Failed to invoke graybox promote action', err);
            return {
                code: 500,
                payload: responsePayload
            };
        }));
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
    appConfig.removePayload();
    return resp;
}

exports.main = main;
