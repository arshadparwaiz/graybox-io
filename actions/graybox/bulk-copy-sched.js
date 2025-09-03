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
    let responsePayload = 'Graybox Promote Scheduler invoked';
    logger.info(responsePayload);

    const filesWrapper = await initFilesWrapper(logger);

    try {
        let projectQueue = await filesWrapper.readFileIntoObject('graybox_promote/project_queue.json');
        logger.info(`From Promote-sched Project Queue Json: ${JSON.stringify(projectQueue)}`);

        // Sorting the Promote Projects based on the 'createdTime' property, pick the oldest project
        projectQueue = projectQueue.sort((a, b) => a.createdTime - b.createdTime);

        // Find the First Project where status is 'processed'
        const projectEntries = projectQueue.filter((project) => project.status === 'processed');
        logger.info(`In Promote Sched, projectEntries: ${JSON.stringify(projectEntries)}`);

        if (projectEntries && projectEntries.length > 0) {
            // Process each project entry instead of just the first one
            const processProject = async (projectEntry) => {
                const project = projectEntry.projectPath;
                try {
                    const projectStatusJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/status.json`);

                    // Read the Batch Status in the current project's "batch_status.json" file
                    const batchStatusJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/batch_status.json`);
                    logger.info(`In Promote Sched, batchStatusJson for project: ${project} is: ${JSON.stringify(batchStatusJson)}`);

                    // Find if any batch is in 'copy_in_progress' status, if yes then don't trigger another copy action for another "processed" batch
                    const copyOrPromoteInProgressBatch = Object.entries(batchStatusJson)
                        .find(([, copyBatchJson]) => (copyBatchJson.status === 'copy_in_progress' || copyBatchJson.status === 'promote_in_progress'));

                    if (copyOrPromoteInProgressBatch && Array.isArray(copyOrPromoteInProgressBatch) && copyOrPromoteInProgressBatch.length > 0) {
                        logger.info(`Promote or Copy Action already in progress for project: ${project} for Batch: ${copyOrPromoteInProgressBatch[0]}, skipping this project`);
                        return { skipped: true, project };
                    }

                    const promoteBatchesJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/promote_batches.json`);

                    // Find the First Batch where status is 'processed', to promote one batch at a time
                    const processedBatchName = Object.keys(promoteBatchesJson)
                        .find((batchName) => promoteBatchesJson[batchName].status === 'processed');
                    // If no batch is found with status 'processed then nothing to promote', skip this project
                    if (!processedBatchName) {
                        logger.info(`No Promote Batches found with status "processed" for project: ${project}`);
                        return { skipped: true, project };
                    }

                    if (promoteBatchesJson[processedBatchName].status === 'processed') {
                        // copy all params from json into the params object
                        const inputParams = projectStatusJson?.params;
                        const projectParams = { ...params };
                        Object.keys(inputParams).forEach((key) => {
                            projectParams[key] = inputParams[key];
                        });
                        // Set the Project & Batch Name in params for the Promote Content Worker Action to read and process
                        projectParams.project = project;
                        projectParams.batchName = processedBatchName;

                        logger.info(`In Promote Sched, Invoking Promote Content Worker for Batch: ${processedBatchName} of Project: ${project}`);
                        try {
                            await ow.actions.invoke({
                                name: 'graybox/promote-worker',
                                blocking: false,
                                result: false,
                                params: projectParams
                            }).then(async (result) => {
                                logger.info(result);
                            }).catch(async (err) => {
                                const errorMsg = 'Failed to invoke graybox promote action';
                                logger.error(`${errorMsg}: ${err}`);
                            });
                        } catch (err) {
                            const errorMsg = 'Unknown error occurred while invoking Promote Content Worker Action';
                            logger.error(`${errorMsg}: ${err}`);
                        }
                    }
                    logger.info(`Triggered Promote Content Worker Action for project: ${project}`);
                    return { processed: true, project };
                } catch (err) {
                    logger.error(`Error processing project ${project}: ${err}`);
                    return { error: true, project };
                }
            };

            // Process all projects sequentially
            const results = await projectEntries.reduce(async (previousPromise, projectEntry) => {
                const accumulator = await previousPromise;
                const result = await processProject(projectEntry);
                accumulator.push(result);
                return accumulator;
            }, Promise.resolve([]));

            const processedCount = results.filter((r) => r.processed).length;
            const skippedCount = results.filter((r) => r.skipped).length;
            const errorCount = results.filter((r) => r.error).length;

            responsePayload = `Processed ${processedCount} projects, skipped ${skippedCount} projects, ${errorCount} errors`;
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

export { main };
