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

import { getAioLogger, toUTCStr, handleExtension } from '../utils.js';
import AppConfig from '../appConfig.js';
import Sharepoint from '../sharepoint.js';
import initFilesWrapper from './filesWrapper.js';
import { writeProjectStatus } from './statusUtils.js';
import { updateBulkCopyStepStatus } from './bulkCopyStatusUtils.js';

const logger = getAioLogger();

async function main(params) {
    logger.info('Graybox Bulk Copy Non-Processing Worker triggered');
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

    // process data in batches
    const filesWrapper = await initFilesWrapper(logger);
    let responsePayload;
    const copiedFiles = [];
    const failedCopies = [];

    logger.info('In Bulk Copy Non-Processing Worker, Processing Copy Content');

    const project = params.project || '';
    const batchName = params.batchName || '';

    // Read the Batch Status in the current project's "batch_status.json" file
    let batchStatusJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-batches/batch_status.json`);

    // Read the specific batch file
    const batchFile = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-batches/${batchName}.json`);
    logger.info(`In Bulk Copy Non-Processing Worker, Copy File Paths for project: ${project} for batchname ${batchName} of params: ${JSON.stringify(params)}: ${JSON.stringify(batchFile)}`);

    // Update step 2 status (non-processing copy started)
    await updateBulkCopyStepStatus(filesWrapper, project, 'step2_non_processing_copy', {
        status: 'in_progress',
        startTime: toUTCStr(new Date()),
        progress: {
            total: batchFile ? batchFile.length : 0
        }
    });

    // Update & Write the Batch Status to in progress "batch_status.json" file
    // So that the scheduler doesn't pick the same batch again
    batchStatusJson[batchName] = 'copy_in_progress';
    await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-batches/batch_status.json`, batchStatusJson);

    // Process the Copy Content
    const copyFilePathsJson = batchFile || [];

    for (let i = 0; i < copyFilePathsJson.length; i += 1) {
        const copyPathsEntry = copyFilePathsJson[i];
        try {
            // Determine source and destination paths
            let sourcePath;
            let destinationPath;
            if (typeof copyPathsEntry === 'string') {
                sourcePath = copyPathsEntry;
                destinationPath = `/${experienceName}${copyPathsEntry}`;
            } else if (copyPathsEntry.sourcePath && copyPathsEntry.destinationPath) {
                sourcePath = copyPathsEntry.sourcePath;
                destinationPath = copyPathsEntry.destinationPath;
            } else if (copyPathsEntry.sourcePath) {
                // If it has sourcePath, use it (this includes fragments with their own sourcePath)
                sourcePath = copyPathsEntry.sourcePath;
                destinationPath = `/${experienceName}${copyPathsEntry.sourcePath}`;
                if (copyPathsEntry.fragmentPath) {
                    logger.info(`Processing fragment with sourcePath: ${copyPathsEntry.type || 'unknown'} - copying fragment: ${sourcePath}`);
                    logger.info(`  Fragment URL: ${copyPathsEntry.fragmentPath}`);
                } else {
                    logger.info(`Processing file with sourcePath: ${sourcePath}`);
                }
            } else if (copyPathsEntry.sourcePage) {
                sourcePath = copyPathsEntry.sourcePage;
                destinationPath = `/${experienceName}${copyPathsEntry.sourcePage}`;
                logger.info(`Processing fragment metadata entry: ${copyPathsEntry.type || 'unknown'} - copying source page: ${sourcePath}`);
                if (copyPathsEntry.fragmentPath) {
                    logger.info(`  Fragment metadata: ${copyPathsEntry.fragmentPath} (not copied, just metadata)`);
                }
            } else if (copyPathsEntry.fragmentPath && !copyPathsEntry.sourcePage) {
                logger.info(`Skipping fragment-only entry: ${copyPathsEntry.type || 'unknown'} - fragment ${copyPathsEntry.fragmentPath} has no source file to copy`);
                continue;
            } else {
                logger.warn(`Invalid file entry format: ${JSON.stringify(copyPathsEntry)}`);
                failedCopies.push(`Invalid format: ${JSON.stringify(copyPathsEntry)}`);
                continue;
            }

            if (sourcePath && !sourcePath.startsWith('/')) {
                sourcePath = `/${sourcePath}`;
                logger.info(`Normalized sourcePath to: ${sourcePath}`);
            }

            logger.info(`Processing file: ${sourcePath} -> ${destinationPath}`);
            // Download the source file and save it to destination location
            logger.info(`Getting file data for: ${sourcePath} (isGraybox: false - source files are in regular SharePoint)`);
            let sourcePathForFileData = sourcePath;
            if (sourcePath.endsWith('.json')) {
                sourcePathForFileData = sourcePath.replace(/\.json$/, '.xlsx');
                logger.info(`Converted .json to .xlsx for file data: ${sourcePathForFileData}`);
            }
            const { fileDownloadUrl, fileSize } = await sharepoint.getFileData(sourcePathForFileData, false);
            logger.info(`File download URL: ${fileDownloadUrl ? 'PRESENT' : 'MISSING'}, File size: ${fileSize || 'unknown'}`);
            if (!fileDownloadUrl) {
                throw new Error(`No download URL returned for file: ${sourcePathForFileData}`);
            }
            logger.info(`Downloading file from URL: ${fileDownloadUrl.substring(0, 100)}...`);
            const file = await sharepoint.getFileUsingDownloadUrl(fileDownloadUrl);
            logger.info(`File downloaded successfully, size: ${file ? file.size || 'unknown' : 'null'}`);
            let destPath = destinationPath;
            if (destPath.endsWith('.json')) {
                destPath = destPath.replace(/\.json$/, '.xlsx');
                logger.info(`Converted destination .json to .xlsx: ${destPath}`);
            }
            const saveStatus = await sharepoint.saveFileSimple(file, destPath, true);

            if (saveStatus?.success) {
                // Only add if not already in the array (prevent duplicates)
                if (!copiedFiles.includes(destPath)) {
                    copiedFiles.push(destPath);
                    logger.info(`Successfully copied: ${sourcePath} -> ${destPath}`);
                } else {
                    logger.info(`File already copied (duplicate): ${destPath}`);
                }
            } else if (saveStatus?.errorMsg?.includes('File is locked')) {
                failedCopies.push(`${destPath} (locked file)`);
                logger.warn(`File locked: ${destPath}`);
            } else {
                failedCopies.push(destPath);
                logger.error(`Failed to copy: ${sourcePath} -> ${destPath}, Error: ${saveStatus?.errorMsg || 'Unknown error'}`);
            }
        } catch (err) {
            const errorMsg = `Error processing file ${JSON.stringify(copyPathsEntry)}: ${err.message}`;
            logger.error(errorMsg);
            failedCopies.push(errorMsg);
        }
    }

    logger.info(`In Bulk Copy Non-Processing Worker, Copied files for project: ${project} for batchname ${batchName} no.of files ${copiedFiles.length}, files list: ${JSON.stringify(copiedFiles)}`);
    // Update step 2 status (non-processing copy completed)
    await updateBulkCopyStepStatus(filesWrapper, project, 'step2_non_processing_copy', {
        status: 'completed',
        endTime: toUTCStr(new Date()),
        progress: {
            completed: copiedFiles.length,
            failed: failedCopies.length
        },
        details: {
            copiedFiles,
            failedFiles: failedCopies
        },
        errors: failedCopies
    });
    // Update the Copied Files tracking for preview
    if (copiedFiles.length > 0) {
        await updateCopiedFilesTracking(project, copiedFiles, filesWrapper);
    }
    if (copiedFiles.length > 0) {
        let copiedPathsJson = {};
        const copiedPathsPath = `graybox_promote${project}/copied_paths.json`;
        try {
            const pathsData = await filesWrapper.readFileIntoObject(copiedPathsPath);
            if (typeof pathsData === 'object' && pathsData !== null && !Array.isArray(pathsData)) {
                copiedPathsJson = pathsData;
                logger.info(`Loaded existing copied paths file with ${Object.keys(copiedPathsJson).length} batch entries`);
            } else {
                logger.warn(`Copied paths file exists but does not contain an object (type: ${typeof pathsData}), starting with empty object`);
                copiedPathsJson = {};
            }
        } catch (err) {
            logger.info(`Copied paths file does not exist yet at ${copiedPathsPath}, will create new one`);
            copiedPathsJson = {};
        }

        if (typeof copiedPathsJson !== 'object' || copiedPathsJson === null || Array.isArray(copiedPathsJson)) {
            logger.error(`copiedPathsJson is not an object: ${typeof copiedPathsJson}, value: ${JSON.stringify(copiedPathsJson)}`);
            copiedPathsJson = {};
        }

        if (copiedPathsJson[batchName]) {
            const existingFiles = Array.isArray(copiedPathsJson[batchName]) ? copiedPathsJson[batchName] : [];
            copiedFiles = copiedFiles.concat(existingFiles);
            logger.info(`Combined with ${existingFiles.length} existing files for batch ${batchName}`);
        }
        copiedPathsJson[batchName] = copiedFiles;
        await filesWrapper.writeFile(copiedPathsPath, copiedPathsJson);
        logger.info(`Successfully wrote ${copiedFiles.length} copied files for batch ${batchName} to ${copiedPathsPath}`);
    }

    if (failedCopies.length > 0) {
        let copyErrorsJson = [];
        const copyErrorsPath = `graybox_promote${project}/copy_errors.json`;
        try {
            const errorsData = await filesWrapper.readFileIntoObject(copyErrorsPath);
            if (Array.isArray(errorsData)) {
                copyErrorsJson = errorsData;
                logger.info(`Loaded existing copy errors file with ${copyErrorsJson.length} entries`);
            } else {
                logger.warn(`Copy errors file exists but does not contain an array (type: ${typeof errorsData}), starting with empty array`);
                copyErrorsJson = [];
            }
        } catch (err) {
            logger.info(`Copy errors file does not exist yet at ${copyErrorsPath}, will create new one`);
            copyErrorsJson = [];
        }

        if (!Array.isArray(copyErrorsJson)) {
            logger.error(`copyErrorsJson is not an array: ${typeof copyErrorsJson}, value: ${JSON.stringify(copyErrorsJson)}`);
            copyErrorsJson = [];
        }

        const originalLength = copyErrorsJson.length;
        copyErrorsJson.push(...failedCopies);
        logger.info(`Added ${failedCopies.length} new failed copies to error log (total: ${copyErrorsJson.length})`);

        await filesWrapper.writeFile(copyErrorsPath, copyErrorsJson);
        logger.info(`Successfully wrote ${copyErrorsJson.length} error entries to ${copyErrorsPath}`);
    }

    batchStatusJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-batches/batch_status.json`);
    batchStatusJson[batchName] = 'copied';
    await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-batches/batch_status.json`, batchStatusJson);

    const allNonProcessingBatchesCopied = Object.keys(batchStatusJson)
        .filter(batchName => batchName.startsWith('non_processing_batch_'))
        .every(batchName => batchStatusJson[batchName] === 'copied');

    if (allNonProcessingBatchesCopied) {
        await updateProjectStatus(gbRootFolder, experienceName, filesWrapper);
    }

    try {
        const sFailedCopyStatuses = failedCopies.length > 0 ? `Failed Copies: \n${failedCopies.join('\n')}` : '';
        const copyExcelValues = [[`Step 2 of 5: Bulk Copy Non-Processing completed for Batch ${batchName}`, toUTCStr(new Date()), sFailedCopyStatuses, JSON.stringify(copiedFiles)]];
        await sharepoint.updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', copyExcelValues);

        const statusJsonPath = `graybox_promote${project}/status.json`;
        const statusEntry = {
            stepName: 'bulk_copy_non_processing_completed',
            step: `Step 2 of 5: Bulk Copy Non-Processing completed for Batch ${batchName}`,
            failures: sFailedCopyStatuses,
            files: copiedFiles
        };
        await writeProjectStatus(filesWrapper, statusJsonPath, statusEntry);
    } catch (err) {
        logger.error(`Error occurred while updating Excel during Graybox Bulk Copy Non-Processing: ${err}`);
    }

    responsePayload = `Bulk Copy Non-Processing Worker finished copying content for batch ${batchName}`;
    logger.info(responsePayload);
    return exitAction({
        body: responsePayload,
        statusCode: 200
    });
}

/**
 * Update the Copied Files tracking for preview
 * @param {*} project project path
 * @param {*} copiedFiles array of copied file paths
 * @param {*} filesWrapper filesWrapper object
 */
async function updateCopiedFilesTracking(project, copiedFiles, filesWrapper) {
    try {
        const copiedFilesPath = `graybox_promote${project}/copied_files_for_preview.json`;
        let copiedFilesJson = [];
        try {
            const existingData = await filesWrapper.readFileIntoObject(copiedFilesPath);
            if (Array.isArray(existingData)) {
                copiedFilesJson = existingData;
            }
        } catch (err) {
            if (err.message.includes('ERROR_FILE_NOT_EXISTS')) {
                logger.info('Copied files tracking file doesn\'t exist yet, creating new one');
            } else {
                logger.warn(`Error reading copied files tracking file: ${err.message}, creating new one`);
            }
        }

        const timestamp = toUTCStr(new Date());
        copiedFiles.forEach((filePath) => {
            // Normalize the file path to match what the preview worker expects
            const normalizedFilePath = handleExtension(filePath);
            copiedFilesJson.push({
                filePath: normalizedFilePath,
                originalFilePath: filePath, // Keep the original path for reference
                copiedAt: timestamp,
                previewStatus: 'pending',
                fileType: 'non_processing'
            });
        });

        await filesWrapper.writeFile(copiedFilesPath, copiedFilesJson);
        logger.info(`Updated copied files tracking with ${copiedFiles.length} new files`);
    } catch (err) {
        logger.error(`Error updating copied files tracking: ${err.message}`);
    }
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

    projectStatusJson.status = 'non_processing_batches_copied';
    await filesWrapper.writeFile(`graybox_promote${gbRootFolder}/${experienceName}/status.json`, projectStatusJson);

    try {
        const queueData = await filesWrapper.readFileIntoObject('graybox_promote/bulk_copy_project_queue.json');
        if (Array.isArray(queueData)) {
            const bulkCopyProjectQueue = queueData;
            const index = bulkCopyProjectQueue.findIndex((obj) => obj.projectPath === `${gbRootFolder}/${experienceName}`);
            if (index !== -1) {
                bulkCopyProjectQueue[index].status = 'non_processing_batches_copied';
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
