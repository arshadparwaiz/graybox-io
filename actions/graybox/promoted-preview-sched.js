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
    let responsePayload = 'Graybox Promoted Preview Scheduler invoked';
    logger.info(responsePayload);

    const filesWrapper = await initFilesWrapper(logger);

    try {
        // Read the bulk copy project queue to find projects that have been promoted
        const bulkCopyProjectQueue = await filesWrapper.readFileIntoObject('graybox_promote/bulk_copy_project_queue.json');
        logger.info(`From Promoted Preview Sched Bulk Copy Project Queue Json: ${JSON.stringify(bulkCopyProjectQueue)}`);

        if (!bulkCopyProjectQueue || !Array.isArray(bulkCopyProjectQueue)) {
            responsePayload = 'No bulk copy projects in the queue';
            logger.info(responsePayload);
            return {
                code: 200,
                payload: responsePayload
            };
        }

        // Find projects that have been promoted or have copied files for preview
        const projectsToPreview = [];
        for (const project of bulkCopyProjectQueue) {
            if (project.status === 'promoted' || project.status === 'partially_promoted' || project.status === 'non_processing_batches_copied') {
                try {
                    let pendingFilesCount = 0;
                    
                    // Check for promoted files for preview
                    if (project.status === 'promoted' || project.status === 'partially_promoted') {
                        const promotedFilesPath = `graybox_promote${project.projectPath}/promoted_files_for_preview.json`;
                        try {
                            const promotedFiles = await filesWrapper.readFileIntoObject(promotedFilesPath);
                            
                            if (promotedFiles && Array.isArray(promotedFiles) && promotedFiles.length > 0) {
                                const pendingPromotedFiles = promotedFiles.filter(file => file.previewStatus === 'pending');
                                pendingFilesCount += pendingPromotedFiles.length;
                            }
                        } catch (err) {
                            if (err.message.includes('ERROR_FILE_NOT_EXISTS')) {
                                logger.info(`Promoted files tracking file does not exist for project ${project.projectPath} - no promoted files to preview`);
                            } else {
                                logger.warn(`Error reading promoted files for project ${project.projectPath}: ${err.message}`);
                            }
                        }
                    }
                    
                    // Check for copied files for preview
                    if (project.status === 'non_processing_batches_copied' || project.status === 'promoted' || project.status === 'partially_promoted') {
                        const copiedFilesPath = `graybox_promote${project.projectPath}/copied_files_for_preview.json`;
                        try {
                            const copiedFiles = await filesWrapper.readFileIntoObject(copiedFilesPath);
                            
                            if (copiedFiles && Array.isArray(copiedFiles) && copiedFiles.length > 0) {
                                const pendingCopiedFiles = copiedFiles.filter(file => file.previewStatus === 'pending');
                                pendingFilesCount += pendingCopiedFiles.length;
                            }
                        } catch (err) {
                            if (err.message.includes('ERROR_FILE_NOT_EXISTS')) {
                                logger.info(`Copied files tracking file does not exist for project ${project.projectPath} - no copied files to preview`);
                            } else {
                                logger.warn(`Error reading copied files for project ${project.projectPath}: ${err.message}`);
                            }
                        }
                    }
                    
                    if (pendingFilesCount > 0) {
                        projectsToPreview.push({
                            ...project,
                            pendingFilesCount
                        });
                    }
                } catch (err) {
                    logger.warn(`Could not read files for preview for project ${project.projectPath}: ${err.message}`);
                }
            }
        }

        if (projectsToPreview.length === 0) {
            responsePayload = 'No projects with promoted or copied files ready for preview';
            logger.info(responsePayload);
            return {
                code: 200,
                payload: responsePayload
            };
        }

        logger.info(`Found ${projectsToPreview.length} projects with promoted or copied files ready for preview`);

        // Process the first project (one at a time to avoid overwhelming the system)
        const projectToPreview = projectsToPreview[0];
        const { projectPath, experienceName, gbRootFolder } = projectToPreview;
        const project = `${gbRootFolder}/${experienceName}`;

        logger.info(`In Promoted Preview Sched, Processing project: ${project} with ${projectToPreview.pendingFilesCount} pending files`);

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
                logger.info(`Extracted essential params: ${JSON.stringify(Object.keys(essentialParams))}`);
                logger.info(`adminPageUri: ${essentialParams.adminPageUri ? 'PRESENT' : 'MISSING'}`);
                logger.info(`spToken: ${essentialParams.spToken ? 'PRESENT' : 'MISSING'}`);
                logger.info(`driveId: ${essentialParams.driveId || 'MISSING'}`);
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
            ...essentialParams
        };

        logger.info(`In Promoted Preview Sched, Invoking worker for project: ${project}`);

        // Invoke the promoted preview worker
        try {
            await ow.actions.invoke({
                name: 'graybox/promoted-preview-worker',
                blocking: false,
                result: false,
                params: projectParams
            });
            return { project, status: 'triggered' };
        } catch (err) {
            logger.error(`Failed to invoke Promoted Preview Worker for project ${project}: ${err}`);
            return { project, status: 'failed', error: err.message };
        }
    } catch (err) {
        logger.error(`In Promoted Preview Sched, Error: ${err.message}`);
        return {
            code: 500,
            payload: `Error in promoted preview scheduler: ${err.message}`
        };
    }
}

export { main };
