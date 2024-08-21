/* ************************************************************************
* ADOBE CONFIDENTIAL
* ___________________
*
* Copyright 2024 Adobe
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

const fetch = require('node-fetch');
const { Readable } = require('stream');
const {
    getAioLogger, toUTCStr
} = require('../utils');
const AppConfig = require('../appConfig');
const HelixUtils = require('../helixUtils');
const Sharepoint = require('../sharepoint');
const updateDocument = require('../docxUpdater');
const initFilesWrapper = require('./filesWrapper');

const gbStyleExpression = 'gb-'; // graybox style expression. need to revisit if there are any more styles to be considered.
const gbDomainSuffix = '-graybox';

const BATCH_REQUEST_PROMOTE = 200;

const logger = getAioLogger();

async function main(params) {
    logger.info('Graybox Process Docx Action triggered');

    const appConfig = new AppConfig(params);
    const { gbRootFolder, experienceName, projectExcelPath } = appConfig.getPayload();

    const sharepoint = new Sharepoint(appConfig);
    // process data in batches
    const helixUtils = new HelixUtils(appConfig);
    const filesWrapper = await initFilesWrapper(logger);
    let responsePayload;

    // Get the Helix Admin API Key for the Graybox content tree, needed for accessing (with auth) Images in graybox tree
    const helixAdminApiKey = helixUtils.getAdminApiKey(true);

    const previewStatuses = await filesWrapper.readFileIntoObject(`graybox_promote${gbRootFolder}/${experienceName}/preview_status.json`);

    logger.info(`In Process-doc-worker, previewStatuses: ${JSON.stringify(previewStatuses)}`);
    if (!previewStatuses) {
        responsePayload = 'No preview statuses found';
        logger.info(responsePayload);
        return exitAction({
            body: responsePayload,
            statusCode: 200
        });
    }
    const processFilesParams = {
        previewStatuses,
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
    previewStatuses, experienceName, helixAdminApiKey, sharepoint, helixUtils, filesWrapper, gbRootFolder, projectExcelPath
}) {
    const options = {};
    // Passing isGraybox param true to fetch graybox Hlx Admin API Key
    const grayboxHlxAdminApiKey = helixUtils.getAdminApiKey(true);
    if (grayboxHlxAdminApiKey) {
        options.headers = new fetch.Headers();
        options.headers.append('Authorization', `token ${grayboxHlxAdminApiKey}`);
    }

    // Read the Project Status in the current project's "status.json" file
    const projectStatusJson = await filesWrapper.readFileIntoObject(`graybox_promote${gbRootFolder}/${experienceName}/status.json`);

    // Read the Batch Status in the current project's "batch_status.json" file
    const batchStatusJson = await filesWrapper.readFileIntoObject(`graybox_promote${gbRootFolder}/${experienceName}/batch_status.json`);

    logger.info(`In Process-doc-worker, batchStatusJson: ${JSON.stringify(batchStatusJson)}`);
    const promoteBatchesJson = {};
    const copyBatchesJson = {};
    let promoteBatchCount = 0;
    let copyBatchCount = 0;
    const processDocxErrors = [];

    // iterate through preview statuses, generate docx files and create promote & copy batches
    Object.keys(previewStatuses).forEach(async (batchName) => {
        const batchPreviewStatuses = previewStatuses[batchName];

        // Check if Step 2 finished, do the Step 3, if the batch status is 'initial_preview_done' then process the batch
        if (batchStatusJson[batchName] === 'initial_preview_done') {
            const allPreviewPromises = batchPreviewStatuses.map(async (status) => {
                if (status.success && status.mdPath) { // If the file is successfully initial previewed and has a mdPath then process the file
                    const response = await sharepoint.fetchWithRetry(`${status.mdPath}`, options);
                    const content = await response.text();
                    let docx;

                    if (content.includes(experienceName) || content.includes(gbStyleExpression) || content.includes(gbDomainSuffix)) {
                        // Process the Graybox Styles and Links with Mdast to Docx conversion
                        docx = await updateDocument(content, experienceName, helixAdminApiKey);
                        if (docx) {
                            const destinationFilePath = `${status.path.substring(0, status.path.lastIndexOf('/') + 1).replace('/'.concat(experienceName), '')}${status.fileName}`;
                            const docxFileStream = Readable.from(docx);

                            // Write the processed documents to the AIO folder for docx files
                            await filesWrapper.writeFileFromStream(`graybox_promote${gbRootFolder}/${experienceName}/docx${destinationFilePath}`, docxFileStream);

                            // Create Promote Batches
                            // const promoteBatchName = `batch_${promoteBatchCount + 1}`;
                            // Don't create new batch names, use the same batch names created in the start before initial preview

                            let promoteBatchJson = promoteBatchesJson[batchName];
                            if (!promoteBatchJson) {
                                promoteBatchJson = { status: 'processed', files: [destinationFilePath] };
                            } else if (promoteBatchJson.files) {
                                promoteBatchJson.files.push(destinationFilePath);
                            } else {
                                promoteBatchJson.files = [destinationFilePath];
                            }
                            promoteBatchesJson[batchName] = promoteBatchJson;

                            logger.info(`In Process-doc-worker Promote Batch JSON after push: ${JSON.stringify(promoteBatchesJson)}`);

                            // If the promote batch count reaches the limit, increment the promote batch count
                            if (promoteBatchCount === BATCH_REQUEST_PROMOTE) { // TODO remove this code if promoteBatchCount is not needed, and instead initial preview batch count is used
                                promoteBatchCount += 1;
                            }

                            // Write the promote batches JSON file
                            await filesWrapper.writeFile(`graybox_promote${gbRootFolder}/${experienceName}/promote_batches.json`, promoteBatchesJson);
                        } else {
                            processDocxErrors.push(`Error processing docx for ${status.fileName}`);
                        }

                        // Update each Batch Status in the current project's "batch_status.json" file
                        batchStatusJson[batchName] = 'processed';

                        // Update the Project Status & Batch Status in the current project's "status.json" & updated batch_status.json file respectively
                        await filesWrapper.writeFile(`graybox_promote${gbRootFolder}/${experienceName}/batch_status.json`, batchStatusJson);
                    } else {
                        // Copy Source full path with file name and extension
                        const copySourceFilePath = `${status.path.substring(0, status.path.lastIndexOf('/') + 1)}${status.fileName}`;
                        // Copy Destination folder path, no file name
                        const copyDestinationFolder = `${status.path.substring(0, status.path.lastIndexOf('/')).replace('/'.concat(experienceName), '')}`;
                        const copyDestFilePath = `${copyDestinationFolder}/${status.fileName}`;

                        // Create Copy Batches
                        // const copyBatchName = `batch_${copyBatchCount + 1}`;
                        // Don't create new batch names, use the same batch names created in the start before initial preview
                        let copyBatchJson = copyBatchesJson[batchName];
                        if (!copyBatchJson) {
                            copyBatchJson = { status: 'processed', files: [{ copySourceFilePath, copyDestFilePath }] };
                        } else if (!copyBatchJson.files) {
                            copyBatchJson.files = [];
                        }
                        copyBatchJson.files.push({ copySourceFilePath, copyDestFilePath });
                        copyBatchesJson[batchName] = copyBatchJson;

                        // If the copy batch count reaches the limit, increment the copy batch count
                        if (copyBatchCount === BATCH_REQUEST_PROMOTE) { // TODO remove this code if copyBatchCount is not needed, and instead initial preview batch count is used
                            copyBatchCount += 1; // Increment the copy batch count
                        }
                        logger.info(`In Process-doc-worker Copy Batch JSON after push: ${JSON.stringify(copyBatchesJson)}`);
                        // Write the copy batches JSON file
                        await filesWrapper.writeFile(`graybox_promote${gbRootFolder}/${experienceName}/copy_batches.json`, copyBatchesJson);

                        // Update each Batch Status in the current project's "batch_status.json" file
                        batchStatusJson[batchName] = 'processed';
                        // Update the Project Status & Batch Status in the current project's "status.json" & updated batch_status.json file respectively
                        await filesWrapper.writeFile(`graybox_promote${gbRootFolder}/${experienceName}/batch_status.json`, batchStatusJson);
                    }
                }
            });
            await Promise.all(allPreviewPromises); // await all async functions in the array are executed
        }
    });

    // Write the processDocxErrors to the AIO Files
    if (processDocxErrors.length > 0) {
        await filesWrapper.writeFile(`graybox_promote${gbRootFolder}/${experienceName}/process_docx_errors.json`, processDocxErrors);
    }

    // Update the Project Status in the current project's "status.json" file
    projectStatusJson.status = 'processed';

    // Update the Project Excel with the Promote Status
    try {
        const promoteExcelValues = [['Step 2 of 5: Process Docx completed', toUTCStr(new Date()), '']];
        await sharepoint.updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', promoteExcelValues);
    } catch (err) {
        logger.error(`Error Occured while updating Excel during Graybox Process Docx Step: ${err}`);
    }

    // Update the Project Status in JSON files
    updateProjectStatus(batchStatusJson, projectStatusJson, gbRootFolder, experienceName, filesWrapper);
}

/**
 * Update the Project Status in the current project's "status.json" file & the parent "project_queue.json" file
 * @param {*} gbRootFolder graybox root folder
 * @param {*} experienceName graybox experience name
 * @param {*} filesWrapper filesWrapper object
 * @returns updated project status
 */
async function updateProjectStatus(batchStatusJson, projectStatusJson, gbRootFolder, experienceName, filesWrapper) {
    const projectQueue = await filesWrapper.readFileIntoObject('graybox_promote/project_queue.json');
    // Write the Project Status in the current project's "status.json" file
    await filesWrapper.writeFile(`graybox_promote${gbRootFolder}/${experienceName}/status.json`, projectStatusJson);

    // Update the Project Status in the parent "project_queue.json" file
    const index = projectQueue.findIndex((obj) => obj.projectPath === `${gbRootFolder}/${experienceName}`);
    if (index !== -1) {
        // Replace the object at the found index
        projectQueue[index].status = 'processed';
    }
    logger.info(`In Process-docx-worker After Processing Docx, Project Queue Json: ${JSON.stringify(projectQueue)}`);
    await filesWrapper.writeFile('graybox_promote/project_queue.json', projectQueue);
}

function exitAction(resp) {
    return resp;
}

exports.main = main;
