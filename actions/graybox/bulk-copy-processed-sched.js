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
    let responsePayload = 'Graybox Bulk Copy Processed Scheduler invoked';
    logger.info(responsePayload);

    const filesWrapper = await initFilesWrapper(logger);

    try {
        const projectQueueBulkCopy = await filesWrapper.readFileIntoObject('graybox_promote/bulk_copy_project_queue.json');
        logger.info(`In Bulk Copy Processed Sched Project Queue Json: ${JSON.stringify(projectQueueBulkCopy)}`);

        if (!projectQueueBulkCopy) {
            responsePayload = 'No Bulk Copy Projects in the queue';
            logger.info(responsePayload);
            return {
                code: 200,
                payload: responsePayload
            };
        }

        // iterate the JSON array projects and extract the project_path where status is 'initiated'
        const toBeCopiedProjects = projectQueueBulkCopy
            .filter((project) => project.status === 'processed')
            .map((project) => project.projectPath);

            logger.info(`In Bulk Copy Process Content Sched, To Be Processed Projects: ${JSON.stringify(toBeCopiedProjects)}`);

        if (!toBeCopiedProjects || toBeCopiedProjects.length === 0) {
            responsePayload = 'No Bulk Copy Projects in the queue with status `processed`';
            logger.info(responsePayload);
            return {
                code: 200,
                payload: responsePayload
            };
        }

        
        toBeCopiedProjects.forEach(async (project) => {
            const projectStatusBulkCopyJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
            const batchStatusBulkCopyJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk_copy_batch_status.json`);
            logger.info(`In Bulk Copy Processed Sched, Batch Status Bulk Copy Json: ${JSON.stringify(batchStatusBulkCopyJson)}`);
            logger.info(`In Bulk Copy Processed Sched, Project Status Bulk Copy Json: ${JSON.stringify(projectStatusBulkCopyJson)}`);
            const batchNames = Object.keys(batchStatusBulkCopyJson).flat();
            const allProcessingPromises = batchNames.map(async (batchName) => {
                if (batchStatusBulkCopyJson[batchName] === 'processed') {
                    // copy all params from json into the params object
                    const inputParams = projectStatusBulkCopyJson?.params;
                    const projectParams = { ...params };
                    Object.keys(inputParams).forEach((key) => {
                        projectParams[key] = inputParams[key];
                    });
                    // Set the Project & Batch Name in params for the Promote Content Worker Action to read and process
                    projectParams.project = project;
                    projectParams.batchName = batchName;

                    logger.info(`In BulkCopyProcessed Sched, Invoking BulkCopyProcessed Worker for Batch: ${batchName} of Project: ${project}`);

                    logger.info(`In Bulk Copy Processed Content Sched, Project Status Bulk Copy Json: ${JSON.stringify(projectStatusBulkCopyJson)}`);
                    logger.info(`In Bulk Copy Processed Content Sched, Params: ${JSON.stringify(projectParams)}`);

                    try {
                        return ow.actions.invoke({
                            name: 'graybox/bulk-copy-processed-worker',
                            blocking: false,
                            result: false,
                            params: projectParams
                        }).then(async (result) => {
                            logger.info(result);
                            return {
                                code: 200,
                                payload: responsePayload
                            };
                        }).catch(async (err) => {
                            responsePayload = 'Failed to invoke graybox bulk copy processed content action';
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
                }
            });
        
            await Promise.all(allProcessingPromises); // await all async functions in the array are executed
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
