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
import { updateExcel, convertJsonToExcel } from '../excelHandler.js';
import initFilesWrapper from './filesWrapper.js';
import { writeProjectStatus } from './statusUtils.js';

const BATCH_REQUEST_BULK_COPY = 200;

const logger = getAioLogger();

async function main(params) {
    logger.info('Graybox Bulk Copy Processed Content Action triggered');

    const appConfig = new AppConfig(params);
    const { gbRootFolder, experienceName, projectExcelPath } = appConfig.getPayload();

    const sharepoint = new Sharepoint(appConfig);
    // Copy Processed docx files in batches
    const helixUtils = new HelixUtils(appConfig);
    const filesWrapper = await initFilesWrapper(logger);
    let responsePayload;

    const project = params.project || '';
    const batchName = params.batchName || '';

    logger.info(`In BulkCopyProcessed-worker, project: ${project} batchName: ${batchName}`);
    // Get the Helix Admin API Key for the main content tree, needed for accessing (with auth) Images in graybox tree
    const helixAdminApiKey = helixUtils.getAdminApiKey(false);

    // Read the Project Status in the current project's "bulk-copy-status.json" file
    const projectStatusBulkCopyJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
    logger.info(`In BulkCopyProcessed-worker, Path of bulk-copy-status.json: graybox_promote${project}/bulk-copy-status.json`);
    logger.info(`In BulkCopyProcessed-worker, projectStatusJson: ${JSON.stringify(projectStatusBulkCopyJson)}`);

    const processFilesParams = {
        experienceName,
        helixAdminApiKey,
        sharepoint,
        helixUtils,
        appConfig,
        filesWrapper,
        gbRootFolder,
        projectExcelPath,
        project,
        batchName
    };

    // Copy Processed docx files to the graybox content tree
    await copyFiles(processFilesParams);

    responsePayload = 'Processing for Frament Paths of Bulk Copy Graybox Content Tree completed';
    logger.info(responsePayload);
    return exitAction({
        body: responsePayload,
        statusCode: 200
    });
}

/**
* Process files to clean up GB Styles and Link
* @returns
*/
async function copyFiles({
    experienceName, helixAdminApiKey, sharepoint, helixUtils, filesWrapper, gbRootFolder, projectExcelPath, project, batchName
}) {
    logger.info('Copying processed files to Graybox tree under experience folder');
    const options = {};
    // Passing isGraybox param true to fetch graybox Hlx Admin API Key
    const mainContentHlxAdminApiKey = helixUtils.getAdminApiKey(false);
    if (mainContentHlxAdminApiKey) {
        options.headers = new fetch.Headers();
        options.headers.append('Authorization', `token ${mainContentHlxAdminApiKey}`);
    }
logger.info('Options: ', JSON.stringify(options));
    const toBeStatus = 'process_content_in_progress';
    const statusEntry = {
        step: 'Processing files for Fragment Path transformation to include Experience Name',
        stepName: toBeStatus,
        files: []
    };
logger.info('Status Entry: ', JSON.stringify(statusEntry));
    await writeProjectStatus(filesWrapper, `graybox_promote${project}/bulk-copy-status.json`, statusEntry, toBeStatus);

    // Update the Project Status in the parent "bulk_copy_project_queue.json" file
    await changeProjectStatusInQueue(filesWrapper, project, toBeStatus);

    // Read the Batch Status in the current project's "bulk_copy_batch_status.json" file
    const batchStatusBulkCopyJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk_copy_batch_status.json`);

    logger.info(`In Bulk copy Process-doc-worker, for project: ${project} batchStatusBulkCopyJson: ${JSON.stringify(batchStatusBulkCopyJson)}`);
    const processDocxErrors = [];
    const processedFiles = []; // Track all processed files
    const unprocessedFiles = []; // Track files that don't need processing

    // Write the processed files list to a JSON file
    const processedBatchesJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/processed_batches.json`);

    logger.info(`In BulkCopyProcessed-worker, processedBatchesJson: ${JSON.stringify(processedBatchesJson)}`);
    logger.info(`In BulkCopyProcessed-worker, batchName: ${batchName}`);
    const processedFilePathObjs = processedBatchesJson[batchName].files || [];

    logger.info(`In Bulk Copy Processed Worker, before copying processed files for project: ${project} for Batch Name ${batchName} promoteFilePaths: ${JSON.stringify(processedFilePathObjs)}`);

    // Process the Promote Content
    const promotes = [];
    const failedPromotes = [];

    // Collect all promises from the forEach loop
    // eslint-disable-next-line no-restricted-syntax
    for (const processedFilePathObj of processedFilePathObjs) {
        const { sourcePath, destinationPath } = processedFilePathObj;
        // Check if the file is a docx or xlsx based on file extension
        const isExcelFile = sourcePath.toLowerCase().endsWith('.xlsx') || sourcePath.toLowerCase().endsWith('.xls');
        const folderType = isExcelFile ? 'excel' : 'docx';
        // eslint-disable-next-line no-await-in-loop
        // const promoteFile = await filesWrapper.readFileIntoBuffer(`graybox_promote${project}/${folderType}${processedFilePath}`);
        const processedFile = await filesWrapper.readFileIntoBuffer(`graybox_promote${project}/docx_bulk_copy${sourcePath}`);
        if (processedFile) {
            logger.info(`In BulkCopyProcessDocx-worker, processedFile before save`);
            // Check file existence and compare dates
            // const { newerDestinationFiles: newFiles } = await checkAndCompareFileDates({
            //     sharepoint,
            //     filesWrapper,
            //     project,
            //     filePath: processedFilePath
            // });
            // newerDestinationFiles.push(...newFiles);
            
            // If file doesn't exist or we're overwriting it anyway
            const saveStatus = await sharepoint.saveFileSimple(processedFile, destinationPath, true);

            if (saveStatus?.success) {
                promotes.push(destinationPath);
            } else if (saveStatus?.errorMsg?.includes('File is locked')) {
                failedPromotes.push(`${destinationPath} (locked file)`);
            } else {
                failedPromotes.push(`${destinationPath} (failed with reason: ${saveStatus?.errorMsg})`);
            }
        }
    }

    // Update the current batch status to 'promoted'
    batchStatusBulkCopyJson[batchName] = 'promoted';
    await filesWrapper.writeFile(`graybox_promote${project}/bulk_copy_batch_status.json`, batchStatusBulkCopyJson);
    await updateStatuses(processedBatchesJson, project, filesWrapper, processDocxErrors, sharepoint, projectExcelPath, processedFiles, unprocessedFiles);
}

/**
 * Check if the content contains any fragment paths
 * @param {string} content - The content to check
 * @returns {boolean} - True if content contains any fragment paths
 */
async function hasFragmentPathsInContent(content) {
    // Find fragment links in content using angle bracket format
    // Pattern matches: <https://...aem.page/.../fragments/...>
    return content.match(/<https:\/\/[^>]*aem\.page[^>]*\/fragments\/[^>]*>/g) || [];
}

async function updateStatuses(processedBatchesJson, project, filesWrapper, processContentErrors, sharepoint, projectExcelPath, processedFiles, unprocessedFiles) {
    // Write the copy batches JSON file
    // await filesWrapper.writeFile(`graybox_promote${project}/processed_batches.json`, processedBatchesJson);
    // Update the Project Status in JSON files
    await updateProjectStatus(project, filesWrapper, processedFiles, unprocessedFiles);

    // Write the processDocxErrors to the AIO Files
    if (processContentErrors.length > 0) {
        await filesWrapper.writeFile(`graybox_promote${project}/process_content_errors.json`, processContentErrors);
    }

    // Update the Project Excel with the Promote Status
    try {
        const promoteExcelValues = [['Step 2 of 5: Processing files for Graybox blocks, styles and links completed', toUTCStr(new Date()), '', '']];
        await sharepoint.updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', promoteExcelValues);

        // Add processed files summary to Excel
        const docxFiles = processedFiles.filter((file) => file.fileType === 'docx');
        const excelFiles = processedFiles.filter((file) => file.fileType === 'excel');
        const otherFiles = processedFiles.filter((file) => file.fileType === 'other');

        logger.info(`In Process-doc-worker, for project: ${project} Processed Files Summary: ${JSON.stringify(processedFiles)}`);
        logger.info(`In Process-doc-worker, for project: ${project} Unprocessed Files Summary: ${JSON.stringify(unprocessedFiles)}`);
        
        const filesSummaryValues = [[
            `Processed Files Summary: ${processedFiles.length} total files (${docxFiles.length} DOCX, ${excelFiles.length} Excel, ${otherFiles.length} Other)`,
            toUTCStr(new Date()),
            '', 
            JSON.stringify(processedFiles.map(file => file.sourcePath))
        ]];
        await sharepoint.updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', filesSummaryValues);
        logger.info(`In Process-doc-worker, for project filesSummaryValues: ${project} Processed Files Summary: ${JSON.stringify(filesSummaryValues)}`);
        // Add unprocessed files summary to Excel
        const unprocessedSummaryValues = [[
            `Unprocessed Files Summary: ${unprocessedFiles.length} total files skipped or failed`,
            toUTCStr(new Date()),
            '',
            JSON.stringify(unprocessedFiles.map(file => file.sourcePath))
        ]];
        logger.info(`In Process-doc-worker, for project unprocessedSummaryValues: ${project} Unprocessed Files Summary: ${JSON.stringify(unprocessedSummaryValues)}`);
        await sharepoint.updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', unprocessedSummaryValues);

        // Write status to status.json
        const statusJsonPath = `graybox_promote${project}/status.json`;
        const statusEntry = {
            step: 'Step 2 of 5: Processing files for Graybox blocks, styles and links completed',
            stepName: 'processed',
            processedFiles: {
                total: processedFiles.length,
                docx: docxFiles.length,
                excel: excelFiles.length,
                other: otherFiles.length,
                files: processedFiles.map(file => file.sourcePath)
            },
            unprocessedFiles: {
                total: unprocessedFiles.length,
                files: unprocessedFiles.map(file => file.sourcePath)
            }
        };
        await writeProjectStatus(filesWrapper, statusJsonPath, statusEntry, 'processed');
    } catch (err) {
        logger.error(`Error Occured while updating Excel during Graybox Process Content Step: ${err}`);
    }
}

/**
 * Update the Project Status in the current project's "status.json" file & the parent "bulk_copy_project_queue.json" file
 * @param {*} gbRootFolder graybox root folder
 * @param {*} experienceName graybox experience name
 * @param {*} filesWrapper filesWrapper object
 * @returns updated project status
 */
async function updateProjectStatus(project, filesWrapper, processedFiles, unprocessedFiles) {
    // Update the Project Status in the current project's "status.json" file
    const toBeStatus = 'processed';
    const statusEntry = {
        step: 'Processing files for Graybox blocks, styles and links completed',
        stepName: toBeStatus,
        files: processedFiles.map(file => file.sourcePath)
    };
    await writeProjectStatus(filesWrapper, `graybox_promote${project}/status.json`, statusEntry, toBeStatus);

    // Update the Project Status in the parent "bulk_copy_project_queue.json" file
    const projectQueueBulkCopy = await changeProjectStatusInQueue(filesWrapper, project, toBeStatus);
    logger.info(`In process-content-worker, for project: ${project} After Processing Docx, Project Queue Json: ${JSON.stringify(projectQueueBulkCopy)}`);
}

async function changeProjectStatusInQueue(filesWrapper, project, toBeStatus) {
    const projectQueueBulkCopy = await filesWrapper.readFileIntoObject('graybox_promote/bulk_copy_project_queue.json');
    const index = projectQueueBulkCopy.findIndex((obj) => obj.projectPath === `${project}`);
    if (index !== -1) {
        // Replace the object at the found index
        projectQueueBulkCopy[index].status = toBeStatus;
        await filesWrapper.writeFile('graybox_promote/bulk_copy_project_queue.json', projectQueueBulkCopy);
    }
    return projectQueueBulkCopy;
}

function exitAction(resp) {
    return resp;
}

export { main };