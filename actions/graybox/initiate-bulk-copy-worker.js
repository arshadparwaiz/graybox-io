/* ***********************************************************************
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

import AppConfig from '../appConfig.js';
import Sharepoint from '../sharepoint.js';
import { delay, getAioLogger } from '../utils.js';
import initFilesWrapper from './filesWrapper.js';
import { toUTCStr } from '../utils.js';

const logger = getAioLogger();

const BATCH_REQUEST_BULK_COPY = 200;

async function main(params) {
    logger.info('Graybox Bulk Copy Worker triggered');
    const appConfig = new AppConfig(params);
    const sharepoint = new Sharepoint(appConfig);
    const filesWrapper = await initFilesWrapper(logger);
    const {
        sourcePaths, rootFolder, gbRootFolder, experienceName, projectExcelPath, driveId, adminPageUri
    } = params;

    const project = `${gbRootFolder}/${experienceName}`;
    // Array to track failed files
    const failedFiles = [];
    // Array to track Excel updates
    const excelUpdates = [];

    try {
        logger.info('Starting bulk copy worker');

        logger.info(`In Initiate Bulk Copy Worker, params: ${JSON.stringify(params)}`);
        // await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, {
        //     statuses: []
        // });

        // const { sourcePaths } = params;
        const results = {
            successful: [],
            failed: []
        };

        const bulkCopyStatus = {
            status: 'initiated',
            sourcePaths,
            experienceName,
            destinationFolder: gbRootFolder,
            timestamp: new Date().toISOString(),
            statuses: []
        };

        await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, bulkCopyStatus);

        // Create Batch Status JSON
        const bulkCopyBatchStatusJson = {};

        // Create File Batches JSON
        const fileBatchesJson = {};

        // create batches to process the data
        const filesBatchArray = [];
        const writeBatchJsonPromises = [];

        for (let i = 0, batchCounter = 1; i < sourcePaths.length; i += BATCH_REQUEST_BULK_COPY, batchCounter += 1) {
            const arrayChunk = sourcePaths.slice(i, i + BATCH_REQUEST_BULK_COPY);
            filesBatchArray.push(arrayChunk);
            const batchName = `batch_${batchCounter}`;
            bulkCopyBatchStatusJson[`${batchName}`] = 'initiated';

            // Each Files Batch is written to a batch_n.json file
            writeBatchJsonPromises.push(filesWrapper.writeFile(`graybox_promote${project}/batches_bulk_copy/${batchName}.json`, arrayChunk));
        }

        await Promise.all(writeBatchJsonPromises);

        // const processingStatus = {
        //     timestamp: new Date().toISOString(),
        //     status: 'processing'
        // };
        // const currentStatus = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
        // currentStatus.status = 'processing';
        // currentStatus.statuses.push(processingStatus);
        // await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, currentStatus);

        const inputParams = {};
        inputParams.sourcePaths = sourcePaths;
        inputParams.rootFolder = rootFolder;
        inputParams.gbRootFolder = gbRootFolder;
        inputParams.projectExcelPath = projectExcelPath;
        inputParams.experienceName = experienceName;
        inputParams.adminPageUri = adminPageUri;
        inputParams.driveId = driveId;

        logger.info(`In Initiate Bulk Copy Worker, Input Params: ${JSON.stringify(inputParams)}`);

        // Create Project Queue Json
        let bulkCopyProjectQueue = [];
        // Read the existing Project Queue Json & then merge the current project to it
        if (await filesWrapper.fileExists('graybox_promote/bulk_copy_project_queue.json')) {
            bulkCopyProjectQueue = await filesWrapper.readFileIntoObject('graybox_promote/bulk_copy_project_queue.json');
            if (!bulkCopyProjectQueue) {
                bulkCopyProjectQueue = [];
            }
        }

        const newProject = { projectPath: `${project}`, status: 'initiated', createdTime: Date.now() };

        // TODO - check if replacing existing project is needed, if not remove this logic and just add the project to the queue
        // Find the index of the same  experience Project exists, replace it with this one
        const index = bulkCopyProjectQueue.findIndex((obj) => obj.projectPath === `${project}`);
        if (index !== -1) {
            // Replace the object at the found index
            bulkCopyProjectQueue[index] = newProject;
        } else {
            // Add the current project to the Project Queue Json & make it the current project
            bulkCopyProjectQueue.push(newProject);
        }

        logger.info(`In Initiate Bulk Copy Worker, Project Queue Json: ${JSON.stringify(bulkCopyProjectQueue)}`);

        // Create Bulk Copy Project Status JSON
        // const bulkCopyProjectStatusJson = {
        //     status: 'initiated',
        //     params: inputParams,
        //     statuses: [
        //         {
        //             stepName: 'initiated',
        //             step: 'Found files to copy',
        //             timestamp: toUTCStr(new Date()),
        //             files: sourcePaths
        //         }
        //     ]
        // };

        bulkCopyStatus.params = inputParams,
        bulkCopyStatus.statuses = [
                {
                    stepName: 'initiated',
                    step: 'Found files to copy',
                    timestamp: toUTCStr(new Date()),
                    files: sourcePaths
                }
            ];
        
        // write to JSONs to AIO Files for Projects Queue and Project Status
        await filesWrapper.writeFile('graybox_promote/bulk_copy_project_queue.json', bulkCopyProjectQueue);
        await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, bulkCopyStatus);
        await filesWrapper.writeFile(`graybox_promote${project}/bulk_copy_batch_status.json`, bulkCopyBatchStatusJson);

        // read Graybox Project Json from AIO Files
        const projectStatusBulkCopyJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
        const projectQueueBulkCopyJson = await filesWrapper.readFileIntoObject('graybox_promote/bulk_copy_project_queue.json');
        const projectBatchStatusJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk_copy_batch_status.json`);

        logger.info(`In Initiate Bulk Copy Worker, Project Status Bulk Copy Json: ${JSON.stringify(projectStatusBulkCopyJson)}`);
        logger.info(`In Initiate Bulk Copy Worker, Project Queue Bulk Copy Json: ${JSON.stringify(projectQueueBulkCopyJson)}`);
        logger.info(`In Initiate Bulk Copy Worker, Project Batch Status Json: ${JSON.stringify(projectBatchStatusJson)}`);
    

        // await Promise.all(sourcePaths.map(async (pathInfo) => {
        //     try {
        //         const { sourcePath, destinationPath: fileDestinationPath } = pathInfo;

        //         const status = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
        //         status.statuses.push({
        //             timestamp: new Date().toISOString(),
        //             status: 'processing_file',
        //             file: sourcePath
        //         });
        //         await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, status);

        //         let sourcePathForFileData = sourcePath;
        //         if (sourcePath.endsWith('.json')) {
        //             sourcePathForFileData = sourcePath.replace(/\.json$/, '.xlsx');
        //         }
        //         const { fileDownloadUrl, fileSize } = await sharepoint.getFileData(sourcePathForFileData, false);

        //         if (!fileDownloadUrl) {
        //             const errorMsg = `Failed to get file data for: ${sourcePath}`;
        //             failedFiles.push({ path: sourcePath, error: errorMsg });
        //             excelUpdates.push([`Failed to copy file: ${sourcePath}`, toUTCStr(new Date()), errorMsg, '']);
        //             throw new Error(errorMsg);
        //         }

        //         const fileContent = await sharepoint.getFileUsingDownloadUrl(fileDownloadUrl);
        //         if (!fileContent) {
        //             const errorMsg = `Failed to download file: ${sourcePath}`;
        //             logger.error(`Failed to download file in bulk copy worker: ${sourcePath}`);
        //             failedFiles.push({ path: sourcePath, error: errorMsg });
        //             excelUpdates.push([`Failed to download file: ${sourcePath}`, toUTCStr(new Date()), errorMsg, '']);
        //             throw new Error(errorMsg);
        //         }

        //         let destPath = fileDestinationPath;
        //         if (destPath.endsWith('.json')) {
        //             destPath = destPath.replace(/\.json$/, '.xlsx');
        //         }

        //         const savingStatus = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
        //         savingStatus.statuses.push({
        //             timestamp: new Date().toISOString(),
        //             status: 'saving_file',
        //             sourcePath,
        //             destinationPath: destPath
        //         });
        //         await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, savingStatus);

        //         const saveResult = await sharepoint.saveFileSimple(fileContent, destPath, true);
        //         if (!saveResult.success) {
        //             const errorMsg = saveResult.errorMsg || `Failed to save file to: ${destPath}`;
        //             failedFiles.push({ path: sourcePath, error: errorMsg });
        //             excelUpdates.push([`Failed to copy file: ${sourcePath}`, toUTCStr(new Date()), errorMsg, '']);
        //             throw new Error(errorMsg);
        //         }
        //         logger.info(`File saved to destination: ${destPath}`);

        //         results.successful.push({
        //             sourcePath,
        //             destinationPath: destPath,
        //             fileSize
        //         });

        //         const successStatus = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
        //         successStatus.statuses.push({
        //             timestamp: new Date().toISOString(),
        //             status: 'file_copied',
        //             sourcePath,
        //             destinationPath: destPath,
        //             fileSize
        //         });
        //         await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, successStatus);

        //         await delay(100);
        //     } catch (error) {
        //         logger.error(`Error processing ${pathInfo.sourcePath}: ${error.message}`);
        //         results.failed.push({
        //             sourcePath: pathInfo.sourcePath,
        //             error: error.message
        //         });

        //         const failureStatus = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
        //         failureStatus.statuses.push({
        //             timestamp: new Date().toISOString(),
        //             status: 'file_failed',
        //             sourcePath: pathInfo.sourcePath,
        //             error: error.message
        //         });
        //         await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, failureStatus);

        //         if (!failedFiles.some((f) => f.path === pathInfo.sourcePath)) {
        //             failedFiles.push({ path: pathInfo.sourcePath, error: error.message });
        //             excelUpdates.push([`Failed to copy file: ${pathInfo.sourcePath}`, toUTCStr(new Date()), error.message, '']);
        //         }
        //     }
        // }));

        // const finalStatus = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
        // finalStatus.status = 'completed';
        // finalStatus.statuses.push({
        //     status: 'completed',
        //     timestamp: new Date().toISOString(),
        //     results
        // });
        // await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, finalStatus);

        try {
        excelUpdates.push(['Bulk Copy Initiated', toUTCStr(new Date()), '', '']);
        if (failedFiles.length > 0) {
            excelUpdates.push([`Bulk Copy: ${failedFiles.length} files failed`, toUTCStr(new Date()), 'See individual file errors above', '']);
        }
        await sharepoint.updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', excelUpdates);
        } catch (error) {
            logger.error(`Error updating Excel table: ${error.message}`);
        }

        return {
            statusCode: 200,
            body: {
                message: 'Bulk copy operation initiated',
                results: {
                    total: sourcePaths.length,
                    successful: results.successful.length,
                    failed: results.failed.length,
                    details: results
                }
            }
        };
    } catch (error) {
        logger.error(error);

        try {
            const errorStatus = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
            errorStatus.status = 'error';
            errorStatus.statuses.push({
                timestamp: new Date().toISOString(),
                status: 'error',
                error: error.message
            });
            await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, errorStatus);

            excelUpdates.push(['Bulk Copy Failed', toUTCStr(new Date()), error.message, '']);
            await sharepoint.updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', excelUpdates);
        } catch (statusError) {
            logger.error(`Failed to update status file: ${statusError.message}`);
        }

        return {
            statusCode: 500,
            body: {
                error: 'Internal server error',
                message: error.message
            }
        };
    }
}

export { main };
