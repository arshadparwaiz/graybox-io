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
const initFilesWrapper = require('./filesWrapper');

async function main(params) {
    const logger = getAioLogger();
    const ow = openwhisk();
    let responsePayload = 'Graybox Promote Scheduler invoked';
    logger.info(responsePayload);

    const filesWrapper = await initFilesWrapper(logger);

    try {
        let projectQueue = await filesWrapper.readFileIntoObject('graybox_promote/project_queue.json');
        logger.info(`From Promote-sched Project Queue Json: ${JSON.stringify(projectQueue)}`);

        // Sorting the Promote Projects based on the 'createdTime' property, pick the oldest project
        projectQueue = projectQueue.sort((a, b) => a.createdTime - b.createdTime);

        // Find the First Project where status is 'processed'
        const projectEntry = projectQueue.find((project) => project.status === 'processed');

        if (projectEntry && projectEntry.projectPath) {
            const project = projectEntry.projectPath;
            const projectStatusJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/status.json`);

            // Read the Batch Status in the current project's "batch_status.json" file
            const batchStatusJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/batch_status.json`);
            logger.info(`In Promote Sched, batchStatusJson for project: ${project} is: ${JSON.stringify(batchStatusJson)}`);

            // Find if any batch is in 'copy_in_progress' status, if yes then don't trigger another copy action for another "processed" batch
            const copyOrPromoteInProgressBatch = Object.entries(batchStatusJson)
                .find(([batchName, copyBatchJson]) => (copyBatchJson.status === 'copy_in_progress' || copyBatchJson.status === 'promote_in_progress'));

            if (copyOrPromoteInProgressBatch && Array.isArray(copyOrPromoteInProgressBatch) && copyOrPromoteInProgressBatch.length > 0) {
                responsePayload = `Promote or Copy Action already in progress for project: ${project} for Batch: ${copyOrPromoteInProgressBatch[0]}, not triggering another action until it completes`;
                return {
                    code: 200,
                    payload: responsePayload
                };
            }

            const promoteBatchesJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/promote_batches.json`);

            // Find the First Batch where status is 'processed', to promote one batch at a time
            const processedBatchName = Object.keys(promoteBatchesJson)
                .find((batchName) => promoteBatchesJson[batchName].status === 'processed');
            // If no batch is found with status 'processed then nothing to promote', return
            if (!processedBatchName) {
                responsePayload = 'No Promote Batches found with status "processed"';
                return {
                    code: 200,
                    payload: responsePayload
                };
            }

            if (promoteBatchesJson[processedBatchName].status === 'processed') {
                // copy all params from json into the params object
                const inputParams = projectStatusJson?.params;
                Object.keys(inputParams).forEach((key) => {
                    params[key] = inputParams[key];
                });
                // Set the Project & Batch Name in params for the Promote Content Worker Action to read and process
                params.project = project;
                params.batchName = processedBatchName;

                logger.info(`In Promote Sched, Invoking Promote Content Worker for Batch: ${processedBatchName} of Project: ${project}`);
                try {
                    return ow.actions.invoke({
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
                    });
                } catch (err) {
                    responsePayload = 'Unknown error occurred while invoking Promote Content Worker Action';
                    logger.error(`${responsePayload}: ${err}`);
                    responsePayload = err;
                }
            }
            responsePayload = 'Triggered Promote Content Worker Action';
            return {
                code: 200,
                payload: responsePayload,
            };
        }
    } catch (err) {
        responsePayload = 'Unknown error occurred while processing the projects for Promote';
        logger.error(`${responsePayload}: ${err}`);
        responsePayload = err;
    }

    // No errors while initiating all the Promote Content Worker Action for all the projects
    return {
        code: 200,
        payload: responsePayload
    };
}

exports.main = main;
