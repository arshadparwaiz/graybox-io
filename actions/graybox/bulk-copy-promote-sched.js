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

import openwhisk from 'openwhisk';
import { getAioLogger } from '../utils.js';
import initFilesWrapper from './filesWrapper.js';

async function main() {
    const logger = getAioLogger();
    const ow = openwhisk();
    logger.info('Graybox Bulk Copy Promote Scheduler triggered');

    const filesWrapper = await initFilesWrapper(logger);

    const projectQueueBulkCopy = await filesWrapper.readFileIntoObject('graybox_promote/bulk_copy_project_queue.json');
    logger.info(`In Bulk Copy Promote Sched, Project Queue Json: ${JSON.stringify(projectQueueBulkCopy)}`);

    // Filter projects that have completed processing and are ready for promotion
    const projectsToPromote = projectQueueBulkCopy.filter((project) => project.status === 'processing_batches_completed');
    logger.info(`In Bulk Copy Promote Sched, Found ${projectsToPromote.length} projects ready for promotion`);

    if (projectsToPromote.length === 0) {
        logger.info('No projects ready for promotion');
        return exitAction({
            body: 'No projects ready for promotion',
            statusCode: 200
        });
    }

    // Process the first project (one at a time to avoid overwhelming the system)
    const projectToPromote = projectsToPromote[0];
    const { experienceName, gbRootFolder } = projectToPromote;
    const project = `${gbRootFolder}/${experienceName}`;

    logger.info(`In Bulk Copy Promote Sched, Promoting project: ${project}`);

    // Read the processed files for this project
    const processedPathsJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/processed_paths.json`);
    logger.info(`In Bulk Copy Promote Sched, Processed paths for project ${project}: ${JSON.stringify(processedPathsJson)}`);

    // Get all processed files that need to be promoted
    const allProcessedFiles = [];
    Object.keys(processedPathsJson).forEach((batchName) => {
        const batchFiles = processedPathsJson[batchName];
        if (Array.isArray(batchFiles)) {
            batchFiles.forEach((file) => {
                if (file.processType === 'promote') {
                    allProcessedFiles.push({
                        ...file,
                        batchName
                    });
                }
            });
        }
    });

    logger.info(`In Bulk Copy Promote Sched, Found ${allProcessedFiles.length} files to promote for project ${project}`);

    if (allProcessedFiles.length === 0) {
        logger.info(`No files to promote for project ${project}`);
        return exitAction({
            body: `No files to promote for project ${project}`,
            statusCode: 200
        });
    }

    // Read project parameters from status.json
    const essentialParams = {};
    try {
        const projectStatusJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/status.json`);
        logger.info(`Project status JSON for ${project}: ${JSON.stringify(projectStatusJson)}`);

        if (projectStatusJson?.params && typeof projectStatusJson.params === 'object') {
            logger.info(`Raw params from status file: ${JSON.stringify(projectStatusJson.params)}`);
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

    // Prepare parameters for the worker
    const projectParams = {
        project,
        experienceName,
        gbRootFolder,
        filesToPromote: allProcessedFiles,
        ...essentialParams
    };

    logger.info(`In Bulk Copy Promote Sched, Invoking worker for project: ${project} with ${allProcessedFiles.length} files`);

    try {
        try {
            await ow.actions.invoke({
                name: 'graybox/bulk-copy-promote-worker',
                blocking: false,
                result: false,
                params: projectParams
            });
            return { project, status: 'triggered' };
        } catch (err) {
            logger.error(`Failed to invoke Bulk Copy Promote Worker for project ${project}: ${err}`);
            return { project, status: 'failed', error: err.message };
        }
    } catch (err) {
        logger.error(`In Bulk Copy Promote Sched, Error invoking worker: ${err.message}`);
        return exitAction({
            body: `Error invoking promote worker: ${err.message}`,
            statusCode: 500
        });
    }
}

function exitAction(resp) {
    return resp;
}

export { main };
