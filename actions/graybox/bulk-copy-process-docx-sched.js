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
        // Read the bulk copy project queue
        let bulkCopyProjectQueue = [];
        try {
            const queueData = await filesWrapper.readFileIntoObject('graybox_promote/bulk_copy_project_queue.json');
            // Ensure we have an array, even if the file contains something else
            if (Array.isArray(queueData)) {
                bulkCopyProjectQueue = queueData;
                logger.info(`From Bulk Copy Process Content Sched Project Queue Json: ${JSON.stringify(bulkCopyProjectQueue)}`);
            } else {
                logger.warn('Queue file exists but does not contain an array, starting with empty queue');
                bulkCopyProjectQueue = [];
            }
        } catch (queueError) {
            logger.info('Bulk copy project queue file does not exist yet. No projects to process.');
            return {
                code: 200,
                payload: 'No bulk copy projects in queue - system is ready for new requests'
            };
        }

        if (!Array.isArray(bulkCopyProjectQueue)) {
            logger.error(`bulkCopyProjectQueue is not an array: ${typeof bulkCopyProjectQueue}, value: ${JSON.stringify(bulkCopyProjectQueue)}`);
            bulkCopyProjectQueue = [];
        }

        // If queue is empty, return early
        if (!bulkCopyProjectQueue || bulkCopyProjectQueue.length === 0) {
            logger.info('Bulk copy project queue is empty. No projects to process.');
            return {
                code: 200,
                payload: 'No bulk copy projects in queue - system is ready for new requests'
            };
        }

        logger.info(`Queue contains ${bulkCopyProjectQueue.length} projects`);

        // Sorting the Bulk Copy Projects based on the 'createdTime' property, pick the oldest project
        bulkCopyProjectQueue = bulkCopyProjectQueue.sort((a, b) => a.createdTime - b.createdTime);

        // Find the First Project where status is 'non_processing_batches_copied'
        const projectEntries = bulkCopyProjectQueue.filter((project) => project.status === 'non_processing_batches_copied');
        if (!projectEntries || projectEntries.length === 0) {
            logger.info('No projects found with status "non_processing_batches_copied"');
            return {
                code: 200,
                payload: 'No projects ready for processing - waiting for non-processing batches to be copied'
            };
        }

        const processedProjects = [];
        const triggeredActions = [];

        // Process all projects with status 'non_processing_batches_copied'
        const projectResults = await Promise.allSettled(
            projectEntries.map(async (projectEntry) => {
                const project = projectEntry.projectPath;
                try {
                    // Read the Batch Status in the current project's "bulk-copy-batches/batch_status.json" file
                    let batchStatusJson = {};
                    try {
                        const batchData = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-batches/batch_status.json`);
                        if (typeof batchData === 'object' && batchData !== null && !Array.isArray(batchData)) {
                            batchStatusJson = batchData;
                            logger.info(`In Bulk Copy Process Content Sched, Batch Status Json for project: ${project} is: ${JSON.stringify(batchStatusJson)}`);
                        } else {
                            logger.warn(`Batch status file exists but does not contain an object (type: ${typeof batchData}), starting with empty object`);
                            batchStatusJson = {};
                        }
                    } catch (batchErr) {
                        logger.info(`Batch status file does not exist yet for project ${project}, will skip this project`);
                        return { project, status: 'skipped', reason: 'no_batch_status_file' };
                    }

                    // Find if any processing batch is in 'processing_in_progress' status, if yes then don't trigger another processing action
                    const processingInProgressBatch = Object.entries(batchStatusJson)
                        .find(([batchName, status]) => batchName.startsWith('processing_batch_') && status === 'processing_in_progress');

                    if (processingInProgressBatch && Array.isArray(processingInProgressBatch) && processingInProgressBatch.length > 0) {
                        logger.info(`Processing Action already in progress for project: ${project} for Batch: ${processingInProgressBatch[0]}, skipping to next project`);
                        return { project, status: 'skipped', reason: 'action_in_progress' };
                    }

                    // Find the First processing batch where status is 'initiated', to process one batch at a time
                    const initiatedBatchName = Object.keys(batchStatusJson)
                        .find((batchName) => batchName.startsWith('processing_batch_') && batchStatusJson[batchName] === 'initiated');

                    // If no processing batch is found with status 'initiated' then nothing to process, skip this project
                    if (!initiatedBatchName) {
                        logger.info(`No processing batches found with status "initiated" for project: ${project}`);
                        return { project, status: 'skipped', reason: 'no_initiated_batches' };
                    }

                    // Read essential parameters from project status file for the worker
                    const essentialParams = {};
                    try {
                        const projectStatusJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/status.json`);
                        logger.info(`Project status JSON for ${project}: ${JSON.stringify(projectStatusJson)}`);

                        if (projectStatusJson?.params && typeof projectStatusJson.params === 'object') {
                            const inputParams = projectStatusJson?.params;
                            Object.keys(inputParams).forEach((key) => {
                                essentialParams[key] = inputParams[key];
                            });
                        } else {
                            logger.warn(`No valid params found in project status for ${project}, worker may fail`);
                            logger.warn(`projectStatusJson.params: ${JSON.stringify(projectStatusJson?.params)}`);
                        }
                    } catch (statusErr) {
                        logger.warn(`Could not read project status file for ${project}: ${statusErr.message}`);
                    }

                    const projectParams = { ...params };
                    Object.keys(essentialParams).forEach((key) => {
                        projectParams[key] = essentialParams[key];
                    });
                    // Set the Project & Batch Name in params for the Bulk Copy Process Content Worker Action to read and process
                    projectParams.project = project;
                    projectParams.batchName = initiatedBatchName;

                    try {
                        await ow.actions.invoke({
                            name: 'graybox/bulk-copy-process-docx-worker',
                            blocking: false,
                            result: false,
                            params: projectParams
                        });
                        return { project, batchName: initiatedBatchName, status: 'triggered' };
                    } catch (err) {
                        logger.error(`Failed to invoke Bulk Copy Process Content Worker for project ${project}, batch ${initiatedBatchName}: ${err}`);
                        return { project, status: 'failed', error: err.message };
                    }
                } catch (err) {
                    logger.error(`Error processing project ${project}: ${err}`);
                    return { project, status: 'error', error: err.message };
                }
            })
        );

        // Process results and build response
        projectResults.forEach((result) => {
            if (result.status === 'fulfilled' && result.value.status === 'triggered') {
                processedProjects.push(result.value.project);
                triggeredActions.push(`${result.value.project}/${result.value.batchName}`);
            }
        });

        if (processedProjects.length > 0) {
            responsePayload = `Triggered Bulk Copy Process Content Worker Actions for ${processedProjects.length} projects: ${triggeredActions.join(', ')}`;
        } else {
            responsePayload = 'No projects were processed - all projects either have actions in progress or no initiated processing batches';
        }

        return {
            code: 200,
            payload: responsePayload
        };
    } catch (err) {
        responsePayload = 'Unknown error occurred while processing the projects for Bulk Copy Process Content';
        logger.error(`${responsePayload}: ${err}`);
        responsePayload = err;
    }

    return {
        code: 200,
        payload: responsePayload
    };
}

export { main };
