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
import openwhisk from 'openwhisk';
import { getAioLogger } from '../utils.js';
import initFilesWrapper from './filesWrapper.js';

async function main(params) {
    const logger = getAioLogger();
    const ow = openwhisk();
    let responsePayload = 'Graybox Preview Scheduler invoked';
    logger.info(responsePayload);

    const filesWrapper = await initFilesWrapper(logger);

    try {
        const projectQueue = await filesWrapper.readFileIntoObject('graybox_promote/project_queue.json');
        logger.info(`From Preview-sched Project Queue Json: ${JSON.stringify(projectQueue)}`);
        if (!projectQueue) {
            responsePayload = 'No projects in the queue';
            logger.info(responsePayload);
            return {
                code: 200,
                payload: responsePayload
            };
        }

        // iterate the JSON array projects and extract the project_path where status is 'initiated'
        const toBePreviewedProjectPaths = [];
        projectQueue.forEach((project) => {
            if (project.status === 'initiated' || project.status === 'promoted') {
                toBePreviewedProjectPaths.push(project.projectPath);
            }
        });

        if (!toBePreviewedProjectPaths || toBePreviewedProjectPaths.length === 0) {
            responsePayload = 'No projects in the queue with status initiated';
            logger.info(responsePayload);
            return {
                code: 200,
                payload: responsePayload
            };
        }

        toBePreviewedProjectPaths.forEach(async (project) => {
            const projectStatusJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/status.json`);

            // copy all params from json into the params object
            const inputParams = projectStatusJson?.params;
            Object.keys(inputParams).forEach((key) => {
                params[key] = inputParams[key];
            });

            try {
                return ow.actions.invoke({
                    name: 'graybox/preview-worker',
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
                    responsePayload = 'Failed to invoke graybox preview action';
                    logger.error(`${responsePayload}: ${err}`);
                    return {
                        code: 500,
                        payload: responsePayload
                    };
                });
            } catch (err) {
                responsePayload = 'Unknown error occurred';
                logger.error(`${responsePayload}: ${err}`);
                responsePayload = err;
            }

            return {
                code: 500,
                payload: responsePayload,
            };
        });
    } catch (err) {
        responsePayload = 'Unknown error occurred';
        logger.error(`${responsePayload}: ${err}`);
        responsePayload = err;
    }

    return {
        code: 500,
        payload: responsePayload,
    };
}

export { main };
