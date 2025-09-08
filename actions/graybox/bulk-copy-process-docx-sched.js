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

// eslint-disable-next-line import/no-extraneous-dependencies
import openwhisk from 'openwhisk';
import { getAioLogger } from '../utils.js';
import initFilesWrapper from './filesWrapper.js';

async function main(params) {
    const logger = getAioLogger();
    const ow = openwhisk();
    let responsePayload = 'Graybox Bulk Copy Process Content Scheduler invoked';
    logger.info(responsePayload);

    const filesWrapper = await initFilesWrapper(logger);

    try {
        const projectQueueBulkCopy = await filesWrapper.readFileIntoObject('graybox_promote/bulk_copy_project_queue.json');
        logger.info(`In Bulk Copy Process Content Sched Project Queue Json: ${JSON.stringify(projectQueueBulkCopy)}`);

        if (!projectQueueBulkCopy) {
            responsePayload = 'No Bulk Copy Projects in the queue';
            logger.info(responsePayload);
            return {
                code: 200,
                payload: responsePayload
            };
        }

        // iterate the JSON array projects and extract the project_path where status is 'initiated'
        const toBeProcessedProjects = projectQueueBulkCopy
            .filter((project) => project.status === 'initiated')
            .map((project) => project.projectPath);

            logger.info(`In Bulk Copy Process Content Sched, To Be Processed Projects: ${JSON.stringify(toBeProcessedProjects)}`);

        if (!toBeProcessedProjects || toBeProcessedProjects.length === 0) {
            responsePayload = 'No Bulk Copy Projects in the queue with status `initiated`';
            logger.info(responsePayload);
            return {
                code: 200,
                payload: responsePayload
            };
        }

        toBeProcessedProjects.forEach(async (project) => {
            const projectStatusBulkCopyJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);

            // copy all params from json into the params object
            const inputParams = projectStatusBulkCopyJson?.params;
            Object.keys(inputParams).forEach((key) => {
                params[key] = inputParams[key];
            });

            logger.info(`In Bulk Copy Process Content Sched, Project Status Bulk Copy Json: ${JSON.stringify(projectStatusBulkCopyJson)}`);
            logger.info(`In Bulk Copy Process Content Sched, Params: ${JSON.stringify(params)}`);
             
            try {
                return ow.actions.invoke({
                    name: 'graybox/bulk-copy-process-docx-worker',
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
                    responsePayload = 'Failed to invoke graybox bulk copy process content action';
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
