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

const gbStyleExpression = 'gb-'; // graybox style expressions
const gbBlockName = 'graybox'; // graybox block name
const gbDomainSuffix = '-graybox';

const BATCH_REQUEST_BULK_COPY = 200;

const logger = getAioLogger();

async function main(params) {
    logger.info('Graybox Bulk Copy Process Content Action triggered');

    logger.info(`Parameters received: ${JSON.stringify(params, null, 2)}`);
    
    const appConfig = new AppConfig(params);
    const { gbRootFolder, experienceName, projectExcelPath } = appConfig.getPayload();

    const sharepoint = new Sharepoint(appConfig);
    // process data in batches
    const helixUtils = new HelixUtils(appConfig);
    const filesWrapper = await initFilesWrapper(logger);
    let responsePayload;

    const project = `${gbRootFolder}/${experienceName}`;

    // Get the Helix Admin API Key for the main content tree, needed for accessing (with auth) Images in graybox tree
    const helixAdminApiKey = helixUtils.getAdminApiKey(false);

    // Read the Project Status in the current project's "bulk-copy-status.json" file
    const projectStatusBulkCopyJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
    logger.info(`In BulkCopyProcessDocx-worker, Path of bulk-copy-status.json: graybox_promote${project}/bulk-copy-status.json`);
    logger.info(`In BulkCopyProcessDocx-worker, projectStatusJson: ${JSON.stringify(projectStatusBulkCopyJson)}`);

    const processFilesParams = {
        experienceName,
        helixAdminApiKey,
        sharepoint,
        helixUtils,
        appConfig,
        filesWrapper,
        gbRootFolder,
        projectExcelPath
    };

    // Process Docx files to transform fragment links
    await processFiles(processFilesParams);

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
async function processFiles({
    experienceName, helixAdminApiKey, sharepoint, helixUtils, filesWrapper, gbRootFolder, projectExcelPath
}) {
    logger.info('Processing files for Fragment Path transformation to include Experience Name');
    const options = {};
    // Passing isGraybox param true to fetch graybox Hlx Admin API Key
    const mainContentHlxAdminApiKey = helixUtils.getAdminApiKey(false);
    if (mainContentHlxAdminApiKey) {
        options.headers = new fetch.Headers();
        options.headers.append('Authorization', `token ${mainContentHlxAdminApiKey}`);
    }
logger.info('Options: ', JSON.stringify(options));
    const project = `${gbRootFolder}/${experienceName}`;
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
    const processedBatchesJson = {};
    const unprocessedBatchesJson = {};
    let processedBatchCount = 0;
    let unprocessedBatchCount = 0;
    const processDocxErrors = [];
    const processedFiles = []; // Track all processed files
    const unprocessedFiles = []; // Track files that don't need processing

    // iterate through batch names, read .md files, generate docx files and create promote & copy batches
    const batchNames = Object.keys(batchStatusBulkCopyJson).flat();
    const allProcessingPromises = batchNames.map(async (batchName) => {
        // const batchStatuses = batchStatusBulkCopyJson[batchName];
        const sourcePathObjs = await filesWrapper.readFileIntoObject(`graybox_promote${project}/batches_bulk_copy/${batchName}.json`);

logger.info('Source Path Objs: ', JSON.stringify(sourcePathObjs));
        // Check if Step 2 finished, do the Step 3, if the batch status is 'initial_preview_done' then process the batch
        if (batchStatusBulkCopyJson[batchName] === 'initiated') {
            for (let batchIndex = 0; batchIndex < sourcePathObjs.length; batchIndex += 1) {
                const sourcePathObj = sourcePathObjs[batchIndex];
                const { sourcePath, destinationPath, mdPath } = sourcePathObj;
                const fileName = sharepoint.getFileNameFromPath(sourcePath);
                if (mdPath) { // If the file has a mdPath then process the file
                    // Check if the file is a docx file
                    const isDocxFile = fileName.toLowerCase().endsWith('.docx');
                    // Check if the file is an Excel file
                    const isExcelFile = fileName.toLowerCase().endsWith('.xlsx') ||
                        fileName.toLowerCase().endsWith('.xls');

                        logger.info(`In BulkCopyProcessDocx-worker, for project: ${project} isDocxFile: ${isDocxFile}`);
                    if (isDocxFile) {
                        // eslint-disable-next-line no-await-in-loop
                        const response = await sharepoint.fetchWithRetry(`${mdPath}`, options);
                        // eslint-disable-next-line no-await-in-loop
                        const content = await response.text();
                        let docx;
                        logger.info(`In BulkCopyProcessDocx-worker, hasFragmentPathsInContent(content): ${hasFragmentPathsInContent(content)}`);
                        if (hasFragmentPathsInContent(content)) {
                            // Add the Graybox Experience Name to Graybox Fragment Links then perform Mdast to Docx conversion
                            // eslint-disable-next-line no-await-in-loop
                            docx = await updateDocumentForBulkCopy(content, experienceName, helixAdminApiKey, helixUtils);
                            if (docx) {
                                const destinationFilePath = `${sourcePath.substring(0, sourcePath.lastIndexOf('/') + 1).replace('/'.concat(experienceName), '')}${fileName}`;
                                const docxFileStream = Readable.from(docx);

                                logger.info(`In BulkCopyProcessDocx-worker, destinationFilePath: ${destinationFilePath}`);
                                logger.info(`In BulkCopyProcessDocx-worker, sourceFilePath: ${sourcePath}`);
                                logger.info(`In BulkCopyProcessDocx-worker, fileName: ${fileName}`);
                                logger.info(`In BulkCopyProcessDocx-worker, batchName: ${batchName}`);
                                // Write the processed documents to the AIO folder for docx files
                                // eslint-disable-next-line no-await-in-loop
                                await filesWrapper.writeFileFromStream(`graybox_promote${project}/docx_bulk_copy${destinationFilePath}`, docxFileStream);

                                // Add to processed files list
                                processedFiles.push({
                                    fileName: fileName,
                                    sourcePath: sourcePath,
                                    destinationPath: destinationPath,
                                    fileType: 'docx',
                                    batchName,
                                    processType: 'promote'
                                });

                                let processedBatchJson = processedBatchesJson[batchName];
                                if (!processedBatchJson) {
                                    processedBatchJson = { status: 'processed', 
                                        files: [{ sourcePath, destinationPath }] };
                                } else if (processedBatchJson.files) {
                                    processedBatchJson.files.push({ sourcePath, destinationPath });
                                } else {
                                    processedBatchJson.files = [{ sourcePath, destinationPath }];
                                }
                                processedBatchesJson[batchName] = processedBatchJson;

                                logger.info(`In Process-doc-worker, for project: ${project} Promote Batch JSON after push: ${JSON.stringify(processedBatchesJson)}`);

                                // If the promote batch count reaches the limit, increment the promote batch count
                                if (processedBatchCount === BATCH_REQUEST_BULK_COPY) { // TODO remove this code if promoteBatchCount is not needed, and instead initial preview batch count is used
                                    processedBatchCount += 1;
                                }

                                // Write the promote batches JSON file
                                // eslint-disable-next-line no-await-in-loop
                                await filesWrapper.writeFile(`graybox_promote${project}/processed_batches.json`, processedBatchesJson);
                            } else {
                                processDocxErrors.push(`Error processing docx for ${fileName}`);
                            }
                        } else {
                            // Copy Source full path with file name and extension
                            const copySourceFilePath = `${sourcePath.substring(0, sourcePath.lastIndexOf('/') + 1)}${fileName}`;
                            // Copy Destination folder path, no file name
                            const copyDestinationFolder = `${sourcePath.substring(0, sourcePath.lastIndexOf('/')).replace('/'.concat(experienceName), '')}`;
                            const copyDestFilePath = `${copyDestinationFolder}/${fileName}`;

                            unprocessedFiles.push({
                                fileName: fileName,
                                sourcePath: copySourceFilePath,
                                destinationPath: copyDestFilePath,
                                fileType: 'docx',
                                batchName,
                                processType: 'copy'
                            });

                            // Don't create new batch names, use the same batch names created in the start before initial preview
                            let unprocessedBatchJson = unprocessedBatchesJson[batchName];
                            if (!unprocessedBatchJson) {
                                unprocessedBatchJson = { status: 'processed', files: [{ copySourceFilePath, copyDestFilePath }] };
                            } else if (!unprocessedBatchJson.files) {
                                unprocessedBatchJson.files = [];
                            }
                            // Check if the file entry already exists before adding
                            const fileEntryExists = unprocessedBatchJson.files.some(
                                file => file.copySourceFilePath === copySourceFilePath && file.copyDestFilePath === copyDestFilePath
                            );
                            if (!fileEntryExists) {
                                unprocessedBatchJson.files.push({ copySourceFilePath, copyDestFilePath });
                            }
                            unprocessedBatchesJson[batchName] = unprocessedBatchJson;

                            // If the copy batch count reaches the limit, increment the copy batch count
                            if (unprocessedBatchCount === BATCH_REQUEST_BULK_COPY) { // TODO remove this code if copyBatchCount is not needed, and instead initial preview batch count is used
                                unprocessedBatchCount += 1; // Increment the copy batch count
                            }
                            logger.info(`In Process-doc-worker, for project: ${project} Copy Batch JSON after push: ${JSON.stringify(unprocessedBatchesJson)}`);
                            // Remove the immediate write here - we'll write at the end of batch processing
                        }
                    } else if (isExcelFile) {
                        // For Excel files, transform URLs from graybox to non-graybox format
                        // eslint-disable-next-line no-await-in-loop
                        const response = await sharepoint.fetchWithRetry(`${status.mdPath}`, options);
                        // eslint-disable-next-line no-await-in-loop
                        const content = await response.text();
                        // Check if we need to convert the transformed Excel content to an actual Excel file
                        // Transform graybox URLs to non-graybox URLs
                        // if (hasGrayboxContent(content, experienceName)) {
                        //     const transformedExcelContent = await updateExcel(content, experienceName);
                        //     const excelBuffer = convertJsonToExcel(transformedExcelContent, experienceName);
                        //     // Write the transformed content back
                        //     const destinationFilePath = `${sourcePath.substring(0, sourcePath.lastIndexOf('/') + 1).replace('/'.concat(experienceName), '')}${fileName}`;

                        //     // eslint-disable-next-line no-await-in-loop
                        //     await filesWrapper.writeFile(`graybox_promote${project}/excel${destinationFilePath}`, excelBuffer);

                        //     // Add to processed files list
                        //     processedFiles.push({
                        //         fileName: fileName,
                        //         sourcePath: sourcePath,
                        //         destinationPath: destinationFilePath,
                        //         fileType: 'excel',
                        //         batchName,
                        //         processType: 'promote'
                        //     });

                        //     let processedBatchJson = processedBatchesJson[batchName];
                        //     if (!processedBatchJson) {
                        //         processedBatchJson = { status: 'processed', files: [destinationFilePath] };
                        //     } else if (processedBatchJson.files) {
                        //         processedBatchJson.files.push(destinationFilePath);
                        //     } else {
                        //         processedBatchJson.files = [destinationFilePath];
                        //     }
                        //     processedBatchesJson[batchName] = processedBatchJson;

                        //     logger.info(`In Process-doc-worker, for project: ${project} Promote Batch JSON after push: ${JSON.stringify(processedBatchesJson)}`);
                        //     // eslint-disable-next-line no-await-in-loop
                        //     await filesWrapper.writeFile(`graybox_promote${project}/promote_batches.json`, processedBatchesJson);
                        // } else {
                            // If no graybox URLs found, just copy the file
                            const copySourceFilePath = `${sourcePath.substring(0, sourcePath.lastIndexOf('/') + 1)}${fileName}`;
                            const copyDestinationFolder = `${sourcePath.substring(0, sourcePath.lastIndexOf('/')).replace('/'.concat(experienceName), '')}`;
                            const copyDestFilePath = `${copyDestinationFolder}/${fileName}`;

                            unprocessedFiles.push({
                                fileName: fileName,
                                sourcePath: copySourceFilePath,
                                destinationPath: copyDestFilePath,
                                fileType: 'excel',
                                batchName,
                                processType: 'copy'
                            });

                            let copyBatchJson = unprocessedBatchesJson[batchName];
                            if (!copyBatchJson) {
                                copyBatchJson = { status: 'processed', files: [{ copySourceFilePath, copyDestFilePath }] };
                            } else if (!copyBatchJson.files) {
                                copyBatchJson.files = [];
                            }
                            // Check if the file entry already exists before adding
                            const fileEntryExists = copyBatchJson.files.some(
                                file => file.copySourceFilePath === copySourceFilePath && file.copyDestFilePath === copyDestFilePath
                            );
                            if (!fileEntryExists) {
                                copyBatchJson.files.push({ copySourceFilePath, copyDestFilePath });
                            }
                            unprocessedBatchesJson[batchName] = copyBatchJson;

                            if (unprocessedBatchCount === BATCH_REQUEST_BULK_COPY) {
                                unprocessedBatchCount += 1;
                            }
                            logger.info(`In Process-doc-worker, for project: ${project} Copy Batch JSON after push: ${JSON.stringify(unprocessedBatchesJson)}`);
                            // Remove the immediate write here - we'll write at the end of batch processing
                        // }
                    } else {
                        // For non-docx files, just add to copy batches
                        const copySourceFilePath = `${sourcePath.substring(0, sourcePath.lastIndexOf('/') + 1)}${fileName}`;
                        const copyDestinationFolder = `${sourcePath.substring(0, sourcePath.lastIndexOf('/')).replace('/'.concat(experienceName), '')}`;
                        const copyDestFilePath = `${copyDestinationFolder}/${fileName}`;

                        unprocessedFiles.push({
                            fileName: fileName,
                            sourcePath: copySourceFilePath,
                            destinationPath: copyDestFilePath,
                            fileType: 'other',
                            batchName,
                            processType: 'copy'
                        });

                        let unprocessedBatchJson = unprocessedBatchesJson[batchName];
                        if (!unprocessedBatchJson) {
                            unprocessedBatchJson = { status: 'processed', files: [{ copySourceFilePath, copyDestFilePath }] };
                        } else if (!unprocessedBatchJson.files) {
                            unprocessedBatchJson.files = [];
                        }
                        // Check if the file entry already exists before adding
                        const fileEntryExists = unprocessedBatchJson.files.some(
                            file => file.copySourceFilePath === copySourceFilePath && file.copyDestFilePath === copyDestFilePath
                        );
                        if (!fileEntryExists) {
                            unprocessedBatchJson.files.push({ copySourceFilePath, copyDestFilePath });
                        }
                        unprocessedBatchesJson[batchName] = unprocessedBatchJson;

                        if (unprocessedBatchCount === BATCH_REQUEST_BULK_COPY) {
                            unprocessedBatchCount += 1;
                        }
                        logger.info(`In Process-doc-worker, for project: ${project} Copy Batch JSON after push: ${JSON.stringify(unprocessedBatchesJson)}`);
                        // Remove the immediate write here - we'll write at the end of batch processing
                    }

                    // Update each Batch Status in the current project's "bulk_copy_batch_status.json" file
                    batchStatusBulkCopyJson[batchName] = 'processed';

                    // Update the Project Status & Batch Status in the current project's "status.json" & updated bulk_copy_batch_status.json file respectively
                    // eslint-disable-next-line no-await-in-loop
                    await filesWrapper.writeFile(`graybox_promote${project}/bulk_copy_batch_status.json`, batchStatusBulkCopyJson);
                } else {
                    // Add to unprocessed files list - files that failed preview or don't need processing
                    // Update the Project Excel with the unprocessed file status
                    try {
                        const unprocessedFileInfo = {
                            fileName: fileName,
                            path: sourcePath,
                            reason: 'No mdPath available',
                            status: 'failed'
                        };
                        
                        const unprocessedFileExcelValues = [[
                            `Unprocessed file: ${fileName}`,
                            toUTCStr(new Date()),
                            unprocessedFileInfo.reason,
                            JSON.stringify(unprocessedFileInfo)
                        ]];
                        
                        // eslint-disable-next-line no-await-in-loop
                        await sharepoint.updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', unprocessedFileExcelValues);
                    } catch (err) {
                        logger.error(`Error occurred while updating Excel with unprocessed file status: ${err}`);
                    }
                }
            }
        }
    });

    await Promise.all(allProcessingPromises); // await all async functions in the array are executed

    // Write the processed files list to a JSON file
    await filesWrapper.writeFile(`graybox_promote${project}/processed_files.json`, processedFiles);
    
    // Write the unprocessed files list to a JSON file
    await filesWrapper.writeFile(`graybox_promote${project}/unprocessed_files.json`, unprocessedFiles);

    await updateStatuses(processedBatchesJson, project, filesWrapper, processDocxErrors, sharepoint, projectExcelPath, processedFiles, unprocessedFiles);

    const batchName = 'batch_1'; // TODO read batchname from batches json
    const processedFilePathObjs = processedBatchesJson[batchName].files || [];

    logger.info(`In Promote Content Worker, for project: ${project} for Batch Name ${batchName} promoteFilePaths: ${JSON.stringify(processedFilePathObjs)}`);

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
    await filesWrapper.writeFile(`graybox_promote${project}/processed_batches.json`, processedBatchesJson);
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
