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
    let responsePayload = 'Graybox Bulk Copy Scheduler invoked';
    logger.info(responsePayload);

    const filesWrapper = await initFilesWrapper(logger);

    try {
        let bulkCopyProjectQueue = [];
        try {
            const queueData = await filesWrapper.readFileIntoObject('graybox_promote/bulk_copy_project_queue.json');
            if (Array.isArray(queueData)) {
                bulkCopyProjectQueue = queueData;
                logger.info(`From Bulk Copy Sched Project Queue Json: ${JSON.stringify(bulkCopyProjectQueue)}`);
            } else {
                logger.warn('Queue file exists but does not contain an array, starting with empty queue');
                bulkCopyProjectQueue = [];
            }
        } catch (queueError) {
            // Queue file doesn't exist yet, which is normal when no bulk copy operations have been initiated
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

        // Find the First Project where status is 'fragment_discovery_completed'
        const projectEntries = bulkCopyProjectQueue.filter((project) => project.status === 'fragment_discovery_completed');
        if (!projectEntries || projectEntries.length === 0) {
            logger.info('No projects found with status "fragment_discovery_completed"');
            return {
                code: 200,
                payload: 'No projects ready for processing - waiting for fragment discovery to complete'
            };
        }

        const processedProjects = [];
        const triggeredActions = [];

        // Process all projects with status 'fragment_discovery_completed'
        const projectResults = await Promise.allSettled(
            projectEntries.map(async (projectEntry) => {
                const project = projectEntry.projectPath;
                try {
                    let batchStatusJson = {};
                    try {
                        const batchData = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-batches/batch_status.json`);
                        if (typeof batchData === 'object' && batchData !== null && !Array.isArray(batchData)) {
                            batchStatusJson = batchData;
                            logger.info(`In Bulk Copy Sched, Batch Status Json for project: ${project} is: ${JSON.stringify(batchStatusJson)}`);
                        } else {
                            logger.warn(`Batch status file exists but does not contain an object (type: ${typeof batchData}), starting with empty object`);
                            batchStatusJson = {};
                        }
                    } catch (batchErr) {
                        logger.info(`Batch status file does not exist yet for project ${project}, will skip this project`);
                        return { project, status: 'skipped', reason: 'no_batch_status_file' };
                    }

                    // Find if any non-processing batch is in 'copy_in_progress' status, if yes then don't trigger another copy action
                    const copyInProgressBatch = Object.entries(batchStatusJson)
                        .find(([batchName, status]) => batchName.startsWith('non_processing_batch_') && status === 'copy_in_progress');

                    if (copyInProgressBatch && Array.isArray(copyInProgressBatch) && copyInProgressBatch.length > 0) {
                        logger.info(`Copy Action already in progress for project: ${project} for Batch: ${copyInProgressBatch[0]}, skipping to next project`);
                        return { project, status: 'skipped', reason: 'action_in_progress' };
                    }

                    // Find the First non-processing batch where status is 'initiated', to copy one batch at a time
                    const initiatedBatchName = Object.keys(batchStatusJson)
                        .find((batchName) => batchName.startsWith('non_processing_batch_') && batchStatusJson[batchName] === 'initiated');

                    // If no non-processing batch is found with status 'initiated' then nothing to copy, skip this project
                    if (!initiatedBatchName) {
                        logger.info(`No non-processing batches found with status "initiated" for project: ${project}`);
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
                    // Set the Project & Batch Name in params for the Bulk Copy Non-Processing Worker Action to read and process
                    projectParams.project = project;
                    projectParams.batchName = initiatedBatchName;
                    try {
                        await ow.actions.invoke({
                            name: 'graybox/bulk-copy-non-processing-worker',
                            blocking: false,
                            result: false,
                            params: projectParams
                        });
                        return { project, batchName: initiatedBatchName, status: 'triggered' };
                    } catch (err) {
                        logger.error(`Failed to invoke Bulk Copy Non-Processing Worker for project ${project}, batch ${initiatedBatchName}: ${err}`);
                        return { project, status: 'failed', error: err.message };
                    }
                } catch (err) {
                    logger.error(`Error processing project ${project}: ${err}`);
                    return { project, status: 'error', error: err.message };
                }
            })
        );

        projectResults.forEach((result) => {
            if (result.status === 'fulfilled' && result.value.status === 'triggered') {
                processedProjects.push(result.value.project);
                triggeredActions.push(`${result.value.project}/${result.value.batchName}`);
            }
        });

        if (processedProjects.length > 0) {
            responsePayload = `Triggered Bulk Copy Non-Processing Worker Actions for ${processedProjects.length} projects: ${triggeredActions.join(', ')}`;
        } else {
            responsePayload = 'No projects were processed - all projects either have actions in progress or no initiated non-processing batches';
        }

        return {
            code: 200,
            payload: responsePayload
        };
    } catch (err) {
        responsePayload = 'Unknown error occurred while processing the projects for Bulk Copy';
        logger.error(`${responsePayload}: ${err}`);
        responsePayload = err;
    }

    // No errors while initiating all the Bulk Copy Non-Processing Worker Actions for all the projects
    return {
        code: 200,
        payload: responsePayload
    };
}

export { main };
