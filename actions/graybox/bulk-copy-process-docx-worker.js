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

import fetch from 'node-fetch';
import { Readable } from 'stream';
import { getAioLogger, toUTCStr } from '../utils.js';
import AppConfig from '../appConfig.js';
import HelixUtils from '../helixUtils.js';
import Sharepoint from '../sharepoint.js';
import { updateDocumentForBulkCopy } from '../docxUpdater.js';
import initFilesWrapper from './filesWrapper.js';
import { writeProjectStatus } from './statusUtils.js';
import { updateBulkCopyStepStatus } from './bulkCopyStatusUtils.js';

const logger = getAioLogger();

async function main(params) {
    logger.info('Graybox Bulk Copy Process Content Worker triggered');

    const appConfig = new AppConfig(params);
    const { gbRootFolder, experienceName, projectExcelPath } = appConfig.getPayload();

    const spConfig = appConfig.getSpConfig();
    if (!spConfig) {
        return {
            statusCode: 500,
            body: {
                error: 'SharePoint configuration failed',
                message: 'Missing required parameters: adminPageUri, spToken, or driveId'
            }
        };
    }

    const sharepoint = new Sharepoint(appConfig);
    const helixUtils = new HelixUtils(appConfig);
    const filesWrapper = await initFilesWrapper(logger);
    const processedFiles = [];
    const failedProcesses = [];

    logger.info('In Bulk Copy Process Content Worker, Processing Content');

    const project = params.project || '';
    const batchName = params.batchName || '';

    // Get the Helix Admin API Key for the main content tree, needed for accessing (with auth) Images in graybox tree
    const helixAdminApiKey = helixUtils.getAdminApiKey(false);

    // Read the Batch Status in the current project's "bulk-copy-batches/batch_status.json" file
    let batchStatusJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-batches/batch_status.json`);

    const batchFile = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-batches/${batchName}.json`);

    logger.info(`In Bulk Copy Process Content Worker, Processing File Paths for project: ${project} for batchname ${batchName} of params: ${JSON.stringify(params)}: ${JSON.stringify(batchFile)}`);

    await updateBulkCopyStepStatus(filesWrapper, project, 'step3_docx_processing', {
        status: 'in_progress',
        startTime: toUTCStr(new Date()),
        progress: {
            total: batchFile ? batchFile.length : 0
        }
    });

    if (!batchFile || !Array.isArray(batchFile) || batchFile.length === 0) {
        logger.warn(`Batch file ${batchName}.json does not exist or is empty for project ${project}. Skipping processing.`);
        return exitAction({
            body: `Batch file ${batchName}.json does not exist or is empty. No processing performed.`,
            statusCode: 200
        });
    }

    batchStatusJson[batchName] = 'processing_in_progress';
    await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-batches/batch_status.json`, batchStatusJson);

    const sourcePathObjs = batchFile;

    logger.info(`In BulkCopyProcessDocx-worker, processing ${sourcePathObjs.length} files from batch ${batchName}`);

    // eslint-disable-next-line no-restricted-syntax
    for (let i = 0; i < sourcePathObjs.length; i += 1) {
        const sourcePathObj = sourcePathObjs[i];

        try {
            const {
                sourcePath, mdPath, fragmentPath, sourceUrl
            } = sourcePathObj;
            const fileName = sharepoint.getFileNameFromPath(sourcePath);

            const contentPath = mdPath || fragmentPath || sourceUrl;

            /* if (!contentPath && sourcePath) {
                const pathWithoutExtension = sourcePath.replace(/\.(docx|xlsx|xls)$/i, '');
                contentPath = `https://main--homepage--adobecom.aem.page${pathWithoutExtension}`;
            } */

            logger.info(`In BulkCopyProcessDocx-worker, processing file: ${fileName}, sourcePath: ${sourcePath}, ` +
                `mdPath: ${mdPath}, fragmentPath: ${fragmentPath}, sourceUrl: ${sourceUrl}, contentPath: ${contentPath}`);

            if (contentPath) {
                const isDocxFile = fileName.toLowerCase().endsWith('.docx');
                const isExcelFile = fileName.toLowerCase().endsWith('.xlsx') ||
                    fileName.toLowerCase().endsWith('.xls');

                logger.info(`In BulkCopyProcessDocx-worker, for project: ${project} isDocxFile: ${isDocxFile}`);

                if (isDocxFile) {
                    const options = {};
                    const mainContentHlxAdminApiKey = helixUtils.getAdminApiKey(false);
                    if (mainContentHlxAdminApiKey) {
                        options.headers = new fetch.Headers();
                        options.headers.append('Authorization', `token ${mainContentHlxAdminApiKey}`);
                    }

                    // eslint-disable-next-line no-await-in-loop
                    const response = await sharepoint.fetchWithRetry(`${contentPath}`, options);
                    // eslint-disable-next-line no-await-in-loop
                    const content = await response.text();
                    const fragmentMatches = hasFragmentPathsInContent(content);
                    logger.info(`In BulkCopyProcessDocx-worker, hasFragmentPathsInContent(content): ${fragmentMatches ? fragmentMatches.length : 0} fragments found`);

                    if (fragmentMatches && fragmentMatches.length > 0) {
                        logger.info(`In BulkCopyProcessDocx-worker, processing DOCX file with fragments: ${fileName}`);
                        // eslint-disable-next-line no-await-in-loop
                        const docx = await updateDocumentForBulkCopy(content, experienceName, helixAdminApiKey, helixUtils);
                        logger.info(`In BulkCopyProcessDocx-worker, docx processing result: ${docx ? 'SUCCESS' : 'FAILED'}`);
                        if (docx) {
                            const sourceDirPath = sourcePath.substring(0, sourcePath.lastIndexOf('/') + 1);
                            const destinationFilePath = `/${experienceName}${sourceDirPath}${fileName}`;
                            const docxFileStream = Readable.from(docx);

                            // Write the processed documents to the AIO folder for docx files
                            const aioFilePath = `graybox_promote${project}/docx_bulk_copy${destinationFilePath}`;
                            logger.info(`In BulkCopyProcessDocx-worker, writing to AIO file: ${aioFilePath}`);
                            // eslint-disable-next-line no-await-in-loop
                            await filesWrapper.writeFileFromStream(aioFilePath, docxFileStream);
                            logger.info(`In BulkCopyProcessDocx-worker, successfully wrote to AIO file: ${aioFilePath}`);

                            // Add to processed files list
                            processedFiles.push({
                                fileName,
                                sourcePath,
                                destinationPath: destinationFilePath,
                                fileType: 'docx',
                                batchName,
                                processType: 'promote'
                            });

                            logger.info(`Successfully processed: ${sourcePath} -> ${destinationFilePath}`);
                        } else {
                            failedProcesses.push(`Error processing docx for ${fileName}`);
                        }
                    } else {
                        const copySourceFilePath = `${sourcePath.substring(0, sourcePath.lastIndexOf('/') + 1)}${fileName}`;
                        const copyDestinationFolder = `/${experienceName}${sourcePath.substring(0, sourcePath.lastIndexOf('/'))}`;
                        const copyDestFilePath = `${copyDestinationFolder}/${fileName}`;

                        processedFiles.push({
                            fileName,
                            sourcePath: copySourceFilePath,
                            destinationPath: copyDestFilePath,
                            fileType: 'docx',
                            batchName,
                            processType: 'copy'
                        });

                        logger.info(`File doesn't need processing, will be copied: ${sourcePath} -> ${copyDestFilePath}`);
                    }
                } else if (isExcelFile) {
                    // For Excel files, just add to copy list (processing logic commented out in original)
                    const copySourceFilePath = `${sourcePath.substring(0, sourcePath.lastIndexOf('/') + 1)}${fileName}`;
                    const copyDestinationFolder = `/${experienceName}${sourcePath.substring(0, sourcePath.lastIndexOf('/'))}`;
                    const copyDestFilePath = `${copyDestinationFolder}/${fileName}`;

                    processedFiles.push({
                        fileName,
                        sourcePath: copySourceFilePath,
                        destinationPath: copyDestFilePath,
                        fileType: 'excel',
                        batchName,
                        processType: 'copy'
                    });

                    logger.info(`Excel file will be copied: ${sourcePath} -> ${copyDestFilePath}`);
                } else {
                    // For non-docx files, just add to copy list
                    const copySourceFilePath = `${sourcePath.substring(0, sourcePath.lastIndexOf('/') + 1)}${fileName}`;
                    const copyDestinationFolder = `/${experienceName}${sourcePath.substring(0, sourcePath.lastIndexOf('/'))}`;
                    const copyDestFilePath = `${copyDestinationFolder}/${fileName}`;

                    processedFiles.push({
                        fileName,
                        sourcePath: copySourceFilePath,
                        destinationPath: copyDestFilePath,
                        fileType: 'other',
                        batchName,
                        processType: 'copy'
                    });

                    logger.info(`Other file will be copied: ${sourcePath} -> ${copyDestFilePath}`);
                }
            } else {
                try {
                    const unprocessedFileInfo = {
                        fileName,
                        path: sourcePath,
                        reason: 'No content path (mdPath, fragmentPath, or sourceUrl) available and cannot construct URL from sourcePath',
                        status: 'failed'
                    };

                    const unprocessedFileExcelValues = [[
                        `Unprocessed file: ${fileName}`,
                        toUTCStr(new Date()),
                        unprocessedFileInfo.reason,
                        JSON.stringify(unprocessedFileInfo)
                    ]];

                    // eslint-disable-next-line no-await-in-loop
                    await sharepoint.updateExcelTable(
                        projectExcelPath,
                        'PROMOTE_STATUS',
                        unprocessedFileExcelValues
                    );
                } catch (err) {
                    logger.error(`Error occurred while updating Excel with unprocessed file status: ${err}`);
                }
            }
        } catch (err) {
            const errorMsg = `Error processing file ${JSON.stringify(sourcePathObj)}: ${err.message}`;
            logger.error(errorMsg);
            failedProcesses.push(errorMsg);
        }
    }

    logger.info(`In Bulk Copy Process Content Worker, Processed files for project: ${project} for batchname ${batchName} no.of files ${processedFiles.length}`);
    logger.info(`Files list: ${JSON.stringify(processedFiles)}`);

    await updateBulkCopyStepStatus(filesWrapper, project, 'step3_docx_processing', {
        status: 'completed',
        endTime: toUTCStr(new Date()),
        progress: {
            completed: processedFiles.length,
            failed: failedProcesses.length
        },
        details: {
            processedFiles,
            failedFiles: failedProcesses,
            transformedFragments: processedFiles.length
        },
        errors: failedProcesses
    });

    if (processedFiles.length > 0) {
        let processedPathsJson = {};
        const processedPathsPath = `graybox_promote${project}/processed_paths.json`;

        try {
            const pathsData = await filesWrapper.readFileIntoObject(processedPathsPath);
            if (typeof pathsData === 'object' && pathsData !== null && !Array.isArray(pathsData)) {
                processedPathsJson = pathsData;
                logger.info(`Loaded existing processed paths file with ${Object.keys(processedPathsJson).length} batch entries`);
            } else {
                logger.warn(`Processed paths file exists but does not contain an object (type: ${typeof pathsData}), starting with empty object`);
                processedPathsJson = {};
            }
        } catch (err) {
            if (err.message.includes('ERROR_FILE_NOT_EXISTS')) {
                logger.info(`Processed paths file does not exist yet at ${processedPathsPath}, will create new one`);
            } else {
                logger.warn(`Error reading processed paths file: ${err.message}, will create new one`);
            }
            processedPathsJson = {};
        }

        if (typeof processedPathsJson !== 'object' || processedPathsJson === null || Array.isArray(processedPathsJson)) {
            logger.error(`processedPathsJson is not an object: ${typeof processedPathsJson}, value: ${JSON.stringify(processedPathsJson)}`);
            processedPathsJson = {};
        }

        if (processedPathsJson[batchName]) {
            const existingFiles = Array.isArray(processedPathsJson[batchName]) ? processedPathsJson[batchName] : [];
            processedFiles.push(...existingFiles);
            logger.info(`Combined with ${existingFiles.length} existing files for batch ${batchName}`);
        }

        processedPathsJson[batchName] = processedFiles;
        await filesWrapper.writeFile(processedPathsPath, processedPathsJson);
        logger.info(`Successfully wrote ${processedFiles.length} processed files for batch ${batchName} to ${processedPathsPath}`);
    }

    // Update the Processing Errors if any
    if (failedProcesses.length > 0) {
        let processErrorsJson = [];

        // Check if the process errors file exists first
        const processErrorsPath = `graybox_promote${project}/process_errors.json`;
        try {
            const errorsData = await filesWrapper.readFileIntoObject(processErrorsPath);
            // Ensure we have an array, even if the file contains something else
            if (Array.isArray(errorsData)) {
                processErrorsJson = errorsData;
                logger.info(`Loaded existing process errors file with ${processErrorsJson.length} entries`);
            } else {
                logger.warn(`Process errors file exists but does not contain an array (type: ${typeof errorsData}), starting with empty array`);
                processErrorsJson = [];
            }
        } catch (err) {
            logger.info(`Process errors file does not exist yet at ${processErrorsPath}, will create new one`);
            processErrorsJson = [];
        }

        if (!Array.isArray(processErrorsJson)) {
            logger.error(`processErrorsJson is not an array: ${typeof processErrorsJson}, value: ${JSON.stringify(processErrorsJson)}`);
            processErrorsJson = [];
        }

        processErrorsJson.push(...failedProcesses);
        logger.info(`Added ${failedProcesses.length} new failed processes to error log (total: ${processErrorsJson.length})`);

        await filesWrapper.writeFile(processErrorsPath, processErrorsJson);
        logger.info(`Successfully wrote ${processErrorsJson.length} error entries to ${processErrorsPath}`);
    }

    // Update the Batch Status in the current project's "bulk-copy-batches/batch_status.json" file
    // Only mark as processed if files were actually processed
    if (processedFiles.length > 0 || sourcePathObjs.length === 0) {
        batchStatusJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-batches/batch_status.json`);
        batchStatusJson[batchName] = 'processed';
        // Write the batch status file
        await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-batches/batch_status.json`, batchStatusJson);
        logger.info(`Batch ${batchName} marked as processed. Files processed: ${processedFiles.length}`);
    } else {
        logger.warn(`Batch ${batchName} not marked as processed because no files were successfully processed.`);
    }

    // Check if all processing batches are processed
    const allProcessingBatchesProcessed = Object.keys(batchStatusJson)
        .filter((batch) => batch.startsWith('processing_batch_'))
        .every((batch) => batchStatusJson[batch] === 'processed');

    if (allProcessingBatchesProcessed) {
        // Update the Project Status in JSON files
        await updateProjectStatus(gbRootFolder, experienceName, filesWrapper);
    }

    // Note: File promotion to SharePoint is now handled by the separate bulk-copy-promote-worker
    // This worker only processes files and stores them in AIO storage
    logger.info('In Bulk Copy Process Content Worker, Files processed and stored in AIO. Promotion will be handled by bulk-copy-promote-worker.');

    // Update the Project Excel with the Process Status
    try {
        const sFailedProcessStatuses = failedProcesses.length > 0 ? `Failed Processes: \n${failedProcesses.join('\n')}` : '';

        const processExcelValues = [[
            `Step 3 of 5: Bulk Copy Process Content completed for Batch ${batchName}`,
            toUTCStr(new Date()),
            sFailedProcessStatuses,
            JSON.stringify({
                processed: processedFiles.length,
                processedFiles: processedFiles.map((f) => f.sourcePath)
            })
        ]];
        await sharepoint.updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', processExcelValues);

        const statusJsonPath = `graybox_promote${project}/status.json`;
        const statusEntry = {
            stepName: 'bulk_copy_process_content_completed',
            step: `Step 3 of 5: Bulk Copy Process Content completed for Batch ${batchName}`,
            failures: sFailedProcessStatuses,
            files: processedFiles
        };
        await writeProjectStatus(filesWrapper, statusJsonPath, statusEntry);
    } catch (err) {
        logger.error(`Error occurred while updating Excel during Graybox Bulk Copy Process Content: ${err}`);
    }

    const responsePayload = `Bulk Copy Process Content Worker finished processing content for batch ${batchName}. ` +
        `Processed: ${processedFiles.length}, Failed: ${failedProcesses.length}`;
    logger.info(responsePayload);
    return exitAction({
        body: responsePayload,
        statusCode: 200
    });
}

/**
 * Check if the content contains any fragment paths
 * @param {string} content - The content to check
 * @returns {Array} - Array of fragment matches or empty array
 */
function hasFragmentPathsInContent(content) {
    // Find fragment links in content using angle bracket format
    // Pattern matches: <https://...aem.page/.../fragments/...>
    return content.match(/<https:\/\/[^>]*aem\.page[^>]*\/fragments\/[^>]*>/g) || [];
}

/**
 * Update the Project Status in the current project's "status.json" file & the parent "bulk_copy_project_queue.json" file
 * @param {*} gbRootFolder graybox root folder
 * @param {*} experienceName graybox experience name
 * @param {*} filesWrapper filesWrapper object
 * @returns updated project status
 */
async function updateProjectStatus(gbRootFolder, experienceName, filesWrapper) {
    const projectStatusJson = await filesWrapper.readFileIntoObject(`graybox_promote${gbRootFolder}/${experienceName}/status.json`);

    // Update the Project Status in the current project's "status.json" file
    projectStatusJson.status = 'processing_batches_completed';
    await filesWrapper.writeFile(`graybox_promote${gbRootFolder}/${experienceName}/status.json`, projectStatusJson);

    // Update the Project Status in the parent "bulk_copy_project_queue.json" file
    try {
        const queueData = await filesWrapper.readFileIntoObject('graybox_promote/bulk_copy_project_queue.json');
        // Ensure we have an array, even if the file contains something else
        if (Array.isArray(queueData)) {
            const bulkCopyProjectQueue = queueData;
            const index = bulkCopyProjectQueue.findIndex((obj) => obj.projectPath === `${gbRootFolder}/${experienceName}`);
            if (index !== -1) {
                // Replace the object at the found index
                bulkCopyProjectQueue[index].status = 'processing_batches_completed';
                await filesWrapper.writeFile('graybox_promote/bulk_copy_project_queue.json', bulkCopyProjectQueue);
            }
        } else {
            logger.warn('Bulk copy project queue file exists but does not contain an array, cannot update project status');
        }
    } catch (err) {
        logger.error(`Failed to read bulk copy project queue: ${err.message}`);
    }
}

function exitAction(resp) {
    return resp;
}

export { main };
