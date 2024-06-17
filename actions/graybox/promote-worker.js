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
const {
    getAioLogger, handleExtension, isFilePatternMatched, toUTCStr
} = require('../utils');
const appConfig = require('../appConfig');
const { getConfig } = require('../config');
const {
    getAuthorizedRequestOption, fetchWithRetry, updateExcelTable,
    getFileData, getFileUsingDownloadUrl, saveFileSimple
} = require('../sharepoint');
const helixUtils = require('../helixUtils');
const updateDocument = require('../docxUpdater');

const logger = getAioLogger();
const MAX_CHILDREN = 1000;
const BATCH_REQUEST_PREVIEW = 200;

const gbStyleExpression = 'gb-'; // graybox style expression. need to revisit if there are any more styles to be considered.
const gbDomainSuffix = '-graybox';

/**
 *  - Bulk Preview docx files
 *  - GET markdown files using preview-url.md
 *  - Process markdown - process MDAST by cleaning it up
 *  - Generate updated Docx file using md2docx lib
 *  - copy updated docx file to the default content tree
 *  - run the bulk preview action on the list of files that were copied to default content tree
 *  - update the project excel file as and when necessary to update the status of the promote action
 */
async function main(params) {
    logger.info('Graybox Promote Worker invoked');

    appConfig.setAppConfig(params);
    const { gbRootFolder, experienceName } = appConfig.getPayload();
    const { projectExcelPath } = appConfig.getPayload();

    // Update Promote Status
    const promoteTriggeredExcelValues = [['Promote triggered', toUTCStr(new Date()), '']];
    await updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', promoteTriggeredExcelValues);

    logger.info(`GB ROOT FOLDER ::: ${gbRootFolder}`);
    logger.info(`GB EXP NAME ::: ${experienceName}`);

    // Get all files in the graybox folder for the specific experience name
    // NOTE: This does not capture content inside the locale/expName folders yet
    const gbFiles = await findAllFiles(experienceName, appConfig);
    logger.info(`Files in graybox folder in ${experienceName}`);
    logger.info(JSON.stringify(gbFiles));

    // create batches to process the data
    const batchArray = [];
    for (let i = 0; i < gbFiles.length; i += BATCH_REQUEST_PREVIEW) {
        const arrayChunk = gbFiles.slice(i, i + BATCH_REQUEST_PREVIEW);
        batchArray.push(arrayChunk);
    }

    // process data in batches
    const previewStatuses = [];
    let failedPreviews = [];

    const promotedPreviewStatuses = [];
    let promotedFailedPreviews = [];
    let responsePayload = '';
    if (helixUtils.canBulkPreview(true)) {
        logger.info('Bulk Previewing Graybox files');
        const paths = [];
        batchArray.forEach((batch) => {
            batch.forEach((gbFile) => paths.push(handleExtension(gbFile.filePath)));
        });
        previewStatuses.push(await helixUtils.bulkPreview(paths, helixUtils.getOperations().PREVIEW, experienceName, true));

        failedPreviews = previewStatuses.flatMap((statusArray) => statusArray.filter((status) => !status.success)).map((status) => status.path);

        // Update project excel file with status (sample)
        logger.info('Updating project excel file with status');

        const sFailedPreviews = failedPreviews.length > 0 ? `Failed Previews(Promote won't happen for these): \n${failedPreviews.join('\n')}` : '';
        const excelValues = [['Preview completed', toUTCStr(new Date()), sFailedPreviews]];
        // Update Preview Status
        await updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', excelValues);

        // Get the Helix Admin API Key for the Graybox content tree, needed for accessing (with auth) Images in graybox tree
        const helixAdminApiKey = helixUtils.getAdminApiKey(true);

        // Promote Graybox files to the default content tree
        const { promotes, failedPromotes } = await promoteFiles(previewStatuses, experienceName, helixAdminApiKey);

        // Update Promote Status
        const sFailedPromoteStatuses = failedPromotes.length > 0 ? `Failed Promotes: \n${failedPromotes.join('\n')}` : '';
        const promoteExcelValues = [['Promote completed', toUTCStr(new Date()), sFailedPromoteStatuses]];

        await updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', promoteExcelValues);

        // Handle the extensions of promoted files
        const promotedPaths = promotes.map((promote) => handleExtension(promote));

        // Perform Preview of all Promoted files in the Default Content Tree
        if (helixUtils.canBulkPreview(false)) {
            promotedPaths.forEach((promote) => logger.info(`Promoted file in Default folder: ${promote}`));
            // Don't pass the experienceName & isGraybox params for the default content tree
            promotedPreviewStatuses.push(await helixUtils.bulkPreview(promotedPaths, helixUtils.getOperations().PREVIEW));
        }

        promotedFailedPreviews = promotedPreviewStatuses.flatMap((statusArray) => statusArray.filter((status) => !status.success)).map((status) => status.path);
        const sFailedPromotedPreviews = promotedFailedPreviews.length > 0 ? `Failed Promoted Previews: \n${promotedFailedPreviews.join('\n')}` : '';

        const promotedExcelValues = [['Promoted Files Preview completed', toUTCStr(new Date()), sFailedPromotedPreviews]];
        // Update Promoted Preview Status
        await updateExcelTable(projectExcelPath, 'PROMOTE_STATUS', promotedExcelValues);
        responsePayload = 'Graybox Promote Worker action completed.';
    } else {
        responsePayload = 'Bulk Preview not enabled for Graybox Content Tree';
    }
    logger.info(responsePayload);
    return exitAction({
        body: responsePayload,
    });
}

/**
* Promote Graybox files to the default content tree
 * @param {*} previewStatuses file preview statuses
 * @param {*} experienceName graybox experience name
 * @param {*} helixAdminApiKey helix admin api key for performing Mdast to Docx conversion
 * @returns JSON array of successful & failed promotes
 */
async function promoteFiles(previewStatuses, experienceName, helixAdminApiKey) {
    const promotes = [];
    const failedPromotes = [];
    const options = {};
    // Passing isGraybox param true to fetch graybox Hlx Admin API Key
    const grayboxHlxAdminApiKey = helixUtils.getAdminApiKey(true);
    if (grayboxHlxAdminApiKey) {
        options.headers = new fetch.Headers();
        options.headers.append('Authorization', `token ${grayboxHlxAdminApiKey}`);
    }

    // iterate through preview statuses, generate docx files and promote them
    const allPromises = previewStatuses.map(async (status) => {
        // check if status is an array and iterate through the array
        if (Array.isArray(status)) {
            const promises = status.map(async (stat) => {
                if (stat.success && stat.mdPath) {
                    const response = await fetchWithRetry(`${stat.mdPath}`, options);
                    const content = await response.text();
                    let docx;
                    const { sp } = await getConfig();

                    if (content.includes(experienceName) || content.includes(gbStyleExpression) || content.includes(gbDomainSuffix)) {
                        // Process the Graybox Styles and Links with Mdast to Docx conversion
                        docx = await updateDocument(content, experienceName, helixAdminApiKey);
                        if (docx) {
                            // Save file Destination full path with file name and extension
                            const destinationFilePath = `${stat.path.substring(0, stat.path.lastIndexOf('/') + 1).replace('/'.concat(experienceName), '')}${stat.fileName}`;
                            const saveStatus = await saveFileSimple(docx, destinationFilePath, sp);

                            if (saveStatus?.success) {
                                promotes.push(destinationFilePath);
                            } else if (saveStatus?.errorMsg?.includes('File is locked')) {
                                failedPromotes.push(`${destinationFilePath} (locked file)`);
                            } else {
                                failedPromotes.push(destinationFilePath);
                            }
                        } else {
                            logger.error(`Error generating docx file for ${stat.path}`);
                        }
                    } else {
                        const copySourceFilePath = `${stat.path.substring(0, stat.path.lastIndexOf('/') + 1)}${stat.fileName}`; // Copy Source full path with file name and extension
                        const copyDestinationFolder = `${stat.path.substring(0, stat.path.lastIndexOf('/')).replace('/'.concat(experienceName), '')}`; // Copy Destination folder path, no file name
                        const destFilePath = `${copyDestinationFolder}/${stat.fileName}`;

                        const { fileDownloadUrl } = await getFileData(copySourceFilePath, true);
                        const file = await getFileUsingDownloadUrl(fileDownloadUrl);
                        const saveStatus = await saveFileSimple(file, destFilePath, sp);

                        if (saveStatus?.success) {
                            promotes.push(destFilePath);
                        } else if (saveStatus?.errorMsg?.includes('File is locked')) {
                            failedPromotes.push(`${destFilePath} (locked file)`);
                        } else {
                            failedPromotes.push(destFilePath);
                        }
                    }
                }
            });
            await Promise.all(promises); // await all async functions in the array are executed, before updating the status in the graybox project excel
        }
    });
    await Promise.all(allPromises); // await all async functions in the array are executed, before updating the status in the graybox project excel
    return { promotes, failedPromotes };
}

/**
 * Find all files in the Graybox tree to promote.
 */
async function findAllFiles(experienceName, appConf) {
    const { sp } = await getConfig();
    const options = await getAuthorizedRequestOption({ method: 'GET' });
    const promoteIgnoreList = appConf.getPromoteIgnorePaths();
    logger.info(`Promote ignore list: ${promoteIgnoreList}`);

    return findAllGrayboxFiles({
        baseURI: sp.api.file.get.gbBaseURI,
        options,
        gbFolders: appConf.isDraftOnly() ? [`/${experienceName}/drafts`] : [''],
        promoteIgnoreList,
        downloadBaseURI: sp.api.file.download.baseURI,
        experienceName
    });
}

/**
 * Iteratively finds all files under a specified root folder.
 */
async function findAllGrayboxFiles({
    baseURI, options, gbFolders, promoteIgnoreList, downloadBaseURI, experienceName
}) {
    const gbRoot = baseURI.split(':').pop();
    // Regular expression to select the gbRoot and anything before it
    // Eg: the regex selects "https://<sharepoint-site>:/<app>-graybox"
    const pPathRegExp = new RegExp(`.*:${gbRoot}`);
    // Regular expression to select paths that has the experienceName at first or second level
    const pathsToSelectRegExp = new RegExp(`^/([^/]+/)?${experienceName}(/.*)?$`);
    const gbFiles = [];
    while (gbFolders.length !== 0) {
        const uri = `${baseURI}${gbFolders.shift()}:/children?$top=${MAX_CHILDREN}`;
        // eslint-disable-next-line no-await-in-loop
        const res = await fetchWithRetry(uri, options);
        logger.info(`Find all Graybox files URI: ${uri} \nResponse: ${res.ok}`);
        if (res.ok) {
            // eslint-disable-next-line no-await-in-loop
            const json = await res.json();
            // eslint-disable-next-line no-await-in-loop
            const driveItems = json.value;
            for (let di = 0; di < driveItems?.length; di += 1) {
                const item = driveItems[di];
                const itemPath = `${item.parentReference.path.replace(pPathRegExp, '')}/${item.name}`;
                logger.info(`${itemPath} ::: ${pathsToSelectRegExp.test(itemPath)}`);
                if (!isFilePatternMatched(itemPath, promoteIgnoreList)) {
                    if (item.folder) {
                        // it is a folder
                        gbFolders.push(itemPath);
                    } else if (pathsToSelectRegExp.test(itemPath)) {
                        const downloadUrl = `${downloadBaseURI}/${item.id}/content`;
                        // eslint-disable-next-line no-await-in-loop
                        gbFiles.push({ fileDownloadUrl: downloadUrl, filePath: itemPath });
                    }
                } else {
                    logger.info(`Ignored from promote: ${itemPath}`);
                }
            }
        }
    }
    return gbFiles;
}

function exitAction(resp) {
    appConfig.removePayload();
    return resp;
}

exports.main = main;
