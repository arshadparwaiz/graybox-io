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
const { validateAction } = require('./validateAction');
const appConfig = require('../appConfig');

async function main(params) {
    const logger = getAioLogger();
    const ow = openwhisk();
    let responsePayload = 'Graybox Promote action invoked';
    logger.info(responsePayload);
    try {
        appConfig.setAppConfig(params);
        const grpIds = appConfig.getConfig().grayboxUserGroups;
        const vActData = await validateAction(params, grpIds, appConfig.ignoreUserCheck());
        if (vActData && vActData.code !== 200) {
            logger.info(`Validation failed: ${JSON.stringify(vActData)}`);
            return exitAction(vActData);
        }

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
            responsePayload = 'Failed to invoke graybox promote action';
            logger.error(`${responsePayload}: ${err}`);
            return {
                code: 500,
                payload: responsePayload
            };
        }));
    } catch (err) {
        responsePayload = 'Unknown error occurred';
        logger.error(`${responsePayload}: ${err}`);
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
