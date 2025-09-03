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
import { updateDocumentForPromote, updateDocumentForBulkCopy } from '../docxUpdater.js';
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

    const appConfig = new AppConfig(params);
    const { gbRootFolder, experienceName, projectExcelPath } = appConfig.getPayload();

    const sharepoint = new Sharepoint(appConfig);
    // process data in batches
    const helixUtils = new HelixUtils(appConfig);
    const filesWrapper = await initFilesWrapper(logger);
    let responsePayload;

    const project = `${gbRootFolder}/${experienceName}`;

    // Get the Helix Admin API Key for the Graybox content tree, needed for accessing (with auth) Images in graybox tree
    const helixAdminApiKey = helixUtils.getAdminApiKey(true);

    // Read the Project Status in the current project's "status.json" file
    const projectStatusBulkCopyJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/bulk-copy-status.json`);
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
    // Promote Graybox files to the default content tree
    await processFiles(processFilesParams);

    responsePayload = 'Processing of Graybox Content Tree completed';
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
    const options = {};
    // Passing isGraybox param true to fetch graybox Hlx Admin API Key
    const grayboxHlxAdminApiKey = helixUtils.getAdminApiKey(true);
    if (grayboxHlxAdminApiKey) {
        options.headers = new fetch.Headers();
        options.headers.append('Authorization', `token ${grayboxHlxAdminApiKey}`);
    }

    const project = `${gbRootFolder}/${experienceName}`;
    const toBeStatus = 'process_content_in_progress';
    const statusEntry = {
        step: 'Processing files for Graybox blocks, styles and links started',
        stepName: toBeStatus,
        files: []
    };

    await writeProjectStatus(filesWrapper, `graybox_promote${project}/status.json`, statusEntry, toBeStatus);

    // Update the Project Status in the parent "project_queue.json" file
    await changeProjectStatusInQueue(filesWrapper, gbRootFolder, experienceName, toBeStatus);

    // Read the Batch Status in the current project's "batch_status_bulk_copy.json" file
    const batchStatusBulkCopyJson = await filesWrapper.readFileIntoObject(`graybox_promote${project}/batch_status_bulk_copy.json`);

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


        // Check if Step 2 finished, do the Step 3, if the batch status is 'initial_preview_done' then process the batch
        if (batchStatusBulkCopyJson[batchName] === 'initiated') {
            for (let batchIndex = 0; batchIndex < sourcePathObjs.length; batchIndex += 1) {
                const sourcePathObj = sourcePathObjs[batchIndex];
                const { sourcePath, destinationPath } = sourcePathObj;
                const fileName = sharepoint.getFileNameFromPath(sourcePath);
                if (sourcePathObj.mdPath) { // If the file has a mdPath then process the file
                    // Check if the file is a docx file
                    const isDocxFile = fileName.toLowerCase().endsWith('.docx');
                    // Check if the file is an Excel file
                    const isExcelFile = fileName.toLowerCase().endsWith('.xlsx') ||
                        fileName.toLowerCase().endsWith('.xls');

                    if (isDocxFile) {
                        // eslint-disable-next-line no-await-in-loop
                        const response = await sharepoint.fetchWithRetry(`${sourcePathObj.mdPath}`, options);
                        // eslint-disable-next-line no-await-in-loop
                        const content = await response.text();
                        let docx;
                        if (hasGrayboxContent(content, experienceName)) {
                            // Add the Graybox Experience Name to Graybox Fragment Links then perform Mdast to Docx conversion
                            // eslint-disable-next-line no-await-in-loop
                            docx = await updateDocumentForBulkCopy(content, experienceName, helixAdminApiKey);
                            if (docx) {
                                const destinationFilePath = `${sourcePath.substring(0, sourcePath.lastIndexOf('/') + 1).replace('/'.concat(experienceName), '')}${fileName}`;
                                const docxFileStream = Readable.from(docx);

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

                                let promoteBatchJson = processedBatchesJson[batchName];
                                if (!promoteBatchJson) {
                                    promoteBatchJson = { status: 'processed', files: [destinationFilePath] };
                                } else if (promoteBatchJson.files) {
                                    promoteBatchJson.files.push(destinationFilePath);
                                } else {
                                    promoteBatchJson.files = [destinationFilePath];
                                }
                                processedBatchesJson[batchName] = promoteBatchJson;

                                logger.info(`In Process-doc-worker, for project: ${project} Promote Batch JSON after push: ${JSON.stringify(processedBatchesJson)}`);

                                // If the promote batch count reaches the limit, increment the promote batch count
                                if (processedBatchCount === BATCH_REQUEST_BULK_COPY) { // TODO remove this code if promoteBatchCount is not needed, and instead initial preview batch count is used
                                    processedBatchCount += 1;
                                }

                                // Write the promote batches JSON file
                                // eslint-disable-next-line no-await-in-loop
                                await filesWrapper.writeFile(`graybox_promote${project}/promote_batches.json`, processedBatchesJson);
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
                        if (hasGrayboxContent(content, experienceName)) {
                            const transformedExcelContent = await updateExcel(content, experienceName);
                            const excelBuffer = convertJsonToExcel(transformedExcelContent, experienceName);
                            // Write the transformed content back
                            const destinationFilePath = `${sourcePath.substring(0, sourcePath.lastIndexOf('/') + 1).replace('/'.concat(experienceName), '')}${fileName}`;

                            // eslint-disable-next-line no-await-in-loop
                            await filesWrapper.writeFile(`graybox_promote${project}/excel${destinationFilePath}`, excelBuffer);

                            // Add to processed files list
                            processedFiles.push({
                                fileName: fileName,
                                sourcePath: sourcePath,
                                destinationPath: destinationFilePath,
                                fileType: 'excel',
                                batchName,
                                processType: 'promote'
                            });

                            let promoteBatchJson = processedBatchesJson[batchName];
                            if (!promoteBatchJson) {
                                promoteBatchJson = { status: 'processed', files: [destinationFilePath] };
                            } else if (promoteBatchJson.files) {
                                promoteBatchJson.files.push(destinationFilePath);
                            } else {
                                promoteBatchJson.files = [destinationFilePath];
                            }
                            processedBatchesJson[batchName] = promoteBatchJson;

                            logger.info(`In Process-doc-worker, for project: ${project} Promote Batch JSON after push: ${JSON.stringify(processedBatchesJson)}`);
                            // eslint-disable-next-line no-await-in-loop
                            await filesWrapper.writeFile(`graybox_promote${project}/promote_batches.json`, processedBatchesJson);
                        } else {
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
                        }
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
                    }

                    // Update each Batch Status in the current project's "batch_status_bulk_copy.json" file
                    batchStatusBulkCopyJson[batchName] = 'processed';

                    // Update the Project Status & Batch Status in the current project's "status.json" & updated batch_status_bulk_copy.json file respectively
                    // eslint-disable-next-line no-await-in-loop
                    await filesWrapper.writeFile(`graybox_promote${project}/batch_status_bulk_copy.json`, batchStatusBulkCopyJson);
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

    await updateStatuses(processedBatchesJson, unprocessedBatchesJson, project, filesWrapper, processDocxErrors, sharepoint, projectExcelPath, processedFiles, unprocessedFiles);
}

async function updateStatuses(promoteBatchesJson, copyBatchesJson, project, filesWrapper, processContentErrors, sharepoint, projectExcelPath, processedFiles, unprocessedFiles) {
    // Write the copy batches JSON file
    await filesWrapper.writeFile(`graybox_promote${project}/copy_batches.json`, copyBatchesJson);
    await filesWrapper.writeFile(`graybox_promote${project}/promote_batches.json`, promoteBatchesJson);
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
 * Update the Project Status in the current project's "status.json" file & the parent "project_queue.json" file
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

    // Update the Project Status in the parent "project_queue.json" file
    const projectQueue = await changeProjectStatusInQueue(filesWrapper, project, toBeStatus);
    logger.info(`In process-content-worker, for project: ${project} After Processing Docx, Project Queue Json: ${JSON.stringify(projectQueue)}`);
}

async function changeProjectStatusInQueue(filesWrapper, project, toBeStatus) {
    const projectQueue = await filesWrapper.readFileIntoObject('graybox_promote/project_queue.json');
    const index = projectQueue.findIndex((obj) => obj.projectPath === `${project}`);
    if (index !== -1) {
        // Replace the object at the found index
        projectQueue[index].status = toBeStatus;
        await filesWrapper.writeFile('graybox_promote/project_queue.json', projectQueue);
    }
    return projectQueue;
}

function exitAction(resp) {
    return resp;
}

export { main };
