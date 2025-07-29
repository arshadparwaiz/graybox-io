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
async function main(params) {
    logger.info('Graybox Bulk Copy Worker triggered');
    const appConfig = new AppConfig(params);
    const sharepoint = new Sharepoint(appConfig);
    const filesWrapper = await initFilesWrapper(logger);
    const {
        gbRootFolder, experienceName, projectExcelPath
    } = appConfig.getPayload();

    const project = `${gbRootFolder}/${experienceName}`;
    // Array to track failed files
    const failedFiles = [];
    // Array to track Excel updates
    const excelUpdates = [];

    try {
        logger.info('Starting bulk copy worker');

        await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, {
            statuses: []
        });

        const { sourcePaths } = params;
        const results = {
            successful: [],
            failed: []
        };

        const bulkCopyStatus = {
            status: 'started',
            sourcePaths,
            experienceName,
            destinationFolder: gbRootFolder,
            timestamp: new Date().toISOString(),
            statuses: []
        };

        await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, bulkCopyStatus);

        const processingStatus = {
            timestamp: new Date().toISOString(),
            status: 'processing'
        };
        const currentStatus = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
        currentStatus.status = 'processing';
        currentStatus.statuses.push(processingStatus);
        await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, currentStatus);

        await Promise.all(sourcePaths.map(async (pathInfo) => {
            try {
                const { sourcePath, destinationPath: fileDestinationPath } = pathInfo;

                const status = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
                status.statuses.push({
                    timestamp: new Date().toISOString(),
                    status: 'processing_file',
                    file: sourcePath
                });
                await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, status);

                let sourcePathForFileData = sourcePath;
                if (sourcePath.endsWith('.json')) {
                    sourcePathForFileData = sourcePath.replace(/\.json$/, '.xlsx');
                }
                const { fileDownloadUrl, fileSize } = await sharepoint.getFileData(sourcePathForFileData, false);

                if (!fileDownloadUrl) {
                    const errorMsg = `Failed to get file data for: ${sourcePath}`;
                    failedFiles.push({ path: sourcePath, error: errorMsg });
                    excelUpdates.push([`Failed to copy file: ${sourcePath}`, toUTCStr(new Date()), errorMsg, '']);
                    throw new Error(errorMsg);
                }

                const fileContent = await sharepoint.getFileUsingDownloadUrl(fileDownloadUrl);
                if (!fileContent) {
                    const errorMsg = `Failed to download file: ${sourcePath}`;
                    logger.error(`Failed to download file in bulk copy worker: ${sourcePath}`);
                    failedFiles.push({ path: sourcePath, error: errorMsg });
                    excelUpdates.push([`Failed to download file: ${sourcePath}`, toUTCStr(new Date()), errorMsg, '']);
                    throw new Error(errorMsg);
                }

                let destPath = fileDestinationPath;
                if (destPath.endsWith('.json')) {
                    destPath = destPath.replace(/\.json$/, '.xlsx');
                }

                const savingStatus = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
                savingStatus.statuses.push({
                    timestamp: new Date().toISOString(),
                    status: 'saving_file',
                    sourcePath,
                    destinationPath: destPath
                });
                await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, savingStatus);

                const saveResult = await sharepoint.saveFileSimple(fileContent, destPath, true);
                if (!saveResult.success) {
                    const errorMsg = saveResult.errorMsg || `Failed to save file to: ${destPath}`;
                    failedFiles.push({ path: sourcePath, error: errorMsg });
                    excelUpdates.push([`Failed to copy file: ${sourcePath}`, toUTCStr(new Date()), errorMsg, '']);
                    throw new Error(errorMsg);
                }
                logger.info(`File saved to destination: ${destPath}`);

                results.successful.push({
                    sourcePath,
                    destinationPath: destPath,
                    fileSize
                });

                const successStatus = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
                successStatus.statuses.push({
                    timestamp: new Date().toISOString(),
                    status: 'file_copied',
                    sourcePath,
                    destinationPath: destPath,
                    fileSize
                });
                await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, successStatus);

                await delay(100);
            } catch (error) {
                logger.error(`Error processing ${pathInfo.sourcePath}: ${error.message}`);
                results.failed.push({
                    sourcePath: pathInfo.sourcePath,
                    error: error.message
                });

                const failureStatus = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
                failureStatus.statuses.push({
                    timestamp: new Date().toISOString(),
                    status: 'file_failed',
                    sourcePath: pathInfo.sourcePath,
                    error: error.message
                });
                await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, failureStatus);

                if (!failedFiles.some((f) => f.path === pathInfo.sourcePath)) {
                    failedFiles.push({ path: pathInfo.sourcePath, error: error.message });
                    excelUpdates.push([`Failed to copy file: ${pathInfo.sourcePath}`, toUTCStr(new Date()), error.message, '']);
                }
            }
        }));

        const finalStatus = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
        finalStatus.status = 'completed';
        finalStatus.statuses.push({
            status: 'completed',
            timestamp: new Date().toISOString(),
            results
        });
        await filesWrapper.writeFile(`graybox_promote${project}/bulk-copy-status.json`, finalStatus);

        excelUpdates.push(['Bulk Copy Completed', toUTCStr(new Date()), '', '']);
        if (failedFiles.length > 0) {
            excelUpdates.push([`Bulk Copy: ${failedFiles.length} files failed`, toUTCStr(new Date()), 'See individual file errors above', '']);
        }
        await sharepoint.updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', excelUpdates);

        return {
            statusCode: 200,
            body: {
                message: 'Bulk copy operation completed',
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
